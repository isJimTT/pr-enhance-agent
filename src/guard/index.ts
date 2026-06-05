import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitEngine } from "../git/index.js";
import { findCompletedJob } from "../store/jobs.js";

// --- Gitee Webhook Signature Verification ---

export function verifyGiteeSignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("base64");
  // Constant-time comparison
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// --- Idempotency Check ---

export async function checkIdempotency(
  route: string,
  repo: string,
  prNumber: number,
  headSha: string,
): Promise<{ alreadyProcessed: boolean; reason?: string }> {
  const existing = await findCompletedJob(route, repo, prNumber, headSha);
  if (existing) {
    return {
      alreadyProcessed: true,
      reason: `Already processed (trace_id: ${existing.trace_id})`,
    };
  }
  return { alreadyProcessed: false };
}

// --- Commit Marker Check ---

export async function checkLastCommitMarker(
  git: GitEngine,
  substring: string,
  botAuthor?: { name?: string; email?: string },
): Promise<{ shouldSkip: boolean; reason?: string }> {
  const msg = await git.getLastCommitMessage();

  // Check 1: commit message contains bot marker
  if (substring && msg.includes(substring)) {
    return {
      shouldSkip: true,
      reason: `Last commit has bot marker: "${substring}"`,
    };
  }

  // Check 2: last commit author is the bot
  if (botAuthor?.name || botAuthor?.email) {
    const author = await git.getLastCommitAuthor();
    if (botAuthor.name && author.name === botAuthor.name) {
      return { shouldSkip: true, reason: `Last commit author is bot: ${author.name}` };
    }
    if (botAuthor.email && author.email === botAuthor.email) {
      return { shouldSkip: true, reason: `Last commit author is bot: ${author.email}` };
    }
  }

  return { shouldSkip: false };
}

// --- Path Whitelist ---

export function filterAllowedPaths(
  files: { path: string; content: string }[],
  allowedPaths: string[],
): { allowed: { path: string; content: string }[]; blocked: string[] } {
  if (!allowedPaths || allowedPaths.length === 0) {
    // No whitelist = allow all (with safety checks)
    const blocked: string[] = [];
    const allowed = files.filter((file) => {
      if (file.path.includes("..") || file.path.startsWith(".git/") || file.path === ".git") {
        blocked.push(`Blocked dangerous path: ${file.path}`);
        return false;
      }
      return true;
    });
    return { allowed, blocked };
  }

  const allowed: { path: string; content: string }[] = [];
  const blocked: string[] = [];

  for (const file of files) {
    // Block dangerous paths
    if (file.path.includes("..")) {
      blocked.push(`Path traversal: ${file.path}`);
      continue;
    }
    if (file.path.startsWith(".git/") || file.path === ".git" || file.path.includes("/.git/")) {
      blocked.push(`Cannot modify .git: ${file.path}`);
      continue;
    }
    if (file.path === ".env" || file.path.endsWith(".env")) {
      blocked.push(`Cannot modify env files: ${file.path}`);
      continue;
    }

    // Check against allowedPaths (prefix matching)
    const matched = allowedPaths.some(
      (ap) => file.path === ap || file.path.startsWith(ap.endsWith("/") ? ap : ap + "/"),
    );
    if (matched) {
      allowed.push(file);
    } else {
      blocked.push(`Path not in allowedPaths: ${file.path}`);
    }
  }

  return { allowed, blocked };
}

// --- Sender Blacklist ---

export function checkSenderBlacklist(
  sender: string,
  ignoreSenders: string[],
): { shouldIgnore: boolean } {
  if (!ignoreSenders || ignoreSenders.length === 0) {
    return { shouldIgnore: false };
  }
  const shouldIgnore = ignoreSenders.some(
    (ignored) => ignored.toLowerCase() === sender.toLowerCase(),
  );
  return { shouldIgnore };
}

// --- Event & Action Filters ---

export function matchRouteRules(
  payload: {
    action: string;
    targetBranch: string;
    sourceBranch: string;
    sender: string;
  },
  rules: {
    actions?: string[];
    targetBranches?: string[];
    sourceBranchPrefix?: string[];
    ignoreSenders?: string[];
  },
): { matched: boolean; reason?: string } {
  // Check action
  if (rules.actions && rules.actions.length > 0) {
    if (!rules.actions.includes(payload.action)) {
      return {
        matched: false,
        reason: `Action '${payload.action}' not in allowed: ${rules.actions.join(", ")}`,
      };
    }
  }

  // Check target branch
  if (rules.targetBranches && rules.targetBranches.length > 0) {
    if (!rules.targetBranches.includes(payload.targetBranch)) {
      return {
        matched: false,
        reason: `Target branch '${payload.targetBranch}' not in: ${rules.targetBranches.join(", ")}`,
      };
    }
  }

  // Check source branch prefix
  if (rules.sourceBranchPrefix && rules.sourceBranchPrefix.length > 0) {
    const matched = rules.sourceBranchPrefix.some((prefix) =>
      payload.sourceBranch.startsWith(prefix),
    );
    if (!matched) {
      return {
        matched: false,
        reason: `Source branch '${payload.sourceBranch}' doesn't match prefixes: ${rules.sourceBranchPrefix.join(", ")}`,
      };
    }
  }

  // Check sender blacklist
  if (rules.ignoreSenders && rules.ignoreSenders.length > 0) {
    const ignored = checkSenderBlacklist(payload.sender, rules.ignoreSenders);
    if (ignored.shouldIgnore) {
      return {
        matched: false,
        reason: `Sender '${payload.sender}' is in ignore list`,
      };
    }
  }

  return { matched: true };
}
