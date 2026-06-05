import { Hono } from "hono";
import { getConfig } from "../config.js";

export const configApi = new Hono();

// GET /api/config - get full server config (no route secrets)
configApi.get("/", (c) => {
  const config = getConfig();
  return c.json({
    server: config.server,
    workspace: config.workspace,
  });
});

// GET /api/config/env - list relevant env vars (masked)
configApi.get("/env", (c) => {
  const envVars = [
    "PORT",
    "BOT_CONFIG",
    "WORKSPACE_ROOT",
    "DATABASE_URL",
    "GITEE_TOKEN",
    "GITEE_WEBHOOK_SECRET",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "GITEE_REPO",
  ];

  const info = envVars.map((name) => ({
    name,
    set: !!process.env[name],
    preview: process.env[name]
      ? process.env[name]!.length > 12
        ? process.env[name]!.slice(0, 6) + "..." + process.env[name]!.slice(-4)
        : "***"
      : null,
  }));

  return c.json(info);
});
