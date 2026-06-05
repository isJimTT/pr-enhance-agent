import type { HttpStrategyConfig } from "../config.js";
import type { StrategyContext, StrategyResult } from "./types.js";

export async function executeHttpStrategy(
  config: HttpStrategyConfig,
  ctx: StrategyContext,
): Promise<StrategyResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutSec * 1000);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    // Resolve env vars in headers
    for (const [key, value] of Object.entries(headers)) {
      headers[key] = value.replace(/\$\{(\w+)\}/g, (_, name) => {
        return process.env[name] ?? `\${${name}}`;
      });
    }

    const response = await fetch(config.url, {
      method: config.method,
      headers,
      body: JSON.stringify(ctx),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        action: "error",
        reason: `HTTP strategy returned ${response.status}: ${response.statusText}`,
      };
    }

    const result = (await response.json()) as StrategyResult;

    if (!["update", "no_change", "error"].includes(result.action)) {
      return {
        action: "error",
        reason: `HTTP strategy returned invalid action: ${(result as { action: string }).action}`,
      };
    }

    return result;
  } catch (err: unknown) {
    const error = err as { message?: string; name?: string };
    if (error.name === "AbortError") {
      return {
        action: "error",
        reason: `HTTP strategy timed out after ${config.timeoutSec}s`,
      };
    }
    return {
      action: "error",
      reason: `HTTP strategy failed: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
