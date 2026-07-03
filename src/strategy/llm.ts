import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { LlmStrategyConfig } from "../config.js";
import type { StrategyContext, StrategyResult } from "./types.js";

function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    return vars[name] ?? `{{${name}}}`;
  });
}

// Tools the LLM can call
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_diff",
      description: "Get the git diff of the pull request. Call this to see what code changed.",
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the current content of a file from the repository. Call this to see the current state of a documentation file before modifying it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root, e.g. PRD.md or docs-site/changelog.md" },
        },
        required: ["path"],
      },
    },
  },
];

function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: StrategyContext,
): string {
  switch (name) {
    case "get_diff": {
      const diff = ctx.git.diff;
      if (!diff) return "(no diff - this is an empty PR)";
      // Return full diff, the LLM can handle it
      return diff;
    }
    case "read_file": {
      const filePath = join(ctx.repo.workspaceDir, args.path as string);
      if (!filePath.startsWith(ctx.repo.workspaceDir)) return "(access denied)";
      try {
        return readFileSync(filePath, "utf-8");
      } catch {
        return `(file not found: ${args.path})`;
      }
    }
    default:
      return `(unknown tool: ${name})`;
  }
}

export async function executeLlmStrategy(
  config: LlmStrategyConfig,
  ctx: StrategyContext,
): Promise<StrategyResult> {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    return {
      action: "error",
      reason: `API key env var '${config.apiKeyEnv}' is not set`,
    };
  }

  const baseURL = process.env[config.baseUrlEnv] ?? "https://api.deepseek.com";
  const client = new OpenAI({ apiKey, baseURL: baseURL + "/v1" });

  // Read system prompt file
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(config.systemPromptFile, "utf-8");
  } catch (err: unknown) {
    return { action: "error", reason: `Failed to read system prompt: ${(err as Error).message}` };
  }

  // Read workspace skill file if configured
  if (config.workspaceSkillFile) {
    const skillPath = join(ctx.repo.workspaceDir, config.workspaceSkillFile);
    if (existsSync(skillPath)) {
      try {
        const skillContent = readFileSync(skillPath, "utf-8");
        systemPrompt += `\n\n---\n## Project Skill\n\n${skillContent}`;
      } catch { /* ignore */ }
    }
  }

  // Read user prompt template
  let userPromptTemplate: string;
  try {
    userPromptTemplate = readFileSync(config.userPromptTemplate, "utf-8");
  } catch (err: unknown) {
    return { action: "error", reason: `Failed to read user prompt: ${(err as Error).message}` };
  }

  // Render initial user prompt (metadata only, no diff/file content)
  const initialPrompt = renderTemplate(userPromptTemplate, {
    diff: "(use get_diff tool to retrieve the diff)",
    targetFiles: "(use read_file tool to see current file contents)",
    prTitle: ctx.event.pr.title,
    prBody: ctx.event.pr.body,
    prNumber: String(ctx.event.pr.number),
    sourceBranch: ctx.event.pr.sourceBranch,
    targetBranch: ctx.event.pr.targetBranch,
    changedFiles: ctx.git.changedFiles.join("\n"),
    route: ctx.route,
    traceId: ctx.traceId,
    headSha: ctx.event.pr.headSha,
  });

  console.log(`[llm] Initial prompt: system=${systemPrompt.length} user=${initialPrompt.length} chars`);

  // Function calling loop (max 5 turns)
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: initialPrompt },
  ];

  let rawOutput = "";
  const maxTurns = 5;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages,
      tools,
      tool_choice: turn === maxTurns - 1 ? "none" : "auto",
    });

    const choice = response.choices[0];
    const finish = choice?.finish_reason ?? "unknown";
    console.log(`[llm] Turn ${turn + 1}: finish=${finish} prompt_tokens=${response.usage?.prompt_tokens} completion_tokens=${response.usage?.completion_tokens}`);

    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
      // Execute tool calls
      messages.push(choice.message);

      for (const tc of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          console.log(`[llm]   tool: ${tc.function.name} — invalid JSON args, using empty args`);
        }
        const result = executeTool(tc.function.name, args, ctx);
        console.log(`[llm]   tool: ${tc.function.name}(${JSON.stringify(args)}) → ${result.length} chars`);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
    } else {
      rawOutput = choice?.message?.content ?? "";
      break;
    }
  }

  if (!rawOutput) {
    return {
      action: "error",
      reason: `LLM returned empty response after function calls`,
    };
  }

  // Parse output in delimiter-based format
  let { action, patches, message } = parseOutput(rawOutput);

  // Retry: if parsing failed, ask LLM to reformat
  if (action === "error" || action === "unknown") {
    console.log(`[llm] Parse failed (action=${action}), sending correction prompt...`);
    messages.push({ role: "assistant", content: rawOutput });
    messages.push({ role: "user", content: CORRECTION_PROMPT });

    try {
      const retryResp = await client.chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: config.maxTokens,
        messages,
        tool_choice: "none",
      });
      const retryOutput = retryResp.choices[0]?.message?.content ?? "";
      console.log(`[llm] Retry response: ${retryOutput.length} chars`);
      if (retryOutput) {
        const reparsed = parseOutput(retryOutput);
        if (reparsed.action !== "error" && reparsed.action !== "unknown") {
          action = reparsed.action;
          patches = reparsed.patches;
          message = reparsed.message;
          rawOutput = retryOutput;
          console.log(`[llm] Retry succeeded: action=${action}`);
        } else {
          console.log(`[llm] Retry parse also failed, trying natural language fallback...`);
          const fallback = parseNaturalLanguage(retryOutput, config.allowedPaths);
          if (fallback) return fallback;
        }
      }
    } catch (err: unknown) {
      console.log(`[llm] Retry call failed: ${(err as Error).message}`);
      // Fall through to try natural language on original output
    }

    // Fallback: try natural language extraction on the original output
    if (action === "error" || action === "unknown") {
      const fallback = parseNaturalLanguage(rawOutput, config.allowedPaths);
      if (fallback) return fallback;
    }
  }

  if (action === "error") {
    return { action: "error", reason: message ?? "Failed to parse LLM output" };
  }

  if (action === "no_change") {
    return { action: "no_change", reason: message ?? "LLM determined no changes needed" };
  }

  if (action === "patch" && patches) {
    return { action: "patch", patches, message, rawOutput };
  }

  return { action: "error", reason: `Failed to parse LLM output. Raw: ${rawOutput.slice(0, 300)}` };
}

const CORRECTION_PROMPT = `Your last response was NOT in the required format and caused a parse error.

You MUST output using ONLY the exact delimiters below. No preamble, no analysis, no markdown code blocks. The first line MUST be ACTION:.

For changes:
ACTION: patch

---FILE:path/to/file.md---
HEADING: Section Name
CONTENT:
Updated section content here...
---END---

MESSAGE: Brief summary

For no changes:
ACTION: no_change
MESSAGE: reason

Reformat your previous analysis using EXACTLY this format now.`;

function parseOutput(raw: string): {
  action: string;
  patches?: { path: string; sections: { heading: string; newContent: string }[] }[];
  message?: string;
} {
  const text = raw.trim();

  // Extract action
  const actionMatch = text.match(/^ACTION:\s*(\w+)/m);
  const action = actionMatch?.[1] ?? "unknown";

  if (action === "no_change") {
    const msg = text.match(/^MESSAGE:\s*(.+)/m);
    return { action: "no_change", message: msg?.[1] };
  }

  // Parse file sections: ---FILE:path--- ... ---END---
  const patches: { path: string; sections: { heading: string; newContent: string }[] }[] = [];
  const filePattern = /---FILE:(.+?)---\n([\s\S]*?)---END---/g;
  let m: RegExpExecArray | null;

  while ((m = filePattern.exec(text)) !== null) {
    const path = m[1].trim();
    const block = m[2];

    const sections: { heading: string; newContent: string }[] = [];
    const headingPattern = /HEADING:\s*(.+)\nCONTENT:\n([\s\S]*?)(?=\n---END---|\nHEADING:|$)/g;
    let hm: RegExpExecArray | null;

    while ((hm = headingPattern.exec(block)) !== null) {
      const heading = hm[1].trim();
      const content = hm[2].trim();
      sections.push({ heading, newContent: content });
    }

    if (sections.length > 0) {
      patches.push({ path, sections });
    }
  }

  const msgMatch = text.match(/^MESSAGE:\s*(.+)/m);
  const message = msgMatch?.[1];

  if (patches.length === 0 && action === "patch") {
    return { action: "error", message: "No valid patches found in LLM output" };
  }

  return { action, patches: patches.length > 0 ? patches : undefined, message };
}

// --- Natural language fallback parser ---

const NO_CHANGE_PATTERNS: RegExp[] = [
  /no\s+(changes?|updates?|modifications?)\s+(needed|required|necessary)/i,
  /does\s+not\s+(need|require)\s+(any\s+)?(changes?|updates?|modifications?)/i,
  /不需(要)?(修改|更新|变更|改动)/,
  /无需(修改|更新|变更|改动|\w*任何\w*(修改|更新|变更|改动))/,
  /already\s+(up[-\s]?to[-\s]?date|current)/i,
  /no\s+(documentation|doc)\s+(changes?|updates?)\s+(needed|required)/i,
  /文档已经?(是最新|无需|不需要?|没有需要)/,
  /(should|can)\s+(be\s+)?(skip|ignore)/i,
];

function parseNaturalLanguage(
  raw: string,
  allowedPaths?: string[],
): StrategyResult | null {
  const text = raw.trim();
  if (!text) return null;

  // Check for "no change" intent
  const hasNoChange = NO_CHANGE_PATTERNS.some((p) => p.test(text));
  const hasCodeBlock = /```[\s\S]*?```/.test(text);

  if (hasNoChange && !hasCodeBlock) {
    return { action: "no_change", reason: "Natural language indicates no changes needed" };
  }

  // Find which allowed paths are mentioned in the text
  const paths = allowedPaths ?? [];
  const mentionedPaths = paths.filter(
    (p) =>
      text.includes(p) || text.includes(p.split("/").pop() ?? p),
  );

  if (mentionedPaths.length === 0) return null;

  // Extract patches: look for code blocks containing markdown headings
  // Each code block likely contains proposed content for a file
  const patches = extractPatchesFromNaturalLanguage(text, mentionedPaths);

  return patches.length > 0
    ? { action: "patch", patches, message: "Extracted from natural language (fallback)" }
    : null;
}

function extractPatchesFromNaturalLanguage(
  text: string,
  mentionedPaths: string[],
): { path: string; sections: { heading: string; newContent: string }[] }[] {
  const result: { path: string; sections: { heading: string; newContent: string }[] }[] = [];

  // Find all markdown code blocks — these likely contain proposed content
  const codeBlockRegex = /```(?:markdown|md)?\n([\s\S]*?)```/g;
  const codeBlocks: string[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = codeBlockRegex.exec(text)) !== null) {
    codeBlocks.push(cm[1].trim());
  }

  if (codeBlocks.length === 0) {
    // Try to find content between triple-backtick fences without language tag
    // or indented blocks that look like markdown
    const fenceRegex = /```\n?([\s\S]*?)```/g;
    while ((cm = fenceRegex.exec(text)) !== null) {
      const content = cm[1].trim();
      if (content.length > 10) codeBlocks.push(content);
    }
  }

  if (codeBlocks.length === 0) return result;

  // Map code blocks to files based on proximity in text
  // For simplicity: if only one file and one code block, pair them
  // If multiple, try to map by file name proximity
  if (mentionedPaths.length === 1 && codeBlocks.length >= 1) {
    const sections = extractHeadingsFromContent(codeBlocks[0]);
    if (sections.length > 0) {
      result.push({ path: mentionedPaths[0], sections });
    }
  } else {
    // Try to map each code block to the closest mentioned file
    const usedPaths = new Set<string>();
    for (const block of codeBlocks) {
      // Find the block position in text
      const blockIdx = text.indexOf(block);
      if (blockIdx < 0) continue;

      // Find closest mentioned path before this block
      let closestPath = "";
      let closestDist = Infinity;
      for (const p of mentionedPaths) {
        const pIdx = text.lastIndexOf(p, blockIdx);
        if (pIdx >= 0 && blockIdx - pIdx < closestDist) {
          closestDist = blockIdx - pIdx;
          closestPath = p;
        }
      }
      if (!closestPath) closestPath = mentionedPaths[0];

      const sections = extractHeadingsFromContent(block);
      if (sections.length > 0) {
        // Merge into existing file entry if already present
        const existing = result.find((r) => r.path === closestPath);
        if (existing) {
          existing.sections.push(...sections);
        } else {
          result.push({ path: closestPath, sections });
          usedPaths.add(closestPath);
        }
      }
    }
  }

  return result;
}

function extractHeadingsFromContent(
  content: string,
): { heading: string; newContent: string }[] {
  const sections: { heading: string; newContent: string }[] = [];

  // Split content by markdown headings: ## Section or ### Section
  const headingSplitRegex = /^(#{1,4})\s+(.+)$/gm;
  const matches: { index: number; end: number; level: string; heading: string }[] = [];
  let hm: RegExpExecArray | null;

  while ((hm = headingSplitRegex.exec(content)) !== null) {
    matches.push({
      index: hm.index,
      end: hm.index + hm[0].length,
      level: hm[1],
      heading: hm[2].trim(),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end + 1; // after heading line
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const body = content.slice(start, end).trim();
    if (body.length > 5) {
      sections.push({ heading: matches[i].heading, newContent: body });
    }
  }

  // If no headings found but content looks like a single section,
  // try to identify a heading from the first line
  if (sections.length === 0 && content.length > 10) {
    const firstLine = content.split("\n")[0].trim();
    const headingMatch = firstLine.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      const body = content.slice(firstLine.length + 1).trim();
      if (body.length > 5) {
        sections.push({ heading: headingMatch[1].trim(), newContent: body });
      }
    }
  }

  return sections;
}

// --- Content correction: called when the pre-push validator rejects merged output ---

export interface CorrectionIssue {
  path: string;
  type: string;
  detail: string;
}

export async function correctLlmOutput(
  config: LlmStrategyConfig,
  rawOutput: string,
  issues: CorrectionIssue[],
  workspaceDir: string,
): Promise<StrategyResult> {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    return {
      action: "error",
      reason: `API key env var '${config.apiKeyEnv}' is not set`,
    };
  }

  const baseURL = process.env[config.baseUrlEnv] ?? "https://api.deepseek.com";
  const client = new OpenAI({ apiKey, baseURL: baseURL + "/v1" });

  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(config.systemPromptFile, "utf-8");
  } catch (err: unknown) {
    return { action: "error", reason: `Failed to read system prompt: ${(err as Error).message}` };
  }

  if (config.workspaceSkillFile) {
    const skillPath = join(workspaceDir, config.workspaceSkillFile);
    if (existsSync(skillPath)) {
      try {
        const skillContent = readFileSync(skillPath, "utf-8");
        systemPrompt += `\n\n---\n## Project Skill\n\n${skillContent}`;
      } catch { /* ignore */ }
    }
  }

  const issueList = issues
    .map((i) => `- [${i.type}] ${i.path}: ${i.detail}`)
    .join("\n");

  const correctionPrompt = `Your previous output passed format parsing but was REJECTED by the content validator after merging with existing files. The merged file had these problems:

${issueList}

Your original output:
\`\`\`
${rawOutput}
\`\`\`

Fix each problem:
- **duplicate_heading**: You output the same HEADING block more than once. Keep only one. If you're adding to an existing month, output the month heading once with ONLY the new bullets.
- **duplicate_content**: You copied existing content into CONTENT. Remove any bullets/lines that already exist in the file. CONTENT = ONLY new entries.
- **size_anomaly**: Your CONTENT is too large (the file grew too much). Reduce to ONLY the genuinely new entries — never include existing content.
- **llm_artifact**: Raw format markers (ACTION:, ---FILE:, HEADING:, CONTENT:) leaked into CONTENT. Remove them — these are format delimiters, not content.
- **structure_broken**: The changelog structure is damaged. Month headings MUST be "## YYYY-MM" format. Page header must be preserved.

Output in the correct format. NO preamble. First line MUST be ACTION:.

ACTION: patch

---FILE:path/to/file.md---
HEADING: Section Name
CONTENT:
Only new content here — do NOT include existing bullets...
---END---

MESSAGE: Brief summary

If the fix reveals no actual changes are needed:
ACTION: no_change
MESSAGE: reason`;

  console.log(`[llm] Content correction: issues=${issues.length} prompt=${correctionPrompt.length} chars`);

  try {
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: config.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: correctionPrompt },
      ],
      tool_choice: "none",
    });

    const corrected = response.choices[0]?.message?.content ?? "";
    console.log(`[llm] Correction response: ${corrected.length} chars`);

    if (!corrected) {
      return { action: "error", reason: "LLM returned empty correction response" };
    }

    const { action, patches, message } = parseOutput(corrected);

    if (action === "error" || action === "unknown") {
      const fallback = parseNaturalLanguage(corrected, config.allowedPaths);
      if (fallback) return fallback;
      return {
        action: "error",
        reason: `Failed to parse corrected output. Raw: ${corrected.slice(0, 200)}`,
      };
    }

    if (action === "no_change") {
      return { action: "no_change", reason: message ?? "Correction resulted in no changes" };
    }

    if (action === "patch" && patches && patches.length > 0) {
      return { action: "patch", patches, message: message ?? "Corrected", rawOutput: corrected };
    }

    return {
      action: "error",
      reason: `Failed to parse corrected output. Raw: ${corrected.slice(0, 200)}`,
    };
  } catch (err: unknown) {
    return {
      action: "error",
      reason: `Correction call failed: ${(err as Error).message}`,
    };
  }
}
