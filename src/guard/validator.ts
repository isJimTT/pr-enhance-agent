/**
 * Pre-push content validator. Runs sanity checks on files produced by the
 * strategy before they are committed. Catches common LLM mistakes such as
 * duplicating entire sections, copying the whole file, or generating
 * malformed markdown.
 */
import { getLogger } from "../logger.js";

const log = getLogger("validator");

export interface ValidationIssue {
  type:
    | "duplicate_heading"
    | "duplicate_content"
    | "size_anomaly"
    | "llm_artifact"
    | "structure_broken";
  path: string;
  detail: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidationContext {
  /** File path relative to repo root */
  path: string;
  /** Final file content after merge */
  content: string;
  /** Original file content before merge (empty string if new file) */
  originalContent: string;
}

// Patterns that indicate raw LLM output leaked into the file.
// Be conservative: only match clear format leaks.
// Code blocks (```) are NOT flagged — they're legitimate in technical docs.
const LLM_ARTIFACT_PATTERNS: RegExp[] = [
  /^(?:Based on|根据|根据 PR|I analyzed|I've analyzed)/im,
  /^(?:Here(?:'s| is)|以下是)(?: the)? (?:updated|修改后)/im,
  /^ACTION:\s*(?:patch|no_change)/im,
  /^---FILE:/im,
  /^HEADING:/im,
  /^CONTENT:/im,
  /^MESSAGE:/im,
];

// Files that get changelog-specific strict checks
const CHANGELOG_PATTERNS = [/changelog/i, /CHANGELOG/];

export function isChangelogFile(path: string): boolean {
  return CHANGELOG_PATTERNS.some((p) => p.test(path));
}

export function validateFile(
  ctx: ValidationContext,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // 1. LLM artifact detection (runs first — if it fires the content is
  //    very likely broken)
  checkLlmArtifacts(ctx, issues);

  // 2. Duplicate headings
  checkDuplicateHeadings(ctx, issues);

  // 3. Duplicate content blocks (sliding window)
  checkDuplicateContent(ctx, issues);

  // 4. Size anomaly
  checkSizeAnomaly(ctx, issues);

  // 5. Changelog-specific structure checks
  if (isChangelogFile(ctx.path)) {
    checkChangelogStructure(ctx, issues);
  }

  if (issues.length > 0) {
    log.warn(
      { path: ctx.path, issueCount: issues.length, types: issues.map((i) => i.type) },
      "Validation found issues",
    );
  }

  return { valid: issues.length === 0, issues };
}

// --- Individual checks ---

function checkLlmArtifacts(
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  for (const pattern of LLM_ARTIFACT_PATTERNS) {
    const match = ctx.content.match(pattern);
    if (match) {
      issues.push({
        type: "llm_artifact",
        path: ctx.path,
        detail: `File contains raw LLM output: "${match[0].slice(0, 80)}"`,
      });
      return; // One artifact is enough to fail
    }
  }
}

function checkDuplicateHeadings(
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const headingRegex = /^(#{1,4})\s+(.+)$/gm;
  const headings = new Map<string, number>(); // normalized heading → count
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(ctx.content)) !== null) {
    const h = match[2].trim().toLowerCase();
    headings.set(h, (headings.get(h) ?? 0) + 1);
  }

  for (const [h, count] of headings) {
    if (count > 1) {
      issues.push({
        type: "duplicate_heading",
        path: ctx.path,
        detail: `Heading "${h}" appears ${count} times`,
      });
    }
  }
}

function checkDuplicateContent(
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const lines = ctx.content.split("\n");
  const WINDOW = 3;
  const MIN_BLOCK_LENGTH = 30; // minimum chars to consider a meaningful duplicate

  if (lines.length < WINDOW * 2) return;

  // Map normalized window → first occurrence line index
  const seen = new Map<string, number>();

  for (let i = 0; i <= lines.length - WINDOW; i++) {
    const windowLines = lines.slice(i, i + WINDOW);
    // Skip windows that are mostly whitespace or very short
    const joined = windowLines.join("\n").trim();
    if (joined.length < MIN_BLOCK_LENGTH) continue;

    const normalized = windowLines.map((l) => l.trim()).join("\n");
    const prev = seen.get(normalized);

    if (prev !== undefined) {
      // Non-overlapping duplicate found
      if (i - prev >= WINDOW) {
        issues.push({
          type: "duplicate_content",
          path: ctx.path,
          detail: `Lines ${prev + 1}-${prev + WINDOW} duplicated at lines ${i + 1}-${i + WINDOW}: "${joined.slice(0, 60)}..."`,
        });
        return; // One duplicate block is enough
      }
    } else {
      seen.set(normalized, i);
    }
  }
}

function checkSizeAnomaly(
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  if (!ctx.originalContent) return; // New file, nothing to compare

  const origLen = ctx.originalContent.length;
  const newLen = ctx.content.length;

  if (origLen === 0) return;

  const ratio = newLen / origLen;
  const threshold = isChangelogFile(ctx.path) ? 1.3 : 2.0;

  if (ratio > threshold) {
    const pct = Math.round((ratio - 1) * 100);
    issues.push({
      type: "size_anomaly",
      path: ctx.path,
      detail: `File grew by ${pct}% (${origLen} → ${newLen} chars), exceeding ${Math.round((threshold - 1) * 100)}% threshold`,
    });
  }
}

function checkChangelogStructure(
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const lines = ctx.content.split("\n");

  // Skip YAML frontmatter (delimited by --- lines)
  let contentStart = 0;
  if (lines[0]?.trim() === "---") {
    const endIdx = lines.indexOf("---", 1);
    if (endIdx !== -1) {
      contentStart = endIdx + 1;
    }
  }

  // Check page header (first 3 non-empty lines after frontmatter)
  const nonEmpty = lines.slice(contentStart).filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) {
    issues.push({
      type: "structure_broken",
      path: ctx.path,
      detail: "File appears empty or missing content",
    });
    return;
  }

  // First content line should be "# 更新日志" or similar changelog title
  const title = nonEmpty[0].trim();
  if (!title.startsWith("# ") || !/更新日志|changelog/i.test(title)) {
    issues.push({
      type: "structure_broken",
      path: ctx.path,
      detail: `Unexpected title: "${title.slice(0, 40)}"`,
    });
  }

  // Each month must use ## YYYY-MM format (after the header)
  const monthHeadingRegex = /^##\s+\d{4}-\d{2}/;
  const anyOtherHeadingRegex = /^#{1,4}\s+/;
  let inBody = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const monthMatch = line.match(monthHeadingRegex);
    const headingMatch = line.match(anyOtherHeadingRegex);

    if (monthMatch) {
      inBody = true;
      continue;
    }

    if (headingMatch && !monthMatch && inBody) {
      // A heading that isn't ## YYYY-MM in the body section — could be
      // an LLM artifact or broken format (e.g., missing ## prefix)
      const hText = headingMatch[0];
      issues.push({
        type: "structure_broken",
        path: ctx.path,
        detail: `Line ${i + 1}: unexpected heading format "${hText}" — month headings must be "## YYYY-MM"`,
      });
      return;
    }

    // Check bullet format in month sections
    if (inBody && line.trim().length > 0 && !line.match(/^##\s/) && !line.match(/^\s*[-*]\s/)) {
      // Non-empty, non-heading, non-bullet line: might be a broken entry
      // Allow blank lines and the intro paragraph
      if (!line.match(/^[A-Z一-鿿]/)) continue; // Not suspicious
      // Line starts with CJK or Latin letter but isn't a bullet — check if
      // it's the intro sentence (before any ## month)
      // We already passed the intro check, so this is suspicious
    }
  }

  // Check for duplicate month headings
  const monthHeadings = new Map<string, number>();
  const monthRegex = /^##\s+(\d{4}-\d{2})/gm;
  let mm: RegExpExecArray | null;
  while ((mm = monthRegex.exec(ctx.content)) !== null) {
    const m = mm[1];
    monthHeadings.set(m, (monthHeadings.get(m) ?? 0) + 1);
  }
  for (const [m, count] of monthHeadings) {
    if (count > 1) {
      issues.push({
        type: "duplicate_heading",
        path: ctx.path,
        detail: `Month "${m}" appears ${count} times in changelog`,
      });
    }
  }
}
