# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file **MCP server (`server.js`) that wraps the `cursor-agent` CLI** over stdio, exposing it as Claude-friendly tools (chat / edit / analyze / search / plan / raw). It lets an MCP host (Claude Code) drive cursor-agent's headless print mode. `private: true`, runs from the repo (not published to npm).

This is a fork: `origin` = `0reo/cursor-agent-mcp` (ours), `upstream` = `sailay1996/cursor-agent-mcp`. Enhancement work is tracked in **issues on the fork** (`gh issue list -R 0reo/cursor-agent-mcp`).

## Commands

```bash
npm ci                       # install deps (@modelcontextprotocol/sdk, zod)
node --check server.js       # fast syntax check after edits
node verify_modes.mjs        # E2E: mode:plan + resume round-trip (spawns a FRESH server; makes ~3 real cursor-agent calls — bills the Cursor plan)
npm test                     # runs test_client.mjs — also a LIVE E2E that bills; not a unit test
```

There are currently **no pure unit tests** (tracked: fork issue #6). The flag-building logic is pure and should be unit-tested without spawning cursor-agent.

Running the server standalone (normally a host spawns it):
```bash
CURSOR_AGENT_PATH=/home/oreo/.local/bin/cursor-agent CURSOR_AGENT_MODEL=auto node server.js
DEBUG_CURSOR_MCP=1 ...        # logs the exact spawned argv + session/extra flags to stderr — the primary debugging lever
```

## Architecture

Two layers inside `server.js`:

- **`invokeCursorAgent({argv, output_format, model, force, print, ...})`** — the only place that spawns the binary (`spawn`, `shell:false`). Builds `finalArgv = [--print --output-format <fmt>, ...userArgs, (-f if force), (--model <m>)]`, then manages the main timeout (`CURSOR_AGENT_TIMEOUT_MS`) and idle kill (`CURSOR_AGENT_IDLE_EXIT_MS`). Resolves the executable via `resolveExecutable()` (explicit arg → `CURSOR_AGENT_PATH` → PATH).
- **`runCursorAgent(input)`** — assembles the prompt path: `argv = [...buildSessionFlags(...), ...extra_args, prompt]`, then calls `invokeCursorAgent`. Handles prompt echo. **All prompt-based tools funnel through here.**

Tool registration (via `server.tool` + zod schemas):
- `cursor_agent_chat` / `cursor_agent_run` pass the whole args object through.
- `cursor_agent_edit_file` / `analyze_files` / `search_repo` / `plan_task` are **prompt-composition wrappers**: they hand-pick fields into a new object for `runCursorAgent`. **Consequence: any new shared param must be threaded into each of these handlers individually** or it silently drops.
- `cursor_agent_raw` calls `invokeCursorAgent` directly with `print:false` (full escape hatch; ignores typed mode/resume — put flags in `argv`).
- `COMMON` is the shared schema object spread into every tool (output_format, model, force, mode, resume, continue_session, extra_args, cwd, executable, echo_prompt).

## Critical gotchas (hard-won — do not regress)

- **Model flag is `--model`, NOT `-m`.** The installed cursor-agent build rejects `-m` (`error: unknown option '-m'`). Detection accepts both; emission must be `--model` (`invokeCursorAgent` finalArgv).
- **Headless modes are `plan` and `ask` only.** `--mode debug` (and the rest of the interactive TUI mode wheel) is rejected headless. `mode` is a `z.enum(['plan','ask'])`.
- **`plan_task` defaults to `mode:'plan'`** — real read-only at the CLI, not just a prompt asking for a plan. Override via explicit `mode`.
- **`force` is the real write gate.** It maps to `--force`/`-f` and is Claude-decided per call (env default `CURSOR_AGENT_FORCE` = propose-only). `edit_file`'s `apply`/`dry_run` are **only prompt hints** — they do NOT write; `force:true` does.
- **`continue` is a JS reserved word** → the param is named `continue_session` (`--continue`). `resume` (`--resume <id>`) wins if both are given.
- **`cursor-agent ls` is TTY-only** — it errors in headless (`Raw mode is not supported`). There is no headless way to *list* sessions; you can only *resume* a known `session_id` (returned in `--output-format json`). Headless discovery needs a registry (fork issue #1).
- **MCP client timeout ≠ server timeout.** The MCP SDK client default request timeout is **60s**, independent of `CURSOR_AGENT_TIMEOUT_MS`. Long calls fail at the client even while the server works. Mitigation = async start/poll (fork issue #2). In `verify_modes.mjs` the client timeout is raised via `callTool(params, undefined, {timeout})`.
- **Editing `server.js` does not hot-reload.** A host's MCP server process is whatever was spawned at session start / last `/reload-plugins`. Verify changes with `node verify_modes.mjs` (it spawns its own fresh server); activate in a host via `/reload-plugins` or restart.

## Environment variables

`CURSOR_AGENT_PATH` (binary path), `CURSOR_AGENT_MODEL` (default model — use `auto`/`gpt-5.2`/`gpt-5.3-codex`; the README's `gpt-5` is stale), `CURSOR_AGENT_FORCE` (write default; leave unset = propose-only), `CURSOR_AGENT_TIMEOUT_MS` (server hard timeout), `CURSOR_AGENT_IDLE_EXIT_MS` (`0` recommended — prevents premature termination mid-generation), `CURSOR_AGENT_ECHO_PROMPT`, `DEBUG_CURSOR_MCP=1`.

## How it's consumed

Registered with Claude Code at user scope via `claude mcp add cursor-agent -s user -e ... -- node <abs path>/server.js`. cursor-agent must be installed and authenticated (`cursor-agent status`); its models bill against the Cursor plan.
