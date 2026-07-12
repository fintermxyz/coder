// Shell command execution: cd, interrupt, run-and-capture, user-local commands.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { s, T } from "../theme.js";
import { state } from "./state.js";
import { err, info } from "./log.js";

// Handle a *bare* `cd` in-process (chdir). Returns a { code, output } result if
// it handled the command, or null to let the shell run it. Crucially, a command
// that chains/pipes/redirects (e.g. `cd foo && npm i`) is NOT treated as a bare
// cd — it's passed to the shell so it runs correctly in a subshell.
export function tryChdir(cmd) {
  const t = cmd.trim();
  if (t !== "cd" && !t.startsWith("cd ")) return null;
  if (/[;&|\n<>`]|\$\(/.test(t)) return null; // has shell operators → let the shell handle it
  let target = t === "cd" ? os.homedir() : t.slice(3).trim().replace(/^["']|["']$/g, "");
  if (target === "") target = os.homedir();
  const dest = target.startsWith("~")
    ? path.join(os.homedir(), target.slice(1))
    : path.resolve(process.cwd(), target);
  try {
    process.chdir(dest);
    return { code: 0, output: `cwd is now ${process.cwd()}` };
  } catch (e) {
    err(`cd: ${e.message}`);
    return { code: 1, output: `cd: ${e.message}` };
  }
}

// Send SIGINT (then SIGKILL on second press) to the running command.
// Returns true if there was an active command to interrupt.
export function interruptActive() {
  const c = state.activeChild;
  if (!c) return false;
  const sig = (signame) => {
    try { process.kill(-c.pid, signame); } catch { try { c.kill(signame); } catch { /* gone */ } }
  };
  if (c.__interrupting) {
    process.stdout.write(s("\n^C force-killing…\n", T.red));
    sig("SIGKILL");
    return true;
  }
  c.__interrupting = true;
  process.stdout.write(s("\n^C interrupting… (Ctrl-C again to force-kill)\n", T.yellow));
  sig("SIGINT");
  setTimeout(() => { if (state.activeChild === c) sig("SIGKILL"); }, 2000);
  return true;
}

// Strip terminal control sequences so captured output is readable to the model.
export function stripCtl(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\r/g, "");
}

// Run a shell command, streaming output live and capturing it.
// On a TTY: runs in its own process group, raw-mode keystrokes allow Ctrl-C.
// `forwardInput` (the `!` path) pipes keystrokes to the child for interactive use.
export function execCommand(command, { forwardInput = false } = {}) {
  return new Promise((resolve) => {
    const cd = tryChdir(command);
    if (cd) return resolve(cd);
    const shell = process.env.SHELL || "/bin/sh";
    const tty = process.stdout.isTTY && process.stdin.isTTY;
    // Interactive keystroke/raw-mode handling only makes sense in the CLI REPL,
    // which owns a readline interface. In the GUI (Electron) there is no state.rl,
    // so we must NOT touch stdin raw mode / rl — doing so crashed with
    // "Cannot read properties of null (reading 'pause')".
    const interactive = tty && !!state.rl;

    const child = spawn(shell, ["-c", command], {
      stdio: [forwardInput && interactive ? "pipe" : "ignore", "pipe", "pipe"],
      detached: interactive,
    });
    state.activeChild = child;

    let output = "";
    const MAX = 200_000;
    const sink = (d) => { if (interactive) process.stdout.write(d); if (output.length < MAX) output += d; };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);

    let onKey = null;
    let prevRaw = null;
    if (interactive) {
      state.terminalBusy = true;
      prevRaw = process.stdin.isRaw;
      try { process.stdin.setRawMode(true); } catch { /* ignore */ }
      state.rl.pause();
      process.stdin.resume();
      onKey = (buf) => {
        if (buf.length === 1 && buf[0] === 0x03) { interruptActive(); return; }
        if (forwardInput && child.stdin && !child.stdin.destroyed) {
          try { child.stdin.write(buf); } catch { /* exited */ }
        }
      };
      process.stdin.on("data", onKey);
    }

    const done = (code) => {
      state.activeChild = null;
      if (interactive) {
        if (onKey) process.stdin.removeListener("data", onKey);
        try { process.stdin.setRawMode(!!prevRaw); } catch { /* ignore */ }
        state.terminalBusy = false;
        state.rl.resume();
      }
      resolve({ code: code ?? 0, output: stripCtl(output) });
    };
    child.on("error", (e) => { err(`shell error: ${e.message}`); done(1); });
    child.on("close", done);
  });
}

// The `!` path: run a user command with forwarded keystrokes, no approval needed.
export async function runLocal(command) {
  const { code } = await execCommand(command, { forwardInput: true });
  if (code && code !== 0) info(`[exit ${code}]`);
}

// ── Background servers ────────────────────────────────────────────────────────
// Start a long-running process (dev server, watcher) detached from the REPL so it
// doesn't block. Captures the first few seconds of output (usually the URL) and
// returns without waiting for it to exit. Tracked in state.servers so it can be
// listed and stopped.
export function startServer(command, { cwd, warmupMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    let child;
    try {
      child = spawn(shell, ["-c", command], {
        cwd: cwd ? path.resolve(process.cwd(), cwd) : process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group so we can kill the whole tree later
      });
    } catch (e) {
      return resolve({ ok: false, output: `could not start: ${e.message}` });
    }

    let output = "";
    const sink = (d) => { if (output.length < 8000) output += d.toString(); };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);

    const rec = { pid: child.pid, command, cwd: cwd || process.cwd(), child, startedAt: Date.now(), exitCode: null };
    state.servers = state.servers || [];
    state.servers.push(rec);

    let exited = false;
    // On a signal kill `code` is null — record a non-null code so listServers()
    // (which treats exitCode === null as "still running") doesn't resurrect it.
    child.on("exit", (code, signal) => { exited = true; rec.exitCode = code != null ? code : (signal ? 143 : 0); });
    child.on("error", (e) => { exited = true; rec.exitCode = rec.exitCode ?? 1; output += `\n[error: ${e.message}]`; });

    setTimeout(() => {
      resolve({
        ok: !exited,
        pid: child.pid,
        exitCode: rec.exitCode,
        output: stripCtl(output) || "(no output yet)",
      });
    }, warmupMs);
  });
}

export function listServers() {
  return (state.servers || []).filter((r) => r.exitCode === null);
}

export function stopServer(pid) {
  const list = state.servers || [];
  const rec = list.find((r) => r.pid === pid && r.exitCode === null)
    || (pid == null ? list.filter((r) => r.exitCode === null).at(-1) : null);
  if (!rec) return { ok: false, error: `no running server with pid ${pid}` };
  try { process.kill(-rec.pid, "SIGTERM"); } catch { try { rec.child.kill("SIGTERM"); } catch { /* gone */ } }
  rec.exitCode = rec.exitCode ?? -15;
  return { ok: true, pid: rec.pid, command: rec.command };
}
