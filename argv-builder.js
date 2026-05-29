// Pure helpers for the cursor-agent MCP wrapper.
// No I/O, no child_process — safe to import from tests.
// Imported by server.js (argv assembly, timeout resolution, result projection,
// model-list parsing, session-registry path resolution and upsert logic).
// I/O for the session registry lives in session-registry.js.

import path from 'node:path';
import os from 'node:os';

// Build flags for workspace/worktree/sandbox/trust selection. Refs #5.
// Canonical emission order: --workspace, -w[/name], --worktree-base,
// --skip-worktree-setup, --sandbox, --trust. Falsy / blank / invalid values
// are silently skipped — cursor-agent rejects unknown enum values, so we
// pre-validate `sandbox` here.
export function buildWorkspaceFlags({
  workspace,
  worktree,
  worktree_base,
  skip_worktree_setup,
  sandbox,
  trust,
} = {}) {
  const flags = [];
  if (workspace && String(workspace).trim()) {
    flags.push('--workspace', String(workspace).trim());
  }
  if (worktree === true) {
    flags.push('-w');
  } else if (typeof worktree === 'string' && worktree.trim()) {
    flags.push('-w', worktree.trim());
  }
  if (worktree_base && String(worktree_base).trim()) {
    flags.push('--worktree-base', String(worktree_base).trim());
  }
  if (skip_worktree_setup === true) {
    flags.push('--skip-worktree-setup');
  }
  if (sandbox === 'enabled' || sandbox === 'disabled') {
    flags.push('--sandbox', sandbox);
  }
  if (trust === true) {
    flags.push('--trust');
  }
  return flags;
}

// Build leading CLI flags for execution mode and session continuity.
// `resume` (specific id) takes precedence over `continue_session` (most recent).
export function buildSessionFlags({ mode, resume, continue_session } = {}) {
  const flags = [];
  if (mode && String(mode).trim()) flags.push('--mode', String(mode).trim());
  if (resume && String(resume).trim()) flags.push('--resume', String(resume).trim());
  else if (continue_session) flags.push('--continue');
  return flags;
}

// Compose the full argv handed to cursor-agent, given user-supplied argv, model/force
// preferences, and the surrounding environment. Pure — no I/O, no spawn.
//
// Precedence rules (preserved from the original inline logic in server.js):
//   - Per-call `model` beats CURSOR_AGENT_MODEL env.
//   - Per-call `force` (boolean) beats CURSOR_AGENT_FORCE env; omit/undefined falls through to env.
//   - If user already supplied -m / --model / --model=<v> in argv, do NOT append another.
//   - If user already supplied -f / --force in argv, do NOT append another.
//   - Emitted long form is `--model` (cursor-agent rejects `-m` in this build); user-supplied `-m` is left untouched.
//   - `print:false` omits the leading `--print --output-format <fmt>` pair (used by the raw escape hatch).
export function buildFinalArgv({
  argv,
  output_format = 'text',
  model,
  force,
  print = true,
  env = process.env,
  workspace,
  worktree,
  worktree_base,
  skip_worktree_setup,
  sandbox,
  trust,
} = {}) {
  const userArgs = [...(argv ?? [])];
  const hasModelFlag = userArgs.some(
    (a) => a === '-m' || a === '--model' || /^(?:-m=|--model=)/.test(String(a)),
  );
  const envModel = env.CURSOR_AGENT_MODEL && String(env.CURSOR_AGENT_MODEL).trim();
  const effectiveModel = (typeof model === 'string' && model.trim()) || envModel || '';

  const hasForceFlag = userArgs.some((a) => a === '-f' || a === '--force');
  const envForce = (() => {
    const v = String(env.CURSOR_AGENT_FORCE || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  })();
  const effectiveForce = typeof force === 'boolean' ? force : envForce;

  const workspaceFlags = buildWorkspaceFlags({
    workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust,
  });

  return [
    ...(print ? ['--print', '--output-format', output_format] : []),
    ...workspaceFlags,
    ...userArgs,
    ...(hasForceFlag || !effectiveForce ? [] : ['-f']),
    ...(hasModelFlag || !effectiveModel ? [] : ['--model', effectiveModel]),
  ];
}

// Default server-side hard timeout (ms) for a synchronous cursor-agent call.
// Raised from the original 30s to 5 minutes because real cursor-agent tasks
// (multi-file edits, deep analysis, plan generation) routinely run longer.
// Issue #2 (async start/poll) is the structural fix for tasks > MCP-client wall;
// this is the short-term mitigation that prevents premature SIGKILL on the
// common "task completes in 30–90s" case. Refs #9.
export const DEFAULT_TIMEOUT_MS = 300000;

// Resolve the effective hard-timeout for one cursor-agent invocation.
// Precedence: per-call timeout_ms > CURSOR_AGENT_TIMEOUT_MS env > defaultMs.
// Invalid values (NaN, ≤0, non-number for per-call; ≤0/unparseable for env) are ignored.
export function resolveTimeoutMs({
  timeout_ms,
  env = process.env,
  defaultMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof timeout_ms === 'number' && Number.isFinite(timeout_ms) && timeout_ms > 0) {
    return timeout_ms;
  }
  const envRaw = env?.CURSOR_AGENT_TIMEOUT_MS;
  if (envRaw != null && envRaw !== '') {
    const envParsed = Number.parseInt(String(envRaw), 10);
    if (Number.isFinite(envParsed) && envParsed > 0) return envParsed;
  }
  return defaultMs;
}

// Top-level JSON fields we lift into structuredContent so MCP hosts can read
// them as first-class data without re-parsing. session_id is the only one we
// rely on (used by `resume`); model/usage/result are surfaced opportunistically.
const SURFACED_JSON_KEYS = ['session_id', 'model', 'usage', 'result'];

// Build a structured MCP tool result for a cursor-agent stdout.
// Always returns { content, structuredContent } ready to spread into a tool reply.
// - content: [{type: 'text', text}] preserves the raw stdout for back-compat
//   (callers reading content[0].text continue to work).
// - structuredContent always carries duration_ms (null if timing not supplied).
//   When output_format === 'json' and stdout is parseable, surfaces session_id,
//   model, usage, result (when present), and the full parsed payload under `raw`.
//   On parse failure: parsed=false plus parse_error string; content unchanged.
// Refs #3.
export function buildStructuredResult({
  stdout = '',
  output_format = 'text',
  started_at_ms,
  ended_at_ms,
} = {}) {
  const duration_ms =
    typeof started_at_ms === 'number' && typeof ended_at_ms === 'number'
      ? Math.max(0, ended_at_ms - started_at_ms)
      : null;

  const structuredContent = { duration_ms };
  const text = stdout && stdout.length > 0 ? stdout : '(no output)';

  if (output_format === 'json' && stdout) {
    try {
      const parsed = JSON.parse(stdout);
      structuredContent.parsed = true;
      structuredContent.raw = parsed;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of SURFACED_JSON_KEYS) {
          if (parsed[key] !== undefined) structuredContent[key] = parsed[key];
        }
      }
    } catch (e) {
      structuredContent.parsed = false;
      structuredContent.parse_error = String(e?.message || e);
    }
  }

  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

// Assemble the argv that a prompt-based cursor-agent call hands to the
// CLI body (after the leading --print/--output-format that buildFinalArgv
// adds). Layout: [...sessionFlags, ...extra_args, prompt]. Refs #2.
export function buildPromptArgv({ prompt, extra_args, mode, resume, continue_session } = {}) {
  const sessionFlags = buildSessionFlags({ mode, resume, continue_session });
  return [...sessionFlags, ...(extra_args ?? []), String(prompt ?? '')];
}

// Translate a job entry (see jobs.js) into the MCP tool result shape that
// cursor_agent_poll / cursor_agent_cancel return. Pure — depends only on
// the job snapshot, not on any global state. Refs #2.
export function buildJobPollResponse(job) {
  if (!job) {
    return {
      content: [{ type: 'text', text: 'Unknown job_id (may have expired or never existed)' }],
      isError: true,
    };
  }
  const { job_id, status, stdout = '', stderr = '', output_format = 'text', started_at_ms, ended_at_ms, exit_code, error } = job;
  const duration_ms =
    typeof started_at_ms === 'number' && typeof ended_at_ms === 'number'
      ? Math.max(0, ended_at_ms - started_at_ms)
      : null;

  if (status === 'running') {
    const elapsed_ms = typeof started_at_ms === 'number' ? Math.max(0, Date.now() - started_at_ms) : null;
    return {
      content: [{ type: 'text', text: `Job ${job_id} running (${stdout.length} bytes stdout buffered, ${elapsed_ms ?? '?'}ms elapsed).` }],
      structuredContent: { job_id, status: 'running', partial_stdout: stdout, elapsed_ms },
    };
  }

  if (status === 'completed') {
    const built = buildStructuredResult({
      stdout, output_format, started_at_ms, ended_at_ms,
    });
    return {
      content: built.content,
      structuredContent: { ...built.structuredContent, job_id, status: 'completed' },
    };
  }

  if (status === 'timed_out') {
    const partial = stdout ? `\n\nPartial output (${stdout.length} bytes):\n${stdout}` : '';
    return {
      content: [{ type: 'text', text: `Job ${job_id} timed out${partial}` }],
      isError: true,
      structuredContent: { job_id, status: 'timed_out', partial_stdout: stdout, duration_ms },
    };
  }

  if (status === 'cancelled') {
    return {
      content: [{ type: 'text', text: `Job ${job_id} cancelled (${stdout.length} bytes stdout buffered before cancel).` }],
      structuredContent: { job_id, status: 'cancelled', partial_stdout: stdout, duration_ms },
    };
  }

  // failed (spawn error OR non-zero exit)
  const text = error
    ? `Job ${job_id} failed: ${error}`
    : `Job ${job_id} exited with code ${exit_code}\n${stderr || stdout || '(no output)'}`;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: {
      job_id,
      status: 'failed',
      exit_code: exit_code ?? null,
      error: error ?? null,
      partial_stdout: stdout,
      duration_ms,
    },
  };
}

// Resolve the on-disk path for the persistent session registry.
// Precedence: CURSOR_AGENT_MCP_STATE_DIR env (explicit) >
//             $XDG_STATE_HOME/cursor-agent-mcp >
//             $HOME/.local/state/cursor-agent-mcp.
// File name is always `sessions.json`. Refs #1.
export function resolveSessionRegistryPath({ env = process.env, home = os.homedir() } = {}) {
  if (env.CURSOR_AGENT_MCP_STATE_DIR && String(env.CURSOR_AGENT_MCP_STATE_DIR).trim()) {
    return path.join(String(env.CURSOR_AGENT_MCP_STATE_DIR).trim(), 'sessions.json');
  }
  const xdgState =
    (env.XDG_STATE_HOME && String(env.XDG_STATE_HOME).trim()) ||
    path.join(home, '.local', 'state');
  return path.join(xdgState, 'cursor-agent-mcp', 'sessions.json');
}

// Pure upsert: given an existing registry blob and a new entry, return the
// updated registry. Does NOT touch disk — callers read/write at the boundary.
// On first sight of a session_id: appends with first_seen_at=last_seen_at=now
// and any optional model/prompt_preview supplied.
// On repeat: updates last_seen_at, allows model to be promoted from absent or
// to a new value, but PRESERVES prompt_preview (we want the original prompt
// for context, not a later resume's prompt).
// Non-array `sessions` and unrelated top-level keys are tolerated.
// Refs #1.
export function upsertSessionEntry(existingRegistry, entry) {
  if (!entry || typeof entry !== 'object' || !entry.session_id) {
    throw new TypeError('upsertSessionEntry: entry.session_id is required');
  }
  const baseSessions = Array.isArray(existingRegistry?.sessions)
    ? existingRegistry.sessions
    : [];
  const sessions = [...baseSessions];
  const ts = typeof entry.timestamp_ms === 'number' ? entry.timestamp_ms : Date.now();
  const iso = new Date(ts).toISOString();
  const idx = sessions.findIndex((s) => s && s.session_id === entry.session_id);
  if (idx >= 0) {
    const prev = sessions[idx];
    sessions[idx] = {
      ...prev,
      last_seen_at: iso,
      ...(entry.model ? { model: entry.model } : {}),
    };
  } else {
    sessions.push({
      session_id: entry.session_id,
      first_seen_at: iso,
      last_seen_at: iso,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.prompt_preview ? { prompt_preview: entry.prompt_preview } : {}),
    });
  }
  return { ...existingRegistry, sessions };
}

// Parse cursor-agent's `--list-models` text output into a structured list.
// Sample line format: "auto - Auto (current)" or "gpt-5.3-codex - Codex 5.3".
// Header ("Available models") and blank/non-matching lines are ignored.
// Returns { models: [{id, name}, ...] } preserving input order.
// Refs #4.
export function parseModelList(text) {
  const models = [];
  if (text == null) return { models };
  const lineRe = /^\s*([A-Za-z0-9][\w.\-]*)\s+-\s+(.+?)\s*$/;
  for (const line of String(text).split('\n')) {
    const m = line.match(lineRe);
    if (m) models.push({ id: m[1], name: m[2] });
  }
  return { models };
}
