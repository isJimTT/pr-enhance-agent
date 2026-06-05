import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ShellStrategyConfig } from "../config.js";
import type { StrategyContext, StrategyResult } from "./types.js";

export async function executeShellStrategy(
  config: ShellStrategyConfig,
  ctx: StrategyContext,
): Promise<StrategyResult> {
  const contextJsonPath = join(ctx.repo.workspaceDir, ".bot-context.json");
  writeFileSync(contextJsonPath, JSON.stringify(ctx, null, 2), "utf-8");

  try {
    const env = {
      ...process.env,
      ...config.env,
      BOT_CONTEXT_FILE: contextJsonPath,
      BOT_WORKSPACE: ctx.repo.workspaceDir,
      BOT_TRACE_ID: ctx.traceId,
      BOT_ROUTE: ctx.route,
      BOT_PR_NUMBER: String(ctx.event.pr.number),
      BOT_PR_TITLE: ctx.event.pr.title,
      BOT_DIFF_PATH: ctx.git.diffPath,
    };

    execSync(config.command, {
      cwd: ctx.repo.workspaceDir,
      env,
      timeout: config.timeoutSec * 1000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    // After script runs, check if it produced any file changes
    // The script is expected to modify files in-place in the workspace
    // We'll detect changes via git status in the worker, so return update with
    // an empty files array (the worker will detect changes via git status)
    return {
      action: "update",
      files: [], // Worker detects actual changes via git status
      message: "Shell strategy completed, checking for file changes",
    };
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    return {
      action: "error",
      reason: error.stderr ?? error.message ?? "Shell strategy failed",
    };
  } finally {
    try {
      unlinkSync(contextJsonPath);
    } catch {
      // ignore
    }
  }
}
