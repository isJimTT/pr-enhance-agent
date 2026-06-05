# PR Enhance Agent

一个可配置的 Gitee Webhook Bot，监听 PR 事件，调用 LLM 自动分析变更并更新文档，最后 commit + push 回源分支。

## 快速开始

### 1. 环境准备

```bash
cd pr-enhance-agent
cp .env.example .env
npm install
```

### 2. 配置 .env

```bash
# 服务端口
PORT=8787

# PostgreSQL 连接（必须）
DATABASE_URL=postgresql://user:password@localhost:5432/pr_enhance_agent

# Gitee 个人访问令牌（用于 clone/push）
# 获取：Gitee → 设置 → 私人令牌 → 生成新令牌 → 勾选 repo 权限
GITEE_TOKEN=your_personal_access_token

# Webhook 密码（自己设一个随机字符串）
GITEE_WEBHOOK_SECRET=your_random_secret

# 目标仓库（owner/repo 格式）
GITEE_REPO=your-org/your-repo

# DeepSeek API Key
DEEPSEEK_API_KEY=sk-your-deepseek-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

### 3. 启动

```bash
npm run dev
```

访问 `http://localhost:8787/admin` 进入管理后台。

## 关键配置

### .env — 连接信息

| 变量 | 说明 | 必填 |
|------|------|------|
| `GITEE_TOKEN` | Gitee 个人访问令牌，用于 git clone/push | 是 |
| `GITEE_WEBHOOK_SECRET` | Webhook 密码，与 Gitee 配置一致 | 是 |
| `GITEE_REPO` | 目标仓库，格式 `owner/repo` | 是 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 是（LLM 策略） |
| `DEEPSEEK_BASE_URL` | DeepSeek API 地址，默认 `https://api.deepseek.com` | 否 |
| `GITEE_HOST` | Gitee 地址，默认 `gitee.com`（企业版需修改） | 否 |

### bot.yaml — 路由和策略

核心配置文件，也可以在 Admin 面板直接编辑。一个路由对应一个 Webhook 端点 + 一个任务。

```yaml
routes:
  - name: pr-doc                    # 路由名称（唯一）
    path: /webhook/gitee/pr-doc     # Webhook URL 路径
    secret: ${GITEE_WEBHOOK_SECRET} # 密码，引用 .env 变量
    provider: gitee                 # 平台：gitee / github
    events:
      - pull_request                # 监听 PR 事件
    rules:
      actions: [open, update]       # 触发动作：PR 新建/更新
      targetBranches: [master, main] # 目标分支过滤
      ignoreSenders: [bot-username]  # 忽略的发送者
    job:
      repo: your-org/your-repo      # 目标仓库
      strategy:
        type: llm                   # 策略类型：llm / shell / http
        model: deepseek-chat        # LLM 模型
        systemPromptFile: ./prompts/pr-doc-system.md  # 系统提示词
        userPromptTemplate: ./prompts/pr-doc-user.tpl # 用户提示词模板
        workspaceSkillFile: skill/cc-prd-changelog/SKILL.md  # 仓库内 Skill 文件（可选）
        allowedPaths:               # 允许修改的文件白名单
          - PRD.md
          - docs-site/changelog.md
      commit:
        message: '[bot] docs: update for PR #{{pr.number}} [bot:pr-doc]'
        author:
          name: PR Enhance Bot
          email: bot@example.com
      guard:
        skipIfLastCommitMatches: "bot:pr-doc"  # 防循环：跳过含此标记的 commit
      notify:
        prComment: true             # 是否在 PR 下评论通知
```

### 提示词文件 — 告诉 AI 做什么

| 文件 | 作用 |
|------|------|
| `prompts/pr-doc-system.md` | 系统提示词，定义 AI 角色和工作流 |
| `prompts/pr-doc-user.tpl` | 用户提示词模板，包含 PR 元信息。支持变量：`{{prTitle}}` `{{prBody}}` `{{prNumber}}` `{{diff}}` `{{changedFiles}}` `{{sourceBranch}}` `{{targetBranch}}` |

### Skill 文件 — 项目特定规范

放在目标仓库中（如 `skill/cc-prd-changelog/SKILL.md`），Bot clone 代码后会自动读取并拼接到系统提示词。适合定义：
- 文档格式规范（标题层级、列表格式）
- 章节结构说明
- 更新规则（新条目放顶部、已有条目合并等）

## 触发规则

### Gitee Webhook 配置

```
仓库 → 管理 → WebHooks → 添加
  URL:   https://your-domain/webhook/gitee/pr-doc
  密码:   与 .env 中 GITEE_WEBHOOK_SECRET 一致
  事件:   勾选 Pull Request
```

### 触发条件

Bot 收到 Webhook 后会按以下条件过滤：

| 过滤项 | 配置字段 | 说明 |
|--------|----------|------|
| 动作 | `rules.actions` | 如 `[open, update]`，只有 PR 新建和更新时触发 |
| 目标分支 | `rules.targetBranches` | 如 `[master, main]`，只处理合并到这些分支的 PR |
| 源分支前缀 | `rules.sourceBranchPrefix` | 如 `[feat/]`，只处理特定前缀的源分支 |
| 发送者 | `rules.ignoreSenders` | 忽略特定用户触发的 Webhook |

### 防循环机制

Bot push 后会触发新的 Webhook，防止死循环：

1. **Commit 标记**：Bot 的每次提交都含 `[bot:pr-doc]` 标记，下次触发时检查最新 commit，包含标记则跳过
2. **Author 检查**：最新 commit 的作者是 Bot 则跳过

## 本地调试

### 内网穿透

```bash
# 终端 1：启动 Bot
npm run dev

# 终端 2：启动 ngrok
ngrok http 8787
```

将 ngrok 输出的 `https://xxx.ngrok-free.dev` 作为 Gitee Webhook URL 前缀。

### 手动触发测试

```bash
curl -X POST http://localhost:8787/webhook/gitee/pr-doc \
  -H "Content-Type: application/json" \
  -H "X-Gitee-Token: your_webhook_secret" \
  -d '{
    "action": "open",
    "sender": {"login": "your-username"},
    "pull_request": {
      "number": 1,
      "title": "feat: add new feature",
      "body": "PR description here",
      "head": {"ref": "feat/your-branch", "sha": "real-commit-sha"},
      "base": {"ref": "master"},
      "html_url": "https://gitee.com/your-org/your-repo/pulls/1"
    },
    "repository": {"full_name": "your-org/your-repo"}
  }'
```

## 策略类型

| 类型 | 适用场景 | 需提供 |
|------|----------|--------|
| `llm` | AI 分析 diff 并修改文档 | Prompt 文件 + API Key |
| `shell` | 确定性脚本（格式化、codegen） | 脚本路径 + 参数 |
| `http` | 已有内部服务处理 | Handler URL + 鉴权 |

## 执行流程

```
Gitee Webhook 事件
  → Gateway：验签 + 规则匹配
  → Worker：入队 + 幂等检查
  → Git Engine：clone → fetch → checkout → 生成 diff
  → LLM Agent：提供 get_diff / read_file 工具，模型自行拉取所需数据
  → 输出 patch（标题 + 新内容）
  → Agent 合并 patch 到文件
  → commit + push（只暂存修改的文件）
  → PR 评论通知
```

## Admin 管理后台

访问 `http://localhost:8787/admin`：

| 页面 | 功能 |
|------|------|
| 仪表盘 | 统计概览、最近任务 |
| 路由配置 | 新建/编辑/删除路由，在线编辑 Prompt |
| 任务记录 | 查看 Job 历史、状态、耗时、详情 |
| 系统设置 | 服务器配置、环境变量状态检查 |

所有路由配置修改即时生效，无需重启。

## 目录结构

```
├── config/bot.yaml          # 路由 + 任务总配置
├── prompts/                 # LLM 提示词
│   ├── pr-doc-system.md
│   └── pr-doc-user.tpl
├── src/
│   ├── index.ts             # 入口
│   ├── config.ts            # 配置加载与校验
│   ├── gateway/             # HTTP 服务 + Webhook 处理
│   ├── worker/              # 任务队列 + 执行管线
│   ├── git/                 # Git 操作封装
│   ├── strategy/            # 策略插件（llm/shell/http）
│   ├── guard/               # 防护机制（验签/幂等/防循环/白名单）
│   ├── store/               # PostgreSQL 状态存储
│   ├── notify/              # PR 评论通知
│   ├── api/                 # Admin API
│   └── admin/               # Admin 管理后台页面
├── .env.example
└── package.json
```
