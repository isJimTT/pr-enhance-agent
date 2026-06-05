import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { BotConfig } from "../config.js";
import { verifyGiteeSignature } from "./signature.js";
import { matchRouteRules } from "../guard/index.js";
import { enqueue } from "../worker/index.js";
import { getJobByTraceId } from "../store/jobs.js";
import { jobsApi } from "../api/jobs.js";
import { routesApi } from "../api/routes.js";
import { configApi } from "../api/config.js";
import { promptsApi } from "../api/prompts.js";
import { getLogger } from "../logger.js";

const log = getLogger("gateway");

function findAdminHtml(): string {
  // Try multiple paths: dev (tsx from src/gateway), prod (node from dist/gateway), and CWD-based
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(__dirname, "../admin/index.html"),        // dev: src/gateway → src/admin
    resolve(__dirname, "../../src/admin/index.html"),  // prod: dist/gateway → src/admin
    resolve(process.cwd(), "src/admin/index.html"),    // CWD-based
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error("Admin HTML not found in any of: " + candidates.join(", "));
}

function getAdminHtml(): string {
  return findAdminHtml();
}

export function createApp(config: BotConfig): Hono {
  const app = new Hono();

  // --- Admin Panel ---
  app.get("/admin", (c) => c.html(getAdminHtml()));
  app.get("/", (c) => c.redirect("/admin"));

  // --- Public API ---
  app.get("/healthz", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

  app.get("/jobs/:traceId", async (c) => {
    const traceId = c.req.param("traceId");
    const job = await getJobByTraceId(traceId);
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json(job);
  });

  // --- Admin API ---
  app.route("/api/jobs", jobsApi);
  app.route("/api/routes", routesApi);
  app.route("/api/config", configApi);
  app.route("/api/prompts", promptsApi);

  // --- Webhook routes ---
  for (const route of config.routes) {
    log.info({ path: route.path, name: route.name }, "Registering webhook route");

    app.post(route.path, async (c) => {
      const rawBody = await c.req.text();
      const signature = c.req.header("X-Gitee-Token");

      if (!verifyGiteeSignature(rawBody, signature, route.secret)) {
        log.warn({ path: route.path }, "Signature verification failed");
        return c.json({ error: "Invalid signature" }, 401);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      const prPayload = payload as {
        action?: string;
        hook_id?: number;
        sender?: { login?: string };
        pull_request?: {
          number?: number;
          title?: string;
          body?: string;
          head?: { ref?: string; sha?: string };
          base?: { ref?: string };
          html_url?: string;
        };
        repository?: { full_name?: string };
      };

      // Handle Gitee test ping event
      if (prPayload.hook_id && !prPayload.pull_request) {
        log.info({ path: route.path }, "Test ping received");
        return c.json({ status: "ok", message: "Webhook configured correctly" });
      }

      if (!prPayload.action || !prPayload.pull_request || !prPayload.repository) {
        log.warn({ path: route.path, payloadKeys: Object.keys(prPayload) }, "Invalid webhook payload");
        return c.json({ error: `Invalid webhook payload: missing ${!prPayload.action ? 'action' : !prPayload.pull_request ? 'pull_request' : 'repository'}` }, 400);
      }

      const action = prPayload.action;
      const sender = prPayload.sender?.login ?? "unknown";
      const targetBranch = prPayload.pull_request?.base?.ref ?? "";
      const sourceBranch = prPayload.pull_request?.head?.ref ?? "";

      const ruleMatch = matchRouteRules(
        { action, targetBranch, sourceBranch, sender },
        route.rules,
      );

      if (!ruleMatch.matched) {
        log.info(
          { route: route.name, action, targetBranch, reason: ruleMatch.reason },
          "Event filtered by rules",
        );
        return c.json({ status: "ignored", reason: ruleMatch.reason });
      }

      const traceId = enqueue(route.name, payload as import("../worker/types.js").WebhookPayload);

      log.info(
        { route: route.name, traceId, pr: prPayload.pull_request?.number, action },
        "Webhook accepted, job enqueued",
      );

      return c.json({ status: "accepted", traceId });
    });
  }

  return app;
}
