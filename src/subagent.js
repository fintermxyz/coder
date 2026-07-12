// src/subagent.js — the "general" subagent (ported from opencode's @general).
// A bounded, autonomous, READ-ONLY sub-run: it investigates a task with the
// read/grep/glob/search/browse tools and returns a concise summary. It never
// writes, edits, runs commands, or prompts the user, so it can loop unattended.

import { state } from "./state.js";
import { buildToolSchemas, toolCallToAction } from "./tools.js";
import { readFile, grepFiles, globFiles } from "./filetools.js";
import { webSearch, formatResults } from "./search.js";
import { browse } from "./browser.js";

const SUBAGENT_PROMPT = [
  "You are a general-purpose research subagent working inside a coding shell.",
  "You have READ-ONLY tools: read, grep, glob, search, browse. Use them to investigate",
  "the task thoroughly — locate relevant files, read the important parts, cross-check.",
  "You CANNOT modify anything, run commands, or ask the user questions.",
  "Be efficient: a few targeted searches, then STOP and answer. When done, reply with a",
  "concise, well-organized summary citing concrete evidence (file paths, line numbers,",
  "short snippets). Your final plain-text reply (with no tool calls) is your answer.",
].join("\n");

// Tools the subagent may never use.
const SUBAGENT_DENIED = new Set(["run", "write", "edit", "cron", "todo", "question", "task", "mcp-call"]);

const truncate = (str, max = 6000) => {
  const t = (str || "").trim();
  return t.length > max ? "…(truncated)…\n" + t.slice(-max) : t;
};

async function executeReadonly(a) {
  if (a.type === "read") return readFile(a).output;
  if (a.type === "grep") return grepFiles(a).output;
  if (a.type === "glob") return globFiles(a).output;
  if (a.type === "search") {
    try { return formatResults(a.query, await webSearch(a.query)); }
    catch (e) { return `search failed: ${e.message}`; }
  }
  if (a.type === "browse") {
    try { return await browse(a.url); }
    catch (e) { return `browse failed: ${e.message}`; }
  }
  return `tool "${a.type}" is not available to the subagent`;
}

// Run the subagent to completion and return its final text answer.
export async function runSubagent(prompt, { maxSteps = 8 } = {}) {
  if (!state.provider) throw new Error("no active provider");
  const nativeTools = state.provider.supportsTools !== false && process.env.AI_TOOLS !== "0";
  const tools = nativeTools ? buildToolSchemas(SUBAGENT_DENIED) : null;
  const history = [{ role: "user", content: prompt }];

  for (let step = 0; step < maxSteps; step++) {
    const { text, toolCalls } = await state.provider.streamChat({
      system: SUBAGENT_PROMPT, history, onText: () => {}, tools,
    });
    const calls = toolCalls || [];
    if (!calls.length) return text.trim() || "(the subagent returned no answer)";

    history.push({ role: "assistant", content: text, toolCalls: calls });
    const results = [];
    for (const tc of calls) {
      const output = await executeReadonly(toolCallToAction(tc.name, tc.args));
      results.push({ id: tc.id, name: tc.name, output: truncate(output) });
    }
    history.push({ role: "tool", results });
  }

  // Hit the step cap — force a final summary with tools off.
  history.push({ role: "user", content: "Stop investigating and give your final summary now." });
  const { text } = await state.provider.streamChat({ system: SUBAGENT_PROMPT, history, onText: () => {}, tools: null });
  return text.trim() || "(subagent reached its step limit without a conclusion)";
}
