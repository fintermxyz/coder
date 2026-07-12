// src/mcp.js — MCP (Model Context Protocol) client manager.
// Connects to stdio or HTTP/SSE MCP servers, lists their tools, and calls them.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// name -> { client, tools: Tool[], spec: string }
export const mcpServers = new Map();

function parseSpec(spec) {
  const s = spec.trim();
  if (s.startsWith("stdio:")) {
    const cmd = s.slice(6).trim().split(/\s+/);
    return { kind: "stdio", command: cmd[0], args: cmd.slice(1) };
  }
  if (s.startsWith("http://") || s.startsWith("https://")) {
    return { kind: "sse", url: s };
  }
  // Bare command — treat as stdio
  const parts = s.split(/\s+/);
  return { kind: "stdio", command: parts[0], args: parts.slice(1) };
}

export async function connectMCP(name, spec) {
  if (mcpServers.has(name)) await disconnectMCP(name);

  const parsed = parseSpec(spec);
  let transport;
  if (parsed.kind === "stdio") {
    transport = new StdioClientTransport({ command: parsed.command, args: parsed.args });
  } else {
    transport = new SSEClientTransport(new URL(parsed.url));
  }

  const client = new Client(
    { name: "ai-shell", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  await client.connect(transport);

  const { tools } = await client.listTools();
  mcpServers.set(name, { client, tools, spec });
  return tools;
}

export async function disconnectMCP(name) {
  const server = mcpServers.get(name);
  if (!server) return;
  try { await server.client.close(); } catch {}
  mcpServers.delete(name);
}

export async function callMCPTool(serverName, toolName, args) {
  const server = mcpServers.get(serverName);
  if (!server) throw new Error(`MCP server "${serverName}" not connected`);

  const result = await server.client.callTool({ name: toolName, arguments: args });

  return (result.content || []).map((c) => {
    if (c.type === "text") return c.text;
    if (c.type === "image") return `[image: ${c.mimeType}, base64 length: ${c.data?.length ?? 0}]`;
    return JSON.stringify(c);
  }).join("\n");
}

export async function refreshTools(name) {
  const server = mcpServers.get(name);
  if (!server) throw new Error(`MCP server "${name}" not connected`);
  const { tools } = await server.client.listTools();
  server.tools = tools;
  return tools;
}

// Format all connected server tools for injection into the system prompt.
// When `nativeTools` is true the tools are exposed as real function tools
// (named mcp__<server>__<tool>), so we only list them for context and skip the
// fenced-block calling instructions.
export function formatMCPForPrompt(nativeTools = false) {
  if (mcpServers.size === 0) return "";

  const lines = ["MCP SERVERS AND TOOLS:"];
  for (const [name, { tools, spec }] of mcpServers) {
    lines.push(`\nServer: ${name}  (${spec})`);
    if (!tools.length) { lines.push("  (no tools)"); continue; }
    for (const t of tools) {
      const props = t.inputSchema?.properties || {};
      const params = Object.entries(props)
        .map(([k, v]) => `${k}: ${v.type ?? "any"}${v.description ? " — " + v.description : ""}`)
        .join(", ");
      const shownName = nativeTools ? `mcp__${name}__${t.name}` : t.name;
      lines.push(`  • ${shownName}(${params})`);
      if (t.description) lines.push(`    ${t.description}`);
    }
  }

  if (nativeTools) {
    lines.push(
      "",
      "Call these as native function tools (names shown above). Do not emit mcp-call blocks.",
    );
  } else {
    lines.push(
      "",
      "To call an MCP tool emit an `mcp-call` block:",
      "```mcp-call",
      "server: <server-name>",
      "tool: <tool-name>",
      '{"arg1": "value1", "arg2": "value2"}',
      "```",
      "The client executes it and returns the result. You can chain multiple mcp-call blocks.",
    );
  }

  return lines.join("\n");
}

export function listServersForDisplay() {
  if (!mcpServers.size) return "(no MCP servers connected)";
  return [...mcpServers.entries()].map(([name, { tools, spec }]) =>
    `  ${name.padEnd(16)} ${spec}\n` +
    tools.map((t) => `    • ${t.name}`).join("\n"),
  ).join("\n");
}
