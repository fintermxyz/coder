// src/session.js — persist and restore conversations to disk (ported from
// opencode's session persistence). A session captures the neutral history,
// todos, mode, and which provider/model was active. Stored as JSON under
// ~/.ai-shell/sessions/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { state } from "./state.js";

export const SESSIONS_DIR = path.join(os.homedir(), ".ai-shell", "sessions");
export const AUTOSAVE = "_autosave";

const sanitize = (name) => String(name || "default").replace(/[^\w.-]+/g, "_").slice(0, 64) || "default";
const fileFor = (name) => path.join(SESSIONS_DIR, sanitize(name) + ".json");

export function saveSession(name) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const data = {
    version: 1,
    savedAt: new Date().toISOString(),
    provider: state.currentName,
    model: state.currentModel,
    mode: state.mode,
    todos: state.todos || [],
    history: state.history || [],
  };
  const file = fileFor(name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { file, name: sanitize(name), count: data.history.length };
}

export function loadSession(name) {
  const file = fileFor(name);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  state.history = Array.isArray(data.history) ? data.history : [];
  state.todos = Array.isArray(data.todos) ? data.todos : [];
  if (data.mode) state.mode = data.mode;
  return { name: sanitize(name), count: state.history.length, savedAt: data.savedAt, provider: data.provider, model: data.model, mode: data.mode };
}

export function listSessions() {
  let files;
  try { files = fs.readdirSync(SESSIONS_DIR); } catch { return []; }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const p = path.join(SESSIONS_DIR, f);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* corrupt */ }
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch { /* gone */ }
      return {
        name: f.replace(/\.json$/, ""),
        savedAt: meta.savedAt,
        count: Array.isArray(meta.history) ? meta.history.length : 0,
        model: meta.model,
        mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Name of the most recently written session (used by /resume with no argument).
export function mostRecent() {
  return listSessions()[0]?.name || null;
}

// Best-effort autosave; never throws into the chat loop.
export function autosave() {
  try { saveSession(AUTOSAVE); } catch { /* ignore */ }
}
