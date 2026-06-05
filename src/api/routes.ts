import { Hono } from "hono";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { getConfig, loadConfig } from "../config.js";
import type { RouteConfig } from "../config.js";

function getConfigPath(): string {
  return resolve(process.env.BOT_CONFIG ?? "./config/bot.yaml");
}

function readConfigFile(): { config: ReturnType<typeof getConfig>; raw: unknown } {
  const path = getConfigPath();
  const raw = yaml.load(readFileSync(path, "utf-8"));
  const config = getConfig();
  return { config, raw };
}

function writeConfigFile(routes: unknown[]): void {
  const path = getConfigPath();
  const raw = yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>;
  raw.routes = routes;
  writeFileSync(path, yaml.dump(raw, { lineWidth: -1, noRefs: true }), "utf-8");
  // Invalidate cached config so next load picks up changes
  loadConfig(path);
}

export const routesApi = new Hono();

// GET /api/routes - list all routes (without secrets)
routesApi.get("/", (c) => {
  const { config } = readConfigFile();
  const sanitized = config.routes.map((r) => ({
    ...r,
    secret: "***",
  }));
  return c.json(sanitized);
});

// GET /api/routes/:name - get one route
routesApi.get("/:name", (c) => {
  const { config } = readConfigFile();
  const route = config.routes.find((r) => r.name === c.req.param("name"));
  if (!route) return c.json({ error: "Route not found" }, 404);
  return c.json({ ...route, secret: "***" });
});

// POST /api/routes - create a new route
routesApi.post("/", async (c) => {
  const body = await c.req.json<RouteConfig>();
  const { config, raw } = readConfigFile();
  const existingRoutes = (raw as Record<string, unknown>).routes as unknown[] ?? [];

  if (config.routes.some((r) => r.name === body.name)) {
    return c.json({ error: "Route name already exists" }, 409);
  }

  if (!body.secret || body.secret === "***") {
    return c.json({ error: "Secret is required (received masked placeholder)" }, 400);
  }

  existingRoutes.push(body);
  writeConfigFile(existingRoutes);
  return c.json({ status: "created", name: body.name }, 201);
});

// PUT /api/routes/:name - update a route
routesApi.put("/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<RouteConfig>();
  const { raw } = readConfigFile();
  const routes = (raw as Record<string, unknown>).routes as unknown[] ?? [];

  const idx = routes.findIndex(
    (r: unknown) => (r as { name: string }).name === name,
  );
  if (idx === -1) return c.json({ error: "Route not found" }, 404);

  // If secret is masked placeholder, keep the existing secret
  if (body.secret === "***") {
    body.secret = (routes[idx] as { secret: string }).secret;
  }

  routes[idx] = body;
  writeConfigFile(routes);
  return c.json({ status: "updated", name: body.name });
});

// DELETE /api/routes/:name - delete a route
routesApi.delete("/:name", (c) => {
  const name = c.req.param("name");
  const { raw } = readConfigFile();
  const routes = (raw as Record<string, unknown>).routes as unknown[] ?? [];

  const idx = routes.findIndex(
    (r: unknown) => (r as { name: string }).name === name,
  );
  if (idx === -1) return c.json({ error: "Route not found" }, 404);

  routes.splice(idx, 1);
  writeConfigFile(routes);
  return c.json({ status: "deleted" });
});

// GET /api/routes/:name/schema - return the JSON schema for route editing
routesApi.get("/schema/form", (c) => {
  return c.json({
    strategyTypes: ["shell", "http", "llm"],
    providers: ["gitee", "github"],
    events: ["pull_request", "push"],
    fields: {
      name: { type: "string", required: true, desc: "Unique route name" },
      path: { type: "string", required: true, desc: "Webhook URL path, e.g. /webhook/gitee/pr-doc" },
      secret: { type: "string", required: true, desc: "Webhook secret or ${ENV_VAR}" },
      provider: { type: "enum", values: ["gitee", "github"] },
      events: { type: "array", desc: "Event types to listen for" },
      "rules.actions": { type: "array", desc: "PR actions: open, update, close, merge" },
      "rules.targetBranches": { type: "array", desc: "Target branch filter" },
      "rules.ignoreSenders": { type: "array", desc: "Usernames to ignore" },
      "job.repo": { type: "string", required: true, desc: "Repository: owner/name" },
      "job.strategy.type": { type: "enum", values: ["shell", "http", "llm"] },
      "job.commit.message": { type: "string", desc: "Commit message template" },
      "job.guard.skipIfLastCommitMatches": { type: "string", desc: "Regex to skip if already committed" },
    },
  });
});
