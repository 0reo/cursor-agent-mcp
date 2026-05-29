// Unit tests for the pure argv/flag builders in argv-builder.js.
// These must run WITHOUT spawning cursor-agent or any child process.
// Refs #6.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionFlags,
  buildFinalArgv,
  resolveTimeoutMs,
  buildStructuredResult,
  parseModelList,
  resolveSessionRegistryPath,
  upsertSessionEntry,
  buildPromptArgv,
  buildJobPollResponse,
  buildWorkspaceFlags,
} from '../argv-builder.js';

describe('buildSessionFlags', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(buildSessionFlags(), []);
    assert.deepEqual(buildSessionFlags({}), []);
  });

  it('emits --mode <value> when mode is set', () => {
    assert.deepEqual(buildSessionFlags({ mode: 'plan' }), ['--mode', 'plan']);
    assert.deepEqual(buildSessionFlags({ mode: 'ask' }), ['--mode', 'ask']);
  });

  it('trims whitespace around mode', () => {
    assert.deepEqual(buildSessionFlags({ mode: '  plan  ' }), ['--mode', 'plan']);
  });

  it('ignores empty/whitespace mode', () => {
    assert.deepEqual(buildSessionFlags({ mode: '' }), []);
    assert.deepEqual(buildSessionFlags({ mode: '   ' }), []);
  });

  it('emits --resume <id> when resume is set', () => {
    assert.deepEqual(buildSessionFlags({ resume: 'abc-123' }), ['--resume', 'abc-123']);
  });

  it('emits --continue when continue_session is true and resume is absent', () => {
    assert.deepEqual(buildSessionFlags({ continue_session: true }), ['--continue']);
  });

  it('resume wins over continue_session when both are set', () => {
    assert.deepEqual(
      buildSessionFlags({ resume: 'abc-123', continue_session: true }),
      ['--resume', 'abc-123'],
    );
  });

  it('ignores falsy continue_session', () => {
    assert.deepEqual(buildSessionFlags({ continue_session: false }), []);
    assert.deepEqual(buildSessionFlags({ continue_session: 0 }), []);
  });

  it('composes mode and resume in canonical order (mode first, then resume)', () => {
    assert.deepEqual(
      buildSessionFlags({ mode: 'plan', resume: 'abc' }),
      ['--mode', 'plan', '--resume', 'abc'],
    );
  });
});

describe('buildFinalArgv', () => {
  const emptyEnv = {};

  it('emits --print and --output-format text by default', () => {
    assert.deepEqual(
      buildFinalArgv({ argv: ['hello'], env: emptyEnv }),
      ['--print', '--output-format', 'text', 'hello'],
    );
  });

  it('respects output_format', () => {
    assert.deepEqual(
      buildFinalArgv({ argv: ['hi'], output_format: 'json', env: emptyEnv }),
      ['--print', '--output-format', 'json', 'hi'],
    );
  });

  it('omits --print and --output-format when print:false', () => {
    assert.deepEqual(
      buildFinalArgv({ argv: ['--help'], print: false, env: emptyEnv }),
      ['--help'],
    );
  });

  it('emits --model <m> (NOT -m) when model arg is provided', () => {
    const argv = buildFinalArgv({ argv: ['hello'], model: 'gpt-5.3-codex', env: emptyEnv });
    assert.ok(argv.includes('--model'), 'expected --model flag');
    assert.ok(!argv.includes('-m'), 'must NOT use -m (cursor-agent rejects it)');
    assert.equal(argv[argv.indexOf('--model') + 1], 'gpt-5.3-codex');
  });

  it('honors CURSOR_AGENT_MODEL env when model arg is absent', () => {
    const argv = buildFinalArgv({ argv: ['hi'], env: { CURSOR_AGENT_MODEL: 'auto' } });
    assert.deepEqual(argv.slice(-2), ['--model', 'auto']);
  });

  it('per-call model overrides env', () => {
    const argv = buildFinalArgv({
      argv: ['hi'],
      model: 'gpt-5.3-codex',
      env: { CURSOR_AGENT_MODEL: 'auto' },
    });
    assert.deepEqual(argv.slice(-2), ['--model', 'gpt-5.3-codex']);
  });

  it('does NOT duplicate --model when user already passed -m in argv', () => {
    const argv = buildFinalArgv({
      argv: ['-m', 'auto', 'hi'],
      model: 'gpt-5.3-codex',
      env: emptyEnv,
    });
    // User-supplied -m wins; we must not append another --model
    assert.equal(argv.filter((a) => a === '--model').length, 0);
    assert.equal(argv.filter((a) => a === '-m').length, 1);
  });

  it('does NOT duplicate --model when user already passed --model= in argv', () => {
    const argv = buildFinalArgv({
      argv: ['--model=auto', 'hi'],
      model: 'gpt-5.3-codex',
      env: emptyEnv,
    });
    assert.equal(argv.filter((a) => a === '--model').length, 0);
    assert.equal(argv.filter((a) => /^--model=/.test(a)).length, 1);
  });

  it('adds -f when force:true', () => {
    const argv = buildFinalArgv({ argv: ['hi'], force: true, env: emptyEnv });
    assert.ok(argv.includes('-f'), 'expected -f');
  });

  it('omits -f when force is omitted/false and env is unset', () => {
    assert.ok(!buildFinalArgv({ argv: ['hi'], env: emptyEnv }).includes('-f'));
    assert.ok(!buildFinalArgv({ argv: ['hi'], force: false, env: emptyEnv }).includes('-f'));
  });

  it('honors CURSOR_AGENT_FORCE env when force arg is absent', () => {
    for (const truthy of ['1', 'true', 'yes', 'on', 'TRUE', 'YES']) {
      const argv = buildFinalArgv({ argv: ['hi'], env: { CURSOR_AGENT_FORCE: truthy } });
      assert.ok(argv.includes('-f'), `expected -f for env value ${truthy}`);
    }
  });

  it('per-call force=false overrides truthy env (explicit opt-out)', () => {
    const argv = buildFinalArgv({
      argv: ['hi'],
      force: false,
      env: { CURSOR_AGENT_FORCE: '1' },
    });
    assert.ok(!argv.includes('-f'), 'per-call false must beat env');
  });

  it('does NOT duplicate -f when user already passed it in argv', () => {
    const argv = buildFinalArgv({
      argv: ['-f', 'hi'],
      force: true,
      env: emptyEnv,
    });
    assert.equal(argv.filter((a) => a === '-f').length, 1);
  });

  it('does NOT duplicate when user already passed --force in argv', () => {
    const argv = buildFinalArgv({
      argv: ['--force', 'hi'],
      force: true,
      env: emptyEnv,
    });
    assert.equal(argv.filter((a) => a === '-f').length, 0);
    assert.equal(argv.filter((a) => a === '--force').length, 1);
  });

  it('ignores empty CURSOR_AGENT_FORCE values', () => {
    for (const falsy of ['', '0', 'false', 'no', 'off', 'banana']) {
      const argv = buildFinalArgv({ argv: ['hi'], env: { CURSOR_AGENT_FORCE: falsy } });
      assert.ok(!argv.includes('-f'), `must not emit -f for env value '${falsy}'`);
    }
  });

  it('puts --print + output_format BEFORE user argv (so user args can override later if cursor-agent allows)', () => {
    const argv = buildFinalArgv({
      argv: ['sub', '--flag', 'val'],
      env: emptyEnv,
    });
    assert.deepEqual(argv.slice(0, 3), ['--print', '--output-format', 'text']);
    assert.deepEqual(argv.slice(3, 6), ['sub', '--flag', 'val']);
  });

  it('handles missing argv defensively (empty list, no spawn)', () => {
    assert.deepEqual(
      buildFinalArgv({ env: emptyEnv }),
      ['--print', '--output-format', 'text'],
    );
    assert.deepEqual(
      buildFinalArgv({ argv: undefined, env: emptyEnv }),
      ['--print', '--output-format', 'text'],
    );
  });
});

describe('resolveTimeoutMs (Refs #9)', () => {
  const emptyEnv = {};
  const DEFAULT_MS = 300000;

  it('returns the new 5-minute default (300000ms) when nothing is configured', () => {
    assert.equal(resolveTimeoutMs({ env: emptyEnv }), DEFAULT_MS);
    assert.equal(resolveTimeoutMs(), DEFAULT_MS > 0 ? resolveTimeoutMs() : DEFAULT_MS);
  });

  it('honors CURSOR_AGENT_TIMEOUT_MS env when per-call is absent', () => {
    assert.equal(resolveTimeoutMs({ env: { CURSOR_AGENT_TIMEOUT_MS: '60000' } }), 60000);
  });

  it('per-call timeout_ms beats env', () => {
    assert.equal(
      resolveTimeoutMs({
        timeout_ms: 120000,
        env: { CURSOR_AGENT_TIMEOUT_MS: '60000' },
      }),
      120000,
    );
  });

  it('per-call timeout_ms beats default', () => {
    assert.equal(resolveTimeoutMs({ timeout_ms: 45000, env: emptyEnv }), 45000);
  });

  it('ignores invalid per-call values (NaN, 0, negative, non-number) and falls back', () => {
    for (const bad of [Number.NaN, 0, -1, '60000', null, undefined, {}, []]) {
      assert.equal(
        resolveTimeoutMs({ timeout_ms: bad, env: { CURSOR_AGENT_TIMEOUT_MS: '60000' } }),
        60000,
        `bad per-call value ${String(bad)} should fall through to env`,
      );
    }
  });

  it('ignores garbage CURSOR_AGENT_TIMEOUT_MS values and falls back to default', () => {
    for (const garbage of ['', 'abc', '0', '-100', 'NaN']) {
      assert.equal(
        resolveTimeoutMs({ env: { CURSOR_AGENT_TIMEOUT_MS: garbage } }),
        DEFAULT_MS,
        `garbage env value '${garbage}' should fall through to default`,
      );
    }
  });

  it('allows overriding default for callers that want a different baseline', () => {
    assert.equal(
      resolveTimeoutMs({ env: emptyEnv, defaultMs: 90000 }),
      90000,
    );
  });
});

describe('buildStructuredResult (Refs #3)', () => {
  it('always includes duration_ms in structuredContent when timing is provided', () => {
    const r = buildStructuredResult({
      stdout: 'hi',
      output_format: 'text',
      started_at_ms: 1000,
      ended_at_ms: 1500,
    });
    assert.equal(r.structuredContent.duration_ms, 500);
  });

  it('sets duration_ms to null when timing is missing', () => {
    const r = buildStructuredResult({ stdout: 'hi', output_format: 'text' });
    assert.equal(r.structuredContent.duration_ms, null);
  });

  it('clamps negative duration to 0 (clock skew guard)', () => {
    const r = buildStructuredResult({
      stdout: 'hi',
      output_format: 'text',
      started_at_ms: 2000,
      ended_at_ms: 1000,
    });
    assert.equal(r.structuredContent.duration_ms, 0);
  });

  it('text output_format: content is the raw stdout, structuredContent has only duration', () => {
    const r = buildStructuredResult({
      stdout: 'hello world',
      output_format: 'text',
      started_at_ms: 1000,
      ended_at_ms: 1100,
    });
    assert.deepEqual(r.content, [{ type: 'text', text: 'hello world' }]);
    assert.equal(r.structuredContent.session_id, undefined);
    assert.equal(r.structuredContent.parsed, undefined);
  });

  it('substitutes "(no output)" when stdout is empty', () => {
    const r = buildStructuredResult({ stdout: '', output_format: 'text' });
    assert.deepEqual(r.content, [{ type: 'text', text: '(no output)' }]);
  });

  it('json output_format with valid JSON: surfaces session_id, model, usage; flags parsed:true', () => {
    const payload = {
      session_id: 'abc-123',
      model: 'gpt-5.3-codex',
      result: 'agent reply',
      usage: { input_tokens: 100, output_tokens: 42 },
    };
    const r = buildStructuredResult({
      stdout: JSON.stringify(payload),
      output_format: 'json',
      started_at_ms: 1000,
      ended_at_ms: 1750,
    });
    assert.equal(r.structuredContent.session_id, 'abc-123');
    assert.equal(r.structuredContent.model, 'gpt-5.3-codex');
    assert.deepEqual(r.structuredContent.usage, { input_tokens: 100, output_tokens: 42 });
    assert.equal(r.structuredContent.parsed, true);
    assert.deepEqual(r.structuredContent.raw, payload);
    assert.equal(r.structuredContent.duration_ms, 750);
    // back-compat: content still has the raw stdout
    assert.equal(r.content[0].text, JSON.stringify(payload));
  });

  it('json output_format with INVALID JSON: parsed:false, parse_error present, content preserves stdout', () => {
    const r = buildStructuredResult({
      stdout: 'not json {{{',
      output_format: 'json',
      started_at_ms: 0,
      ended_at_ms: 50,
    });
    assert.equal(r.structuredContent.parsed, false);
    assert.ok(typeof r.structuredContent.parse_error === 'string' && r.structuredContent.parse_error.length > 0);
    assert.equal(r.structuredContent.session_id, undefined);
    assert.equal(r.content[0].text, 'not json {{{');
  });

  it('json output_format with parsed primitive (not object): does not crash, no extracted fields', () => {
    const r = buildStructuredResult({
      stdout: '42',
      output_format: 'json',
    });
    assert.equal(r.structuredContent.parsed, true);
    assert.equal(r.structuredContent.session_id, undefined);
    assert.equal(r.structuredContent.raw, 42);
  });

  it('text output_format does NOT attempt JSON parsing even if stdout looks like JSON', () => {
    const r = buildStructuredResult({
      stdout: '{"session_id":"x"}',
      output_format: 'text',
    });
    assert.equal(r.structuredContent.session_id, undefined);
    assert.equal(r.structuredContent.parsed, undefined);
  });

  it('json: missing top-level fields are simply omitted (no defaults injected)', () => {
    const r = buildStructuredResult({
      stdout: JSON.stringify({ session_id: 'only-id' }),
      output_format: 'json',
    });
    assert.equal(r.structuredContent.session_id, 'only-id');
    assert.equal(r.structuredContent.model, undefined);
    assert.equal(r.structuredContent.usage, undefined);
  });
});

describe('parseModelList (Refs #4)', () => {
  it('returns { models: [] } for empty input', () => {
    assert.deepEqual(parseModelList(''), { models: [] });
    assert.deepEqual(parseModelList(undefined), { models: [] });
    assert.deepEqual(parseModelList(null), { models: [] });
  });

  it('skips the header line and any blank lines', () => {
    const out = parseModelList('Available models\n\nauto - Auto (current)\n');
    assert.equal(out.models.length, 1);
    assert.deepEqual(out.models[0], { id: 'auto', name: 'Auto (current)' });
  });

  it('parses multiple models from the sample format', () => {
    const sample = [
      'Available models',
      '',
      'auto - Auto (current)',
      'gpt-5.3-codex - Codex 5.3',
      'gpt-5.3-codex-low-fast - Codex 5.3 Low Fast',
      'composer-2.5 - Composer 2.5',
    ].join('\n');
    const out = parseModelList(sample);
    assert.equal(out.models.length, 4);
    assert.deepEqual(out.models[0], { id: 'auto', name: 'Auto (current)' });
    assert.deepEqual(out.models[1], { id: 'gpt-5.3-codex', name: 'Codex 5.3' });
    assert.deepEqual(out.models[2], { id: 'gpt-5.3-codex-low-fast', name: 'Codex 5.3 Low Fast' });
    assert.deepEqual(out.models[3], { id: 'composer-2.5', name: 'Composer 2.5' });
  });

  it('tolerates trailing/leading whitespace per line', () => {
    const out = parseModelList('  gpt-5 - GPT 5  \n');
    assert.deepEqual(out.models, [{ id: 'gpt-5', name: 'GPT 5' }]);
  });

  it('ignores lines that do not match the "<id> - <name>" shape', () => {
    const text = [
      'Available models',
      '',
      'just a sentence',
      'auto - Auto',
      '----',
      '== section ==',
    ].join('\n');
    const out = parseModelList(text);
    assert.deepEqual(out.models, [{ id: 'auto', name: 'Auto' }]);
  });

  it('treats id token strictly (no spaces, dots/dashes/underscores allowed)', () => {
    // id with space is invalid; the dash on left of separator should be consumed by id
    const out = parseModelList('gpt 5 - GPT 5\nfoo.bar_baz - Foo\n');
    assert.deepEqual(out.models, [{ id: 'foo.bar_baz', name: 'Foo' }]);
  });

  it('preserves the original order from input', () => {
    const out = parseModelList('z-model - Z\na-model - A\nm-model - M\n');
    assert.deepEqual(
      out.models.map((m) => m.id),
      ['z-model', 'a-model', 'm-model'],
    );
  });
});

describe('resolveSessionRegistryPath (Refs #1)', () => {
  it('honors CURSOR_AGENT_MCP_STATE_DIR when set', () => {
    const p = resolveSessionRegistryPath({
      env: { CURSOR_AGENT_MCP_STATE_DIR: '/tmp/custom' },
      home: '/home/x',
    });
    assert.equal(p, '/tmp/custom/sessions.json');
  });

  it('falls back to XDG_STATE_HOME/cursor-agent-mcp/sessions.json', () => {
    const p = resolveSessionRegistryPath({
      env: { XDG_STATE_HOME: '/xdg/state' },
      home: '/home/x',
    });
    assert.equal(p, '/xdg/state/cursor-agent-mcp/sessions.json');
  });

  it('falls back to $HOME/.local/state/... when no env hints', () => {
    const p = resolveSessionRegistryPath({ env: {}, home: '/home/x' });
    assert.equal(p, '/home/x/.local/state/cursor-agent-mcp/sessions.json');
  });

  it('CURSOR_AGENT_MCP_STATE_DIR beats XDG_STATE_HOME', () => {
    const p = resolveSessionRegistryPath({
      env: { CURSOR_AGENT_MCP_STATE_DIR: '/explicit', XDG_STATE_HOME: '/xdg' },
      home: '/home/x',
    });
    assert.equal(p, '/explicit/sessions.json');
  });
});

describe('upsertSessionEntry (Refs #1)', () => {
  const t0 = Date.UTC(2026, 4, 28, 12, 0, 0); // 2026-05-28T12:00:00Z

  it('initializes an empty registry on first call', () => {
    const out = upsertSessionEntry(
      {},
      { session_id: 'abc-1', model: 'auto', timestamp_ms: t0 },
    );
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].session_id, 'abc-1');
    assert.equal(out.sessions[0].first_seen_at, '2026-05-28T12:00:00.000Z');
    assert.equal(out.sessions[0].last_seen_at, '2026-05-28T12:00:00.000Z');
    assert.equal(out.sessions[0].model, 'auto');
  });

  it('appends a new entry rather than overwriting existing', () => {
    const reg = { sessions: [{ session_id: 'first', first_seen_at: 'x', last_seen_at: 'x' }] };
    const out = upsertSessionEntry(reg, {
      session_id: 'second',
      timestamp_ms: t0,
    });
    assert.equal(out.sessions.length, 2);
    assert.equal(out.sessions[0].session_id, 'first');
    assert.equal(out.sessions[1].session_id, 'second');
  });

  it('updates last_seen_at on repeat session_id, preserves first_seen_at', () => {
    const reg = {
      sessions: [{
        session_id: 'abc',
        first_seen_at: '2026-05-27T00:00:00.000Z',
        last_seen_at: '2026-05-27T00:00:00.000Z',
        model: 'auto',
      }],
    };
    const out = upsertSessionEntry(reg, {
      session_id: 'abc',
      timestamp_ms: t0,
    });
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].first_seen_at, '2026-05-27T00:00:00.000Z');
    assert.equal(out.sessions[0].last_seen_at, '2026-05-28T12:00:00.000Z');
    assert.equal(out.sessions[0].model, 'auto', 'model preserved');
  });

  it('updates model on repeat if new entry carries one', () => {
    const reg = {
      sessions: [{ session_id: 'abc', first_seen_at: 'x', last_seen_at: 'x', model: 'auto' }],
    };
    const out = upsertSessionEntry(reg, {
      session_id: 'abc',
      model: 'gpt-5.3-codex',
      timestamp_ms: t0,
    });
    assert.equal(out.sessions[0].model, 'gpt-5.3-codex');
  });

  it('preserves prompt_preview on first insert, does not overwrite on update', () => {
    let reg = upsertSessionEntry({}, {
      session_id: 's1',
      prompt_preview: 'Hello there',
      timestamp_ms: t0,
    });
    reg = upsertSessionEntry(reg, {
      session_id: 's1',
      prompt_preview: 'Should NOT replace',
      timestamp_ms: t0 + 1000,
    });
    assert.equal(reg.sessions[0].prompt_preview, 'Hello there');
  });

  it('tolerates non-array sessions (legacy / corrupted shape) by treating as empty', () => {
    const out = upsertSessionEntry(
      { sessions: 'oops' },
      { session_id: 'new', timestamp_ms: t0 },
    );
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].session_id, 'new');
  });

  it('preserves unrelated registry keys (forward-compat)', () => {
    const out = upsertSessionEntry(
      { sessions: [], version: 1, meta: { foo: 'bar' } },
      { session_id: 'x', timestamp_ms: t0 },
    );
    assert.equal(out.version, 1);
    assert.deepEqual(out.meta, { foo: 'bar' });
  });
});

describe('buildPromptArgv (Refs #2)', () => {
  it('composes [sessionFlags, ...extra_args, prompt]', () => {
    const argv = buildPromptArgv({
      prompt: 'hello',
      mode: 'plan',
      extra_args: ['--foo', 'bar'],
    });
    assert.deepEqual(argv, ['--mode', 'plan', '--foo', 'bar', 'hello']);
  });

  it('no session flags, no extra args, just the prompt', () => {
    assert.deepEqual(buildPromptArgv({ prompt: 'hi' }), ['hi']);
  });

  it('coerces non-string prompt to string', () => {
    assert.deepEqual(buildPromptArgv({ prompt: 42 }), ['42']);
  });

  it('handles undefined extra_args', () => {
    assert.deepEqual(
      buildPromptArgv({ prompt: 'hi', resume: 'abc' }),
      ['--resume', 'abc', 'hi'],
    );
  });
});

describe('buildJobPollResponse (Refs #2)', () => {
  it('null job → isError unknown', () => {
    const r = buildJobPollResponse(null);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Unknown job_id/);
  });

  it('running job → status running, partial_stdout, elapsed_ms', () => {
    const job = {
      job_id: 'j1',
      status: 'running',
      stdout: 'in-progress text',
      stderr: '',
      output_format: 'text',
      started_at_ms: Date.now() - 250,
      ended_at_ms: null,
    };
    const r = buildJobPollResponse(job);
    assert.equal(r.structuredContent.status, 'running');
    assert.equal(r.structuredContent.partial_stdout, 'in-progress text');
    assert.ok(r.structuredContent.elapsed_ms >= 0);
    assert.equal(r.isError, undefined);
  });

  it('completed text job → content has stdout, structuredContent has status completed + duration', () => {
    const job = {
      job_id: 'j2',
      status: 'completed',
      stdout: 'final output',
      stderr: '',
      output_format: 'text',
      started_at_ms: 1000,
      ended_at_ms: 1500,
      exit_code: 0,
    };
    const r = buildJobPollResponse(job);
    assert.equal(r.content[0].text, 'final output');
    assert.equal(r.structuredContent.status, 'completed');
    assert.equal(r.structuredContent.duration_ms, 500);
    assert.equal(r.structuredContent.job_id, 'j2');
  });

  it('completed json job → surfaces session_id + duration', () => {
    const job = {
      job_id: 'j3',
      status: 'completed',
      stdout: JSON.stringify({ session_id: 'sess-1', model: 'auto' }),
      stderr: '',
      output_format: 'json',
      started_at_ms: 0,
      ended_at_ms: 100,
      exit_code: 0,
    };
    const r = buildJobPollResponse(job);
    assert.equal(r.structuredContent.session_id, 'sess-1');
    assert.equal(r.structuredContent.model, 'auto');
    assert.equal(r.structuredContent.status, 'completed');
  });

  it('timed_out job → isError, partial_stdout preserved', () => {
    const job = {
      job_id: 'j4',
      status: 'timed_out',
      stdout: 'partial...',
      stderr: '',
      output_format: 'text',
      started_at_ms: 0,
      ended_at_ms: 1000,
      exit_code: null,
    };
    const r = buildJobPollResponse(job);
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.status, 'timed_out');
    assert.equal(r.structuredContent.partial_stdout, 'partial...');
    assert.match(r.content[0].text, /timed out/i);
    assert.match(r.content[0].text, /partial\.\.\./);
  });

  it('cancelled job → not isError, status cancelled', () => {
    const job = {
      job_id: 'j5',
      status: 'cancelled',
      stdout: 'some output before cancel',
      stderr: '',
      output_format: 'text',
      started_at_ms: 0,
      ended_at_ms: 200,
      exit_code: null,
    };
    const r = buildJobPollResponse(job);
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.status, 'cancelled');
    assert.equal(r.structuredContent.partial_stdout, 'some output before cancel');
  });

  it('failed job (nonzero exit) → isError with exit_code and stderr in text', () => {
    const job = {
      job_id: 'j6',
      status: 'failed',
      stdout: '',
      stderr: 'something went wrong',
      output_format: 'text',
      started_at_ms: 0,
      ended_at_ms: 50,
      exit_code: 2,
      error: null,
    };
    const r = buildJobPollResponse(job);
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.status, 'failed');
    assert.equal(r.structuredContent.exit_code, 2);
    assert.match(r.content[0].text, /something went wrong/);
  });

  it('failed job (spawn error) → isError with error message', () => {
    const job = {
      job_id: 'j7',
      status: 'failed',
      stdout: '',
      stderr: '',
      output_format: 'text',
      started_at_ms: 0,
      ended_at_ms: 5,
      exit_code: null,
      error: 'ENOENT: missing binary',
    };
    const r = buildJobPollResponse(job);
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.status, 'failed');
    assert.equal(r.structuredContent.error, 'ENOENT: missing binary');
    assert.match(r.content[0].text, /ENOENT/);
  });
});

describe('buildWorkspaceFlags (Refs #5)', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(buildWorkspaceFlags(), []);
    assert.deepEqual(buildWorkspaceFlags({}), []);
  });

  it('emits --workspace <path> when workspace is set', () => {
    assert.deepEqual(
      buildWorkspaceFlags({ workspace: '/tmp/myproject' }),
      ['--workspace', '/tmp/myproject'],
    );
  });

  it('trims whitespace around workspace and ignores empty strings', () => {
    assert.deepEqual(
      buildWorkspaceFlags({ workspace: '  /tmp/x  ' }),
      ['--workspace', '/tmp/x'],
    );
    assert.deepEqual(buildWorkspaceFlags({ workspace: '' }), []);
    assert.deepEqual(buildWorkspaceFlags({ workspace: '   ' }), []);
  });

  it('emits bare -w when worktree:true (auto-name)', () => {
    assert.deepEqual(buildWorkspaceFlags({ worktree: true }), ['-w']);
  });

  it('emits -w <name> when worktree is a string', () => {
    assert.deepEqual(
      buildWorkspaceFlags({ worktree: 'experiment-1' }),
      ['-w', 'experiment-1'],
    );
  });

  it('ignores worktree:false and empty/whitespace strings', () => {
    assert.deepEqual(buildWorkspaceFlags({ worktree: false }), []);
    assert.deepEqual(buildWorkspaceFlags({ worktree: '' }), []);
    assert.deepEqual(buildWorkspaceFlags({ worktree: '   ' }), []);
  });

  it('emits --worktree-base <branch> when set', () => {
    assert.deepEqual(
      buildWorkspaceFlags({ worktree_base: 'main' }),
      ['--worktree-base', 'main'],
    );
  });

  it('emits --skip-worktree-setup when true', () => {
    assert.deepEqual(
      buildWorkspaceFlags({ skip_worktree_setup: true }),
      ['--skip-worktree-setup'],
    );
    assert.deepEqual(buildWorkspaceFlags({ skip_worktree_setup: false }), []);
  });

  it('emits --sandbox enabled/disabled, rejects garbage', () => {
    assert.deepEqual(
      buildWorkspaceFlags({ sandbox: 'enabled' }),
      ['--sandbox', 'enabled'],
    );
    assert.deepEqual(
      buildWorkspaceFlags({ sandbox: 'disabled' }),
      ['--sandbox', 'disabled'],
    );
    assert.deepEqual(buildWorkspaceFlags({ sandbox: 'maybe' }), []);
    assert.deepEqual(buildWorkspaceFlags({ sandbox: '' }), []);
  });

  it('emits --trust when true (ignores falsy)', () => {
    assert.deepEqual(buildWorkspaceFlags({ trust: true }), ['--trust']);
    assert.deepEqual(buildWorkspaceFlags({ trust: false }), []);
    assert.deepEqual(buildWorkspaceFlags({ trust: 'yes' }), []);
  });

  it('composes all flags in a stable canonical order', () => {
    assert.deepEqual(
      buildWorkspaceFlags({
        workspace: '/tmp/x',
        worktree: 'wt-1',
        worktree_base: 'main',
        skip_worktree_setup: true,
        sandbox: 'enabled',
        trust: true,
      }),
      ['--workspace', '/tmp/x', '-w', 'wt-1', '--worktree-base', 'main', '--skip-worktree-setup', '--sandbox', 'enabled', '--trust'],
    );
  });
});

describe('buildFinalArgv integration with workspace params (Refs #5)', () => {
  it('threads workspace/worktree/sandbox/trust into the assembled argv', () => {
    const argv = buildFinalArgv({
      argv: ['prompt-text'],
      workspace: '/tmp/p',
      worktree: 'wt',
      sandbox: 'enabled',
      trust: true,
      env: {},
    });
    // Order: --print, --output-format, text, <workspace flags>, <user args>
    assert.deepEqual(argv.slice(0, 3), ['--print', '--output-format', 'text']);
    // workspace flags appear before the user args
    const workspaceIdx = argv.indexOf('--workspace');
    const userIdx = argv.indexOf('prompt-text');
    assert.ok(workspaceIdx >= 0 && userIdx >= 0 && workspaceIdx < userIdx);
    assert.ok(argv.includes('-w'));
    assert.ok(argv.includes('--sandbox'));
    assert.ok(argv.includes('--trust'));
  });

  it('omits workspace flags entirely when none are provided', () => {
    const argv = buildFinalArgv({ argv: ['hi'], env: {} });
    assert.ok(!argv.includes('--workspace'));
    assert.ok(!argv.includes('-w'));
    assert.ok(!argv.includes('--sandbox'));
    assert.ok(!argv.includes('--trust'));
  });
});
