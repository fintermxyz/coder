// Parse model-suggested ```run / ```write / ```search / ```browse blocks and execute them.

import fs from "node:fs";
import path from "node:path";
import { s, T, BOLD, rule, box } from "../theme.js";
import { state } from "./state.js";
import { execCommand, startServer, stopServer } from "./exec.js";
import { decide, ask } from "./input.js";
import { warn, info } from "./log.js";
import { webSearch, formatResults } from "./search.js";
import { browse } from "./browser.js";
import { addCronJob, listCronJobs, formatCronList } from "./cron.js";
import { callMCPTool } from "./mcp.js";
import { readFile, prepareEdit, commitWrite, grepFiles, globFiles } from "./filetools.js";
import { permissionFor } from "./permissions.js";
import { runSubagent } from "./subagent.js";

// Render a todo list with status glyphs (also used for the tool-result text).
export function renderTodos(todos) {
  const glyph = { completed: "✓", in_progress: "▸", pending: "○" };
  return (todos || []).map((t) => {
    const g = glyph[t.status] || "○";
    const color = t.status === "completed" ? T.green : t.status === "in_progress" ? T.teal : T.faint;
    return s(`  ${g} ${t.content}`, color);
  }).join("\n") || s("  (empty)", T.faint);
}

// Parse ```run and ```write fenced blocks into action objects:
//   { type: "run",   cmd }
//   { type: "write", path, content }
export function parseActions(text) {
  const actions = [];
  const addBlock = (lang, meta, body) => {
    lang = (lang || "").toLowerCase();
    body = body.replace(/\n+$/, "");
    if (lang === "run") {
      for (const line of body.split("\n")) {
        const cmd = line.trim();
        if (cmd && !cmd.startsWith("#")) actions.push({ type: "run", cmd });
      }
    } else if (lang === "write" || lang === "file") {
      let p = ((meta || "").match(/path\s*=\s*(.+)$/)?.[1] ?? meta ?? "").trim();
      p = p.replace(/^["']|["']$/g, "");
      if (p) actions.push({ type: "write", path: p, content: body });
    } else if (lang === "search") {
      const q = body.trim();
      if (q) actions.push({ type: "search", query: q });
    } else if (lang === "browse") {
      const url = body.trim();
      if (url) actions.push({ type: "browse", url });
    } else if (lang === "cron") {
      // info string: name=<name> schedule=<cron-expr>  body: the command to run
      const nameM = (meta || "").match(/name=([^\s]+)/);
      const schedM = (meta || "").match(/schedule=(.+)$/);
      const name = nameM?.[1];
      const schedule = schedM?.[1]?.trim();
      const cmd = body.trim();
      if (name && schedule && cmd) actions.push({ type: "cron", name, schedule, cmd });
    } else if (lang === "mcp-call") {
      // body lines: "server: <name>", "tool: <tool>", then JSON args
      const serverM = body.match(/^server:\s*(.+)$/m);
      const toolM   = body.match(/^tool:\s*(.+)$/m);
      const jsonM   = body.match(/(\{[\s\S]*\})/);
      const server  = serverM?.[1]?.trim();
      const tool    = toolM?.[1]?.trim();
      let args = {};
      if (jsonM) { try { args = JSON.parse(jsonM[1]); } catch { /* invalid json */ } }
      if (server && tool) actions.push({ type: "mcp-call", server, tool, args });
    }
  };

  const fence = /```([A-Za-z0-9_-]+)([^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) addBlock(m[1], m[2], m[3]);

  // Fallback for Mistral/devstral [TOOL_CALLS] token format.
  if (!actions.length) {
    const tc = /\[TOOL_CALLS\]\s*(run|write|file)\b([^\n]*)\n([\s\S]*?)(?=```|\[TOOL_CALLS\]|$)/g;
    while ((m = tc.exec(text)) !== null) addBlock(m[1], m[2], m[3]);
  }

  return actions.slice(0, 30);
}

// Trim long output so it doesn't blow up the model context.
export function tail(out, max = 4000) {
  const t = (out || "").trim();
  return t.length > max ? "…(truncated)…\n" + t.slice(-max) : t;
}

// LCS line diff → array of ["+"|"-"|" ", line].
export function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([" ", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(["-", a[i]]); i++; }
    else { out.push(["+", b[j]]); j++; }
  }
  while (i < n) out.push(["-", a[i++]]);
  while (j < m) out.push(["+", b[j++]]);
  return out;
}

// Render a colored, context-collapsed diff between two file contents.
export function renderDiff(oldStr, newStr) {
  const a = oldStr.replace(/\n$/, "").split("\n");
  const b = newStr.replace(/\n$/, "").split("\n");
  if (a.length * b.length > 4_000_000) {
    return { adds: b.length, dels: a.length, text: s("  (large file — diff suppressed)", T.faint) };
  }
  const ops = lcsDiff(a, b);
  let adds = 0, dels = 0;
  for (const [t] of ops) { if (t === "+") adds++; else if (t === "-") dels++; }
  const ctx = 3;
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++)
    if (ops[i][0] !== " ")
      for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) keep[k] = true;
  const out = [];
  let gap = false;
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      const [t, line] = ops[i];
      const color = t === "+" ? T.green : t === "-" ? T.red : T.faint;
      out.push(s(`${t} `, color) + s(line, color));
      gap = false;
    } else if (!gap) { out.push(s("  ⋮", T.faint)); gap = true; }
  }
  return { adds, dels, text: out.join("\n") };
}

// Preview a write action: full listing for new files, diff for existing ones.
export function previewWrite(action) {
  const abs = path.resolve(process.cwd(), action.path);
  let oldContent = null;
  try { oldContent = fs.readFileSync(abs, "utf8"); } catch { /* new file */ }

  if (oldContent === null) {
    const lines = action.content.split("\n");
    const head = `write ${action.path} (new file · ${lines.length} line${lines.length === 1 ? "" : "s"})`;
    const shown = lines.slice(0, 40).map((l) => s("+ " + l, T.green));
    if (lines.length > 40) shown.push(s(`  … +${lines.length - 40} more lines`, T.faint));
    process.stdout.write("\n" + rule(head, T.accent2) + "\n" + shown.join("\n") + "\n");
  } else {
    const d = renderDiff(oldContent, action.content);
    process.stdout.write(
      "\n" + rule(`edit ${action.path} (+${d.adds} −${d.dels})`, T.accent2) + "\n" + d.text + "\n",
    );
  }
}

// Write a file to disk (creating parent directories as needed).
export function applyWrite(action) {
  const abs = path.resolve(process.cwd(), action.path);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = action.content.endsWith("\n") ? action.content : action.content + "\n";
    fs.writeFileSync(abs, content);
    return { ok: true, abs };
  } catch (e) {
    return { ok: false, abs, error: e.message };
  }
}

// Preview each suggested action, ask for approval, execute approved ones, then
// feed results back into history so the model can continue multi-step tasks.
// Returns { ranAny, aborted }.
export async function offerActions(actions) {
  process.stdout.write(
    "\n" + rule(`suggested ${actions.length} action(s)`, T.accent2) + "\n",
  );
  const results = [];
  let aborted = false;

  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];
    const idx = s(`[${i + 1}/${actions.length}]`, T.faint);

    // Permission policy (mode + config): deny blocks; allow skips the Y/n prompt.
    const perm = permissionFor(act.type);
    if (perm === "deny") {
      const what = act.cmd || act.path || act.pattern || act.tool || act.type;
      process.stdout.write("\n" + box([`${idx}  ${s(`⊘ ${act.type} ${what}`, T.white, BOLD)}`], T.yellow) + "\n");
      process.stdout.write(s(`  denied by ${state.mode} mode\n`, T.yellow));
      results.push({ type: act.type, path: act.path, done: false, error: `not permitted in ${state.mode} mode` });
      continue;
    }
    // "allow" auto-approves destructive actions (no Y/n); "ask" prompts as usual.
    const approve = async (q) => (perm === "allow" ? "yes" : await decide(q));

    if (act.type === "run") {
      process.stdout.write(
        "\n" + box([`${idx}  ${s("$ " + act.cmd, T.white, BOLD)}`], T.accent2) + "\n",
      );
      const d = await approve(s("  run this? ", T.green, BOLD) + s("[Y/n] ", T.faint));
      if (d === "abort") { aborted = true; process.stdout.write(s("  ✗ aborted\n", T.yellow)); break; }
      if (d === "yes") {
        process.stdout.write(s("  ↳ running…", T.teal) + s("  (Ctrl-C to cancel)\n", T.faint));
        const { code, output } = await execCommand(act.cmd);
        process.stdout.write(s(`  ${code === 0 ? "✓" : "✗"} exit ${code}\n`, code === 0 ? T.green : T.red));
        const killedBySignal = code === 130 || code === 137 || code === -2 || code === -9;
        const runResult = {
          type: "run", cmd: act.cmd, code,
          output: killedBySignal ? "(stopped by user — Ctrl-C)" : output,
          done: true,
        };
        results.push(runResult);

        // Auto-search on failure: if the command failed with a real error (not SIGINT/SIGKILL).
        // Folded into the run result so results stay 1:1 with actions (needed to map
        // each native tool_call back to exactly one tool result).
        if (code !== 0 && !killedBySignal && output) {
          const errLine = output.split("\n").find((l) => /error|Error|ERR|failed|FAIL/i.test(l))?.trim()
            || output.slice(-200).trim();
          const ci = state.clientInfo;
          const ctx = [
            ci?.os?.type && `OS: ${ci.os.type}`,
            ci?.runtime?.node && `Node: ${ci.runtime.node}`,
          ].filter(Boolean).join(", ");
          const query = `${errLine} ${ctx} fix`.trim();
          process.stdout.write(s(`  🔍 command failed — searching: "${query}"\n`, T.faint));
          try {
            const searchResults = await webSearch(query);
            const formatted = formatResults(query, searchResults);
            runResult.output += `\n\n[auto-searched the web for this failure: "${query}"]\n${formatted}`;
          } catch (e) {
            runResult.output += `\n\n[auto-search after failure failed: ${e.message}]`;
          }
        }
      } else {
        process.stdout.write(s("  ⊘ skipped\n", T.yellow));
        results.push({ type: "run", cmd: act.cmd, done: false });
      }
    } else if (act.type === "search") {
      process.stdout.write(
        "\n" + box([`${idx}  ${s("🔍 search: " + act.query, T.white, BOLD)}`], T.accent2) + "\n",
      );
      process.stdout.write(s("  ↳ searching…\n", T.teal));
      try {
        const searchResults = await webSearch(act.query);
        const formatted = formatResults(act.query, searchResults);
        process.stdout.write(s(`  ✓ got ${searchResults.length} result(s)\n`, T.green));
        results.push({ type: "search", query: act.query, output: formatted, done: true });
      } catch (e) {
        process.stdout.write(s(`  ✗ search failed: ${e.message}\n`, T.red));
        results.push({ type: "search", query: act.query, output: `Search failed: ${e.message}`, done: false });
      }
    } else if (act.type === "browse") {
      process.stdout.write(
        "\n" + box([`${idx}  ${s("🌐 browse: " + act.url, T.white, BOLD)}`], T.accent2) + "\n",
      );
      process.stdout.write(s("  ↳ loading page…\n", T.teal));
      try {
        const content = await browse(act.url);
        process.stdout.write(s("  ✓ page loaded\n", T.green));
        results.push({ type: "browse", url: act.url, output: content, done: true });
      } catch (e) {
        process.stdout.write(s(`  ✗ browse failed: ${e.message}\n`, T.red));
        results.push({ type: "browse", url: act.url, output: `Browse failed: ${e.message}`, done: false });
      }
    } else if (act.type === "cron") {
      process.stdout.write(
        "\n" + box([`${idx}  ${s(`⏰ cron: [${act.schedule}] ${act.cmd}`, T.white, BOLD)}`], T.accent2) + "\n",
      );
      process.stdout.write(s(`     name: ${act.name}\n`, T.faint));
      const d = await approve(s("  schedule this? ", T.green, BOLD) + s("[Y/n] ", T.faint));
      if (d === "abort") { aborted = true; process.stdout.write(s("  ✗ aborted\n", T.yellow)); break; }
      if (d === "yes") {
        try {
          await addCronJob(act.name, act.schedule, act.cmd);
          const jobs = await listCronJobs();
          process.stdout.write(s(`  ✓ cron job "${act.name}" scheduled\n`, T.green));
          results.push({ type: "cron", name: act.name, schedule: act.schedule, cmd: act.cmd,
            output: formatCronList(jobs), done: true });
        } catch (e) {
          process.stdout.write(s(`  ✗ ${e.message}\n`, T.red));
          results.push({ type: "cron", name: act.name, error: e.message, done: false });
        }
      } else {
        process.stdout.write(s("  ⊘ skipped\n", T.yellow));
        results.push({ type: "cron", name: act.name, done: false });
      }
    } else if (act.type === "mcp-call") {
      process.stdout.write(
        "\n" + box([`${idx}  ${s(`⚡ mcp: ${act.server} → ${act.tool}`, T.white, BOLD)}`], T.accent2) + "\n",
      );
      if (Object.keys(act.args).length)
        process.stdout.write(s("     args: " + JSON.stringify(act.args) + "\n", T.faint));
      process.stdout.write(s("  ↳ calling…\n", T.teal));
      try {
        const output = await callMCPTool(act.server, act.tool, act.args);
        process.stdout.write(s("  ✓ done\n", T.green));
        // Show a preview of the result inline so the user (and model) can see it.
        const previewLines = output.split("\n").slice(0, 12);
        const clipped = previewLines.join("\n").slice(0, 500);
        const suffix = (output.length > 500 || output.split("\n").length > 12) ? "\n     …" : "";
        if (clipped) process.stdout.write(
          clipped.split("\n").map((l) => s("     " + l, T.faint)).join("\n") + suffix + "\n",
        );
        results.push({ type: "mcp-call", server: act.server, tool: act.tool, output, done: true });
      } catch (e) {
        process.stdout.write(s(`  ✗ ${e.message}\n`, T.red));
        results.push({ type: "mcp-call", server: act.server, tool: act.tool, error: e.message, done: false });
      }
    } else if (act.type === "read") {
      process.stdout.write("\n" + box([`${idx}  ${s("📖 read " + act.path, T.white, BOLD)}`], T.accent2) + "\n");
      const r = readFile(act);
      process.stdout.write(s(r.ok ? "  ✓ read\n" : `  ✗ ${r.output}\n`, r.ok ? T.green : T.red));
      results.push({ type: "read", path: act.path, output: r.output, done: r.ok });
    } else if (act.type === "grep") {
      process.stdout.write("\n" + box([`${idx}  ${s("🔎 grep /" + act.pattern + "/", T.white, BOLD)}`], T.accent2) + "\n");
      const r = grepFiles(act);
      process.stdout.write(s(r.ok ? `  ✓ ${r.count ?? 0} match(es)\n` : `  ✗ ${r.output}\n`, r.ok ? T.green : T.red));
      results.push({ type: "grep", pattern: act.pattern, output: r.output, done: r.ok });
    } else if (act.type === "glob") {
      process.stdout.write("\n" + box([`${idx}  ${s("📁 glob " + act.pattern, T.white, BOLD)}`], T.accent2) + "\n");
      const r = globFiles(act);
      process.stdout.write(s(r.ok ? `  ✓ ${r.count ?? 0} file(s)\n` : `  ✗ ${r.output}\n`, r.ok ? T.green : T.red));
      results.push({ type: "glob", pattern: act.pattern, output: r.output, done: r.ok });
    } else if (act.type === "todo") {
      const rendered = renderTodos(act.todos);
      process.stdout.write("\n" + rule("todos", T.accent2) + "\n" + rendered + "\n");
      state.todos = act.todos;
      const plain = (act.todos || []).map((t) => `[${t.status}] ${t.content}`).join("\n");
      results.push({ type: "todo", output: plain || "(empty)", done: true });
    } else if (act.type === "serve") {
      process.stdout.write(
        "\n" + box([`${idx}  ${s("🚀 serve: " + act.cmd + (act.cwd ? `  (in ${act.cwd})` : ""), T.white, BOLD)}`], T.accent2) + "\n",
      );
      const d = await approve(s("  start this server in the background? ", T.green, BOLD) + s("[Y/n] ", T.faint));
      if (d === "abort") { aborted = true; process.stdout.write(s("  ✗ aborted\n", T.yellow)); break; }
      if (d === "yes") {
        process.stdout.write(s("  ↳ starting…\n", T.teal));
        const r = await startServer(act.cmd, { cwd: act.cwd });
        if (r.ok) process.stdout.write(s(`  ✓ running (pid ${r.pid}) — stop with stop_server / Ctrl-C won't affect it\n`, T.green));
        else process.stdout.write(s(`  ✗ server exited (code ${r.exitCode})\n`, T.red));
        results.push({ type: "serve", cmd: act.cmd, pid: r.pid, output: r.output, done: r.ok, exitCode: r.exitCode });
      } else {
        process.stdout.write(s("  ⊘ skipped\n", T.yellow));
        results.push({ type: "serve", cmd: act.cmd, done: false });
      }
    } else if (act.type === "stop_server") {
      const r = stopServer(act.pid);
      process.stdout.write(
        "\n" + box([`${idx}  ${s("🛑 stop server " + (act.pid ?? "(latest)"), T.white, BOLD)}`], T.accent2) + "\n",
      );
      process.stdout.write(s(r.ok ? `  ✓ stopped pid ${r.pid}\n` : `  ✗ ${r.error}\n`, r.ok ? T.green : T.red));
      results.push({ type: "stop_server", output: r.ok ? `stopped pid ${r.pid} (${r.command})` : r.error, done: r.ok });
    } else if (act.type === "task") {
      const title = (act.description || act.prompt || "").slice(0, 60);
      process.stdout.write("\n" + box([`${idx}  ${s("🤖 subagent: " + title, T.white, BOLD)}`], T.accent2) + "\n");
      process.stdout.write(s("  ↳ investigating (read-only)…\n", T.teal));
      try {
        const out = await runSubagent(act.prompt);
        process.stdout.write(s("  ✓ subagent finished\n", T.green));
        results.push({ type: "task", output: out, done: true });
      } catch (e) {
        process.stdout.write(s(`  ✗ ${e.message}\n`, T.red));
        results.push({ type: "task", output: `Subagent failed: ${e.message}`, done: false });
      }
    } else if (act.type === "question") {
      process.stdout.write("\n" + box([`${idx}  ${s("❓ " + act.question, T.white, BOLD)}`], T.accent2) + "\n");
      const answer = await ask(s("  your answer: ", T.green, BOLD));
      if (answer === null) { aborted = true; process.stdout.write(s("  ✗ aborted\n", T.yellow)); break; }
      results.push({ type: "question", question: act.question, output: `The user answered: ${String(answer).trim()}`, done: true });
    } else if (act.type === "edit") {
      process.stdout.write("\n" + box([`${idx}  ${s("✎ edit " + act.path, T.white, BOLD)}`], T.accent2) + "\n");
      const prep = prepareEdit(act);
      if (!prep.ok) {
        process.stdout.write(s(`  ✗ ${prep.error}\n`, T.red));
        results.push({ type: "edit", path: act.path, done: false, error: prep.error });
        continue;
      }
      const d = renderDiff(prep.oldContent, prep.newContent);
      process.stdout.write("\n" + rule(`edit ${act.path} (+${d.adds} −${d.dels})`, T.accent2) + "\n" + d.text + "\n");
      const dec = await approve(s("  apply this edit? ", T.green, BOLD) + s("[Y/n] ", T.faint));
      if (dec === "abort") { aborted = true; process.stdout.write(s("  ✗ aborted\n", T.yellow)); break; }
      if (dec === "yes") {
        const w = commitWrite(prep.abs, prep.newContent);
        if (w.ok) {
          process.stdout.write(s(`  ✓ edited ${act.path}\n`, T.green));
          results.push({ type: "edit", path: act.path, done: true });
        } else {
          process.stdout.write(s(`  ✗ ${w.error}\n`, T.red));
          results.push({ type: "edit", path: act.path, error: w.error, done: false });
        }
      } else {
        process.stdout.write(s("  ⊘ skipped\n", T.yellow));
        results.push({ type: "edit", path: act.path, done: false });
      }
    } else if (act.type === "write") {
      process.stdout.write(
        "\n" + box([`${idx}  ${s("✎ write " + act.path, T.white, BOLD)}`], T.accent2) + "\n",
      );

      const abs = path.resolve(process.cwd(), act.path);
      let existing = null;
      try { existing = fs.readFileSync(abs, "utf8"); } catch { /* new file */ }
      const norm = (x) => (x ?? "").replace(/\s+$/g, "");

      if (act.content.trim() === "") {
        warn(`  empty write block — skipped (won't truncate ${act.path})`);
        results.push({ type: "write", path: act.path, done: false, reason: "empty" });
        continue;
      }
      if (existing !== null && norm(existing) === norm(act.content)) {
        info(`  no change — ${act.path} already has that content; skipped`);
        results.push({ type: "write", path: act.path, done: false, reason: "noop" });
        continue;
      }

      previewWrite(act);
      const d = await approve(s("  apply this? ", T.green, BOLD) + s("[Y/n] ", T.faint));
      if (d === "abort") { aborted = true; process.stdout.write(s("  ✗ aborted\n", T.yellow)); break; }
      if (d === "yes") {
        const r = applyWrite(act);
        if (r.ok) {
          process.stdout.write(s(`  ✓ wrote ${act.path}\n`, T.green));
          results.push({ type: "write", path: act.path, done: true });
        } else {
          process.stdout.write(s(`  ✗ ${r.error}\n`, T.red));
          results.push({ type: "write", path: act.path, error: r.error, done: false });
        }
      } else {
        process.stdout.write(s("  ⊘ skipped\n", T.yellow));
        results.push({ type: "write", path: act.path, done: false });
      }
    } else {
      // Unknown / unsupported action type (e.g. a tool name the model invented).
      // Record an error so the tool_call still gets a result and the model can retry.
      warn(`  unknown action type "${act.type}" — skipped`);
      results.push({ type: act.type || "unknown", done: false, error: `unknown tool "${act.type}"` });
    }
  }

  const done = results.filter((r) => r.done);
  process.stdout.write(rule("", T.faint) + "\n");
  return { ranAny: done.length > 0, aborted, results };
}

// Render a single action result as feedback text for the model. Used both for the
// native tool path (one string per tool_call) and the fenced-block fallback.
export function formatOneResult(r) {
  if (r.type === "run") {
    return r.done ? `$ ${r.cmd}\n${tail(r.output)}\n(exit ${r.code})` : `$ ${r.cmd}\n(skipped by user)`;
  }
  if (r.type === "search") {
    return r.done ? `Search: "${r.query}"\n${r.output}` : `Search failed for "${r.query}": ${r.output}`;
  }
  if (r.type === "browse") {
    return r.done ? `Browse: ${r.url}\n${r.output}` : `Browse failed for ${r.url}: ${r.output}`;
  }
  if (r.type === "cron") {
    if (r.done) return `Cron job "${r.name}" scheduled [${r.schedule}]: ${r.cmd}\nAll jobs:\n${r.output}`;
    if (r.error) return `Failed to schedule cron "${r.name}": ${r.error}`;
    return `Cron job "${r.name}" skipped by user.`;
  }
  if (r.type === "mcp-call") {
    if (r.done) return `MCP ${r.server}→${r.tool} result:\n${r.output}`;
    return `MCP ${r.server}→${r.tool} failed: ${r.error}`;
  }
  if (r.type === "read") {
    return r.done ? `Contents of ${r.path}:\n${tail(r.output, 8000)}` : `Failed to read ${r.path}: ${r.output}`;
  }
  if (r.type === "grep") {
    return r.done ? `grep /${r.pattern}/ results:\n${tail(r.output, 6000)}` : `grep failed: ${r.output}`;
  }
  if (r.type === "glob") {
    return r.done ? `glob ${r.pattern} results:\n${tail(r.output, 6000)}` : `glob failed: ${r.output}`;
  }
  if (r.type === "todo") {
    return `Todo list updated:\n${r.output}`;
  }
  if (r.type === "question") {
    return r.output;
  }
  if (r.type === "task") {
    return r.done ? `Subagent result:\n${r.output}` : r.output;
  }
  if (r.type === "serve") {
    if (r.done) return `Server started (pid ${r.pid}) and is running in the background. First output:\n${tail(r.output, 3000)}\nUse stop_server to stop it. Do NOT run it again.`;
    return r.exitCode != null ? `Server command exited immediately (code ${r.exitCode}):\n${tail(r.output || "", 2000)}` : `did not start server (user skipped)`;
  }
  if (r.type === "stop_server") {
    return r.output;
  }
  if (r.type === "edit") {
    if (r.done) return `edited ${r.path}`;
    if (r.error) return `edit failed for ${r.path}: ${r.error}`;
    return `did not edit ${r.path} (user skipped)`;
  }
  if (r.type === "write") {
    if (r.done) return `wrote file ${r.path}`;
    if (r.error) return `failed to write ${r.path}: ${r.error}`;
    if (r.reason === "empty") return `the write for ${r.path} was EMPTY and was rejected. Re-send it containing the COMPLETE file contents.`;
    if (r.reason === "noop") return `${r.path} already contains exactly that content — no change was needed. Do NOT re-write it; continue to the next step.`;
    return `did not write ${r.path} (user skipped)`;
  }
  // unknown / unsupported action
  return r.error ? `${r.type}: ${r.error}` : `${r.type}: done`;
}

// Combine all results into a single user-message note (fenced-block fallback path).
export function resultsToText(results) {
  return `Action results:\n\n${results.map(formatOneResult).join("\n\n")}`;
}
