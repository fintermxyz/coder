// providers.js — provider registry and a unified streaming-chat abstraction.
//
// Two client kinds cover every provider:
//   - "anthropic" → @anthropic-ai/sdk (native Messages API)
//   - "openai"    → openai SDK, pointed at any OpenAI-compatible /chat/completions
//                   endpoint. This covers OpenAI, Gemini, Groq, DeepSeek, Mistral,
//                   xAI, Together, OpenRouter AND local runtimes (Ollama, LM Studio,
//                   llama.cpp) — they all speak the same wire format.
//
// Internal history format is provider-neutral. A message is one of:
//   { role: "user",      content: string }
//   { role: "assistant", content: string, toolCalls?: [{ id, name, args }] }
//   { role: "tool",      results: [{ id, name, output }] }
// Each provider translates this neutral shape to its own wire format below.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const MAX_TOKENS = 16000;

// ── Neutral history → OpenAI chat messages ──────────────────────────────────
function toOpenAiMessages(history) {
  const out = [];
  for (const m of history) {
    if (m.role === "tool") {
      // One OpenAI tool message per result, keyed by the tool_call id.
      for (const r of m.results || []) {
        out.push({ role: "tool", tool_call_id: r.id, content: String(r.output ?? "") });
      }
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content ?? "" });
    }
  }
  return out;
}

// ── Neutral history → Anthropic messages ────────────────────────────────────
function toAnthropicMessages(history) {
  const out = [];
  for (const m of history) {
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: (m.results || []).map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: String(r.output ?? ""),
        })),
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role, content: m.content ?? "" });
    }
  }
  return out;
}

// OpenAI-format tool list → Anthropic tool list.
function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

// ── Built-in providers ──────────────────────────────────────────────────────
// `model` is just a sensible default — override any time with AI_MODEL or :model.
// `local: true` means no API key required.
export const BUILTIN_PROVIDERS = {
  anthropic: { kind: "anthropic", label: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", model: "claude-opus-4-8" },
  openai:    { kind: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", model: "gpt-4o" },
  gemini:    { kind: "openai", label: "Google Gemini", keyEnv: "GEMINI_API_KEY", model: "gemini-2.0-flash", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  groq:      { kind: "openai", label: "Groq", keyEnv: "GROQ_API_KEY", model: "llama-3.3-70b-versatile", baseURL: "https://api.groq.com/openai/v1" },
  deepseek:  { kind: "openai", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-chat", baseURL: "https://api.deepseek.com" },
  mistral:   { kind: "openai", label: "Mistral", keyEnv: "MISTRAL_API_KEY", model: "mistral-large-latest", baseURL: "https://api.mistral.ai/v1" },
  xai:       { kind: "openai", label: "xAI Grok", keyEnv: "XAI_API_KEY", model: "grok-2-latest", baseURL: "https://api.x.ai/v1" },
  together:  { kind: "openai", label: "Together", keyEnv: "TOGETHER_API_KEY", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", baseURL: "https://api.together.xyz/v1" },
  openrouter:{ kind: "openai", label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-4o", baseURL: "https://openrouter.ai/api/v1" },
  ollama:    { kind: "openai", label: "Ollama (local)", local: true, model: "llama3.2", baseURL: process.env.OLLAMA_URL || "http://localhost:11434/v1" },
  lmstudio:  { kind: "openai", label: "LM Studio (local)", local: true, model: "local-model", baseURL: process.env.LMSTUDIO_URL || "http://localhost:1234/v1" },
  llamacpp:  { kind: "openai", label: "llama.cpp (local)", local: true, model: "local-model", baseURL: process.env.LLAMACPP_URL || "http://localhost:8080/v1" },
};

// ── Optional config file: ~/.ai-shell.json or ./.ai-shell.json ──────────────
// Shape: { "provider": "openai", "model": "...", "providers": { "<name>": {...} } }
// Custom providers are merged on top of the built-ins, so you can add any
// OpenAI-compatible endpoint or override a default model.
export function loadConfig() {
  const candidates = [
    path.join(process.cwd(), ".ai-shell.json"),
    path.join(os.homedir(), ".ai-shell.json"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      }
    } catch (err) {
      throw new Error(`failed to read ${file}: ${err.message}`);
    }
  }
  return {};
}

export function buildRegistry(config = {}) {
  return { ...BUILTIN_PROVIDERS, ...(config.providers || {}) };
}

// Pick a default provider: explicit env/config, else the first whose key is set,
// else anthropic.
export function resolveDefault(registry, config = {}) {
  const wanted = process.env.AI_PROVIDER || config.provider;
  if (wanted) return wanted;
  for (const [name, def] of Object.entries(registry)) {
    if (def.local) continue;
    if (def.keyEnv && process.env[def.keyEnv]) return name;
  }
  return "anthropic";
}

// ── Provider instance ───────────────────────────────────────────────────────
// Returns { name, label, kind, model, streamChat, listModels }.
export function createProvider(name, registry, modelOverride) {
  const def = registry[name];
  if (!def) throw new Error(`unknown provider "${name}". Try :providers`);

  const model = modelOverride || def.model;
  const label = def.label || name;

  if (def.kind === "anthropic") {
    const apiKey = process.env[def.keyEnv];
    if (!apiKey) throw new Error(`set ${def.keyEnv} to use ${label}`);
    const client = new Anthropic({ apiKey });

    return {
      name, label, kind: def.kind, model, supportsTools: def.supportsTools !== false,
      async streamChat({ system, history, onText, tools }) {
        const req = {
          model,
          max_tokens: MAX_TOKENS,
          thinking: { type: "adaptive" },
          system,
          messages: toAnthropicMessages(history),
        };
        if (tools?.length) req.tools = toAnthropicTools(tools);
        const stream = client.messages.stream(req);
        let text = "";
        stream.on("text", (delta) => { text += delta; onText(delta); });
        const final = await stream.finalMessage();
        const toolCalls = (final.content || [])
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
        return { text, toolCalls, refused: final.stop_reason === "refusal" };
      },
      async queryVision(imageB64, mimeType, prompt) {
        const msg = await client.messages.create({
          model,
          max_tokens: 2048,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: imageB64 } },
              { type: "text", text: prompt },
            ],
          }],
        });
        return msg.content.find((b) => b.type === "text")?.text || "";
      },
      async listModels() {
        const res = await client.models.list();
        return res.data.map((m) => m.id);
      },
    };
  }

  // openai-compatible (cloud or local)
  const apiKey = def.local
    ? (process.env[def.keyEnv] || "local")
    : process.env[def.keyEnv];
  if (!apiKey) throw new Error(`set ${def.keyEnv} to use ${label}`);
  const client = new OpenAI({ apiKey, baseURL: def.baseURL });

  return {
    name, label, kind: def.kind, model, supportsTools: def.supportsTools !== false,
    async streamChat({ system, history, onText, tools }) {
      const messages = system
        ? [{ role: "system", content: system }, ...toOpenAiMessages(history)]
        : toOpenAiMessages(history);
      const req = { model, messages, stream: true };
      if (tools?.length) { req.tools = tools; req.tool_choice = "auto"; }
      const stream = await client.chat.completions.create(req);
      let text = "";
      // tool_calls arrive as deltas keyed by `index`; accumulate name + arguments.
      const acc = new Map();
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) { text += delta.content; onText(delta.content); }
        for (const tc of delta.tool_calls || []) {
          const cur = acc.get(tc.index) || { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(tc.index, cur);
        }
      }
      const toolCalls = [...acc.values()]
        .filter((c) => c.name)
        .map((c, i) => {
          let args = {};
          try { args = c.args ? JSON.parse(c.args) : {}; } catch { /* keep {} on malformed args */ }
          return { id: c.id || `call_${i}`, name: c.name, args };
        });
      return { text, toolCalls, refused: false };
    },
    async queryVision(imageB64, mimeType, prompt) {
      const resp = await client.chat.completions.create({
        model,
        max_tokens: 2048,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageB64}` } },
            { type: "text", text: prompt },
          ],
        }],
      });
      return resp.choices?.[0]?.message?.content || "";
    },
    async listModels() {
      const res = await client.models.list();
      return res.data.map((m) => m.id);
    },
  };
}
