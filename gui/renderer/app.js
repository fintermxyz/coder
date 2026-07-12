// gui/renderer/app.js — coder desktop UI logic (runs in the sandboxed renderer,
// talks to the agent only through window.coder from preload.js).

const api = window.coder;
const $ = (sel) => document.querySelector(sel);

// ── Blue dolphin mascot (same grid as src/mascot.js) ──────────────────────────
const DOLPHIN = [
  "............BBB...",
  ".......BB..BBBBB..",
  "......BBBBBBBBBBBBB",
  "....BBBBBBBBBBBeBB.",
  "..BBBBBBBBBBBBBBBB.",
  "BBB.BBBBBBBBBBBB...",
  "BB..BBBBBBBBBB.....",
  "BBB..BBBBBBB......",
  "....BB...BB.......",
];
function dolphinSvg(cell = 5, color = "#3b82f6") {
  const w = DOLPHIN[0].length * cell, h = DOLPHIN.length * cell;
  let r = "";
  DOLPHIN.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === "B") r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${color}"/>`;
    else if (c === "e") r += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="#0b1220"/>`;
  }));
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${r}</svg>`;
}
$("#mascot-hero").innerHTML = dolphinSvg(7);
$("#mascot-hero2").innerHTML = dolphinSvg(5);
$("#mascot-mini").innerHTML = dolphinSvg(3);

// ── State ─────────────────────────────────────────────────────────────────────
let mode = "build";
let streamingEl = null;             // current assistant bubble being streamed
const cards = new Map();            // approval/tool id -> card element

// ── Message + card rendering ──────────────────────────────────────────────────
const messages = $("#messages");
function scrollDown() { messages.scrollTop = messages.scrollHeight; }
function dropHero() { const h = $("#hero"); if (h) h.remove(); }

function addMsg(role, text) {
  dropHero();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="avatar">${role === "user" ? "you" : "🐬"}</div><div class="body"></div>`;
  el.querySelector(".body").textContent = text;
  messages.appendChild(el);
  scrollDown();
  return el;
}

function toolCard({ id, type, title }) {
  dropHero();
  const el = document.createElement("div");
  el.className = "tool-card";
  el.innerHTML = `
    <div class="tc-head"><span class="tc-type">${type}</span>
      <span class="tc-title">${escapeHtml(title || "")}</span>
      <span class="tc-status">running…</span></div>`;
  messages.appendChild(el);
  if (id) cards.set(id, el);
  scrollDown();
  return el;
}

function addApproval(p) {
  const el = toolCard(p);
  el.querySelector(".tc-status").textContent = "needs approval";
  if (p.diff) {
    const body = document.createElement("div");
    body.className = "tc-body diff";
    body.innerHTML = renderDiff(p.diff.old || "", p.diff.new || "");
    el.appendChild(body);
  }
  const actions = document.createElement("div");
  actions.className = "tc-actions";
  actions.innerHTML = `<button class="yes">Approve</button><button class="no">Skip</button>`;
  actions.querySelector(".yes").onclick = () => { api.approve(p.id, "yes"); actions.remove(); el.querySelector(".tc-status").textContent = "running…"; };
  actions.querySelector(".no").onclick = () => { api.approve(p.id, "no"); actions.remove(); el.querySelector(".tc-status").textContent = "skipped"; };
  el.appendChild(actions);
  scrollDown();
}

function finishCard({ id, ok, output }) {
  const el = cards.get(id) || toolCard({ id, type: "", title: "" });
  el.classList.add(ok ? "ok" : "err");
  el.querySelector(".tc-status").textContent = ok ? "✓ done" : "✗ failed";
  if (output) {
    let body = el.querySelector(".tc-body:not(.diff)");
    if (!body) { body = document.createElement("div"); body.className = "tc-body"; el.appendChild(body); }
    body.textContent = output;
  }
  scrollDown();
}

function renderDiff(oldStr, newStr) {
  const a = oldStr.split("\n"), b = newStr.split("\n");
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) { if (a[i] !== undefined) out.push("  " + escapeHtml(a[i])); continue; }
    if (a[i] !== undefined) out.push(`<span class="del">- ${escapeHtml(a[i])}</span>`);
    if (b[i] !== undefined) out.push(`<span class="add">+ ${escapeHtml(b[i])}</span>`);
  }
  return out.join("\n");
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// ── Agent events ──────────────────────────────────────────────────────────────
api.onEvent(({ type, payload }) => {
  switch (type) {
    case "ready": applyReady(payload); break;
    case "status": showStatus(payload); break;
    case "token":
      if (!streamingEl) streamingEl = addMsg("assistant", "");
      streamingEl.querySelector(".body").textContent += payload; scrollDown(); break;
    case "assistant":
      if (streamingEl) { streamingEl.querySelector(".body").textContent = payload; streamingEl = null; }
      else addMsg("assistant", payload);
      break;
    case "tool-start": toolCard(payload); break;
    case "approval-request": addApproval(payload); break;
    case "tool-result": finishCard(payload); break;
    case "todos": renderTodos(payload); break;
    case "mode": setModeUI(payload); break;
    case "error": addMsg("assistant", "⚠️ " + payload); break;
    case "done": hideStatus(); streamingEl = null; break;
  }
});

function showStatus(t) { $("#status-text").textContent = t; $("#status-line").classList.remove("hidden"); }
function hideStatus() { $("#status-line").classList.add("hidden"); }

function applyReady({ provider, model, mode: m }) {
  $("#provider-line").textContent = `${provider} · ${model || "—"}`;
  $("#model-badge").textContent = `${provider} · ${model || "—"}`;
  setModeUI(m);
  refreshSessions();
}
function setModeUI(m) {
  mode = m;
  const pill = $("#mode-pill");
  pill.textContent = (m === "plan" ? "◆ plan" : "● build");
  pill.classList.toggle("plan", m === "plan");
}

// ── Composer ──────────────────────────────────────────────────────────────────
const input = $("#input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });
$("#send").onclick = doSend;
function doSend() {
  const text = input.value.trim();
  if (!text) return;
  addMsg("user", text);
  input.value = ""; input.style.height = "auto";
  api.send(text);
}
$("#mode-pill").onclick = () => api.setMode(mode === "build" ? "plan" : "build");
$("#new-session").onclick = async () => { await api.newSession(); messages.innerHTML = ""; addHero(); refreshSessions(); };

function addHero() {
  const h = document.createElement("div");
  h.className = "hero"; h.id = "hero";
  h.innerHTML = `<span class="mascot">${dolphinSvg(7)}</span><h1>Hello</h1><p class="muted">What should we build?</p>`;
  messages.appendChild(h);
}

// ── Todos + sessions + servers ────────────────────────────────────────────────
function renderTodos(todos) {
  const glyph = { completed: "✓", in_progress: "▸", pending: "○" };
  const ul = $("#todo-list-stats");
  ul.innerHTML = (todos && todos.length)
    ? todos.map((t) => `<li>${glyph[t.status] || "○"} ${escapeHtml(t.content)}</li>`).join("")
    : `<li class="muted">none</li>`;
}
async function refreshSessions() {
  const list = await api.sessions();
  const ul = $("#session-list");
  ul.innerHTML = (list || []).slice(0, 30).map((sx) =>
    `<li data-name="${escapeHtml(sx.name)}">🐬 ${escapeHtml(sx.name)}<span class="when">${sx.count}m</span></li>`).join("");
  ul.querySelectorAll("li").forEach((li) => li.onclick = async () => {
    await api.resume(li.dataset.name); messages.innerHTML = ""; addMsg("assistant", `resumed session “${li.dataset.name}”.`);
  });
}
async function refreshServers() {
  const servers = await api.servers();
  $("#server-count").textContent = servers.length ? String(servers.length) : "";
  $("#server-list").innerHTML = servers.length
    ? servers.map((s) => `<li>pid ${s.pid} — ${escapeHtml(s.command)}</li>`).join("")
    : `<li class="muted">none running</li>`;
}

// ── View switching + stats ────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  const view = t.dataset.view;
  $("#view-chat").classList.toggle("hidden", view !== "chat");
  $("#view-stats").classList.toggle("hidden", view !== "stats");
  if (view === "stats") loadStats();
});
document.querySelectorAll(".nav a").forEach((a) => a.onclick = () => {
  document.querySelector('.tab[data-view="stats"]').click();
});

async function loadStats() {
  const snap = await api.snapshot();
  const sessions = await api.sessions();
  await refreshServers();
  renderTodos(snap.todos);
  const totalMsgs = (sessions || []).reduce((n, s) => n + (s.count || 0), snap.messages || 0);
  const tiles = [
    ["Saved sessions", (sessions || []).length],
    ["Messages (this session)", snap.messages],
    ["Mode", snap.mode],
    ["Provider", snap.provider],
    ["Model", (snap.model || "—")],
    ["Total messages", totalMsgs],
  ];
  $("#stat-grid").innerHTML = tiles.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${escapeHtml(String(v))}</div></div>`).join("");
  $("#stat-caption").textContent = "coder · your local coding agent 🐬";
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function boot() {
  try { await api.init(); } catch (e) { $("#provider-line").textContent = "init failed: " + e.message; }
  setInterval(() => { if (!$("#view-stats").classList.contains("hidden")) refreshServers(); }, 4000);
})();
