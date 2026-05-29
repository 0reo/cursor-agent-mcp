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
