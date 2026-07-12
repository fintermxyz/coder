// clientinfo.js — collect a JSON snapshot of the client machine that is sent to
// every AI model server as `client_context`, so the model tailors its commands
// to the user's actual OS, shell, resources, and installed tools.

import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";

const GB = 1024 ** 3;
const round = (n) => Math.round(n * 10) / 10;

function osType() {
  switch (process.platform) {
    case "darwin": return "mac";
    case "win32": return "windows";
    case "linux": return "linux";
    case "android": return "android";
    default: return process.platform;
  }
}

// Node generally runs on desktops/servers; Android (Termux) is the smartphone case.
function deviceClass() {
  if (process.platform === "android" || process.env.TERMUX_VERSION) return "smartphone";
  return "desktop";
}

async function diskInfo() {
  const probe = process.platform === "win32" ? process.cwd() : "/";
  try {
    if (typeof fsp.statfs !== "function") return null; // older Node
    const s = await fsp.statfs(probe);
    const total = s.blocks * s.bsize;
    const free = (s.bavail ?? s.bfree) * s.bsize;
    return { path: probe, totalGB: round(total / GB), freeGB: round(free / GB) };
  } catch {
    return null;
  }
}

// Candidate directories that hold runnable commands.
function commandDirs() {
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const defaults = process.platform === "win32"
    ? []
    : ["/usr/bin", "/bin", "/usr/local/bin", "/usr/sbin", "/sbin"];
  return [...new Set([...defaults, ...fromPath])];
}

// List the commands available to the user. The full list can be large and bloats
// the prompt (overflowing small local-model contexts), so we report the total
// count and a small capped, sorted sample. Override the cap with AI_SHELL_CMD_LIMIT.
async function commandsInfo(limit = Number(process.env.AI_SHELL_CMD_LIMIT) || 80) {
  const winExts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";").filter(Boolean)
    : null;
  const names = new Set();
  const usedDirs = [];
  for (const dir of commandDirs()) {
    let entries;
    try { entries = await fsp.readdir(dir); } catch { continue; }
    usedDirs.push(dir);
    for (const entry of entries) {
      if (winExts) {
        const ext = path.extname(entry).toLowerCase();
        if (!winExts.includes(ext)) continue;
        names.add(path.basename(entry, path.extname(entry)));
      } else {
        names.add(entry);
      }
    }
  }
  const all = [...names].sort();
  return {
    dirs: usedDirs,
    count: all.length,
    truncated: all.length > limit,
    list: all.slice(0, limit),
  };
}

export async function collectClientInfo() {
  let ui = {};
  try { ui = os.userInfo(); } catch { /* ignore */ }
  const cpus = os.cpus() || [];
  const [disk, commands] = await Promise.all([diskInfo(), commandsInfo()]);

  return {
    os: {
      type: osType(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: (() => { try { return os.version(); } catch { return undefined; } })(),
    },
    device: deviceClass(),
    host: os.hostname(),
    user: {
      name: ui.username,
      home: ui.homedir,
      shell: ui.shell || process.env.SHELL || process.env.COMSPEC || undefined,
    },
    memory: { totalGB: round(os.totalmem() / GB), freeGB: round(os.freemem() / GB) },
    cpu: { model: cpus[0]?.model?.trim(), cores: cpus.length },
    disk,
    commands,
    runtime: { node: process.version },
    collectedAt: new Date().toISOString(),
  };
}
