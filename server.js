// MCP wrapper server for cursor-agent CLI
// Exposes multiple tools (chat/edit/analyze/search/plan/raw + legacy run) for better discoverability.
// Start via MCP config (stdio). Requires Node 18+.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import process from 'node:process';

import {
  buildSessionFlags,
  buildFinalArgv,
  resolveTimeoutMs,
  buildStructuredResult,
  parseModelList,
  resolveSessionRegistryPath,
  buildPromptArgv,
  buildJobPollResponse,
  buildProgressNotification,
} from './argv-builder.js';
import { maybeRecordSession, loadRegistry } from './session-registry.js';
import { createJob, getJob, cancelJob } from './jobs.js';

// Tool input schema
const RUN_SCHEMA = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  output_format: z.enum(['text', 'json', 'markdown']).default('text'),
  extra_args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  // Optional override for the executable path if not on PATH
  executable: z.string().optional(),
  // Optional model and force for parity with other tools/env overrides
  model: z.string().optional(),
  // WRITE GATE — Claude decides per call. true => allow disk writes/shell (--force); omit/false => propose-only.
  force: z.boolean().optional().describe('Write gate (Claude decides per call). true = allow cursor-agent to modify files and run shell on disk (--force). Omit/false = propose-only, read-only.'),
});

// Build an onProgress callback bound to the current MCP request's progressToken.
// Returns undefined when the client did NOT request progress (no token) — that
// way the spawn-side fast path stays branch-free for non-streaming callers.
// Refs #7.
function makeProgressDispatcher(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken == null) return undefined;
  // The MCP SDK enforces per-request notification scoping; we just hand the
  // notification object over. Failures are swallowed so a flaky notification
  // channel cannot crash the underlying cursor-agent call.
  return (chunk, total_bytes) => {
    const notification = buildProgressNotification({
      progressToken,
      progress: total_bytes,
      message: chunk,
    });
    if (notification && typeof extra.sendNotification === 'function') {
      extra.sendNotification(notification).catch(() => {});
    }
  };
}

// Resolve the executable path for cursor-agent
function resolveExecutable(explicit) {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.CURSOR_AGENT_PATH && process.env.CURSOR_AGENT_PATH.trim()) {
    return process.env.CURSOR_AGENT_PATH.trim();
  }
  // default assumes "cursor-agent" is on PATH
  return 'cursor-agent';
}

/**
* Internal executor that spawns cursor-agent with provided argv and common options.
* Adds --print and --output-format, handles env/model/force, timeouts and idle kill.
*/
async function invokeCursorAgent({
  argv, output_format = 'text', cwd, executable, model, force, print = true, timeout_ms,
  workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust,
  onProgress,
}) {
 const cmd = resolveExecutable(executable);
 const finalArgv = buildFinalArgv({
   argv, output_format, model, force, print,
   workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust,
 });
 const timeoutMs = resolveTimeoutMs({ timeout_ms });
 const startedAtMs = Date.now();

 return new Promise((resolve) => {
   let settled = false;
   let out = '';
   let err = '';
   let idleTimer = null;
   let killedByIdle = false;

   const cleanup = () => {
     if (mainTimer) clearTimeout(mainTimer);
     if (idleTimer) clearTimeout(idleTimer);
   };

   if (process.env.DEBUG_CURSOR_MCP === '1') {
     try {
       console.error('[cursor-mcp] spawn:', cmd, ...finalArgv);
     } catch {}
   }

   const child = spawn(cmd, finalArgv, {
     shell: false, // safer across platforms; rely on PATH/PATHEXT
     cwd: cwd || process.cwd(),
     env: process.env,
   });
   try { child.stdin?.end(); } catch {}

   const idleMs = Number.parseInt(process.env.CURSOR_AGENT_IDLE_EXIT_MS || '0', 10);
   const scheduleIdleKill = () => {
     if (!Number.isFinite(idleMs) || idleMs <= 0) return;
     if (idleTimer) clearTimeout(idleTimer);
     idleTimer = setTimeout(() => {
       killedByIdle = true;
       try { child.kill('SIGKILL'); } catch {}
     }, idleMs);
   };

   child.stdout.on('data', (d) => {
     const chunk = d.toString();
     out += chunk;
     scheduleIdleKill();
     // Refs #7 — best-effort streaming via MCP progress notifications. Caller
     // (tool handler) supplies onProgress only when a progressToken is present
     // on the request, so most calls pay no cost here.
     if (typeof onProgress === 'function') {
       try { onProgress(chunk, out.length); } catch {}
     }
   });

   child.stderr.on('data', (d) => {
     err += d.toString();
   });

   child.on('error', (e) => {
     if (settled) return;
     settled = true;
     cleanup();
     if (process.env.DEBUG_CURSOR_MCP === '1') {
       try { console.error('[cursor-mcp] error:', e); } catch {}
     }
     const msg =
       `Failed to start "${cmd}": ${e?.message || e}\n` +
       `Args: ${JSON.stringify(finalArgv)}\n` +
       (process.env.CURSOR_AGENT_PATH ? `CURSOR_AGENT_PATH=${process.env.CURSOR_AGENT_PATH}\n` : '');
     resolve({ content: [{ type: 'text', text: msg }], isError: true });
   });

   const mainTimer = setTimeout(() => {
     try { child.kill('SIGKILL'); } catch {}
     if (settled) return;
     settled = true;
     cleanup();
     // Preserve any partial stdout buffered before the kill — without this, callers
     // see only the timeout message and lose any in-flight progress. Refs #9.
     const partial = out ? `\n\nPartial output (${out.length} bytes):\n${out}` : '';
     resolve({
       content: [{ type: 'text', text: `cursor-agent timed out after ${timeoutMs}ms${partial}` }],
       isError: true,
     });
   }, timeoutMs);

   child.on('close', (code) => {
     if (settled) return;
     settled = true;
     cleanup();
     if (process.env.DEBUG_CURSOR_MCP === '1') {
       try { console.error('[cursor-mcp] exit:', code, 'stdout bytes=', out.length, 'stderr bytes=', err.length); } catch {}
     }
     if (code === 0 || (killedByIdle && out)) {
       // Success path: surface session_id, duration, etc. via structuredContent
       // (only parses stdout as JSON when output_format === 'json'). Refs #3.
       const built = buildStructuredResult({
         stdout: out,
         output_format,
         started_at_ms: startedAtMs,
         ended_at_ms: Date.now(),
       });
       // Best-effort session capture — shared with jobs.js via maybeRecordSession. Refs #1.
       // Pass the USER argv (before buildFinalArgv appended --model/-f) so the
       // prompt_preview is the actual prompt, not the trailing model name.
       maybeRecordSession({
         structuredContent: built.structuredContent,
         userArgv: argv,
       }).catch(() => {});
       resolve(built);
     } else {
       resolve({
         content: [{ type: 'text', text: `cursor-agent exited with code ${code}\n${err || out || '(no output)'}` }],
         isError: true,
       });
     }
   });
 });
}

// Back-compat: single-shot run by prompt as positional argument.
// Accepts either a flat args object or an object with an "arguments" field (some hosts).
async function runCursorAgent(input) {
  const source = (input && typeof input === 'object' && input.arguments && typeof input.prompt === 'undefined')
    ? input.arguments
    : input;

  const {
    prompt,
    output_format = 'text',
    extra_args,
    cwd,
    executable,
    model,
    force,
    mode,
    resume,
    continue_session,
    timeout_ms,
    workspace,
    worktree,
    worktree_base,
    skip_worktree_setup,
    sandbox,
    trust,
    onProgress,
  } = source || {};

  const argv = buildPromptArgv({ prompt, extra_args, mode, resume, continue_session });
  const usedPrompt = argv.length ? String(argv[argv.length - 1]) : '';
  const sessionFlags = buildSessionFlags({ mode, resume, continue_session });

  // Optional prompt echo and debug diagnostics
  if (process.env.DEBUG_CURSOR_MCP === '1') {
    try {
      const preview = usedPrompt.slice(0, 400).replace(/\n/g, '\\n');
      console.error('[cursor-mcp] prompt:', preview);
      if (sessionFlags.length) console.error('[cursor-mcp] session flags:', JSON.stringify(sessionFlags));
      if (extra_args?.length) console.error('[cursor-mcp] extra_args:', JSON.stringify(extra_args));
      if (model) console.error('[cursor-mcp] model:', model);
      if (typeof force === 'boolean') console.error('[cursor-mcp] force:', String(force));
    } catch {}
  }
 
  const result = await invokeCursorAgent({
    argv, output_format, cwd, executable, model, force, timeout_ms,
    workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust,
    onProgress,
  });
 
  // Echo prompt either when env is set or when caller provided echo_prompt: true (if host forwards unknown args it's fine)
  const echoEnabled = process.env.CURSOR_AGENT_ECHO_PROMPT === '1' || source?.echo_prompt === true;
  if (echoEnabled) {
    const text = `Prompt used:\n${usedPrompt}`;
    const content = Array.isArray(result?.content) ? result.content : [];
    return { ...result, content: [{ type: 'text', text }, ...content] };
  }
 
  return result;
}

/**
* Create MCP server and register a suite of cursor-agent tools.
* We expose multiple verbs for better discoverability in hosts (chat/edit/analyze/search/plan),
* plus the legacy cursor_agent_run for back-compat and a raw escape hatch.
*/
const server = new McpServer(
 {
   name: 'cursor-agent',
   version: '1.1.0',
   description: 'MCP wrapper for cursor-agent CLI (multi-tool: chat/edit/analyze/search/plan/raw)',
 },
 {
   instructions:
     [
       'Tools:',
       '- cursor_agent_chat: chat with a prompt; optional model/force/format.',
       '- cursor_agent_edit_file: prompt-based file edit wrapper; you provide file and instruction.',
       '- cursor_agent_analyze_files: prompt-based analysis of one or more paths.',
       '- cursor_agent_search_repo: prompt-based code search with include/exclude globs.',
       '- cursor_agent_plan_task: read-only planning (enforces --mode plan by default) given a goal and optional constraints.',
       '- cursor_agent_list_models: list models advertised by the installed cursor-agent (`--list-models`); returns structuredContent.models = [{id, name}].',
       '- cursor_agent_list_sessions: list session_ids captured by this server (auto-recorded on output_format:"json" calls); structuredContent.sessions = [{session_id, first_seen_at, last_seen_at, model?, prompt_preview?}].',
       '- cursor_agent_start / cursor_agent_poll / cursor_agent_cancel: async job pattern for calls that may exceed the 60s MCP client timeout. start returns { job_id } immediately; poll returns running/completed/failed/timed_out/cancelled state with partial_stdout; cancel SIGTERMs.',
       '- cursor_agent_raw: pass raw argv directly to cursor-agent; set print=false to avoid implicit --print. (Put --mode/--resume in argv yourself; typed mode/resume/continue_session are ignored here.)',
       '- cursor_agent_run: legacy single-shot chat (prompt as positional).',
       'Shared params: force (write gate, Claude-decided), mode (plan|ask — read-only; Debug/other TUI modes are NOT headless-available), resume (continue a specific chat id from a prior JSON result), continue_session (continue most recent), timeout_ms (per-call server hard timeout; default 300s).',
       'Successful results carry MCP structuredContent with at least { duration_ms }; with output_format:"json" they also surface { session_id, model, usage, result, raw } when present in cursor-agent\'s JSON.',
       'Streaming: hosts that pass a progressToken in request _meta receive `notifications/progress` (params.progress = bytes streamed, params.message = a 256-char prefix of the latest stdout chunk). Streaming applies to all spawn-driven tools; async start/poll callers should poll instead.',
     ].join(' '),
 },
);

// Common shape used by multiple schemas
const COMMON = {
 output_format: z.enum(['text', 'json', 'markdown']).default('text'),
 extra_args: z.array(z.string()).optional(),
 cwd: z.string().optional(),
 executable: z.string().optional(),
 model: z.string().optional(),
 // WRITE GATE — Claude decides per call. true => cursor-agent may modify files / run shell on disk (adds --force/-f).
 // Omit or false => read-only: changes are PROPOSED, not applied. Env default (CURSOR_AGENT_FORCE) is propose-only.
 // Set true ONLY when the task's intent is to actually change the workspace; leave unset for chat/analyze/search/plan.
 force: z.boolean().optional().describe('Write gate (Claude decides per call). true = allow cursor-agent to modify files and run shell on disk (--force). Omit/false = propose-only, read-only. Set true ONLY when the task intends to change the workspace.'),
 // EXECUTION MODE — headless cursor-agent only supports plan|ask (Debug/Agent-wheel are TUI-only, unavailable here).
 mode: z.enum(['plan', 'ask']).optional().describe('Cursor execution mode (--mode). plan = read-only planning, NO edits (enforced by cursor-agent). ask = read-only Q&A/explanation. Omit = default agent mode (can act/edit subject to force). Note: Debug and other interactive-TUI modes are NOT available headless.'),
 // SESSION CONTINUITY — resume a prior cursor conversation by id, or continue the most recent.
 resume: z.string().optional().describe('Resume a specific cursor chat by id (--resume <id>). Use the session_id returned in a prior call\'s JSON output to continue that exact conversation.'),
 continue_session: z.boolean().optional().describe('Continue the most recent cursor session (--continue). Prefer `resume` with an explicit id when you have one; if both are given, `resume` wins.'),
 // PER-CALL HARD TIMEOUT (ms). Beats CURSOR_AGENT_TIMEOUT_MS env, which beats the 5-minute default.
 // Use a SMALLER value for quick chats, a LARGER value for heavy analyze/edit calls. Refs #9.
 timeout_ms: z.number().int().positive().optional().describe('Server hard-timeout in ms for this cursor-agent call. Beats CURSOR_AGENT_TIMEOUT_MS env. Default: 300000 (5 min). On timeout the child is SIGKILL-ed and any partial stdout collected so far is returned alongside the timeout message.'),
 // WORKSPACE SELECTION — first-class typed params for the cursor-agent workspace/worktree/sandbox/trust flags. Refs #5.
 workspace: z.string().optional().describe('Workspace directory cursor-agent should use (--workspace). Defaults to cwd if omitted.'),
 worktree: z.union([z.string(), z.boolean()]).optional().describe('Start in an isolated git worktree at ~/.cursor/worktrees/<reponame>/<name> (-w). true = auto-generate a name; string = use that literal name. Pairs with worktree_base and skip_worktree_setup.'),
 worktree_base: z.string().optional().describe('Branch or ref to base the new worktree on (--worktree-base). Only meaningful when worktree is set.'),
 skip_worktree_setup: z.boolean().optional().describe('Skip running worktree setup scripts from .cursor/worktrees.json (--skip-worktree-setup). Only meaningful when worktree is set.'),
 sandbox: z.enum(['enabled', 'disabled']).optional().describe('Explicitly enable or disable cursor-agent sandbox mode (--sandbox), overriding the user config.'),
 trust: z.boolean().optional().describe('Trust the current workspace without prompting (--trust). Only works with --print/headless (which this server always uses for prompt-based tools).'),
 // When true, the server will prepend the effective prompt to the tool output (useful for Claude debugging)
 echo_prompt: z.boolean().optional(),
};

// Schemas
const CHAT_SCHEMA = z.object({
 prompt: z.string().min(1, 'prompt is required'),
 ...COMMON,
});

const EDIT_FILE_SCHEMA = z.object({
 file: z.string().min(1, 'file is required'),
 instruction: z.string().min(1, 'instruction is required'),
 // NOTE: apply/dry_run are prompt HINTS only (composed into the instruction text). The ACTUAL disk write
 // is gated by `force` below — set force:true to truly apply edits, regardless of apply/dry_run.
 apply: z.boolean().optional().describe('Prompt hint asking the agent to apply changes. Does NOT itself write to disk — set force:true for an actual write.'),
 dry_run: z.boolean().optional().describe('Prompt hint to treat as dry-run (no writes). For a guaranteed no-write, also omit/false force.'),
 // optional free-form prompt to pass if the CLI supports one
 prompt: z.string().optional(),
 ...COMMON,
});

const ANALYZE_FILES_SCHEMA = z.object({
  paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  prompt: z.string().optional(),
  ...COMMON,
});

const SEARCH_REPO_SCHEMA = z.object({
  query: z.string().min(1, 'query is required'),
  include: z.union([z.string(), z.array(z.string())]).optional(),
  exclude: z.union([z.string(), z.array(z.string())]).optional(),
  ...COMMON,
});

const PLAN_TASK_SCHEMA = z.object({
 goal: z.string().min(1, 'goal is required'),
 constraints: z.array(z.string()).optional(),
 ...COMMON,
});

const RAW_SCHEMA = z.object({
  // raw argv to pass after common flags; e.g., ["--help"] or ["subcmd","--flag"]
  argv: z.array(z.string()).min(1, 'argv must contain at least one element'),
  print: z.boolean().optional(),
  ...COMMON,
});

// Minimal schema for list_models — only needs path / cwd / timeout overrides.
// The COMMON write-gate / mode / output_format params don't apply to --list-models.
const LIST_MODELS_SCHEMA = z.object({
  cwd: z.string().optional(),
  executable: z.string().optional(),
  timeout_ms: z.number().int().positive().optional().describe('Per-call server hard timeout in ms. Default: 300000.'),
});

// list_sessions takes no params — it reads the persistent registry on disk.
const LIST_SESSIONS_SCHEMA = z.object({});

// Async job tools — defeat the 60s MCP client timeout. Refs #2.
// start takes the same shape as cursor_agent_chat but returns immediately
// with a job_id; poll/cancel act on that handle.
const START_SCHEMA = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  ...COMMON,
});

const POLL_SCHEMA = z.object({
  job_id: z.string().min(1, 'job_id is required'),
});

const CANCEL_SCHEMA = z.object({
  job_id: z.string().min(1, 'job_id is required'),
});

// Tools
server.tool(
  'cursor_agent_chat',
  'Chat with cursor-agent using a prompt and optional model/force/output_format.',
  CHAT_SCHEMA.shape,
  async (args, extra) => {
    try {
      const onProgress = makeProgressDispatcher(extra);
      // Normalize prompt in case the host nests under "arguments"
      const prompt =
        (args && typeof args === 'object' && 'prompt' in args ? args.prompt : undefined) ??
        (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments.prompt : undefined);

      const flat = {
        ...(args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args),
        prompt,
        onProgress,
      };

      return await runCursorAgent(flat);
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_edit_file',
  'Edit a file with an instruction. Prompt-based wrapper; no CLI subcommand required.',
  EDIT_FILE_SCHEMA.shape,
  async (args, extra) => {
    try {
      const onProgress = makeProgressDispatcher(extra);
      const { file, instruction, apply, dry_run, prompt, output_format, cwd, executable, model, force, extra_args, mode, resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust } = args;
      const composedPrompt =
        `Edit the repository file:\n` +
        `- File: ${String(file)}\n` +
        `- Instruction: ${String(instruction)}\n` +
        (apply ? `- Apply changes if safe.\n` : `- Propose a patch/diff without applying.\n`) +
        (dry_run ? `- Treat as dry-run; do not write to disk.\n` : ``) +
        (prompt ? `- Additional context: ${String(prompt)}\n` : ``);
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force, mode, resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust, onProgress });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_analyze_files',
  'Analyze one or more paths; optional prompt. Prompt-based wrapper.',
  ANALYZE_FILES_SCHEMA.shape,
  async (args, extra) => {
    try {
      const onProgress = makeProgressDispatcher(extra);
      const { paths, prompt, output_format, cwd, executable, model, force, extra_args, mode, resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust } = args;
      const list = Array.isArray(paths) ? paths : [paths];
      const composedPrompt =
        `Analyze the following paths in the repository:\n` +
        list.map((p) => `- ${String(p)}`).join('\n') + '\n' +
        (prompt ? `Additional prompt: ${String(prompt)}\n` : '');
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force, mode, resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust, onProgress });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_search_repo',
  'Search repository code with include/exclude patterns. Prompt-based wrapper.',
  SEARCH_REPO_SCHEMA.shape,
  async (args, extra) => {
    try {
      const onProgress = makeProgressDispatcher(extra);
      const { query, include, exclude, output_format, cwd, executable, model, force, extra_args, mode, resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust } = args;
      const inc = include == null ? [] : (Array.isArray(include) ? include : [include]);
      const exc = exclude == null ? [] : (Array.isArray(exclude) ? exclude : [exclude]);
      const composedPrompt =
        `Search the repository for occurrences relevant to:\n` +
        `- Query: ${String(query)}\n` +
        (inc.length ? `- Include globs:\n${inc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
        (exc.length ? `- Exclude globs:\n${exc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
        `Return concise findings with file paths and line references.`;
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force, mode, resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust, onProgress });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_plan_task',
  'Generate a plan for a goal with optional constraints. Runs in read-only --mode plan by default (no edits); override via mode.',
  PLAN_TASK_SCHEMA.shape,
  async (args, extra) => {
    try {
      const onProgress = makeProgressDispatcher(extra);
      const { goal, constraints, output_format, cwd, executable, model, force, extra_args, mode, resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust } = args;
      const cons = constraints ?? [];
      const composedPrompt =
        `Create a step-by-step plan to accomplish the following goal:\n` +
        `- Goal: ${String(goal)}\n` +
        (cons.length ? `- Constraints:\n${cons.map((c)=>`  - ${String(c)}`).join('\n')}\n` : '') +
        `Provide a numbered list of actions.`;
      // Enforce real read-only Plan mode by default (caller may override mode explicitly).
      // This makes plan_task actually no-edit at the CLI level, not just a prompt asking for a plan.
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force, mode: mode ?? 'plan', resume, continue_session, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust, onProgress });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

// List cursor-agent sessions captured by this server across calls. The registry
// is a local JSON file (default: $XDG_STATE_HOME/cursor-agent-mcp/sessions.json).
// `cursor-agent ls` is TTY-only and cannot be used headlessly; this tool plus
// the JSON-output capture in invokeCursorAgent provides a headless alternative. Refs #1.
server.tool(
  'cursor_agent_list_sessions',
  'List cursor-agent sessions captured by this server. Entries are recorded automatically on any successful call where output_format:"json" returned a session_id. Each entry: { session_id, first_seen_at, last_seen_at, model?, prompt_preview? }. Use the registry to pick a session_id for `resume`. Storage path: CURSOR_AGENT_MCP_STATE_DIR > XDG_STATE_HOME > ~/.local/state. Disable capture with CURSOR_AGENT_MCP_DISABLE_REGISTRY=1.',
  LIST_SESSIONS_SCHEMA.shape,
  async () => {
    try {
      const registryPath = resolveSessionRegistryPath();
      const reg = await loadRegistry();
      const sessions = Array.isArray(reg?.sessions) ? reg.sessions : [];
      const text = sessions.length === 0
        ? `No sessions recorded yet.\nRegistry path: ${registryPath}\nSessions are captured automatically when a call sets output_format:"json" and cursor-agent returns a session_id.`
        : sessions.map((s) =>
            `${s.session_id}  ${s.model || '(no model)'}  first=${s.first_seen_at}  last=${s.last_seen_at}` +
            (s.prompt_preview ? `\n  "${s.prompt_preview}"` : ''),
          ).join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { sessions, count: sessions.length, registry_path: registryPath },
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to read session registry: ${e?.message || e}` }], isError: true };
    }
  },
);

// List the models cursor-agent currently advertises (`--list-models`).
// The CLI prints a header + one "<id> - <name>" line per model; we surface
// both the raw text and a parsed array in structuredContent.models. Refs #4.
server.tool(
  'cursor_agent_list_models',
  'List models advertised by the installed cursor-agent (`--list-models`). Returns raw text plus a parsed array { id, name }[] in structuredContent.models. Use this to discover valid `model` values before issuing a chat — avoids the stale-model footgun (e.g., README\'s `gpt-5`).',
  LIST_MODELS_SCHEMA.shape,
  async (args) => {
    try {
      const { cwd, executable, timeout_ms } = args || {};
      const result = await invokeCursorAgent({
        argv: ['--list-models'],
        print: false,
        output_format: 'text',
        cwd,
        executable,
        timeout_ms,
      });
      if (!result.isError) {
        const text = result.content?.[0]?.text || '';
        const { models } = parseModelList(text);
        result.structuredContent = { ...(result.structuredContent || {}), models };
      }
      return result;
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

// Async start/poll/cancel — defeats the 60s MCP client timeout. Refs #2.
// cursor_agent_start spawns the child and returns a job_id without awaiting.
// cursor_agent_poll reads the current job state (running/completed/failed/
// timed_out/cancelled) and returns either a partial-stdout snapshot or the
// final result. cursor_agent_cancel SIGTERMs the child.
server.tool(
  'cursor_agent_start',
  'Start an async cursor-agent call. Returns immediately with { job_id, status:"running" } — does NOT wait for completion. Use cursor_agent_poll(job_id) to check progress and collect the result; use cursor_agent_cancel(job_id) to abort. Same params as cursor_agent_chat. Designed to outlive the 60s MCP client request timeout.',
  START_SCHEMA.shape,
  async (args) => {
    try {
      const source = (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object')
        ? args.arguments
        : args;
      const {
        prompt, output_format = 'text', extra_args, cwd, executable, model, force,
        mode, resume, continue_session, timeout_ms,
        workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust,
      } = source || {};
      const argv = buildPromptArgv({ prompt, extra_args, mode, resume, continue_session });
      const job_id = createJob({
        argv,
        output_format,
        cwd,
        executable,
        model,
        force,
        timeout_ms,
        workspace,
        worktree,
        worktree_base,
        skip_worktree_setup,
        sandbox,
        trust,
      });
      const job = getJob(job_id);
      return {
        content: [{ type: 'text', text: `Started job ${job_id} (poll with cursor_agent_poll).` }],
        structuredContent: {
          job_id,
          status: job?.status ?? 'unknown',
          started_at_ms: job?.started_at_ms,
        },
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_poll',
  'Poll an async job started by cursor_agent_start. Returns the current state — running (with partial_stdout + elapsed_ms), completed (with the full result and structured fields), failed/timed_out/cancelled (with isError). Safe to call repeatedly; terminal-state jobs are retained for 30 minutes.',
  POLL_SCHEMA.shape,
  async ({ job_id }) => buildJobPollResponse(getJob(job_id)),
);

server.tool(
  'cursor_agent_cancel',
  'Cancel an async job started by cursor_agent_start. SIGTERMs the child if still running and marks the job cancelled. Idempotent on terminal-state jobs.',
  CANCEL_SCHEMA.shape,
  async ({ job_id }) => buildJobPollResponse(cancelJob(job_id) ?? getJob(job_id)),
);

// Raw escape hatch for power-users and forward compatibility
server.tool(
 'cursor_agent_raw',
 'Advanced: provide raw argv array to pass after common flags (e.g., ["search","--query","foo"]).',
 RAW_SCHEMA.shape,
 async (args, extra) => {
   try {
     const onProgress = makeProgressDispatcher(extra);
     const { argv, output_format, cwd, executable, model, force, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust } = args;
     // For raw calls we disable implicit --print to allow commands like "--help"
     return await invokeCursorAgent({ argv, output_format, cwd, executable, model, force, print: false, timeout_ms, workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust, onProgress });
   } catch (e) {
     return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
   }
 },
);

// Legacy single-shot prompt tool retained for compatibility
server.tool(
 'cursor_agent_run',
 'Run cursor-agent with a prompt and desired output format (legacy single-shot).',
 RUN_SCHEMA.shape,
 async (args, extra) => {
   try {
     const onProgress = makeProgressDispatcher(extra);
     return await runCursorAgent({ ...args, onProgress });
   } catch (e) {
     return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
   }
 },
);

// Connect using stdio transport
const transport = new StdioServerTransport();

server.connect(transport).catch((e) => {
 console.error('MCP server failed to start:', e);
 process.exit(1);
});