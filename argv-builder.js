// Pure functions for building cursor-agent CLI argv vectors.
// No side effects, no child_process — safe to import from tests.
// Imported by server.js; the MCP server layer composes these into spawn calls.

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

  return [
    ...(print ? ['--print', '--output-format', output_format] : []),
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
