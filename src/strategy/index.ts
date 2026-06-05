import type { StrategyConfig } from "../config.js";
import type { StrategyContext, StrategyResult } from "./types.js";
import { executeShellStrategy } from "./shell.js";
import { executeHttpStrategy } from "./http.js";
import { executeLlmStrategy } from "./llm.js";

export type { StrategyContext, StrategyResult } from "./types.js";

export async function executeStrategy(
  config: StrategyConfig,
  ctx: StrategyContext,
): Promise<StrategyResult> {
  switch (config.type) {
    case "shell":
      return await executeShellStrategy(config, ctx);
    case "http":
      return await executeHttpStrategy(config, ctx);
    case "llm":
      return await executeLlmStrategy(config, ctx);
    default:
      return {
        action: "error",
        reason: `Unknown strategy type: ${(config as { type: string }).type}`,
      };
  }
}
