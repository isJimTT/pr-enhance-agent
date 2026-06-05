# Gitee Webhook 代码 Bot — 技术方案

> 本文描述一套**通用**的自建 Bot 服务：可配置地接收 Gitee Webhook，在指定仓库分支上**改代码并 push**。  
> **怎么改代码**不由 Bot 写死，而是由你在配置或插件里定义。  
> 本文仅为方案文档，不含实现代码。

---

## 1. 定位

| 项 | 说明 |
|----|------|
| **Bot 负责** | 接收 Webhook → 验签 → 解析事件 → 拉代码 → 调用「变更策略」→ commit → push → 记录结果 |
| **你负责** | 定义变更策略（脚本 / HTTP 回调 / LLM Prompt 模板等）、目标仓库、触发条件、提交规范 |
| **不负责** | 业务逻辑本身、PR 评审、合并策略 |

Bot 是**执行引擎**，不是**业务规则引擎**。同一套 Bot 可服务多个仓库、多种任务，只要为每个任务配置不同的 Webhook 路由与变更策略即可。

---

## 2. 总体架构

```mermaid
flowchart TB
  subgraph Gitee
    WH[Webhook 事件]
  end

  subgraph Bot["通用 Webhook Bot 服务"]
    GW[Gateway<br/>可配置路由 + 验签]
    R[规则引擎<br/>事件/分支/仓库过滤]
    Q[任务队列]
    W[Worker]
    GE[Git Engine<br/>clone/fetch/diff/commit/push]
    SP[Strategy Plugin<br/>变更策略 可插拔]
    ST[(状态存储)]
  end

  subgraph UserDefined["由你定义"]
    SH[Shell 脚本]
    HTTP[HTTP Handler]
    LLM[LLM Prompt 模板]
    OTHER[其他插件]
  end

  WH --> GW --> R --> Q --> W
  W --> ST
  W --> GE
  W --> SP
  SP --> SH
  SP --> HTTP
  SP --> LLM
  SP --> OTHER
  GE -->|push| Gitee
```

---

## 3. 核心概念

### 3.1 Webhook Route（可配置接收端）

每个路由独立配置，互不影响：

| 配置项 | 说明 |
|--------|------|
| `path` | HTTP 路径，如 `/webhook/gitee/pr-doc` |
| `secret` | 与 Gitee Webhook 密码一致，用于验签 |
| `provider` | 固定 `gitee`（后续可扩展 github/gitlab） |
| `events` | 允许的事件类型，如 `pull_request` |
| `rules` | 过滤条件：目标分支、源分支前缀、action、发送者黑名单等 |
| `job` | 绑定的任务模板（见 3.2） |

**示例**：同一 Bot 进程可同时监听：

- `/webhook/gitee/pr-doc` → 更新 PRD / changelog
- `/webhook/gitee/sync-i18n` → 跑 i18n 脚本
- `/webhook/gitee/nightly-fix` → 仅 `schedule` 或手动触发

### 3.2 Job Template（任务模板）

描述「收到合法 Webhook 后做什么」：

| 配置项 | 说明 |
|--------|------|
| `repo` | `owner/repo`，或从 Webhook payload 动态解析 |
| `git.branch` | 操作分支：通常取 PR **源分支** |
| `git.base` | diff 基准：通常取 PR **目标分支** |
| `strategy` | 变更策略类型与参数（见第 5 节） |
| `commit` | 提交信息模板、作者、是否允许空变更 |
| `guard` | 防循环、幂等、并发锁（见第 7 节） |
| `notify` | 可选：PR 评论、Webhook 回调、告警 |

### 3.3 Strategy Plugin（变更策略 — 由你定义）

Bot 在 checkout 到正确分支、生成上下文（diff、文件快照、环境变量）之后，调用策略插件。**插件只负责产出「要写入的文件变更」或「执行结果」**，不负责 push（push 由 Git Engine 统一完成）。

---

## 4. 端到端流程

```mermaid
sequenceDiagram
  participant G as Gitee
  participant GW as Gateway
  participant W as Worker
  participant GE as Git Engine
  participant SP as Strategy Plugin
  participant ST as State Store

  G->>GW: POST /webhook/gitee/{route}
  GW->>GW: 验签 + 匹配 route 规则
  alt 不匹配 / 应跳过
    GW-->>G: 200 OK (ignored)
  else 入队
    GW-->>G: 200 OK + traceId
    W->>ST: 幂等检查 (route, pr, headSha)
    W->>GE: fetch + checkout 源分支
    W->>GE: 生成 diff / 工作区上下文
    W->>SP: 执行变更策略 (上下文 + 配置)
    SP-->>W: 变更结果 (files / exitCode / no_change)
    alt no_change
      W->>ST: 标记 skipped
    else 有变更
      W->>GE: 应用变更 + commit + push
      W->>ST: 标记 success
    end
    W->>G: 可选 PR 评论 / 外部 notify
  end
```

**关键约束**

1. Gateway **必须快速返回 200**，实际工作在队列中异步执行。
2. push **始终由 Git Engine 执行**，策略插件不能直接操作远程仓库。
3. 策略插件**只能改配置允许的路径**（白名单），防止误伤。

---

## 5. 变更策略（Strategy）设计

策略是可插拔的；Bot 内置几种通用类型，你通过配置选择并传参。

### 5.1 策略类型一览

| 类型 | 适用场景 | 你需提供 |
|------|----------|----------|
| `shell` | 确定性脚本（格式化、 codegen、替换） | 脚本路径 + 参数 |
| `http` | 已有内部服务负责改代码 | Handler URL + 鉴权 |
| `llm` | 自然语言驱动的文档/代码改写 | Prompt 模板 + API Key + 模型 |
| `composite` | 多步流水线 | 有序子策略列表 |

### 5.2 策略输入（Bot 统一注入）

无论哪种策略，Bot 都提供统一上下文，供脚本或服务使用：

```json
{
  "traceId": "uuid",
  "route": "pr-doc",
  "event": {
    "provider": "gitee",
    "action": "open",
    "sender": "jim",
    "pr": {
      "number": 42,
      "title": "feat: xxx",
      "body": "...",
      "sourceBranch": "feature/foo",
      "targetBranch": "master",
      "headSha": "abc123",
      "url": "https://gitee.com/..."
    }
  },
  "repo": {
    "fullName": "org/cc-auto-test",
    "workspaceDir": "/var/lib/bot/repos/cc-auto-test"
  },
  "git": {
    "baseRef": "origin/master",
    "headRef": "HEAD",
    "diffPath": "/tmp/traceId.diff",
    "changedFiles": ["backend/...", "frontend/..."]
  },
  "env": {
    "JOB_ID": "...",
    "ROUTE_NAME": "pr-doc"
  }
}
```

### 5.3 策略输出（Bot 统一约定）

策略必须返回以下之一：

**A. 文件变更（推荐）**

```json
{
  "action": "update",
  "files": [
    { "path": "PRD.md", "content": "..." },
    { "path": "docs-site/changelog.md", "content": "..." }
  ],
  "message": "可选说明，写入 commit body 或 PR 评论"
}
```

**B. 无变更**

```json
{
  "action": "no_change",
  "reason": "仅 CI 变更，无需更新文档"
}
```

**C. 失败**

```json
{
  "action": "error",
  "reason": "LLM 输出无法解析"
}
```

**D. Shell 策略特例**

- 脚本直接在 `workspaceDir` 内改文件，退出码 `0` 表示成功。
- Bot 用 `git status` 检测是否有改动；无改动视为 `no_change`。

### 5.4 策略配置示例

#### Shell 策略

```yaml
strategy:
  type: shell
  command: ./scripts/bot/update-docs.sh
  timeoutSec: 300
  allowedPaths:
    - PRD.md
    - docs-site/changelog.md
```

#### HTTP 策略

```yaml
strategy:
  type: http
  url: https://internal.example.com/code-mutator
  method: POST
  headers:
    Authorization: Bearer ${INTERNAL_TOKEN}
  timeoutSec: 120
  allowedPaths:
    - PRD.md
    - docs-site/changelog.md
```

#### LLM 策略（DeepSeek / 其他 OpenAI 兼容 API）

```yaml
strategy:
  type: llm
  provider: deepseek
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
  systemPromptFile: ./prompts/pr-doc-system.md   # 你可放 skill 全文
  userPromptTemplate: ./prompts/pr-doc-user.tpl  # 模板变量：{{diff}} {{prTitle}} ...
  outputFormat: json                             # 强制 JSON，便于落盘
  allowedPaths:
    - PRD.md
    - docs-site/changelog.md
```

> **怎么改、改哪些文件、用什么 Prompt**，全部在配置与 prompt 文件中由你定义；Bot 只负责调用与校验。

---

## 6. Webhook 接收配置

### 6.1 Gitee 侧

路径：**仓库 → 管理 → WebHooks → 添加**

| 项 | 说明 |
|----|------|
| URL | `https://{bot域名}{route.path}`，如 `https://bot.example.com/webhook/gitee/pr-doc` |
| 密码 | 与对应 route 的 `secret` 一致 |
| 钩子 | 按任务选择，常见为 **Pull Request** |

### 6.2 Bot 侧路由配置（示意）

```yaml
server:
  port: 8787
  publicBaseUrl: https://bot.example.com

routes:
  - name: pr-doc
    path: /webhook/gitee/pr-doc
    secret: ${GITEE_WEBHOOK_SECRET_PR_DOC}
    provider: gitee
    events:
      - pull_request
    rules:
      actions: [open, update, reopen]
      targetBranches: [master, main]
      ignoreSenders: [cuecast-doc-bot]
    job:
      repo: org/cc-auto-test
      git:
        branchFrom: pr.sourceBranch
        baseFrom: pr.targetBranch
      strategy:
        type: llm
        # ... 见 5.4
      commit:
        message: "docs: sync for PR #{{pr.number}} [bot:pr-doc]"
        author:
          name: CueCast Doc Bot
          email: bot@example.com
      guard:
        idempotency: pr.headSha
        skipIfLastCommitMatches: "\\[bot:pr-doc\\]"
      notify:
        prComment: true

  - name: codegen
    path: /webhook/gitee/codegen
    secret: ${GITEE_WEBHOOK_SECRET_CODEGEN}
    provider: gitee
    events:
      - pull_request
    rules:
      actions: [open, update]
      sourceBranchPrefix: [feat/]
    job:
      repo: org/other-repo
      strategy:
        type: shell
        command: npm run bot:codegen
      commit:
        message: "chore: codegen [bot:codegen]"
```

---

## 7. Git Engine

### 7.1 工作区

- 每个 `owner/repo` 一个持久目录：`{workspaceRoot}/{owner}/{repo}/`
- 首次 clone，之后 `fetch` + `checkout` + `reset --hard`

### 7.2 认证

- HTTPS + PAT：`https://oauth2:{token}@gitee.com/{owner}/{repo}.git`
- Token 按仓库或全局配置，来自环境变量，不进 Git

### 7.3 Commit / Push 规则

| 项 | 说明 |
|----|------|
| 变更检测 | 策略返回 `no_change` 或工作区无 diff → 不 commit |
| 提交信息 | 支持模板变量 `{{pr.number}}`、`{{route}}`、`{{headSha}}` |
| 标记 | commit message 含 `[bot:{route}]`，供防循环使用 |
| push 目标 | 默认 PR 源分支；可配置为固定分支 |

---

## 8. 防护机制（Guard）

| 机制 | 说明 |
|------|------|
| **验签** | `X-Gitee-Token` 与 route secret 比对 |
| **发送者黑名单** | 忽略 bot 账号触发的 Webhook |
| **Commit 标记** | 最新 commit 已含 `[bot:{route}]` 则 skip |
| **幂等** | `(route, repo, prNumber, headSha)` 已成功处理则 skip |
| **并发锁** | 同一 `(repo, prNumber)` 同时只跑一个 job |
| **路径白名单** | 策略只能改 `allowedPaths` 内文件 |
| **超时** | 策略执行超时则 fail，不 push |
| **Debounce** | 可选：同 PR N 秒内多次事件只保留最新 headSha |

---

## 9. 状态存储与可观测性

### 9.1 最小数据模型

```text
jobs
  trace_id, route, repo, pr_number, head_sha,
  status, strategy_type, commit_sha, reason,
  created_at, started_at, finished_at

route_stats (可选)
  route, date, success, skipped, failed
```

存储：单机 **SQLite** 即可；多实例时再换 Redis + PostgreSQL。

### 9.2 日志

每条 job 带 `traceId`，日志字段建议：

- route、repo、pr、headSha、strategy、duration、result

### 9.3 对外反馈

| 方式 | 说明 |
|------|------|
| PR 评论 | 成功 / 跳过 / 失败原因 + traceId |
| Webhook 回调 | 任务结束后 POST 到你指定的 notify URL |
| 告警 | 连续失败 N 次 → 企业微信 / 邮件 |

### 9.4 HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/webhook/gitee/{routeName}` | Gitee 回调（path 与配置一致） |
| GET | `/healthz` | 健康检查 |
| GET | `/jobs/{traceId}` | 可选，查询任务状态（建议内网或鉴权） |

---

## 10. 部署建议

### 10.1 目录结构（实现阶段参考）

```text
bot/
├── config/
│   ├── bot.yaml              # 路由 + job + guard 总配置
│   └── routes.d/             # 可选：按文件拆分路由
├── prompts/                  # LLM 策略的 prompt（你维护）
├── scripts/                  # Shell 策略脚本（你维护）
├── plugins/                  # 自定义策略扩展
├── src/
│   ├── gateway/
│   ├── worker/
│   ├── git/
│   ├── strategy/
│   └── store/
└── deploy/
    ├── systemd/
    └── nginx/
```

### 10.2 运行时依赖

| 依赖 | 用途 |
|------|------|
| Node.js 20+ 或 Python 3.10+ | Bot 进程 |
| Git | 拉取与推送 |
| Nginx + HTTPS | 公网入口 |
| SQLite | 任务状态 |
| systemd / pm2 | 进程守护 |

### 10.3 环境变量（示例）

```bash
# 服务
PORT=8787
BOT_CONFIG=/etc/cuecast-bot/bot.yaml
WORKSPACE_ROOT=/var/lib/cuecast-bot/repos
STATE_DB=/var/lib/cuecast-bot/state.db

# Git（可按仓库覆盖）
GITEE_TOKEN_DEFAULT=...

# 策略用（按 route 引用 apiKeyEnv）
DEEPSEEK_API_KEY=...
INTERNAL_TOKEN=...
```

---

## 11. 安全要求

1. 所有 Webhook **必须 HTTPS**；secret 足够长且按 route 隔离。
2. Token / API Key **仅环境变量**，不进仓库、不进日志。
3. 策略 **路径白名单** 强制生效；禁止写 `.git/`、`.env` 等敏感路径。
4. LLM 输出必须 **JSON 校验** 后再落盘；解析失败不 push。
5. 管理接口（查 job）不对公网裸奔，或加 IP / Token 鉴权。
6. 日志中对 diff、token 做脱敏。

---

## 12. 在本仓库中的用法示例（非 Bot 内置逻辑）

若用此 Bot 维护 CueCast 的 PRD 与更新日志，**只是其中一个 route 配置**，不是 Bot 的硬编码行为：

| 项 | 你的定义 |
|----|----------|
| Route | `/webhook/gitee/pr-doc` |
| 触发 | PR → `master` / `main`，action 为 open/update |
| 策略 | `llm` + `systemPromptFile` 指向 `skill/cc-prd-changelog/SKILL.md` |
| 允许修改 | `PRD.md`、`docs-site/changelog.md` |
| Commit | `docs: sync for PR #{{pr.number}} [bot:pr-doc]` |

换项目、换脚本、换 Prompt，**只改配置与策略文件**，无需改 Bot 核心。

---

## 13. 分阶段落地

| 阶段 | 内容 | 验收标准 |
|------|------|----------|
| **P0** | Gateway + 单 route + shell 策略 + git push | Webhook 触发后能 push 空脚本产生的变更 |
| **P1** | 多 route、guard 全套、SQLite、PR 评论 | Bot 自 push 不循环；幂等生效 |
| **P2** | llm / http 策略、prompt 模板、路径白名单 | DeepSeek 按配置改指定文件并 push |
| **P3** | 多仓库、notify 回调、简单管理页 | 一套 Bot 服务多个仓库 |

---

## 14. 非目标（刻意不做）

- 不做 Gitee PR 自动合并
- 不做通用 CI 构建（编译、测试、部署）
- 不在 Bot 内写死「必须更新 PRD/changelog」
- 不替代 Code Review；Bot 产出必须经人工 review

---

## 15. 待确认项（实现前）

1. Bot 进程语言偏好：Node.js / Python  
2. 配置格式：YAML / JSON  
3. 是否需要多实例 + Redis 队列（单机可先内存队列）  
4. 首个 route 名称与 Gitee 仓库列表  
5. 首选策略类型：shell / llm / http  

确认后可按 **P0 → P1 → P2** 在仓库 `bot/` 目录实现。
