// src/tools.js — native function-tool schemas and the tool-call → action bridge.
//
// The engine's built-in capabilities (run a command, write a file, web search,
// browse, schedule cron) plus every connected MCP tool are exposed to the model
// as OpenAI-format function tools. The model returns structured `tool_calls`,
// which we translate back into the SAME internal action objects the fenced-block
// parser produced — so the whole approval / preview / execute pipeline in
// actions.js is reused unchanged.

import { mcpServers } from "./mcp.js";

// MCP tools are namespaced as mcp__<server>__<tool> so a single flat tool list
// can carry them alongside the built-ins without collision.
const MCP_PREFIX = "mcp__";

// ── Built-in tool schemas (OpenAI function-calling format) ──────────────────
export const BUILTIN_TOOLS = [
  {
    type: "function",
    function: {
      name: "run",
      description:
        "Run ONE shell command on the user's machine and get its stdout/stderr and exit code. " +
        "The user approves each command before it runs. Command runs non-interactively (no TTY, " +
        "stdin closed) — always pass flags that skip prompts. Never use for long-running servers " +
        "(dev servers, watch mode); those must be started by the user. Call this tool multiple " +
        "times (or in parallel) to run several commands.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The single shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description:
        "Create or overwrite a file with its COMPLETE new contents. The user sees a diff and " +
        "approves before it is written. Always send the entire file, never a fragment or patch. " +
        "Prefer this over shell here-docs / echo / sed for editing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path of the file to write." },
          content: { type: "string", description: "The full contents of the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Search the web and get back a list of results. Use proactively for current info, docs, " +
        "or exact API/library versions instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse",
      description:
        "Load a web page with a real browser and get its text content (plus a visual description " +
        "if a vision model is available). Use to read docs or inspect a running app.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to load." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cron",
      description:
        "Schedule a recurring shell command via crontab. The user must approve before it is added.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Identifier for the job." },
          schedule: { type: "string", description: "Standard 5-field cron expression (e.g. '0 2 * * *')." },
          command: { type: "string", description: "The shell command to run on schedule." },
        },
        required: ["name", "schedule", "command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read a file from disk and get its contents with line numbers. Prefer this over `cat` via " +
        "the run tool. Use offset/limit to page through large files. Read-only, runs without approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path of the file to read." },
          offset: { type: "integer", description: "0-based line to start from (optional)." },
          limit: { type: "integer", description: "Max lines to return (optional, default 2000)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description:
        "Make a targeted edit to an existing file by replacing an EXACT string. old_string must " +
        "match the file exactly (including whitespace) and be unique unless replace_all is true. " +
        "Prefer this over rewriting the whole file with `write`. The user sees a diff and approves.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path of the file to edit." },
          old_string: { type: "string", description: "The exact text to replace." },
          new_string: { type: "string", description: "The text to replace it with." },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file CONTENTS for a regular expression and get matching file:line results. " +
        "Read-only, runs without approval. Optionally restrict to a subdirectory or a file glob.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression to search for." },
          path: { type: "string", description: "Directory to search under (default: current dir)." },
          glob: { type: "string", description: "Only search files matching this glob (e.g. '*.js')." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files by name/path glob (supports **, *, ?). Read-only, runs without approval.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts' or '*.json'." },
          path: { type: "string", description: "Directory to search under (default: current dir)." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todowrite",
      description:
        "Record/replace your task list for the current job so the user can see progress. Provide " +
        "the FULL list every time. Use for multi-step work; skip it for trivial single-step tasks.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete todo list, in order.",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "What to do." },
                status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Task status." },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "question",
      description:
        "Ask the user a clarifying question and wait for their typed answer. Use sparingly, only " +
        "when you genuinely cannot proceed without a decision that is theirs to make.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask." },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description:
        "Delegate a complex search or multi-step investigation to the general subagent. It has " +
        "read-only tools (read/grep/glob/search/browse), works autonomously, and returns a " +
        "summary. Use it to explore an unfamiliar area without cluttering your own context.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short label for the task." },
          prompt: { type: "string", description: "The full task/question for the subagent to investigate." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "serve",
      description:
        "Start a LONG-RUNNING process — a dev server, watcher, or anything that stays up (e.g. " +
        "`npm run dev`, `next dev`, `vite`, `flask run`, `python -m http.server`). It runs in the " +
        "BACKGROUND (does not block), and returns its first few seconds of output (usually the URL). " +
        "ALWAYS use this instead of the run tool for servers — run would hang forever. Use " +
        "stop_server to stop it.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The server command to start, e.g. 'npm run dev'." },
          cwd: { type: "string", description: "Directory to run it in (relative path, optional)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_server",
      description: "Stop a background server previously started with the serve tool.",
      parameters: {
        type: "object",
        properties: {
          pid: { type: "integer", description: "PID to stop (omit to stop the most recent server)." },
        },
      },
    },
  },
];

// Built-in tool name -> internal action type (for permission filtering).
const TOOL_NAME_TO_TYPE = {
  run: "run", write: "write", search: "search", browse: "browse", cron: "cron",
  read: "read", edit: "edit", grep: "grep", glob: "glob", todowrite: "todo",
  question: "question", task: "task", serve: "serve", stop_server: "stop_server",
};

// Build the full tool list for the current turn: built-ins + one native tool per
// connected MCP tool, carrying that tool's own JSON-Schema so the model sees real
// parameters instead of a free-form blob. `denied` is a Set of action types to
// hide (e.g. write/edit in plan mode).
export function buildToolSchemas(denied = new Set()) {
  const tools = BUILTIN_TOOLS.filter((t) => !denied.has(TOOL_NAME_TO_TYPE[t.function.name]));
  if (denied.has("mcp-call")) return tools; // all MCP tools hidden by policy
  for (const [server, { tools: mcpTools }] of mcpServers) {
    for (const t of mcpTools || []) {
      tools.push({
        type: "function",
        function: {
          name: `${MCP_PREFIX}${server}__${t.name}`,
          description: t.description || `MCP tool ${t.name} on server ${server}`,
          parameters:
            t.inputSchema && typeof t.inputSchema === "object"
              ? t.inputSchema
              : { type: "object", properties: {} },
        },
      });
    }
  }
  return tools;
}

// Translate one structured tool call into the internal action object shape that
// actions.js already knows how to preview / approve / execute.
export function toolCallToAction(name, args) {
  args = args || {};
  if (name === "run") return { type: "run", cmd: String(args.command ?? "").trim() };
  if (name === "write") return { type: "write", path: String(args.path ?? "").trim(), content: String(args.content ?? "") };
  if (name === "search") return { type: "search", query: String(args.query ?? "").trim() };
  if (name === "browse") return { type: "browse", url: String(args.url ?? "").trim() };
  if (name === "cron") {
    return { type: "cron", name: String(args.name ?? "").trim(), schedule: String(args.schedule ?? "").trim(), cmd: String(args.command ?? "").trim() };
  }
  if (name === "read") return { type: "read", path: String(args.path ?? "").trim(), offset: args.offset, limit: args.limit };
  if (name === "edit") {
    return { type: "edit", path: String(args.path ?? "").trim(), old: String(args.old_string ?? ""), new: String(args.new_string ?? ""), replaceAll: !!args.replace_all };
  }
  if (name === "grep") return { type: "grep", pattern: String(args.pattern ?? ""), path: args.path, glob: args.glob };
  if (name === "glob") return { type: "glob", pattern: String(args.pattern ?? ""), path: args.path };
  if (name === "todowrite") return { type: "todo", todos: Array.isArray(args.todos) ? args.todos : [] };
  if (name === "question") return { type: "question", question: String(args.question ?? "").trim() };
  if (name === "task") return { type: "task", description: String(args.description ?? "").trim(), prompt: String(args.prompt ?? "").trim() };
  if (name === "serve") return { type: "serve", cmd: String(args.command ?? "").trim(), cwd: args.cwd };
  if (name === "stop_server") return { type: "stop_server", pid: args.pid };
  if (name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const sep = rest.indexOf("__");
    const server = sep === -1 ? rest : rest.slice(0, sep);
    const tool = sep === -1 ? "" : rest.slice(sep + 2);
    return { type: "mcp-call", server, tool, args };
  }
  return { type: "unknown", name, args };
}
