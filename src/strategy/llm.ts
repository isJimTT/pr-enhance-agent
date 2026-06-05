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
        const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
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
  const { action, patches, message } = parseOutput(rawOutput);

  if (action === "error") {
    return { action: "error", reason: message ?? "Failed to parse LLM output" };
  }

  if (action === "no_change") {
    return { action: "no_change", reason: message ?? "LLM determined no changes needed" };
  }

  if (action === "patch" && patches) {
    return { action: "patch", patches, message };
  }

  return { action: "error", reason: `Failed to parse LLM output. Raw: ${rawOutput.slice(0, 300)}` };
}

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
