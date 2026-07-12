// gui/preload.js — safe bridge exposed to the renderer as window.coder.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coder", {
  init: () => ipcRenderer.invoke("agent:init"),
  send: (text) => ipcRenderer.invoke("agent:send", text),
  approve: (id, decision) => ipcRenderer.invoke("agent:approve", id, decision),
  setMode: (mode) => ipcRenderer.invoke("agent:setMode", mode),
  snapshot: () => ipcRenderer.invoke("agent:snapshot"),
  newSession: () => ipcRenderer.invoke("agent:new"),
  sessions: () => ipcRenderer.invoke("agent:sessions"),
  save: (name) => ipcRenderer.invoke("agent:save", name),
  resume: (name) => ipcRenderer.invoke("agent:resume", name),
  servers: () => ipcRenderer.invoke("agent:servers"),
  // Subscribe to streamed agent events; returns an unsubscribe function.
  onEvent: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
});
