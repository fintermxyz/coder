// MCP test server — SSE/HTTP transport, exposes tools for testing the ai-shell MCP client.

import http from "node:http";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.PORT) || 3333;
const DATA  = process.env.DATA_DIR || "/data";
mkdirSync(DATA, { recursive: true });

// ── Tool definitions ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "echo",
    description: "Echo text back — confirms the MCP connection is live.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Text to echo" } },
      required: ["message"],
    },
  },
  {
    name: "server_info",
    description: "Return info about this MCP server container (hostname, uptime, env).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_dir",
    description: "List files in the shared /data directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Sub-path inside /data (default: root)" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file from /data.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path inside /data" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file in /data.",
    inputSchema: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Relative path inside /data" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "shell",
    description: "Run a shell command inside the MCP container and return its output.",
    inputSchema: {
      type: "object",
      properties: { cmd: { type: "string", description: "Command to run" } },
      required: ["cmd"],
    },
  },
];

// ── Tool execution ──────────────────────────────────────────────────────────────

function safe(rel) {
  // Allow callers to pass DATA-rooted absolute paths like "/data/foo" → treat as "foo".
  // Also allow "/" or "/data" as aliases for the DATA root.
  let normalized;
  if (rel === DATA || rel === DATA + "/") {
    normalized = ".";
  } else if (rel.startsWith(DATA + "/")) {
    normalized = rel.slice(DATA.length + 1);
  } else {
    normalized = rel.replace(/^\/+/, "") || ".";
  }
  const abs = path.resolve(DATA, normalized);
  if (!abs.startsWith(DATA)) throw new Error("Path outside /data");
  return abs;
}

function dispatch(name, args) {
  switch (name) {
    case "echo":
      return `Echo from MCP container: ${args.message}`;

    case "server_info": {
      const hostname = execSync("hostname").toString().trim();
      const os      = execSync("uname -a").toString().trim();
      return [
        `MCP test server v1.0.0`,
        `Hostname : ${hostname}`,
        `OS       : ${os}`,
        `Node     : ${process.version}`,
        `Data dir : ${DATA}`,
        `Uptime   : ${process.uptime().toFixed(1)}s`,
        `Connected clients: ${transports.size}`,
      ].join("\n");
    }

    case "list_dir": {
      const dir = args.path ? safe(args.path) : DATA;
      return readdirSync(dir, { withFileTypes: true })
        .map((e) => {
          const stat = statSync(path.join(dir, e.name));
          return `${e.isDirectory() ? "dir " : "file"} ${e.name.padEnd(40)} ${stat.size}B`;
        })
        .join("\n") || "(empty)";
    }

    case "read_file":
      return readFileSync(safe(args.path), "utf8");

    case "write_file":
      mkdirSync(path.dirname(safe(args.path)), { recursive: true });
      writeFileSync(safe(args.path), args.content);
      return `Wrote ${args.content.length} bytes to /data/${args.path}`;

    case "shell": {
      try {
        return execSync(args.cmd, { timeout: 15000, encoding: "utf8" });
      } catch (e) {
        return `exit ${e.status}\n${e.stdout || ""}${e.stderr || ""}`;
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP server ──────────────────────────────────────────────────────────────────

const mcpServer = new Server(
  { name: "test-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const text = dispatch(name, args ?? {});
    return { content: [{ type: "text", text: String(text) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

// ── HTTP server ─────────────────────────────────────────────────────────────────

const transports = new Map(); // sessionId -> SSEServerTransport

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // SSE stream — client connects here first.
  // Do NOT call res.writeHead() — SSEServerTransport.start() does it internally.
  if (req.method === "GET" && req.url === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    req.on("close", () => { transports.delete(transport.sessionId); });
    await mcpServer.connect(transport);
    return;
  }

  // Client posts JSON-RPC messages here
  if (req.method === "POST" && req.url?.startsWith("/messages")) {
    const sessionId = new URL(req.url, "http://x").searchParams.get("sessionId");
    const transport = transports.get(sessionId);
    if (!transport) { res.writeHead(404); res.end("session not found"); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        await transport.handlePostMessage(req, res, JSON.parse(body));
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
    });
    return;
  }

  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", tools: TOOLS.length, sessions: transports.size }));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[mcp-test-server] listening on :${PORT}`);
  console.log(`[mcp-test-server] tools: ${TOOLS.map((t) => t.name).join(", ")}`);
  console.log(`[mcp-test-server] data dir: ${DATA}`);
});
