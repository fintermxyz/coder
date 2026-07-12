// Types for the preload bridge (window.coder) and the agent event stream.

export interface Ready { provider: string; model: string | null; mode: Mode; }
export type Mode = "build" | "plan";
export interface Todo { content: string; status: "pending" | "in_progress" | "completed"; }
export interface SessionInfo { name: string; count: number; savedAt?: string; model?: string; }
export interface ServerInfo { pid: number; command: string; cwd: string; }
export interface Snapshot { provider: string; model: string | null; mode: Mode; todos: Todo[]; messages: number; }

export interface ApprovalReq {
  id: string; type: string; title: string;
  cmd?: string; path?: string; diff?: { old: string; new: string };
}
export interface ToolResult { id: string; type: string; ok: boolean; output: string; }

export type AgentEvent =
  | { type: "ready"; payload: Ready }
  | { type: "status"; payload: string }
  | { type: "token"; payload: string }
  | { type: "assistant"; payload: string }
  | { type: "tool-start"; payload: { id: string; type: string; title: string } }
  | { type: "approval-request"; payload: ApprovalReq }
  | { type: "tool-result"; payload: ToolResult }
  | { type: "todos"; payload: Todo[] }
  | { type: "mode"; payload: Mode }
  | { type: "error"; payload: string }
  | { type: "done"; payload?: undefined };

export interface CoderApi {
  init(): Promise<Ready>;
  send(text: string): Promise<boolean>;
  approve(id: string, decision: "yes" | "no"): Promise<boolean>;
  setMode(mode: Mode): Promise<Mode>;
  snapshot(): Promise<Snapshot>;
  sessions(): Promise<SessionInfo[]>;
  save(name: string): Promise<unknown>;
  resume(name: string): Promise<unknown>;
  servers(): Promise<ServerInfo[]>;
  newSession(): Promise<boolean>;
  onEvent(cb: (e: AgentEvent) => void): () => void;
}

declare global {
  interface Window { coder: CoderApi; }
}
