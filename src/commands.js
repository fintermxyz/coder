// Slash-command implementations and provider activation.

import { s, T, BOLD, RESET, rule, bar, box } from "../theme.js";
import { createProvider } from "../providers.js";
import { collectClientInfo } from "../clientinfo.js";
import { collectProjectInfo, formatProjectContext } from "./projectinfo.js";
import { listCronJobs, removeCronJob, formatCronList } from "./cron.js";
import { connectMCP, disconnectMCP, listServersForDisplay, mcpServers } from "./mcp.js";
import { state, SPINNER, isTTY, rebuildSystemPrompt } from "./state.js";
import { warn, err, info } from "./log.js";
import { safePrompt } from "./input.js";
import { MODES, setMode } from "./permissions.js";
import { renderTodos } from "./actions.js";
import { saveSession, loadSession, listSessions, mostRecent } from "./session.js";

// ── Provider activation ────────────────────────────────────────────────────────

// Instantiate a provider, auto-pick a loaded model for local runtimes.
export async function activate(name, model) {
  let inst = createProvider(name, state.registry, model);
  state.provider = inst;
  state.currentName = inst.name;
  state.currentModel = inst.model;

  const def = state.registry[name];
  const isPlaceholder = !inst.model || inst.model === "local-model";
  if (!model && def?.local && isPlaceholder) {
    try {
      const ids = await inst.listModels();
      const pick = ids.find((id) => !/embed/i.test(id)) || ids[0];
      if (pick && pick !== inst.model) {
        inst = createProvider(name, state.registry, pick);
        state.provider = inst;
        state.currentName = inst.name;
        state.currentModel = inst.model;
      }
    } catch { /* server unreachable or no models — keep placeholder */ }
  }
}

// ── Slash command implementations ──────────────────────────────────────────────

function help() {
  const row = (cmd, desc) =>
    "  " + s(cmd.padEnd(20), T.cyan, BOLD) + s(desc, T.gray);
  const lines = [
    "",
    s("coder", T.accent2, BOLD) + s(" — talk to any model, run what it suggests", T.gray),
    "",
    s("chat & shell", T.accent, BOLD),
    row("<text>", "send a message to the current model"),
    row("!<command>", "run your own local shell command now"),
    "",
    s("inspect", T.accent, BOLD),
    row("/identity", "who/what this client is (a quick card)"),
    row("/context", "the full client_context JSON sent to the model"),
    row("/project", "the project map (file tree, manifest, README) sent to the model"),
    row("/prompt", "the exact system prompt the model receives"),
    row("/status", "active provider + model + history size"),
    row("/history", "show the conversation so far"),
    "",
    s("agent", T.accent, BOLD),
    row("/mode [build|plan]", "switch agent mode (plan = read-only); no arg toggles"),
    row("/todos", "show the model's current task list"),
    "",
    s("providers & models", T.accent, BOLD),
    row("/providers", "list known providers"),
    row("/provider <name>", "switch provider (e.g. /provider ollama)"),
    row("/model [id]", "pick from a list with ↑/↓, or pass an id directly"),
    row("/models", "list models the provider offers"),
    "",
    s("cron jobs", T.accent, BOLD),
    row("/cron", "list scheduled cron jobs"),
    row("/cron remove <name>", "remove a cron job by name"),
    "",
    s("MCP servers", T.accent, BOLD),
    row("/mcp", "list connected MCP servers and their tools"),
    row("/mcp connect <n> <spec>", "connect to an MCP server (stdio: cmd or https://url)"),
    row("/mcp disconnect <n>", "disconnect an MCP server"),
    row("/mcp refresh <n>", "re-fetch tool list from a connected server"),
    "",
    s("session", T.accent, BOLD),
    row("/save [name]", "save this conversation to disk (default: 'default')"),
    row("/resume [name]", "restore a saved conversation (no name = most recent)"),
    row("/sessions", "list saved conversations"),
    row("/refresh", "re-collect client_context (memory/disk/…)"),
    row("/reset", "clear the conversation history"),
    row("/clear", "clear the screen"),
    row("Shift+Tab", "toggle auto mode (run/write without asking)"),
    row("Ctrl-C", "cancel a running command, or empty prompt twice to exit"),
    row("/help", "show this help"),
    row("/exit", "quit (or Ctrl-D)"),
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function identity() {
  const ci = state.clientInfo;
  if (!ci) { warn("client_context not collected yet."); return; }
  const body = [
    s("user   ", T.faint) + s(`${ci.user?.name}`, T.white, BOLD) +
      s(`  @ ${ci.host}`, T.gray),
    s("system ", T.faint) + s(`${ci.os?.type}`, T.white, BOLD) +
      s(` (${ci.os?.platform}/${ci.os?.arch}) · ${ci.device}`, T.gray),
    s("shell  ", T.faint) + s(`${ci.user?.shell || "?"}`, T.white),
    s("memory ", T.faint) + s(`${ci.memory?.freeGB}`, T.white) +
      s(` / ${ci.memory?.totalGB} GB free`, T.gray),
    s("disk   ", T.faint) + s(`${ci.disk?.freeGB ?? "?"}`, T.white) +
      s(` / ${ci.disk?.totalGB ?? "?"} GB free`, T.gray),
    s("tools  ", T.faint) + s(`${ci.commands?.count ?? 0}`, T.white) +
      s(" commands on PATH", T.gray),
    s("model  ", T.faint) + s(`${state.currentName}:${state.currentModel}`, T.accent2, BOLD),
  ];
  process.stdout.write("\n" + bar("client identity", body, T.accent) + "\n");
}

function showPrompt() {
  process.stdout.write(
    "\n" + rule("system prompt", T.accent) + "\n" +
    s(state.systemPrompt, T.gray) + "\n" + rule("", T.faint) + "\n",
  );
}

function showProject() {
  if (!state.projectInfo) { warn("project map not ready yet — try again in a moment."); return; }
  const text = formatProjectContext(state.projectInfo, 20000); // no truncation for display
  process.stdout.write(
    "\n" + rule("project map", T.accent) + "\n" +
    s(text, T.gray) + "\n" + rule("", T.faint) + "\n",
  );
}

function showHistory() {
  if (!state.history.length) { info("history is empty."); return; }
  process.stdout.write("\n" + rule("conversation", T.accent) + "\n");
  for (const m of state.history) {
    if (m.role === "tool") {
      const summary = (m.results || []).map((r) => `${r.name}: ${String(r.output ?? "").split("\n")[0]}`).join(" · ");
      process.stdout.write(`${s("tool", T.teal, BOLD)}  ${s(summary.replace(/\n/g, " "), T.faint)}\n`);
      continue;
    }
    const who = m.role === "user"
      ? s("you", T.userc, BOLD)
      : s("ai ", T.accent2, BOLD);
    let text = String(m.content ?? "").replace(/\n/g, "\n     ");
    if (m.toolCalls?.length) {
      const calls = m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args ?? {})})`).join(", ");
      text = (text ? text + "\n     " : "") + s(`⚙ ${calls}`, T.faint);
    }
    process.stdout.write(`${who}  ${text}\n`);
  }
  process.stdout.write(rule("", T.faint) + "\n");
}

function listProviders() {
  process.stdout.write("\n" + rule("providers", T.accent) + "\n");
  for (const [name, def] of Object.entries(state.registry)) {
    let status;
    if (def.local) status = s("local", T.teal);
    else if (def.keyEnv && process.env[def.keyEnv]) status = s("key set", T.green);
    else status = s(`set ${def.keyEnv}`, T.faint);
    const active = name === state.currentName ? s(" ●", T.accent2) : "  ";
    process.stdout.write(
      `${active} ${s(name.padEnd(11), T.cyan, BOLD)} ${s((def.label || name).padEnd(20), T.white)} ${status}\n`,
    );
  }
  info("\nlocal providers auto-pick a loaded model · override with /model");
}

function status() {
  if (!state.provider) { warn("no active provider."); return; }
  const toolsOn = process.env.AI_TOOLS !== "0" && state.provider.supportsTools !== false;
  const body = [
    s("provider ", T.faint) + s(state.provider.label, T.white, BOLD) + s(`  (${state.currentName})`, T.gray),
    s("model    ", T.faint) + s(state.currentModel, T.accent2, BOLD),
    s("mode     ", T.faint) + s(state.mode, T.accent2, BOLD) + s(`  (${MODES[state.mode]?.desc || ""})`, T.gray),
    s("tools    ", T.faint) + s(toolsOn ? "native function-calling" : "fenced blocks (AI_TOOLS=0)", T.white),
    s("history  ", T.faint) + s(`${state.history.length} message(s)`, T.white),
  ];
  process.stdout.write("\n" + bar("status", body, T.accent) + "\n");
}

async function showModels() {
  if (!state.provider) { warn("no active provider."); return; }
  info(`fetching models from ${state.provider.label}…`);
  try {
    const models = await state.provider.listModels();
    if (!models.length) { warn("provider returned no models."); return; }
    for (const id of models.sort()) {
      const mark = id === state.currentModel ? s(" ●", T.accent2) : "  ";
      process.stdout.write(`${mark} ${s(id, T.white)}\n`);
    }
  } catch (e) {
    err(`could not list models: ${e.message || e}`);
  }
}

// Arrow-key picker: scrollable list, navigate with ↑/↓ (or j/k),
// select with Enter, cancel with Esc/q/Ctrl-C. Returns chosen index or -1.
function pickFromList(title, items, current = 0) {
  return new Promise((resolve) => {
    if (!isTTY()) return resolve(-1);
    const n = items.length;
    let idx = Math.min(Math.max(0, current), n - 1);
    const ROWS = Math.min(n, 12);
    let start = 0;
    const adjust = () => {
      if (idx < start) start = idx;
      else if (idx >= start + ROWS) start = idx - ROWS + 1;
    };
    adjust();
    const prevRaw = process.stdin.isRaw;
    let drawn = false;

    const draw = () => {
      if (drawn) process.stdout.write(`\x1b[${ROWS + 1}A`);
      process.stdout.write("\r\x1b[J");
      process.stdout.write(
        s(title, T.accent, BOLD) + s("   ↑/↓ move · Enter select · Esc cancel", T.faint) + "\n",
      );
      for (let r = 0; r < ROWS; r++) {
        const i = start + r;
        const sel = i === idx;
        const scroll = (r === 0 && start > 0) ? s(" ↑", T.faint)
          : (r === ROWS - 1 && start + ROWS < n) ? s(" ↓", T.faint) : "";
        const ptr = sel ? s("❯ ", T.accent2, BOLD) : "  ";
        const txt = sel ? s(items[i], T.white, BOLD) : s(items[i], T.gray);
        process.stdout.write(ptr + txt + scroll + "\n");
      }
      drawn = true;
    };

    state.terminalBusy = true;
    state.rl.pause();
    try { process.stdin.setRawMode(true); } catch { /* ignore */ }
    process.stdin.resume();
    process.stdout.write("\x1b[?25l");
    draw();

    const finish = (val) => {
      process.stdin.removeListener("data", onKey);
      process.stdout.write(`\x1b[${ROWS + 1}A\r\x1b[J`);
      process.stdout.write("\x1b[?25h");
      try { process.stdin.setRawMode(!!prevRaw); } catch { /* ignore */ }
      state.terminalBusy = false;
      state.rl.resume();
      resolve(val);
    };

    const onKey = (buf) => {
      const k = buf.toString();
      if (k === "\x1b[A" || k === "\x1bOA" || k === "k") { idx = (idx - 1 + n) % n; adjust(); draw(); }
      else if (k === "\x1b[B" || k === "\x1bOB" || k === "j") { idx = (idx + 1) % n; adjust(); draw(); }
      else if (k === "\r" || k === "\n") finish(idx);
      else if (k === "\x03" || k === "q" || k === "\x1b") finish(-1);
    };
    process.stdin.on("data", onKey);
  });
}

// Warm up a local model with a spinner (local models load on first use).
async function loadModel() {
  let i = 0;
  process.stdout.write("\x1b[?25l");
  const timer = setInterval(() => {
    process.stdout.write(
      `\r${T.accent}${SPINNER[i++ % SPINNER.length]}${RESET} ${s(`loading ${state.currentModel}…`, T.faint)}`,
    );
  }, 80);
  try {
    await state.provider.streamChat({
      history: [{ role: "user", content: "Reply with: ready" }],
      onText: () => {},
    });
    clearInterval(timer);
    process.stdout.write("\r\x1b[K" + s(`✓ loaded ${state.currentModel}`, T.green) + "\n");
  } catch (e) {
    clearInterval(timer);
    process.stdout.write(
      "\r\x1b[K" + s(`model set to ${state.currentModel} (warm-up failed: ${e.message || e})`, T.yellow) + "\n",
    );
  } finally {
    process.stdout.write("\x1b[?25h");
  }
}

// Interactive arrow-key model picker, then activate the chosen model.
async function pickModel() {
  if (!state.provider) { warn("activate a provider first."); return; }
  if (!isTTY()) { warn("the picker needs an interactive terminal — use /model <id>."); return; }
  let ids;
  try { ids = await state.provider.listModels(); }
  catch (e) { err(`could not list models: ${e.message || e}`); return; }
  if (!ids.length) { warn("provider returned no models."); return; }
  ids = ids.slice().sort();
  const cur = Math.max(0, ids.indexOf(state.currentModel));
  const choice = await pickFromList(`select a model · ${state.provider.label}`, ids, cur);
  if (choice < 0) { info("model unchanged."); return; }
  const picked = ids[choice];
  try { await activate(state.currentName, picked); }
  catch (e) { err(e.message); return; }
  if (state.registry[state.currentName]?.local) await loadModel();
  else info(`model → ${state.currentModel}`);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function runSlash(input) {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help": case "/h":
      help(); return;
    case "/identity": case "/id":
      await Promise.all([state.infoReady, state.startupReady]); identity(); return;
    case "/context": case "/ctx":
      await state.infoReady;
      process.stdout.write(JSON.stringify(state.clientInfo, null, 2) + "\n"); return;
    case "/prompt":
      await state.infoReady; showPrompt(); return;
    case "/project":
      await state.projectReady; showProject(); return;
    case "/status":
      await state.startupReady; status(); return;
    case "/mode": {
      const target = arg || (state.mode === "build" ? "plan" : "build");
      if (!setMode(target)) { err(`unknown mode "${target}". Use: build | plan`); return; }
      rebuildSystemPrompt();
      info(`mode → ${s(state.mode, T.accent2, BOLD)} — ${MODES[state.mode].desc}`);
      safePrompt();
      return;
    }
    case "/todos": case "/todo":
      if (!state.todos?.length) { info("no todos yet."); return; }
      process.stdout.write("\n" + rule("todos", T.accent) + "\n" + renderTodos(state.todos) + "\n" + rule("", T.faint) + "\n");
      return;
    case "/servers": {
      const running = listServers();
      if (!running.length) { info("no background servers running."); return; }
      const rows = running.map((r) => s(`  pid ${String(r.pid).padEnd(7)}`, T.cyan, BOLD) + s(`${r.command}  (${r.cwd})`, T.gray));
      process.stdout.write("\n" + rule("background servers", T.accent) + "\n" + rows.join("\n") + "\n" + s("  stop one with /stop <pid>", T.faint) + "\n" + rule("", T.faint) + "\n");
      return;
    }
    case "/stop": {
      const r = stopServer(arg ? Number(arg) : undefined);
      if (r.ok) info(`stopped pid ${r.pid} (${r.command})`); else err(r.error);
      return;
    }
    case "/save": {
      try {
        const r = saveSession(arg || "default");
        info(`saved session "${r.name}" (${r.count} message${r.count === 1 ? "" : "s"})`);
      } catch (e) { err(`could not save: ${e.message}`); }
      return;
    }
    case "/resume": case "/load": {
      const target = arg || mostRecent();
      if (!target) { warn("no saved sessions. Use /save [name] first."); return; }
      try {
        const r = loadSession(target);
        rebuildSystemPrompt();
        info(`resumed "${r.name}" — ${r.count} message(s), mode ${state.mode}${r.model ? `, was on ${r.model}` : ""}`);
      } catch (e) { err(`could not resume "${target}": ${e.message}`); }
      safePrompt();
      return;
    }
    case "/sessions": {
      const list = listSessions();
      if (!list.length) { info("no saved sessions yet. Use /save [name]."); return; }
      const rows = list.map((x) =>
        s("  " + x.name.padEnd(20), T.cyan, BOLD) +
        s(`${String(x.count).padStart(4)} msg  `, T.white) +
        s(`${x.savedAt || "?"}  ${x.model || ""}`, T.gray));
      process.stdout.write("\n" + rule("sessions", T.accent) + "\n" + rows.join("\n") + "\n" + rule("", T.faint) + "\n");
      return;
    }
    case "/history":
      showHistory(); return;
    case "/providers":
      listProviders(); return;
    case "/models":
      await showModels(); return;
    case "/provider":
      if (!arg) { warn("usage: /provider <name>  (see /providers)"); return; }
      try {
        await activate(arg);
        state.history = [];
        info(`switched to ${state.provider.label} (${state.currentModel}); history cleared.`);
      } catch (e) { err(e.message); }
      return;
    case "/model":
      if (!state.provider) { warn("activate a provider first."); return; }
      if (!arg) { await pickModel(); return; }
      try {
        await activate(state.currentName, arg);
        if (state.registry[state.currentName]?.local) await loadModel();
        else info(`model → ${state.currentModel}`);
      } catch (e) { err(e.message); }
      return;
    case "/cron": {
      if (arg.startsWith("remove ")) {
        const name = arg.slice(7).trim();
        if (!name) { warn("usage: /cron remove <name>"); return; }
        try { await removeCronJob(name); info(`removed cron job "${name}".`); }
        catch (e) { err(e.message); }
      } else {
        try {
          const jobs = await listCronJobs();
          process.stdout.write("\n" + rule("cron jobs", T.accent) + "\n" + s(formatCronList(jobs), T.gray) + "\n" + rule("", T.faint) + "\n");
        } catch (e) { err(`cron list: ${e.message}`); }
      }
      return;
    }
    case "/mcp": {
      if (arg.startsWith("connect ")) {
        const rest = arg.slice(8).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx < 0) { warn("usage: /mcp connect <name> <spec>"); return; }
        const name = rest.slice(0, spaceIdx).trim();
        const spec = rest.slice(spaceIdx + 1).trim();
        info(`connecting to MCP server "${name}"…`);
        try {
          const tools = await connectMCP(name, spec);
          rebuildSystemPrompt();
          info(`connected: ${tools.length} tool(s) available from "${name}".`);
          tools.forEach((t) => process.stdout.write(s(`  • ${t.name}\n`, T.gray)));
        } catch (e) { err(`MCP connect: ${e.message}`); }
      } else if (arg.startsWith("disconnect ")) {
        const name = arg.slice(11).trim();
        await disconnectMCP(name);
        rebuildSystemPrompt();
        info(`disconnected from "${name}".`);
      } else if (arg.startsWith("refresh ")) {
        const name = arg.slice(8).trim();
        const { refreshTools } = await import("./mcp.js");
        try {
          const tools = await refreshTools(name);
          rebuildSystemPrompt();
          info(`refreshed: ${tools.length} tool(s) from "${name}".`);
        } catch (e) { err(e.message); }
      } else {
        process.stdout.write("\n" + rule("MCP servers", T.accent) + "\n" + s(listServersForDisplay(), T.gray) + "\n" + rule("", T.faint) + "\n");
      }
      return;
    }
    case "/refresh":
      try {
        [state.clientInfo, state.projectInfo] = await Promise.all([
          collectClientInfo(),
          collectProjectInfo(),
        ]);
        rebuildSystemPrompt();
        info("client_context and project map refreshed.");
      } catch (e) { err(`refresh: ${e.message}`); }
      return;
    case "/reset":
      state.history = [];
      info("conversation reset."); return;
    case "/clear":
      console.clear(); return;
    case "/exit": case "/quit": case "/q":
      state.rl.close(); return;
    default:
      warn(`unknown command ${cmd}. Try /help`); return;
  }
}
