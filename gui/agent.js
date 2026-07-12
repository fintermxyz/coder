// gui/agent.js — headless, event-driven agent driver for the desktop GUI.
//
// Reuses coder's core (providers, tools, filetools, permissions, session) but,
// unlike src/chat.js, does NO terminal I/O. Instead it extends EventEmitter and
// emits structured events the Electron renderer turns into UI, and it asks for
// approval by emitting "approval-request" and awaiting resolveApproval().
//
// Events:
//   ready        {provider, model, mode}
//   status       "thinking" | "working · step N" | "subagent…"
//   token        <string delta>                (live streaming of assistant text)
//   assistant    <string>                      (a finalized assistant message)
//   tool-start   {id, type, title}             (a tool is about to run)
//   approval-request {id, type, title, cmd?, path?, diff?}
//   tool-result  {id, type, ok, output}
//   todos        [{content, status}]
//   mode         "build" | "plan"
//   error        <string>
//   done

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { buildRegistry, loadConfig, resolveDefault, createProvider } from "../providers.js";
import { collectClientInfo } from "../clientinfo.js";
import { collectProjectInfo } from "../src/projectinfo.js";
import { state, rebuildSystemPrompt, toolsEnabled, MAX_STEPS } from "../src/state.js";
import { buildToolSchemas, toolCallToAction } from "../src/tools.js";
import { deniedTypes, permissionFor, setMode } from "../src/permissions.js";
import { formatOneResult, resultsToText, parseActions } from "../src/actions.js";
import { readFile, prepareEdit, commitWrite, grepFiles, globFiles } from "../src/filetools.js";
import { execCommand } from "../src/exec.js";
import { webSearch, formatResults } from "../src/search.js";
import { browse } from "../src/browser.js";
import { addCronJob, listCronJobs, formatCronList } from "../src/cron.js";
import { callMCPTool } from "../src/mcp.js";
import { runSubagent } from "../src/subagent.js";
import { autosave, saveSession, loadSession, listSessions, mostRecent } from "../src/session.js";

const tail = (str, max = 6000) => {
  const t = (str || "").trim();
  return t.length > max ? "…(truncated)…\n" + t.slice(-max) : t;
};

// A short human title for a proposed action (shown in the UI card).
function titleFor(a) {
  switch (a.type) {
    case "run": return `$ ${a.cmd}`;
    case "write": return `write ${a.path}`;
    case "edit": return `edit ${a.path}`;
    case "read": return `read ${a.path}`;
    case "grep": return `grep /${a.pattern}/`;
    case "glob": return `glob ${a.pattern}`;
    case "search": return `search: ${a.query}`;
    case "browse": return `browse ${a.url}`;
    case "cron": return `cron [${a.schedule}] ${a.cmd}`;
    case "todo": return `update ${a.todos?.length || 0} todo(s)`;
    case "task": return `subagent: ${a.description || a.prompt || ""}`.slice(0, 80);
    case "mcp-call": return `mcp ${a.server}→${a.tool}`;
    default: return a.type;
  }
}

export class Agent extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map(); // approvalId -> resolve
    this.approvalSeq = 0;
    this.busy = false;
  }

  async init() {
    let config;
    try { config = loadConfig(); } catch { config = {}; }
    state.config = config;
    state.registry = buildRegistry(config);
    state.currentName = process.env.AI_PROVIDER || config.provider || resolveDefault(state.registry, config);
    state.currentModel = process.env.AI_MODEL || config.model || null;
    state.mode = process.env.AI_MODE || config.mode || "build";
    state.history = [];
    state.todos = [];
    state.provider = createProvider(state.currentName, state.registry, state.currentModel);

    // Enrich the system prompt in the background (non-blocking).
    state.infoReady = collectClientInfo().then((i) => { state.clientInfo = i; rebuildSystemPrompt(); }).catch(() => {});
    state.projectReady = collectProjectInfo().then((p) => { state.projectInfo = p; rebuildSystemPrompt(); }).catch(() => {});
    rebuildSystemPrompt();

    const info = { provider: state.currentName, model: state.currentModel, mode: state.mode };
    this.emit("ready", info);
    return info;
  }

  // ── UI-driven controls ──────────────────────────────────────────────────
  resolveApproval(id, decision) {
    const r = this.pending.get(id);
    if (r) { this.pending.delete(id); r(decision); }
  }

  setMode(mode) {
    if (setMode(mode)) { rebuildSystemPrompt(); this.emit("mode", state.mode); }
    return state.mode;
  }

  snapshot() {
    return {
      provider: state.currentName, model: state.currentModel, mode: state.mode,
      todos: state.todos || [], messages: state.history.length,
    };
  }

  newSession() {
    state.history = [];
    state.todos = [];
    this.emit("todos", []);
    return true;
  }

  sessions() { return listSessions(); }
  save(name) { return saveSession(name || "default"); }
  resume(name) {
    const target = name || mostRecent();
    if (!target) throw new Error("no saved sessions");
    const r = loadSession(target);
    rebuildSystemPrompt();
    this.emit("mode", state.mode);
    if (state.todos?.length) this.emit("todos", state.todos);
    return r;
  }

  // ── Main turn ─────────────────────────────────────────────────────────────
  async send(message) {
    if (this.busy) { this.emit("error", "still working on the previous message"); return; }
    this.busy = true;
    try { await this._run(message); }
    catch (e) { this.emit("error", e?.message || String(e)); }
    finally { this.busy = false; autosave(); this.emit("done"); }
  }

  async _run(message) {
    // Direct @general delegation, mirroring the CLI.
    const gen = message.match(/^@general\b\s*([\s\S]*)$/i);
    state.history.push({ role: "user", content: message });
    if (gen) {
      const task = gen[1].trim();
      if (!task) { this.emit("assistant", "usage: @general <task to investigate>"); return; }
      this.emit("status", "subagent…");
      const out = await runSubagent(task);
      state.history.push({ role: "assistant", content: out });
      this.emit("assistant", out);
      return;
    }

    const useTools = toolsEnabled();
    for (let step = 1; step <= MAX_STEPS; step++) {
      this.emit("status", step === 1 ? "thinking" : `working · step ${step}`);
      const tools = useTools ? buildToolSchemas(deniedTypes()) : null;
      const { text, toolCalls, refused } = await state.provider.streamChat({
        system: state.systemPrompt,
        history: state.history,
        onText: (d) => this.emit("token", d),
        tools,
      });
      if (refused) { this.emit("assistant", "(the model declined to respond)"); return; }

      const nativeCalls = useTools ? (toolCalls || []) : [];
      let actions = nativeCalls.map((tc) => ({ ...toolCallToAction(tc.name, tc.args), id: tc.id, toolName: tc.name }));
      let viaTool = actions.length > 0;
      if (!actions.length) { actions = parseActions(text); viaTool = false; } // model emitted fenced blocks

      state.history.push(
        viaTool
          ? { role: "assistant", content: text, toolCalls: nativeCalls }
          : { role: "assistant", content: text },
      );
      if (text && text.trim()) this.emit("assistant", text.trim());

      if (!actions.length) return;

      const results = await this._execute(actions);

      if (viaTool) {
        state.history.push({
          role: "tool",
          results: actions.map((a, i) => ({
            id: a.id, name: a.toolName,
            output: i < results.length ? formatOneResult(results[i]) : "(not run)",
          })),
        });
      } else if (results.length) {
        state.history.push({ role: "user", content: resultsToText(results) });
      }

      if (state.todos?.length) this.emit("todos", state.todos);
      const ranAny = results.some((r) => r.done);
      const aborted = results.some((r) => r.aborted);
      if (aborted || !ranAny) return;
    }
    this.emit("assistant", `(reached the ${MAX_STEPS}-step limit — send another message to continue)`);
  }

  // Ask the renderer to approve a destructive action; resolves "yes"/"no".
  // Register the pending resolver BEFORE emitting, so an approval that arrives
  // synchronously (fast renderer, or a test) can't race ahead of us.
  _approve(action, extra = {}) {
    const id = `ap${++this.approvalSeq}`;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.emit("approval-request", { id, type: action.type, title: titleFor(action), ...extra });
    });
  }

  // Execute the batch, one action at a time; returns results (offerActions shape).
  async _execute(actions) {
    const results = [];
    for (const act of actions) {
      const perm = permissionFor(act.type);
      if (perm === "deny") {
        this.emit("tool-result", { id: act.id, type: act.type, ok: false, output: `denied by ${state.mode} mode` });
        results.push({ type: act.type, path: act.path, done: false, error: `not permitted in ${state.mode} mode` });
        continue;
      }
      try {
        const r = await this._runOne(act, perm);
        results.push(r);
      } catch (e) {
        this.emit("tool-result", { id: act.id, type: act.type, ok: false, output: e.message });
        results.push({ type: act.type, done: false, error: e.message });
      }
    }
    return results;
  }

  async _runOne(act, perm) {
    const emitResult = (ok, output) => this.emit("tool-result", { id: act.id, type: act.type, ok, output: tail(output || "") });

    // Read-only tools: run immediately.
    if (act.type === "read") {
      const r = readFile(act); emitResult(r.ok, r.output);
      return { type: "read", path: act.path, output: r.output, done: r.ok };
    }
    if (act.type === "grep") {
      const r = grepFiles(act); emitResult(r.ok, r.output);
      return { type: "grep", pattern: act.pattern, output: r.output, done: r.ok };
    }
    if (act.type === "glob") {
      const r = globFiles(act); emitResult(r.ok, r.output);
      return { type: "glob", pattern: act.pattern, output: r.output, done: r.ok };
    }
    if (act.type === "search") {
      this.emit("tool-start", { id: act.id, type: act.type, title: titleFor(act) });
      try { const out = formatResults(act.query, await webSearch(act.query)); emitResult(true, out); return { type: "search", query: act.query, output: out, done: true }; }
      catch (e) { emitResult(false, e.message); return { type: "search", query: act.query, output: e.message, done: false }; }
    }
    if (act.type === "browse") {
      this.emit("tool-start", { id: act.id, type: act.type, title: titleFor(act) });
      try { const out = await browse(act.url); emitResult(true, out); return { type: "browse", url: act.url, output: out, done: true }; }
      catch (e) { emitResult(false, e.message); return { type: "browse", url: act.url, output: e.message, done: false }; }
    }
    if (act.type === "todo") {
      state.todos = act.todos;
      const plain = (act.todos || []).map((t) => `[${t.status}] ${t.content}`).join("\n");
      emitResult(true, plain); return { type: "todo", output: plain || "(empty)", done: true };
    }
    if (act.type === "task") {
      this.emit("status", "subagent…");
      this.emit("tool-start", { id: act.id, type: act.type, title: titleFor(act) });
      try { const out = await runSubagent(act.prompt); emitResult(true, out); return { type: "task", output: out, done: true }; }
      catch (e) { emitResult(false, e.message); return { type: "task", output: `Subagent failed: ${e.message}`, done: false }; }
    }
    if (act.type === "mcp-call") {
      if (perm === "ask" && (await this._approve(act)) !== "yes") { emitResult(false, "skipped"); return { type: "mcp-call", server: act.server, tool: act.tool, done: false }; }
      this.emit("tool-start", { id: act.id, type: act.type, title: titleFor(act) });
      try { const out = await callMCPTool(act.server, act.tool, act.args); emitResult(true, out); return { type: "mcp-call", server: act.server, tool: act.tool, output: out, done: true }; }
      catch (e) { emitResult(false, e.message); return { type: "mcp-call", server: act.server, tool: act.tool, error: e.message, done: false }; }
    }

    // Destructive tools: approve (unless policy says allow), then execute.
    if (act.type === "run") {
      if (perm === "ask" && (await this._approve(act)) !== "yes") { emitResult(false, "skipped"); return { type: "run", cmd: act.cmd, done: false }; }
      this.emit("tool-start", { id: act.id, type: act.type, title: titleFor(act) });
      const { code, output } = await execCommand(act.cmd);
      emitResult(code === 0, `exit ${code}\n${output || ""}`);
      return { type: "run", cmd: act.cmd, code, output, done: true };
    }
    if (act.type === "edit") {
      const prep = prepareEdit(act);
      if (!prep.ok) { emitResult(false, prep.error); return { type: "edit", path: act.path, done: false, error: prep.error }; }
      if (perm === "ask" && (await this._approve(act, { path: act.path, diff: { old: prep.oldContent, new: prep.newContent } })) !== "yes") {
        emitResult(false, "skipped"); return { type: "edit", path: act.path, done: false };
      }
      const w = commitWrite(prep.abs, prep.newContent);
      emitResult(w.ok, w.ok ? `edited ${act.path}` : w.error);
      return { type: "edit", path: act.path, done: w.ok, error: w.ok ? undefined : w.error };
    }
    if (act.type === "write") {
      if (!act.content || act.content.trim() === "") { emitResult(false, "empty write rejected"); return { type: "write", path: act.path, done: false, reason: "empty" }; }
      let old = null; try { old = readFile({ path: act.path, limit: 100000 }).ok ? require("node:fs").readFileSync(act.path, "utf8") : null; } catch { old = null; }
      if (perm === "ask" && (await this._approve(act, { path: act.path, diff: { old: old || "", new: act.content } })) !== "yes") {
        emitResult(false, "skipped"); return { type: "write", path: act.path, done: false };
      }
      const content = act.content.endsWith("\n") ? act.content : act.content + "\n";
      const w = commitWrite(require("node:path").resolve(process.cwd(), act.path), content);
      emitResult(w.ok, w.ok ? `wrote ${act.path}` : w.error);
      return { type: "write", path: act.path, done: w.ok, error: w.ok ? undefined : w.error };
    }
    if (act.type === "cron") {
      if (perm === "ask" && (await this._approve(act)) !== "yes") { emitResult(false, "skipped"); return { type: "cron", name: act.name, done: false }; }
      try { await addCronJob(act.name, act.schedule, act.cmd); const jobs = await listCronJobs(); emitResult(true, formatCronList(jobs)); return { type: "cron", name: act.name, schedule: act.schedule, cmd: act.cmd, output: formatCronList(jobs), done: true }; }
      catch (e) { emitResult(false, e.message); return { type: "cron", name: act.name, error: e.message, done: false }; }
    }

    emitResult(false, `unknown tool ${act.type}`);
    return { type: act.type || "unknown", done: false, error: `unknown tool "${act.type}"` };
  }
}
