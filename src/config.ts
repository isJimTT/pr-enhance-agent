import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

// --- Zod schemas ---

const serverSchema = z.object({
  port: z.number().default(8787),
  publicBaseUrl: z.string().optional(),
});

const workspaceSchema = z.object({
  root: z.string().default("./workspace"),
});

const strategyShellSchema = z.object({
  type: z.literal("shell"),
  command: z.string(),
  timeoutSec: z.number().default(300),
  allowedPaths: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const strategyHttpSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT"]).default("POST"),
  headers: z.record(z.string()).optional(),
  timeoutSec: z.number().default(120),
  allowedPaths: z.array(z.string()).optional(),
});

const strategyLlmSchema = z.object({
  type: z.literal("llm"),
  provider: z.string().default("deepseek"),
  model: z.string().default("deepseek-chat"),
  apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
  baseUrlEnv: z.string().default("DEEPSEEK_BASE_URL"),
  systemPromptFile: z.string(),
  userPromptTemplate: z.string(),
  workspaceSkillFile: z.string().optional(),
  outputFormat: z.enum(["json", "text"]).default("json"),
  temperature: z.number().default(0.3),
  maxTokens: z.number().default(4096),
  timeoutSec: z.number().default(300),
  allowedPaths: z.array(z.string()).default(["CHANGELOG.md"]),
  excludeDiffPatterns: z.array(z.string()).default([
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/*.lock",
  ]),
});

const strategySchema = z.discriminatedUnion("type", [
  strategyShellSchema,
  strategyHttpSchema,
  strategyLlmSchema,
]);

const commitSchema = z.object({
  message: z.string(),
  author: z.object({
    name: z.string(),
    email: z.string(),
  }),
  allowEmpty: z.boolean().default(false),
});

const guardSchema = z.object({
  idempotency: z.string().default("pr.headSha"),
  skipIfLastCommitMatches: z.string().optional(),
  debounceMs: z.number().default(0),
});

const notifySchema = z.object({
  prComment: z.boolean().default(false),
  webhookUrl: z.string().optional(),
});

const jobSchema = z.object({
  repo: z.string(),
  git: z.object({
    branchFrom: z.string(),
    baseFrom: z.string(),
  }),
  strategy: strategySchema,
  commit: commitSchema,
  guard: guardSchema,
  notify: notifySchema,
});

const routeSchema = z.object({
  name: z.string(),
  path: z.string(),
  secret: z.string(),
  provider: z.enum(["gitee", "github"]),
  events: z.array(z.string()),
  rules: z.object({
    actions: z.array(z.string()).optional(),
    targetBranches: z.array(z.string()).optional(),
    sourceBranchPrefix: z.array(z.string()).optional(),
    ignoreSenders: z.array(z.string()).optional(),
  }),
  job: jobSchema,
});

const botConfigSchema = z.object({
  server: serverSchema.default({}),
  workspace: workspaceSchema.default({}),
  routes: z.array(routeSchema),
});

// --- Types ---

export type ServerConfig = z.infer<typeof serverSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export type ShellStrategyConfig = z.infer<typeof strategyShellSchema>;
export type HttpStrategyConfig = z.infer<typeof strategyHttpSchema>;
export type LlmStrategyConfig = z.infer<typeof strategyLlmSchema>;
export type StrategyConfig = z.infer<typeof strategySchema>;
export type CommitConfig = z.infer<typeof commitSchema>;
export type GuardConfig = z.infer<typeof guardSchema>;
export type NotifyConfig = z.infer<typeof notifySchema>;
export type JobConfig = z.infer<typeof jobSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
export type BotConfig = z.infer<typeof botConfigSchema>;

// --- ENV var resolver ---

function resolveEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => {
      const envVal = process.env[name];
      if (envVal === undefined) {
        console.warn(`[config] Environment variable not set: ${name}`);
        return `\${${name}}`;
      }
      return envVal;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

// --- Config loader ---

let _config: BotConfig | null = null;

export function loadConfig(configPath?: string): BotConfig {
  if (_config) return _config;

  const path = configPath ?? process.env.BOT_CONFIG ?? "./config/bot.yaml";
  const raw = readFileSync(path, "utf-8");

  // Parse YAML
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid bot.yaml: must be a YAML object");
  }

  // Resolve env vars
  const resolved = resolveEnvVars(parsed);

  // Validate
  const result = botConfigSchema.safeParse(resolved);
  if (!result.success) {
    console.error("[config] Validation errors:", result.error.format());
    throw new Error(`Invalid bot.yaml: ${result.error.message}`);
  }

  // Resolve workspace/state paths relative to CWD
  const cwd = process.cwd();
  const config = result.data;

  // Make workspace.root absolute if relative
  if (!config.workspace.root.startsWith("/")) {
    config.workspace.root = resolve(cwd, config.workspace.root);
  }
  // Resolve prompt file paths relative to CWD (project root), not config directory
  const configDir = cwd;
  for (const route of config.routes) {
    if (route.job.strategy.type === "llm") {
      if (!route.job.strategy.systemPromptFile.startsWith("/")) {
        route.job.strategy.systemPromptFile = resolve(
          configDir,
          route.job.strategy.systemPromptFile,
        );
      }
      if (!route.job.strategy.userPromptTemplate.startsWith("/")) {
        route.job.strategy.userPromptTemplate = resolve(
          configDir,
          route.job.strategy.userPromptTemplate,
        );
      }
    }
  }

  _config = config;
  return config;
}

export function getConfig(): BotConfig {
  if (!_config) {
    return loadConfig();
  }
  return _config;
}
