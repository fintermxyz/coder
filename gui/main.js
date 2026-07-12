// gui/main.js — Electron main process for the coder desktop app.
// Owns the headless Agent (gui/agent.js), forwards its events to the renderer,
// and exposes send / approve / mode / session controls over IPC.

import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win = null;
let agent = null;

// Agent events we relay to the renderer verbatim.
const FORWARD = [
  "ready", "status", "token", "assistant", "tool-start",
  "approval-request", "tool-result", "todos", "mode", "error", "done",
];

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#0e0f13",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function wireAgent() {
  agent = new Agent();
  for (const ev of FORWARD) {
    agent.on(ev, (payload) => win?.webContents.send("agent:event", { type: ev, payload }));
  }
}

app.whenReady().then(() => {
  wireAgent();
  createWindow();

  // Renderer signals it's ready → init the agent (which emits "ready").
  ipcMain.handle("agent:init", async () => agent.init());
  ipcMain.handle("agent:send", async (_e, text) => { agent.send(text); return true; });
  ipcMain.handle("agent:approve", async (_e, id, decision) => { agent.resolveApproval(id, decision); return true; });
  ipcMain.handle("agent:setMode", async (_e, mode) => agent.setMode(mode));
  ipcMain.handle("agent:snapshot", async () => agent.snapshot());
  ipcMain.handle("agent:new", async () => agent.newSession());
  ipcMain.handle("agent:sessions", async () => agent.sessions());
  ipcMain.handle("agent:save", async (_e, name) => agent.save(name));
  ipcMain.handle("agent:resume", async (_e, name) => agent.resume(name));
  ipcMain.handle("agent:servers", async () => {
    const { listServers } = await import("../src/exec.js");
    return listServers().map((r) => ({ pid: r.pid, command: r.command, cwd: r.cwd }));
  });

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
