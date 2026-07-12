// REPL input: line queue, approval prompts, shell prompt rendering.

import os from "node:os";
import { s, T, BOLD } from "../theme.js";
import { state, CANCEL, isTTY } from "./state.js";

// Read the next line from the FIFO queue (or wait for one to arrive).
export function nextLine() {
  if (state.lineQueue.length) return Promise.resolve(state.lineQueue.shift());
  if (state.closed) return Promise.resolve(null);
  return new Promise((res) => { state.lineWaiter = res; });
}

// Print a question and read the next queued line as its answer.
export function ask(question) {
  process.stdout.write(question);
  return nextLine();
}

// Ask a Y/n question. On an interactive terminal, discard stale buffered input
// so the answer is a fresh, deliberate keypress.
export async function askYesNo(question) {
  if (isTTY()) state.lineQueue.length = 0;
  state.awaitingApproval = true;
  try { return await ask(question); }
  finally { state.awaitingApproval = false; }
}

// Approval decision: "yes" | "no" | "abort". Auto-approves in auto mode.
export async function decide(question) {
  if (state.autoMode) {
    process.stdout.write(s("  ⚡ auto-approved\n", T.yellow));
    return "yes";
  }
  const ans = await askYesNo(question);
  if (ans === null || ans === CANCEL) return "abort";
  const a = ans.trim().toLowerCase();
  return (a === "" || a === "y" || a === "yes") ? "yes" : "no";
}

// Build the colorful shell prompt string.
export function buildPrompt() {
  const user = os.userInfo().username;
  const host = os.hostname().split(".")[0];
  const cwd = process.cwd().replace(os.homedir(), "~");
  const badge = state.autoMode
    ? s("⚡AUTO ", T.yellow, BOLD)
    : s("·manual ", T.faint);
  const modeBadge = state.mode === "plan" ? s("◆plan ", T.teal, BOLD) : "";
  return (
    modeBadge +
    badge +
    s(`${user}@${host}`, T.green, BOLD) +
    s(":", T.faint) +
    s(cwd, T.blue, BOLD) +
    s(" ❯ ", T.accent, BOLD)
  );
}

export function safePrompt() {
  if (state.closed) return;
  try {
    state.rl.setPrompt(buildPrompt());
    state.rl.prompt();
  } catch { /* interface closed underneath us */ }
}
