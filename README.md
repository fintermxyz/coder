# coder

A Node.js command-line program: a Linux-style terminal prompt where you chat
with **any AI provider or a local model**, and run local shell commands inline.

```
william@host:~/project$ how do I find large files?
openai:gpt-4o » Use `du -ah . | sort -rh | head`, or `find . -size +100M`.

william@host:~/project$ !du -ah . | sort -rh | head -3
...local command output...

william@host:~/project$ /provider ollama
switched to Ollama (local) (llama3.2); history cleared.

william@host:~/project$ summarize this repo
ollama:llama3.2 » ...streamed from your local model...
```

## How it works

Three kinds of input:

- **Plain text** → sent to the current AI model, streamed back token-by-token
  with conversation memory.
- **`!command`** → runs *your* local shell command immediately via `$SHELL`
  (`!ls -la`, `!git status`, `!cd src`). `cd` changes the shell's own directory.
- **`/command`** → a built-in command (see below).

### Built-in `/` commands

| Command | What it does |
|---|---|
| `/help` | full command list |
| `/identity` | a quick card: user, OS, shell, memory, disk, model |
| `/context` | the full `client_context` JSON sent to the model |
| `/prompt` | the exact system prompt the model receives |
| `/status` | active provider + model + history size |
| `/history` | the conversation so far |
| `/providers` | list known providers |
| `/provider <name>` | switch provider (e.g. `/provider ollama`) |
| `/model` | open an arrow-key picker of the provider's models (↑/↓, Enter, Esc); local models show a loading spinner |
| `/model <id>` | switch directly to a specific model id |
| `/models` | list models the provider offers |
| `/refresh` | re-collect `client_context` (memory/disk/commands) |
| `/reset` | clear the conversation history |
| `/clear` | clear the screen |
| `/exit` | quit (or Ctrl-D) |

### Agentic actions (run commands + edit files, you approve each)

When you ask for something actionable, you see a **spinner** while the model
thinks — not a wall of prose. The model returns **actions** in fenced blocks; the
client previews each and asks **`[Y/n]`** before applying it. Two kinds:

- ` ```run ` — a shell command. Shown in a box; runs locally on approval (in a
  real PTY, so interactive ones work). Output is fed back to the model.
- ` ```write path=… ` — create or edit a file with the block's full contents.
  Shown as a **colored diff** (or full content for a new file); written on
  approval. The model is told to use this for files instead of fragile
  `touch`/`echo >`/`cat <<EOF` shell commands.

Applied actions feed back into the conversation so the model takes the **next
step** — enabling multi-step workflows (scaffold, write code, run tests, fix,
re-run) one approved action at a time.

```
you ❯ write a sum() function with a test, then run it

⠹ thinking…
── suggested 1 action(s) ──────────────────────────────
│ [1/1]  ✎ write src/sum.js │
── write src/sum.js (new file · 3 lines) ──────────────
+ module.exports = function sum(a, b) {
+   return a + b;
+ }
  apply this? [Y/n] y
  ✓ wrote src/sum.js
... (writes src/sum.test.js, then) ...
│ [1/1]  $ node src/sum.test.js │
  run this? [Y/n] y
  ↳ running…
  PASS
  ✓ exit 0
```

Editing an existing file shows a unified diff:

```
── edit src/sum.js (+1 −1) ────────────────────────────
- module.exports = function sum(a, b) {
+ export function sum(a = 0, b = 0) {
  apply this? [Y/n]
```

```
you ❯ scaffold a Next.js app called web

⠹ thinking…
── suggested 1 command(s) ─────────────────────────────
╭──────────────────────────────────────────────╮
│ [1/1]  npx create-next-app@latest web --yes   │
╰──────────────────────────────────────────────╯
  run this? [Y/n] y
  ↳ running…
  ...output...
  ✓ exit 0

⠹ working · step 2…
── suggested 1 command(s) ─────────────────────────────
╭───────────────────────────────╮
│ [1/1]  cd web && npm run dev    │
╰───────────────────────────────╯
  run this? [Y/n] _
```

- The loop auto-continues after each approved batch (up to 15 steps per message)
  until the model finishes with a summary and no run block.
- Press **n** to skip a command, or **Ctrl-C** at a prompt to abort the whole run.
- **Shift+Tab toggles auto mode** ⚡ — suggested actions run/write **without asking**
  for approval (the prompt shows an `⚡auto` badge). Shift+Tab again to turn it off.
  Empty/no-op writes are still skipped, and Ctrl-C still cancels.
- **Ctrl-C** behaves like Claude Code: cancels a running command (second press
  force-kills); aborts a pending Y/n; clears a half-typed line; and at an empty
  prompt, press it twice to exit.
- **Ctrl-C cancels a running command** (e.g. a slow `npm install`) and returns you
  to the prompt — it kills the command and everything it spawned, not the shell.
- On an interactive terminal, anything you type *while the spinner is running* is
  discarded, so an approval is always a fresh, deliberate keypress.
- Model-suggested commands run **non-interactively** (output captured for the
  model). Tell the model to use non-interactive flags (`--yes`, `-y`); it's
  instructed to. A command that would block on a prompt gets EOF instead of
  hanging, and is cancellable with Ctrl-C either way.
- `!` runs **your own** commands with full interactivity (vim, top, menus) and no
  approval; ` ```run ` / ` ```write ` blocks from the model always require
  explicit approval.
- **Empty / no-op writes are rejected automatically.** A `write` block with no
  content is skipped (so it can never truncate a file), and a write whose content
  already matches the file on disk is skipped as "no change" — the model is told
  why so it can correct itself.

> ⚠️ **Run it in your project / a scratch directory, not in coder's own source
> folder.** The model edits files in the current working directory. If you launch
> it from the coder repo and ask for coding/test work, it may "helpfully"
> rewrite coder's own `package.json` or sources. `cd` to the project you want
> to work on first.

## Client context

At startup the program collects a JSON snapshot of the machine and embeds it in
the system prompt sent to **every** provider as `client_context`, so the model
gives OS-correct, resource-aware commands and only suggests tools you actually
have. Run `/context` to see exactly what is sent; `/refresh` re-collects it.

```jsonc
{
  "os":     { "type": "mac", "platform": "darwin", "arch": "arm64", "release": "...", "version": "..." },
  "device": "desktop",                 // "smartphone" on Android/Termux
  "host":   "William-MacBook.local",
  "user":   { "name": "williammarch", "home": "/Users/...", "shell": "/bin/zsh" },
  "memory": { "totalGB": 24, "freeGB": 0.1 },
  "cpu":    { "model": "Apple M5", "cores": 10 },
  "disk":   { "path": "/", "totalGB": 926.3, "freeGB": 173.6 },
  "commands": {                        // commands in /usr/bin, /bin, and the rest of PATH
    "dirs": ["/usr/bin", "/bin", "/usr/local/bin", "..."],
    "count": 2514,
    "truncated": true,
    "list": ["awk", "bash", "curl", "git", "..."]   // capped to 600, sorted
  },
  "runtime": { "node": "v25.9.0" },
  "collectedAt": "2026-06-12T10:38:29.645Z"
}
```

The instruction prepended to the JSON tells the model to tailor shell commands
to this OS/shell, only reference commands that exist on the system, and respect
the available memory and disk.

## Supported providers

Two client kinds cover everything. Anthropic uses its native SDK; every other
provider — and all local runtimes — speaks the OpenAI-compatible
`/chat/completions` API.

| Provider | `/provider` name | Key env var | Notes |
|---|---|---|---|
| Anthropic (Claude) | `anthropic` | `ANTHROPIC_API_KEY` | native SDK, adaptive thinking |
| OpenAI | `openai` | `OPENAI_API_KEY` | |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | OpenAI-compatible endpoint |
| Groq | `groq` | `GROQ_API_KEY` | |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | |
| Mistral | `mistral` | `MISTRAL_API_KEY` | |
| xAI Grok | `xai` | `XAI_API_KEY` | |
| Together | `together` | `TOGETHER_API_KEY` | |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | gateway to many models |
| **Ollama** | `ollama` | — (local) | `http://localhost:11434` |
| **LM Studio** | `lmstudio` | — (local) | `http://localhost:1234` |
| **llama.cpp** | `llamacpp` | — (local) | `http://localhost:8080` |

Local providers need no API key — just have the server running. For local
providers you don't have to name a model: the CLI queries the server's
`/v1/models` and auto-selects a loaded chat model. Override any time with
`/model <id>` or `AI_MODEL`.

```sh
# LM Studio running on localhost:1234 — no key, no model needed:
AI_PROVIDER=lmstudio node cli.js
```

## Setup

```sh
npm install

# pick whichever provider(s) you have keys for:
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

node cli.js
```

The default provider is chosen from `AI_PROVIDER`, else the config file, else
the first provider whose key env var is set, else `anthropic`. Override the
model with `AI_MODEL` or `/model <id>` at runtime.

```sh
# run entirely against a local model, no keys needed:
AI_PROVIDER=ollama AI_MODEL=llama3.2 node cli.js
```

## Custom providers / defaults (optional)

Drop a `.ai-shell.json` in the working directory or your home directory to set
defaults or add any OpenAI-compatible endpoint:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "providers": {
    "mygateway": {
      "kind": "openai",
      "label": "Internal Gateway",
      "baseURL": "https://llm.internal.example.com/v1",
      "keyEnv": "MY_GATEWAY_KEY",
      "model": "house-model-v2"
    },
    "myollama": {
      "kind": "openai",
      "label": "Remote Ollama",
      "baseURL": "http://gpu-box.lan:11434/v1",
      "local": true,
      "model": "qwen2.5"
    }
  }
}
```

## Notes

- The API is stateless; the program resends the conversation each turn, so the
  model remembers context until you `/reset` or switch providers.
- `/models` lists the models the active provider advertises (handy for local
  servers — shows exactly what's loaded).
- Ctrl-C cancels a pending prompt or the current line; Ctrl-D (or `/exit`) quits.

## Files

- `cli.js` — the REPL: prompt, chat, `!` shell path, `/` commands, the
  suggest-and-approve flow.
- `providers.js` — provider registry + unified streaming-chat abstraction.
- `clientinfo.js` — collects the `client_context` machine snapshot.
- `theme.js` — 256-color styling helpers (boxes, rules, bars).
