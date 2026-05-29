// Unit tests for the pure argv/flag builders in argv-builder.js.
// These must run WITHOUT spawning cursor-agent or any child process.
// Refs #6.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionFlags, buildFinalArgv } from '../argv-builder.js';

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
