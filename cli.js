#!/usr/bin/env node
// coder — a colorful terminal coding agent that talks to any AI provider or
// local model, and can run commands and edit files the model suggests (with your approval).
//
//   <text>        → chat with the current AI model
//   !<command>    → run YOUR local shell command immediately
//   /command      → built-in command (see /help)

import readline from "node:readline";
import { buildRegistry, loadConfig, resolveDefault } from "./providers.js";
import { collectClientInfo } from "./clientinfo.js";
import { collectProjectInfo } from "./src/projectinfo.js";
import { s, T, BOLD, box } from "./theme.js";
import { state, CANCEL, rebuildSystemPrompt } from "./src/state.js";
import { warn, info } from "./src/log.js";
import { nextLine, safePrompt } from "./src/input.js";
import { interruptActive, runLocal } from "./src/exec.js";
import { chat } from "./src/chat.js";
import { activate, runSlash } from "./src/commands.js";
import { dolphinAnsi } from "./src/mascot.js";

// ── Provider setup ────────────────────────────────────────────────────────────
let config;
try {
  config = loadConfig();
} catch (e) {
  warn(e.message);
  config = {};
}
state.config = config;
state.registry = buildRegistry(config);
state.currentName = resolveDefault(state.registry, config);
state.currentModel = process.env.AI_MODEL || config.model || null;
state.autoMode = !!process.env.AI_AUTO;
state.mode = process.env.AI_MODE || config.mode || "build";

// ── Readline interface ────────────────────────────────────────────────────────
state.rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "",
  historySize: 1000,
});

// ── Startup (background) ──────────────────────────────────────────────────────
// Both promises are stored in state so chat() and slash commands can await them.
state.infoReady = collectClientInfo()
  .then((i) => { state.clientInfo = i; rebuildSystemPrompt(); })
  .catch((e) => warn(`client info: ${e.message}`));

state.projectReady = collectProjectInfo()
  .then((p) => { state.projectInfo = p; rebuildSystemPrompt(); })
  .catch((e) => warn(`project scan: ${e.message}`));

state.startupReady = activate(state.currentName, state.currentModel).catch((e) =>
  warn(`could not start ${state.currentName}: ${e.message}`),
);

// ── Banner ────────────────────────────────────────────────────────────────────
// activate() sets state.provider synchronously before its first await, so
// `state.provider` is already non-null here if the provider config was valid.
process.stdout.write("\n" + dolphinAnsi() + "\n");
process.stdout.write(
  "\n" +
  box(
    [
      s("coder", T.accent2, BOLD) + s("  ·  any model, in your terminal", T.gray),
      s(
        state.provider ? `${state.currentName}:${state.currentModel}` : "no provider active",
        state.provider ? T.cyan : T.yellow,
      ),
    ],
    T.accent,
  ) + "\n",
);
info(
  `type ${s("/help", T.cyan, BOLD)}${T.faint} for commands · ` +
  `${s("!cmd", T.cyan, BOLD)}${T.faint} runs local shell · ` +
  `${s("Shift+Tab", T.cyan, BOLD)}${T.faint} auto-approves · ` +
  `${s("Ctrl-C", T.cyan, BOLD)}${T.faint} cancels`,
);
process.stdout.write("\n");

// ── Input routing ─────────────────────────────────────────────────────────────
async function handle(line) {
  const input = line.trim();
  if (!input) return;
  if (input.startsWith("!")) return runLocal(input.slice(1));
  if (input.startsWith("/")) return runSlash(input);
  return chat(input);
}

// ── Event handlers ────────────────────────────────────────────────────────────
// Feed every line into the FIFO queue (or hand it to whoever is awaiting input).
state.rl.on("line", (line) => {
  if (state.lineWaiter) {
    const w = state.lineWaiter;
    state.lineWaiter = null;
    w(line);
  } else {
    state.lineQueue.push(line);
  }
});

state.rl.on("close", () => {
  state.closed = true;
  if (state.lineWaiter) {
    const w = state.lineWaiter;
    state.lineWaiter = null;
    w(null);
  }
});

// Ctrl-C handling (Claude-Code style):
//   command running   → interrupt it (second Ctrl-C force-kills)
//   pending Y/n       → cancel/abort the action
//   typed but unsent  → discard the line
//   empty prompt      → first press arms exit, second press quits
state.rl.on("SIGINT", () => {
  if (interruptActive()) return;
  if (state.awaitingApproval && state.lineWaiter) {
    const w = state.lineWaiter;
    state.lineWaiter = null;
    process.stdout.write("\n");
    w(CANCEL);
    return;
  }
  if (state.rl.line && state.rl.line.length > 0) {
    process.stdout.write("\n");
    state.rl.line = "";
    state.rl.cursor = 0;
    state.sigintArmed = false;
    safePrompt();
    return;
  }
  if (state.sigintArmed) { state.rl.close(); return; }
  state.sigintArmed = true;
  process.stdout.write(s("\n(press Ctrl-C again to exit)\n", T.faint));
  safePrompt();
  setTimeout(() => { state.sigintArmed = false; }, 2000);
});

// Backup handler for SIGINT that bypasses readline (raw-mode paths).
process.on("SIGINT", () => { interruptActive(); });

// Shift+Tab toggles auto-approve mode (when readline owns the terminal).
process.stdin.on("keypress", (_str, key) => {
  if (!key || state.terminalBusy || state.closed) return;
  if (key.name === "tab" && key.shift) {
    const turningOn = !state.autoMode;
    state.autoMode = turningOn;
    process.stdout.write(
      turningOn
        ? "\n" + s("⚡ auto mode ON", T.yellow, BOLD) +
            s("  — suggested actions run WITHOUT asking · Shift+Tab to turn off\n", T.faint)
        : "\n" + s("auto mode off", T.faint) + s("  — actions will ask for approval again\n", T.faint),
    );
    state.sigintArmed = false;
    // If we just turned ON while waiting at a Y/n prompt, auto-approve it now.
    if (turningOn && state.awaitingApproval && state.lineWaiter) {
      process.stdout.write(s("  ⚡ auto-approved\n", T.yellow));
      const w = state.lineWaiter;
      state.lineWaiter = null;
      w("y");
      return;
    }
    safePrompt();
  }
});

// ── Main loop ─────────────────────────────────────────────────────────────────
// Single consumer: read lines in order, dispatch, reprompt. Approval prompts
// read from the same queue via ask(), keeping input correctly sequenced.
(async function main() {
  safePrompt();
  while (true) {
    const line = await nextLine();
    if (line === null) break;
    if (line !== CANCEL) await handle(line);
    safePrompt();
  }
  process.stdout.write(s("\n✦ bye.\n", T.accent));
  process.exit(0);
})();
