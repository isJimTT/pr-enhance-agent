import type { RouteConfig } from "../config.js";
import type { WebhookPayload } from "../worker/types.js";
import type { StrategyResult } from "../strategy/types.js";
import { getLogger } from "../logger.js";

const log = getLogger("notify");

export async function notifyPrComment(
  route: RouteConfig,
  payload: WebhookPayload,
  traceId: string,
  result: StrategyResult,
): Promise<void> {
  if (!route.job.notify.prComment) return;

  const pr = payload.pull_request;
  const repo = payload.repository.full_name;
  const giteeHost = process.env.GITEE_HOST ?? "gitee.com";
  const commentUrl = `https://${giteeHost}/api/v5/repos/${repo}/pulls/${pr.number}/comments`;

  const token = process.env.GITEE_TOKEN;
  if (!token) {
    log.warn("GITEE_TOKEN not set, skipping PR comment");
    return;
  }

  let body: string;
  if (result.action === "patch") {
    const patchList = result.patches
      .map((p) => `- **${p.path}**: ${p.sections.map((s) => s.heading).join(", ")}`)
      .join("\n");
    body = [
      `## PR Enhance Bot - Patched`,
      "",
      result.message ?? "Sections updated",
      "",
      "**Patches:**",
      patchList,
      "",
      `> traceId: \`${traceId}\``,
      `> [bot:${route.name}]`,
    ].join("\n");
  } else if (result.action === "update") {
    const fileList = result.files.map((f) => `- \`${f.path}\``).join("\n");
    body = [
      `## PR Enhance Bot - Updated`,
      "",
      result.message ?? "Files updated",
      "",
      "**Files modified:**",
      fileList || "(detected via git status)",
      "",
      `> traceId: \`${traceId}\``,
      `> [bot:${route.name}]`,
    ].join("\n");
  } else if (result.action === "no_change") {
    body = [
      `## PR Enhance Bot - Skipped`,
      "",
      result.reason,
      "",
      `> traceId: \`${traceId}\``,
      `> [bot:${route.name}]`,
    ].join("\n");
  } else {
    body = [
      `## PR Enhance Bot - Failed`,
      "",
      `**Error:** ${result.reason}`,
      "",
      `> traceId: \`${traceId}\``,
      `> [bot:${route.name}]`,
    ].join("\n");
  }

  try {
    const response = await fetch(commentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ body }),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, traceId },
        "Failed to post PR comment",
      );
    } else {
      log.info({ traceId }, "PR comment posted");
    }
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, traceId }, `Failed to post PR comment: ${error.message}`);
  }
}
