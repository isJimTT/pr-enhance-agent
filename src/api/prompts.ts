import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getConfig } from "../config.js";

export const promptsApi = new Hono();

// GET /api/prompts/:routeName - read prompt files
promptsApi.get("/:routeName", (c) => {
  const name = c.req.param("routeName");
  const config = getConfig();
  const route = config.routes.find((r) => r.name === name);
  if (!route) return c.json({ error: "Route not found" }, 404);

  if (route.job.strategy.type !== "llm") {
    return c.json({ error: "Route strategy is not LLM" }, 400);
  }

  const result: { systemPrompt?: string; userPrompt?: string; systemPromptFile?: string; userPromptTemplate?: string } = {};

  result.systemPromptFile = route.job.strategy.systemPromptFile;
  result.userPromptTemplate = route.job.strategy.userPromptTemplate;

  try {
    result.systemPrompt = readFileSync(route.job.strategy.systemPromptFile, "utf-8");
  } catch {
    result.systemPrompt = "";
  }
  try {
    result.userPrompt = readFileSync(route.job.strategy.userPromptTemplate, "utf-8");
  } catch {
    result.userPrompt = "";
  }

  return c.json(result);
});

// PUT /api/prompts/:routeName - write prompt files
promptsApi.put("/:routeName", async (c) => {
  const name = c.req.param("routeName");
  const config = getConfig();
  const route = config.routes.find((r) => r.name === name);
  if (!route) return c.json({ error: "Route not found" }, 404);

  if (route.job.strategy.type !== "llm") {
    return c.json({ error: "Route strategy is not LLM" }, 400);
  }

  const body = await c.req.json<{ systemPrompt?: string; userPrompt?: string }>();

  if (body.systemPrompt !== undefined) {
    writeFileSync(route.job.strategy.systemPromptFile, body.systemPrompt, "utf-8");
  }
  if (body.userPrompt !== undefined) {
    writeFileSync(route.job.strategy.userPromptTemplate, body.userPrompt, "utf-8");
  }

  return c.json({ status: "saved" });
});
