# HANDOFF — cursor-agent-mcp enhancement build

**Date:** 2026-05-28 · **By:** mc-daemon (session fd866c65-20e4-4130-89b5-b47eeaa88568)
**For:** a fresh Claude Code session started **inside this folder** (`/home/oreo/Development/cursor-agent-mcp`).

> Read `CLAUDE.md` first — it has the architecture and the hard-won gotchas. This file is the *work plan*.

## Mission
Implement **all 8** enhancement issues on the fork (`gh issue list -R 0reo/cursor-agent-mcp`). The user approved building everything ("I want all of those").

## What's already done (this session)
- Server installed at this path; registered with Claude Code at **user scope** (`claude mcp add cursor-agent -s user … -- node …/server.js`) → `claude mcp list` shows ✓ Connected.
- **Shipped + verified** (commits below): fixed `-m`→`--model`; `npm audit fix` → 0 vulns; `force` write-gate is Claude-decided per call; first-class `mode` (plan/ask) / `resume` / `continue_session`; `plan_task` enforces `--mode plan`. Proven via `node verify_modes.mjs` (mode:plan read-only confirmed; resume round-trip recalled a codeword).
- Git: 3 commits pushed to `origin` (`0reo/cursor-agent-mcp`, branch `main`). `upstream` = `sailay1996/cursor-agent-mcp`.
  - `e1b397e` test harness · `46c52a6` fix+feat (model/mode/resume/plan_task) · `e8b9b1b` deps+gitignore
- 8 issues filed (#1–#8) with `enhancement` + `tier-N` labels.

## The 8 issues (build targets)
**Tier 1 (do first):**
- #1 Session registry + `cursor_agent_list_sessions` — headless discovery (`ls` is TTY-only). *The strategic capability jump; works on stdio.*
- #2 Async `start`/`poll` job pattern — defeats the **60s MCP client timeout** (biggest reliability gap).
- #3 Structured result — surface `session_id`, `usage`, `duration` instead of a raw blob.

**Tier 2:**
- #4 `cursor_agent_list_models` tool — kills the stale-model footgun.
- #5 First-class `workspace`/`worktree`/`sandbox`/`trust` params.
- #6 Pure unit tests for the argv/flag builders — fast, no billing; would have caught the `-m` bug.

**Tier 3:**
- #7 Streaming via MCP progress notifications (depends on/complements #2, #3).
- #8 Package as a Claude Code plugin (do last — ship something complete).

## Recommended build order
1. **#6 (unit tests)** + **#3 (structured result)** — small, and #6 gives you a safety net before touching argv logic.
2. **#4 (list_models)** — trivial, removes a footgun.
3. **#1 (registry)** — the real capability.
4. **#2 (async)** then **#5 (workspace params)**.
5. **#7 (streaming)**, then **#8 (plugin packaging)**.

Work **test-first** (superpowers:test-driven-development) — once #6 lands there's a runner to extend. One commit per issue; reference `Refs #N` in commit messages. Push to `origin` (the fork).

## Workflow notes / guardrails
- **Activation:** edits to `server.js` need `/reload-plugins` (or daemon restart) to take effect in a live host. Always verify fresh code with `node verify_modes.mjs` (spawns its own server) — do NOT trust the running MCP process to reflect edits.
- **Billing:** `verify_modes.mjs` and `npm test` make real cursor-agent calls (bills the Cursor plan). Prefer the new **unit tests (#6)** for fast iteration.
- **gh targeting:** multiple remotes exist — always pass `-R 0reo/cursor-agent-mcp` (or rely on `gh repo set-default 0reo/cursor-agent-mcp`, already set) so you never write to `upstream` (sailay's repo). Do **not** push or open PRs to `upstream`.
- **Threading params:** the 4 composed-prompt handlers (`edit_file`/`analyze_files`/`search_repo`/`plan_task`) hand-pick fields — any new `COMMON` param must be added to each handler's destructure + pass-through (see how `mode`/`resume` were threaded in `46c52a6`).
- Decisions already locked: **stdio now, HTTP (Streamable HTTP, not deprecated SSE) later**; `force` defaults to propose-only and is Claude-decided per call.

## Quick commands
```bash
gh issue list -R 0reo/cursor-agent-mcp          # the work queue
node --check server.js                          # syntax
node verify_modes.mjs                           # E2E (bills)
git log --oneline -5                            # history
git push origin main                            # publish to the fork
```
