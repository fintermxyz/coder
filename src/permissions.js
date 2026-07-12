// src/permissions.js — agent modes + per-tool permission policy (ported from
// opencode's build/plan agents and its allow|ask|deny permission config).
//
// A tool action resolves to one of: "allow" (run silently), "ask" (prompt Y/n),
// or "deny" (refuse). The base policy comes from the current MODE; an explicit
// config policy (.ai-shell.json "permissions") can tighten — but never loosen a
// mode's deny (so plan mode stays genuinely read-only).

import { state } from "./state.js";

export const MODES = {
  build: { label: "build", desc: "full access — asks before commands, writes, edits" },
  plan:  { label: "plan",  desc: "read-only — denies writes/edits, asks before commands" },
};

// Destructive tools ask before running in build mode.
const DESTRUCTIVE = new Set(["run", "write", "edit", "cron", "serve"]);

// Base allow/ask/deny for a tool action type, from the active mode.
function modePolicy(type) {
  if (state.mode === "plan") {
    if (type === "write" || type === "edit" || type === "cron" || type === "serve") return "deny";
    if (type === "run" || type === "mcp-call") return "ask";
    return "allow"; // read / grep / glob / search / browse / todo / question / task / stop_server
  }
  // build
  if (DESTRUCTIVE.has(type)) return "ask";
  return "allow"; // mcp-call preserves its historical no-prompt behavior in build
}

// Resolve the effective policy, letting config tighten (not loosen a mode deny).
export function permissionFor(type) {
  const base = modePolicy(type);
  const cfg = state.config?.permissions;
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, type)) {
    const v = cfg[type];
    if (v === "allow" || v === "ask" || v === "deny") {
      if (base === "deny") return "deny";          // mode deny is a floor
      if (base === "ask" && v === "allow") return "allow";
      if (base === "ask" && v === "deny") return "deny";
      if (base === "allow" && v !== "allow") return v; // config may tighten read-only
    }
  }
  return base;
}

// Action types that are fully denied right now — used to hide those tools from
// the model entirely so it doesn't waste a turn calling something it can't use.
export function deniedTypes() {
  const all = ["run", "write", "edit", "cron", "serve", "stop_server", "mcp-call", "read", "grep", "glob", "search", "browse", "todo", "question", "task"];
  const denied = new Set();
  for (const t of all) if (permissionFor(t) === "deny") denied.add(t);
  return denied;
}

export function setMode(mode) {
  if (!MODES[mode]) return false;
  state.mode = mode;
  return true;
}
