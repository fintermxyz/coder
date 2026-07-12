import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { dolphinSvg } from "./dolphin";
import type { AgentEvent, ApprovalReq, Mode, SessionInfo, ServerInfo, Snapshot, Todo } from "./global";

const api = window.coder;

type ToolItem = {
  kind: "tool"; id: string; type: string; title: string;
  status: "running" | "approval" | "done" | "skipped";
  ok?: boolean; output?: string; diff?: { old: string; new: string };
};
type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | ToolItem;

let seq = 0;
const nextId = () => `i${++seq}`;

function Dolphin({ cell }: { cell: number }) {
  return <span class="mascot" dangerouslySetInnerHTML={{ __html: dolphinSvg(cell) }} />;
}

function diffLines(oldStr: string, newStr: string): JSX.Element[] {
  const a = oldStr.split("\n"), b = newStr.split("\n");
  const rows: JSX.Element[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) { if (a[i] !== undefined) rows.push(<div>{"  " + a[i]}</div>); continue; }
    if (a[i] !== undefined) rows.push(<div class="del">{"- " + a[i]}</div>);
    if (b[i] !== undefined) rows.push(<div class="add">{"+ " + b[i]}</div>);
  }
  return rows;
}

export function App() {
  const [ready, setReady] = useState<{ provider: string; model: string | null } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>("build");
  const [items, setItems] = useState<Item[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [status, setStatus] = useState<string>("");
  const [view, setView] = useState<"chat" | "stats">("chat");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [input, setInput] = useState("");
  const [auto, setAuto] = useState(false);

  const streamId = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const patchItem = (id: string, patch: Partial<ToolItem>) =>
    setItems((xs) => xs.map((it) => (it.id === id ? { ...it, ...patch } as Item : it)));

  useEffect(() => {
    const off = api.onEvent((e: AgentEvent) => {
      switch (e.type) {
        case "ready":
          setReady({ provider: e.payload.provider, model: e.payload.model });
          setMode(e.payload.mode); refreshSessions();
          api.models().then(setModels).catch(() => {});
          break;
        case "status": setStatus(e.payload); break;
        case "token":
          if (!streamId.current) {
            const id = nextId(); streamId.current = id;
            setItems((xs) => [...xs, { kind: "assistant", id, text: e.payload }]);
          } else {
            const id = streamId.current;
            setItems((xs) => xs.map((it) => (it.id === id && it.kind === "assistant" ? { ...it, text: it.text + e.payload } : it)));
          }
          break;
        case "assistant":
          if (streamId.current) {
            const id = streamId.current; streamId.current = null;
            setItems((xs) => xs.map((it) => (it.id === id && it.kind === "assistant" ? { ...it, text: e.payload } : it)));
          } else setItems((xs) => [...xs, { kind: "assistant", id: nextId(), text: e.payload }]);
          break;
        case "tool-start":
          setItems((xs) => xs.some((i) => i.id === e.payload.id) ? xs
            : [...xs, { kind: "tool", id: e.payload.id, type: e.payload.type, title: e.payload.title, status: "running" }]);
          break;
        case "approval-request": {
          const p = e.payload as ApprovalReq;
          setItems((xs) => [...xs, { kind: "tool", id: p.id, type: p.type, title: p.title, status: "approval", diff: p.diff }]);
          break;
        }
        case "tool-result":
          patchItem(e.payload.id, { status: "done", ok: e.payload.ok, output: e.payload.output });
          break;
        case "todos": setTodos(e.payload); break;
        case "mode": setMode(e.payload); break;
        case "error": setItems((xs) => [...xs, { kind: "assistant", id: nextId(), text: "⚠️ " + e.payload }]); break;
        case "done": setStatus(""); streamId.current = null; break;
      }
    });
    api.init().catch(() => {});
    return off;
  }, []);

  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [items, status]);

  async function refreshSessions() { setSessions(await api.sessions()); }
  async function refreshServers() { setServers(await api.servers()); }

  function send() {
    const text = input.trim();
    if (!text) return;
    setItems((xs) => [...xs, { kind: "user", id: nextId(), text }]);
    setInput("");
    api.send(text);
  }
  function approve(id: string, decision: "yes" | "no") {
    api.approve(id, decision);
    patchItem(id, { status: decision === "yes" ? "running" : "skipped" });
  }
  async function loadStats() {
    setSnap(await api.snapshot());
    await refreshSessions(); await refreshServers();
    setView("stats");
  }
  async function newSession() { await api.newSession(); setItems([]); setTodos([]); refreshSessions(); }

  const providerLine = ready ? `${ready.provider} · ${ready.model ?? "—"}` : "connecting…";

  return (
    <div id="app-root">
      <aside id="sidebar">
        <div class="side-drag" />
        <div class="tabs">
          <button class={"tab" + (view === "chat" ? " active" : "")} onClick={() => setView("chat")}>Chat</button>
          <button class={"tab" + (view === "stats" ? " active" : "")} onClick={loadStats}>Stats</button>
        </div>
        <button id="new-session" class="primary" onClick={newSession}>＋ New session</button>
        <nav class="nav">
          <a onClick={loadStats}><span class="ico">▣</span> Servers {servers.length ? <span class="badge">{servers.length}</span> : null}</a>
          <a onClick={loadStats}><span class="ico">🗂</span> Sessions</a>
        </nav>
        <div class="recents">
          <div class="section-label">Recents</div>
          <ul id="session-list">
            {sessions.slice(0, 30).map((s) => (
              <li key={s.name} onClick={async () => { await api.resume(s.name); setItems([{ kind: "assistant", id: nextId(), text: `resumed “${s.name}”.` }]); }}>
                🐬 {s.name}<span class="when">{s.count}m</span>
              </li>
            ))}
          </ul>
        </div>
        <div class="side-footer">
          <Dolphin cell={3} />
          <div class="who"><div class="brand">coder</div><div id="provider-line" class="muted">{providerLine}</div></div>
        </div>
      </aside>

      <main id="main">
        {view === "chat" ? (
          <section class="view">
            <div id="messages" ref={scroller}>
              {items.length === 0 && (
                <div class="hero"><Dolphin cell={7} /><h1>Hello</h1><p class="muted">What should we build?</p></div>
              )}
              {items.map((it) => it.kind === "tool"
                ? <ToolCard key={it.id} it={it} onApprove={approve} />
                : (
                  <div class={"msg " + it.kind} key={it.id}>
                    <div class="avatar">{it.kind === "user" ? "you" : "🐬"}</div>
                    <div class="body">{it.text}</div>
                  </div>
                ))}
            </div>
            <div class="composer">
              {status && <div class="status"><span class="dot" />{status}</div>}
              <textarea id="input" rows={1} placeholder="Describe a task or ask a question…"
                value={input}
                onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <div class="composer-bar">
                <div class="chips">
                  <button class={"chip mode-pill" + (mode === "plan" ? " plan" : "")}
                    onClick={() => api.setMode(mode === "build" ? "plan" : "build")}>
                    {mode === "plan" ? "◆ plan" : "● build"}
                  </button>
                  <label class="chip toggle"><input type="checkbox" checked={auto} onChange={(e) => setAuto((e.target as HTMLInputElement).checked)} /> Auto-approve</label>
                </div>
                <div class="right">
                  <select class="model-select" title="LM Studio model"
                    value={ready?.model ?? ""}
                    onChange={(e) => { const id = (e.target as HTMLSelectElement).value; setReady((r) => r ? { ...r, model: id } : r); api.setModel(id); }}>
                    {(models.length ? models : (ready?.model ? [ready.model] : [])).map((m) => (
                      <option value={m} key={m}>{m}</option>
                    ))}
                  </select>
                  <button class="send" onClick={send}>Send ⏎</button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section class="view">
            <div class="hero small" style="display:flex;align-items:center;gap:14px;justify-content:flex-start">
              <Dolphin cell={5} /><h1>Your coder stats</h1>
            </div>
            <div class="stat-grid">
              {statTiles(snap, sessions).map(([k, v]) => (
                <div class="tile" key={k}><div class="k">{k}</div><div class="v">{String(v)}</div></div>
              ))}
            </div>
            <div class="panel">
              <div class="section-label">Background servers</div>
              <ul class="server-list">
                {servers.length ? servers.map((s) => <li key={s.pid}>pid {s.pid} — {s.command}</li>) : <li class="muted">none running</li>}
              </ul>
            </div>
            <div class="panel">
              <div class="section-label">Todos</div>
              <ul class="todo-list">
                {todos.length ? todos.map((t, i) => <li key={i}>{glyph(t.status)} {t.content}</li>) : <li class="muted">none</li>}
              </ul>
            </div>
            <p class="muted caption">coder · your local coding agent 🐬</p>
          </section>
        )}
      </main>
    </div>
  );
}

function ToolCard({ it, onApprove }: { it: ToolItem; onApprove: (id: string, d: "yes" | "no") => void }) {
  const statusText = it.status === "running" ? "running…" : it.status === "approval" ? "needs approval"
    : it.status === "skipped" ? "skipped" : it.ok ? "✓ done" : "✗ failed";
  return (
    <div class={"tool-card" + (it.status === "done" ? (it.ok ? " ok" : " err") : "")}>
      <div class="tc-head">
        <span class="tc-type">{it.type}</span>
        <span class="tc-title">{it.title}</span>
        <span class="tc-status">{statusText}</span>
      </div>
      {it.diff && <div class="tc-body diff">{diffLines(it.diff.old, it.diff.new)}</div>}
      {it.output && <div class="tc-body">{it.output}</div>}
      {it.status === "approval" && (
        <div class="tc-actions">
          <button class="yes" onClick={() => onApprove(it.id, "yes")}>Approve</button>
          <button class="no" onClick={() => onApprove(it.id, "no")}>Skip</button>
        </div>
      )}
    </div>
  );
}

function glyph(s: Todo["status"]) { return s === "completed" ? "✓" : s === "in_progress" ? "▸" : "○"; }
function statTiles(snap: Snapshot | null, sessions: SessionInfo[]): [string, string | number][] {
  const total = sessions.reduce((n, s) => n + (s.count || 0), snap?.messages || 0);
  return [
    ["Saved sessions", sessions.length],
    ["Messages (session)", snap?.messages ?? 0],
    ["Mode", snap?.mode ?? "—"],
    ["Provider", snap?.provider ?? "—"],
    ["Model", snap?.model ?? "—"],
    ["Total messages", total],
  ];
}
