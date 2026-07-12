// AI chat loop: call the model, display the spinner, offer suggested actions.

import { s, T, BOLD, RESET } from "../theme.js";
import { state, SPINNER, MAX_STEPS, isTTY, toolsEnabled } from "./state.js";
import { warn, err, info } from "./log.js";
import { parseActions, offerActions, resultsToText, formatOneResult } from "./actions.js";
import { buildToolSchemas, toolCallToAction } from "./tools.js";
import { deniedTypes } from "./permissions.js";
import { autosave } from "./session.js";
import { runSubagent } from "./subagent.js";

export function modelTag() {
  return (
    s(`${state.currentName}`, T.accent2, BOLD) +
    s(`:${state.currentModel}`, T.faint) +
    s(" ❯ ", T.accent, BOLD)
  );
}

// Return the first prose line from a response (strips run/write blocks).
export function summaryOf(text) {
  const prose = text
    .split("[TOOL_CALLS]")[0]
    .replace(/```(?:run|write|file)[^\n]*\n[\s\S]*?```/g, "")
    .trim();
  return prose.split("\n").map((l) => l.trim()).find(Boolean) || "";
}

// Call the model with a spinner; suppress prose streaming (we act on full text).
async function think(label, tools) {
  const tty = isTTY();
  let i = 0;
  let timer = null;
  if (tty) {
    process.stdout.write("\x1b[?25l");
    timer = setInterval(() => {
      process.stdout.write(
        `\r${T.accent}${SPINNER[i++ % SPINNER.length]}${RESET} ${s(label + "…", T.faint)}`,
      );
    }, 80);
  }
  try {
    return await state.provider.streamChat({
      system: state.systemPrompt,
      history: state.history,
      onText: () => {},
      tools,
    });
  } finally {
    if (timer) clearInterval(timer);
    if (tty) process.stdout.write("\r\x1b[K\x1b[?25h");
  }
}

// Stable key for the loop-guard: identifies a repeated action worth catching.
function actionKey(a) {
  if (a.type === "run") return `run:${a.cmd}`;
  if (a.type === "mcp-call") return `mcp:${a.server}.${a.tool}:${JSON.stringify(a.args)}`;
  if (a.type === "search") return `search:${a.query}`;
  if (a.type === "browse") return `browse:${a.url}`;
  if (a.type === "grep") return `grep:${a.pattern}:${a.path || ""}:${a.glob || ""}`;
  if (a.type === "glob") return `glob:${a.pattern}:${a.path || ""}`;
  if (a.type === "read") return `read:${a.path}:${a.offset || 0}`;
  if (a.type === "edit") return `edit:${a.path}:${a.old}`;
  return null;
}

// Send a user message, drive the multi-step action loop, display the final reply.
export async function chat(message) {
  await Promise.all([state.infoReady, state.projectReady, state.startupReady]);
  if (!state.provider) {
    err("no active provider. Use /provider <name> (see /providers).");
    return;
  }
  state.history.push({ role: "user", content: message });
  const useTools = toolsEnabled();

  try {
    // Direct delegation: "@general <task>" hands the whole turn to the subagent.
    const gen = message.match(/^@general\b\s*([\s\S]*)$/i);
    if (gen) {
      const task = gen[1].trim();
      if (!task) { process.stdout.write(modelTag() + "usage: @general <task to investigate>\n"); return; }
      process.stdout.write(modelTag() + s("delegating to @general subagent…", T.gray) + "\n");
      const out = await runSubagent(task);
      state.history.push({ role: "assistant", content: out });
      process.stdout.write(modelTag() + out + "\n");
      return;
    }

    // Track recently executed run-commands to detect infinite loops.
    const recentCmds = [];

    for (let step = 1; step <= MAX_STEPS; step++) {
      const label = step === 1 ? "thinking" : `working · step ${step}`;
      const tools = useTools ? buildToolSchemas(deniedTypes()) : null;
      const { text, toolCalls, refused } = await think(label, tools);

      if (refused) { warn("the model declined to respond"); return; }

      // Prefer native structured tool_calls. But some models (especially smaller
      // local ones) ignore the tools and emit fenced ```run/```write blocks in prose
      // instead — so if there were no tool_calls, fall back to parsing those blocks
      // even in tools mode. `viaTool` tracks which path we're on so results are fed
      // back in the matching format (role:"tool" vs a plain user note).
      const nativeCalls = useTools ? (toolCalls || []) : [];
      let actions = nativeCalls.map((tc) => ({ ...toolCallToAction(tc.name, tc.args), id: tc.id, toolName: tc.name }));
      let viaTool = actions.length > 0;
      if (!actions.length) { actions = parseActions(text); viaTool = false; }
      const note = summaryOf(text);

      // Record the assistant turn. For real tool calls the tool_calls travel with it
      // so the provider can reconstruct the proper wire format on the next request.
      state.history.push(
        viaTool
          ? { role: "assistant", content: text, toolCalls: nativeCalls }
          : { role: "assistant", content: text },
      );

      if (!actions.length) {
        process.stdout.write(modelTag() + (text.trim() || "(done)") + "\n");
        return;
      }

      // Loop guard: if every side-effecting action this step is identical to
      // something we already ran in the last 2 steps, the model is stuck.
      const thisStepKeys = actions.map(actionKey).filter(Boolean);
      if (thisStepKeys.length && thisStepKeys.every((k) => recentCmds.includes(k))) {
        warn("detected repeated actions — the model appears to be looping. Stopping.");
        // Satisfy the tool protocol: every pending tool_call needs a result before
        // we can send another user message.
        if (viaTool) {
          state.history.push({
            role: "tool",
            results: actions.map((a) => ({ id: a.id, name: a.toolName, output: "(not run — repeated action, stopped)" })),
          });
        }
        state.history.push({
          role: "user",
          content: "You are repeating the same action(s) without making progress. Stop and summarise what you know so far, then ask the user what to do next.",
        });
        const { text: recovery } = await think("recovering", null);
        process.stdout.write(modelTag() + (summaryOf(recovery) || recovery.trim()) + "\n");
        return;
      }
      recentCmds.push(...thisStepKeys);
      if (recentCmds.length > 10) recentCmds.splice(0, recentCmds.length - 10);

      if (note) process.stdout.write(modelTag() + s(note, T.gray) + "\n");

      const { ranAny, aborted, results } = await offerActions(actions);

      // Feed results back to the model. Tool mode: one tool result per tool_call
      // (synthesised for any not reached, e.g. after an abort). Fallback: one note.
      if (viaTool) {
        state.history.push({
          role: "tool",
          results: actions.map((a, i) => ({
            id: a.id,
            name: a.toolName,
            output: i < results.length ? formatOneResult(results[i]) : "(not run)",
          })),
        });
      } else if (results.length) {
        state.history.push({ role: "user", content: resultsToText(results) });
      }

      if (aborted || !ranAny) return;
    }
    info(`reached the ${MAX_STEPS}-step limit; send another message to continue.`);
  } catch (e) {
    process.stdout.write("\n");
    err(`chat error: ${e.message || e}`);
  } finally {
    autosave(); // persist the conversation so /resume can pick it back up
  }
}
