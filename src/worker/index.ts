import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { BotConfig, RouteConfig, LlmStrategyConfig } from "../config.js";
import type { WebhookPayload, JobItem } from "./types.js";
import type { StrategyContext, StrategyResult } from "../strategy/types.js";
import { GitEngine } from "../git/index.js";
import { executeStrategy } from "../strategy/index.js";
import { createJob, updateJobStatus } from "../store/jobs.js";
import {
  checkIdempotency,
  checkLastCommitMarker,
  filterAllowedPaths,
} from "../guard/index.js";
import { validateFile, isChangelogFile } from "../guard/validator.js";
import { correctLlmOutput } from "../strategy/llm.js";
import type { CorrectionIssue } from "../strategy/llm.js";
import { notifyPrComment } from "../notify/index.js";
import { getLogger } from "../logger.js";

const log = getLogger("worker");

const globalEmitter = new EventEmitter();
globalEmitter.setMaxListeners(100);

// In-memory queue
const queue: JobItem[] = [];

// Concurrency locks: key = "repo:prNumber"
const locks = new Map<string, Promise<void>>();

export function enqueue(routeName: string, payload: WebhookPayload): string {
  const traceId = randomUUID();
  const job: JobItem = {
    traceId,
    routeName,
    payload,
    createdAt: Date.now(),
  };
  queue.push(job);
  log.info({ traceId, routeName, pr: payload.pull_request?.number }, "Job enqueued");

  // Wake up worker
  globalEmitter.emit("job:enqueued");

  return traceId;
}

export async function startWorker(config: BotConfig): Promise<void> {
  log.info("Worker started, waiting for jobs...");

  for (;;) {
    // Wait for jobs
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        globalEmitter.once("job:enqueued", resolve);
      });
    }

    // Process all queued jobs
    while (queue.length > 0) {
      const job = queue.shift()!;
      // Fire-and-forget (with lock)
      processJob(job, config).catch((err) => {
        log.error({ err, traceId: job.traceId }, "Job processing failed");
      });
    }
  }
}

async function processJob(
  job: JobItem,
  config: BotConfig,
): Promise<void> {
  const { traceId, routeName, payload } = job;

  const route = config.routes.find((r) => r.name === routeName);
  if (!route) {
    log.error({ traceId, routeName }, "Route not found");
    return;
  }

  const pr = payload.pull_request;
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const repo = payload.repository?.full_name ?? "";
  if (!repo || !repo.includes("/")) {
    log.error({ traceId }, "Invalid repository name");
    return;
  }
  const [owner, repoName] = repo.split("/");

  // --- Guard: Idempotency ---
  const idempotencyField = route.job.guard.idempotency ?? "pr.headSha";
  if (idempotencyField === "pr.headSha") {
    const check = await checkIdempotency(route.name, repo, prNumber, headSha);
    if (check.alreadyProcessed) {
      log.info({ traceId, pr: prNumber }, `Skipping (idempotent): ${check.reason}`);
      await notifyPrComment(route, payload, traceId, {
        action: "no_change",
        reason: check.reason ?? "Idempotent skip",
      });
      return;
    }
  }

  // --- Concurrency lock ---
  const lockKey = `${repo}:${prNumber}`;
  if (locks.has(lockKey)) {
    log.info({ traceId, lockKey }, "Waiting for concurrent job to finish");
    await locks.get(lockKey);
  }

  // Create the actual lock
  let resolveLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  locks.set(lockKey, lockPromise);

  try {
    await executeJob(traceId, route, payload, config, owner, repoName);
  } finally {
    resolveLock!();
    locks.delete(lockKey);
  }
}

async function executeJob(
  traceId: string,
  route: RouteConfig,
  payload: WebhookPayload,
  config: BotConfig,
  owner: string,
  repoName: string,
): Promise<void> {
  const pr = payload.pull_request;
  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const repo = payload.repository.full_name;

  // Record job start
  await createJob({
    traceId,
    route: route.name,
    repo,
    prNumber,
    headSha,
    strategyType: route.job.strategy.type,
  });
  await updateJobStatus(traceId, "running");

  const logCtx = { traceId, route: route.name, repo, pr: prNumber };
  log.info(logCtx, "Starting job");

  // --- Git Engine ---
  const workspaceRoot = config.workspace.root;
  const workspaceDir = join(workspaceRoot, owner, repoName);
  mkdirSync(workspaceDir, { recursive: true });

  const token = process.env.GITEE_TOKEN;
  if (!token) {
    await updateJobStatus(traceId, "failed", {
      reason: "GITEE_TOKEN environment variable not set",
    });
    return;
  }

  const git = new GitEngine({
    owner,
    repo: repoName,
    workspaceDir,
    token,
    provider: "gitee",
    host: process.env.GITEE_HOST ?? undefined,
  });

  // Resolve branches first
  const sourceBranch = pr.head.ref;
  const targetBranch = pr.base.ref;

  try {
    await git.ensureRepo(sourceBranch, targetBranch);
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, ...logCtx }, "Git clone/fetch failed");
    await updateJobStatus(traceId, "failed", {
      reason: `Git clone/fetch failed: ${error.message}`,
    });
    return;
  }

  // Checkout source branch

  try {
    await git.checkout(sourceBranch);
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, ...logCtx }, "Git checkout failed");
    await updateJobStatus(traceId, "failed", {
      reason: `Git checkout failed: ${error.message}`,
    });
    return;
  }

  // --- Guard: Commit marker ---
  const commitMarker = route.job.guard.skipIfLastCommitMatches;
  if (commitMarker || true) {
    const markerCheck = await checkLastCommitMarker(
      git,
      commitMarker ?? "[bot:",
      route.job.commit.author,
    );
    if (markerCheck.shouldSkip) {
      log.info(logCtx, `Skipping (loop guard): ${markerCheck.reason}`);
      await updateJobStatus(traceId, "skipped", { reason: markerCheck.reason });
      return;
    }
  }

  // --- Generate diff ---
  const baseRef = `origin/${targetBranch}`;
  const headRef = "HEAD";
  let diff: string;
  let changedFiles: string[];

  try {
    diff = await git.getDiff(baseRef, headRef);
    changedFiles = await git.getChangedFiles(baseRef, headRef);
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, ...logCtx }, "Failed to generate diff");
    await updateJobStatus(traceId, "failed", {
      reason: `Failed to generate diff: ${error.message}`,
    });
    return;
  }

  if (diff.trim().length === 0) {
    log.info(logCtx, "No diff, skipping");
    await updateJobStatus(traceId, "skipped", { reason: "No diff found" });
    return;
  }

  // Write diff to file for reference
  const diffPath = join(workspaceDir, ".bot-diff.txt");
  writeFileSync(diffPath, diff, "utf-8");

  // --- Read current content of target files ---
  const allowedPaths =
    (route.job.strategy as LlmStrategyConfig).allowedPaths ?? [];
  const targetFiles: { path: string; currentContent: string }[] = [];
  for (const ap of allowedPaths) {
    try {
      const exactPath = join(workspaceDir, ap);
      const content = readFileSync(exactPath, "utf-8");
      targetFiles.push({ path: ap, currentContent: content });
    } catch {
      log.info({ path: ap }, "Target file not found, will be created if LLM outputs it");
    }
  }

  // --- Build strategy context ---
  const strategyContext: StrategyContext = {
    traceId,
    route: route.name,
    event: {
      provider: "gitee",
      action: payload.action,
      sender: payload.sender.login,
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        sourceBranch,
        targetBranch,
        headSha,
        url: pr.html_url,
      },
    },
    repo: {
      fullName: repo,
      workspaceDir,
    },
    git: {
      baseRef,
      headRef,
      diff,
      diffPath,
      changedFiles,
    },
    env: {
      JOB_ID: traceId,
      ROUTE_NAME: route.name,
    },
    targetFiles,
  };

  // --- Execute strategy ---
  let strategyResult: StrategyResult;
  try {
    strategyResult = await executeStrategy(route.job.strategy, strategyContext);
    log.info({ ...logCtx, result: strategyResult.action }, "Strategy completed");
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, ...logCtx }, "Strategy execution failed");
    await updateJobStatus(traceId, "failed", {
      reason: `Strategy execution failed: ${error.message}`,
    });
    return;
  }

  if (strategyResult.action === "error") {
    log.error({ ...logCtx, reason: strategyResult.reason }, "Strategy error");
    await updateJobStatus(traceId, "failed", { reason: strategyResult.reason });
    await notifyPrComment(route, payload, traceId, strategyResult);
    return;
  }

  if (strategyResult.action === "no_change") {
    log.info({ ...logCtx, reason: strategyResult.reason }, "No changes needed");
    await updateJobStatus(traceId, "skipped", { reason: strategyResult.reason });
    await notifyPrComment(route, payload, traceId, strategyResult);
    return;
  }

  // --- Handle patch action: merge + validate with correction retry ---
  let finalMessage = strategyResult.message;
  if (strategyResult.action === "patch") {
    let currentPatches = strategyResult.patches;
    let currentRawOutput = strategyResult.rawOutput;
    const MAX_CORRECTIONS = 2;
    let finalFiles: { path: string; content: string }[] | null = null;

    for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
      if (attempt > 0) {
        log.info({ ...logCtx, attempt }, "Retrying merge after LLM correction");
      }

      // Merge patches into files (re-read from disk each attempt)
      const mergedFiles: { path: string; content: string }[] = [];
      for (const patch of currentPatches) {
        const existingPath = join(workspaceDir, patch.path);
        let fileContent = "";
        try {
          fileContent = readFileSync(existingPath, "utf-8");
        } catch {
          log.warn({ path: patch.path }, "Patch target file not found, skipping");
          continue;
        }

        for (const section of patch.sections) {
          const heading = section.heading;
          const newContent = section.newContent;

          const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          let matched = false;

          if (isChangelogFile(patch.path)) {
            const sectionRegex = new RegExp(
              `(#{1,4}\\s+${escaped}[^\\n]*\\n)([\\s\\S]*?)(?=\\n#{1,4}\\s|$(?![\\s\\S]))`,
              "i",
            );
            const m = fileContent.match(sectionRegex);
            if (m) {
              const headingLine = m[1];
              const existingBody = m[2].replace(/\n?$/, "");
              const appendix = existingBody ? `\n${newContent}` : newContent;
              fileContent = fileContent.replace(m[0], `${headingLine}${existingBody}${appendix}\n`);
              matched = true;
              log.info({ path: patch.path, heading }, "Changelog section appended");
            }
          } else {
            const patterns = [
              new RegExp(
                `(#{1,4}\\s*${escaped}[^\\n]*\\n)([\\s\\S]*?)(?=\\n#{1,4}\\s|\\n---\\n|$(?![\\s\\S]))`,
                "i",
              ),
              new RegExp(
                `(^${escaped}[^\\n]*\\n)([\\s\\S]*?)(?=\\n(?:#{1,4}\\s|\\d{4}-\\d{2}\\b|[A-Z][a-z].{2,40}\\n[-=])|$(?![\\s\\S]))`,
                "im",
              ),
            ];

            for (const regex of patterns) {
              const m = fileContent.match(regex);
              if (m && m[2]) {
                fileContent = fileContent.replace(m[0], `${m[1]}${newContent}\n`);
                matched = true;
                log.info({ path: patch.path, heading }, "Section updated");
                break;
              }
            }
          }

          if (!matched) {
            const sep = fileContent.endsWith("\n") ? "\n" : "\n\n";
            fileContent += `${sep}${heading}\n${newContent}\n`;
            log.info({ path: patch.path, heading }, "Section appended");
          }
        }
        mergedFiles.push({ path: patch.path, content: fileContent });
      }

      // Filter by path whitelist
      const { allowed, blocked } = filterAllowedPaths(mergedFiles, allowedPaths);
      if (blocked.length > 0) {
        log.info({ ...logCtx, blocked }, "Some files filtered by whitelist");
      }
      if (allowed.length === 0) {
        await updateJobStatus(traceId, "skipped", {
          reason: `All files blocked by whitelist: ${blocked.join("; ")}`,
        });
        return;
      }

      // Validate merged content
      const validationIssues: CorrectionIssue[] = [];
      for (const file of allowed) {
        const original = targetFiles.find((tf) => tf.path === file.path);
        const result = validateFile({
          path: file.path,
          content: file.content,
          originalContent: original?.currentContent ?? "",
        });
        if (!result.valid) {
          for (const issue of result.issues) {
            validationIssues.push({
              path: issue.path,
              type: issue.type,
              detail: issue.detail,
            });
          }
        }
      }

      if (validationIssues.length === 0) {
        // Validation passed
        finalFiles = allowed;
        if (strategyResult.message) finalMessage = strategyResult.message;
        break;
      }

      // Validation failed — try LLM correction
      log.warn(
        { ...logCtx, attempt, issueCount: validationIssues.length },
        "Content validation failed",
      );

      if (
        attempt < MAX_CORRECTIONS &&
        route.job.strategy.type === "llm" &&
        currentRawOutput
      ) {
        log.info({ ...logCtx, attempt }, "Attempting LLM content correction...");
        const correctionResult = await correctLlmOutput(
          route.job.strategy,
          currentRawOutput,
          validationIssues,
          workspaceDir,
        );

        if (
          correctionResult.action === "patch" &&
          correctionResult.patches &&
          correctionResult.patches.length > 0
        ) {
          currentPatches = correctionResult.patches;
          currentRawOutput = correctionResult.rawOutput;
          log.info(
            { ...logCtx, attempt },
            `Correction returned ${correctionResult.patches.length} patches, re-merging`,
          );
          continue;
        }

        if (correctionResult.action === "no_change") {
          await updateJobStatus(traceId, "skipped", {
            reason: correctionResult.reason ?? "Correction determined no changes needed",
          });
          return;
        }

        log.error(
          { ...logCtx, correctionResult: correctionResult.action },
          "LLM correction failed, will not retry",
        );
      }

      // Cannot correct — fail the job
      log.error(
        { ...logCtx, issues: validationIssues, attempt },
        "Pre-push validation failed after correction attempts — blocking commit",
      );
      await updateJobStatus(traceId, "failed", {
        reason: `Content validation failed after ${attempt + 1} attempt(s): ${validationIssues.map((i) => `[${i.type}] ${i.detail}`).join("; ")}`,
      });
      await notifyPrComment(route, payload, traceId, {
        action: "error",
        reason: `Pre-push content validation failed after ${attempt + 1} correction attempt(s):\n\n${validationIssues.map((i) => `- **${i.type}** (${i.path}): ${i.detail}`).join("\n")}`,
      });
      return;
    }

    if (!finalFiles) {
      return; // Should not reach here, but guard
    }

    strategyResult = {
      action: "update",
      files: finalFiles,
      message: finalMessage ?? "Patch applied",
    };
  }

  // --- Clean up temp files before applying changes ---
  await git.removeFile(".bot-diff.txt");

  // --- Apply changes ---
  try {
    await git.applyFiles(strategyResult.files);
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, ...logCtx }, "Failed to apply file changes");
    await updateJobStatus(traceId, "failed", {
      reason: `Failed to apply file changes: ${error.message}`,
    });
    return;
  }

  // Check for changes (for shell strategy, changes happen in workspace)
  const changed = await git.hasChanges();
  if (!changed && !route.job.commit.allowEmpty) {
    log.info(logCtx, "No file changes after strategy execution");
    await updateJobStatus(traceId, "skipped", {
      reason: "No file changes after strategy execution",
    });
    return;
  }

  // --- Commit and push ---
  const commitMessage = strategyResult.message
    ? `[bot] ${strategyResult.message}\n\n[bot:${route.name}]`
    : route.job.commit.message
        .replace("{{pr.number}}", String(pr.number))
        .replace("{{pr.title}}", pr.title)
        .replace("{{headSha}}", headSha.slice(0, 7))
        .replace("{{route}}", route.name);

  try {
    const filePaths = strategyResult.files.map((f) => f.path);
    const commitSha = await git.commitAndPush(
      commitMessage,
      route.job.commit.author,
      sourceBranch,
      filePaths,
    );
    log.info({ ...logCtx, commitSha }, "Commit and push successful");
    await updateJobStatus(traceId, "success", {
      commitSha,
      reason: strategyResult.message ?? "Changes applied",
    });

    await notifyPrComment(route, payload, traceId, {
      action: "update",
      files: strategyResult.files,
      message: `Committed: ${commitSha.slice(0, 7)}`,
    });
  } catch (err: unknown) {
    const error = err as { message?: string };
    log.error({ err, ...logCtx }, "Commit/push failed");
    await updateJobStatus(traceId, "failed", {
      reason: `Commit/push failed: ${error.message}`,
    });
    await notifyPrComment(route, payload, traceId, {
      action: "error",
      reason: `Commit/push failed: ${error.message}`,
    });
  }
}
