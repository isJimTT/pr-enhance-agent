import "dotenv/config";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { initStore } from "./store/index.js";
import { createApp } from "./gateway/index.js";
import { startWorker } from "./worker/index.js";
import { getLogger } from "./logger.js";

const log = getLogger("main");

async function main() {
  log.info("Starting PR Enhance Agent...");

  // Load configuration
  const config = loadConfig();

  // Apply env var overrides
  if (process.env.PORT) config.server.port = parseInt(process.env.PORT, 10);
  if (process.env.WORKSPACE_ROOT) config.workspace.root = process.env.WORKSPACE_ROOT;

  log.info(
    { routes: config.routes.length, workspace: config.workspace.root },
    "Configuration loaded",
  );

  // Initialize store
  initStore();
  log.info("Store initialized");

  // Create HTTP app
  const app = createApp(config);

  // Start worker in background
  startWorker(config).catch((err) => {
    log.error({ err }, "Worker crashed");
    process.exit(1);
  });

  // Start HTTP server
  const port = config.server.port;
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      log.info({ port: info.port }, "Server listening");
      for (const route of config.routes) {
        log.info(
          `  POST http://localhost:${info.port}${route.path} → ${route.name}`,
        );
      }
    },
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
