// Integration-style tests for the JSON session registry I/O layer.
// Uses isolated tmpdirs — no cursor-agent spawn, no billing. Refs #1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  readRegistry,
  writeRegistry,
  recordSession,
  loadRegistry,
  isRegistryDisabled,
  maybeRecordSession,
} from '../session-registry.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cursor-agent-mcp-test-'));
}

describe('session-registry I/O (Refs #1)', () => {
  it('readRegistry returns an empty blob when the file does not exist', async () => {
    const dir = await tmpDir();
    const r = await readRegistry(path.join(dir, 'absent.json'));
    assert.deepEqual(r, { sessions: [] });
  });

  it('writeRegistry creates parent directories and writes valid JSON', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'nested', 'deep', 'sessions.json');
    await writeRegistry(p, { sessions: [{ session_id: 'a' }] });
    const back = JSON.parse(await fs.readFile(p, 'utf8'));
    assert.equal(back.sessions[0].session_id, 'a');
  });

  it('recordSession round-trip: append + repeat updates last_seen_at, preserves first_seen_at', async () => {
    const dir = await tmpDir();
    const env = { CURSOR_AGENT_MCP_STATE_DIR: dir };
    await recordSession({ session_id: 'x', model: 'auto', timestamp_ms: 1000 }, { env });
    await recordSession({ session_id: 'x', timestamp_ms: 2000 }, { env });
    const r = await readRegistry(path.join(dir, 'sessions.json'));
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].first_seen_at, '1970-01-01T00:00:01.000Z');
    assert.equal(r.sessions[0].last_seen_at, '1970-01-01T00:00:02.000Z');
    assert.equal(r.sessions[0].model, 'auto');
  });

  it('recordSession appends distinct sessions in arrival order', async () => {
    const dir = await tmpDir();
    const env = { CURSOR_AGENT_MCP_STATE_DIR: dir };
    await recordSession({ session_id: 'a', timestamp_ms: 1000 }, { env });
    await recordSession({ session_id: 'b', timestamp_ms: 2000 }, { env });
    await recordSession({ session_id: 'c', timestamp_ms: 3000 }, { env });
    const r = await loadRegistry({ env });
    assert.deepEqual(r.sessions.map((s) => s.session_id), ['a', 'b', 'c']);
  });

  it('CURSOR_AGENT_MCP_DISABLE_REGISTRY=1 suppresses writes entirely', async () => {
    const dir = await tmpDir();
    const env = { CURSOR_AGENT_MCP_STATE_DIR: dir, CURSOR_AGENT_MCP_DISABLE_REGISTRY: '1' };
    await recordSession({ session_id: 'x' }, { env });
    let exists = true;
    try {
      await fs.stat(path.join(dir, 'sessions.json'));
    } catch (e) {
      if (e?.code === 'ENOENT') exists = false;
      else throw e;
    }
    assert.equal(exists, false, 'no file should be created when registry is disabled');
  });

  it('corrupted JSON is renamed aside and read returns an empty registry', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'sessions.json');
    await fs.writeFile(p, 'this is not json {{{');
    const r = await readRegistry(p);
    assert.deepEqual(r, { sessions: [] });
    const files = await fs.readdir(dir);
    assert.ok(
      files.some((f) => f.startsWith('sessions.json.corrupted.')),
      'corrupted file should be backed up alongside',
    );
  });

  it('readRegistry rejects arrays at the top level (defends against legacy/odd shapes)', async () => {
    const dir = await tmpDir();
    const p = path.join(dir, 'sessions.json');
    await fs.writeFile(p, JSON.stringify(['not', 'an', 'object']));
    const r = await readRegistry(p);
    assert.deepEqual(r, { sessions: [] });
  });

  it('isRegistryDisabled accepts truthy strings and rejects everything else', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON']) {
      assert.ok(isRegistryDisabled({ CURSOR_AGENT_MCP_DISABLE_REGISTRY: v }), `expected truthy for ${v}`);
    }
    for (const v of ['', '0', 'false', undefined, 'banana', 'off']) {
      assert.ok(!isRegistryDisabled({ CURSOR_AGENT_MCP_DISABLE_REGISTRY: v }), `expected falsy for ${String(v)}`);
    }
  });

  it('recordSession is best-effort: bad entry (missing session_id) silently no-ops', async () => {
    const dir = await tmpDir();
    const env = { CURSOR_AGENT_MCP_STATE_DIR: dir };
    await recordSession({ model: 'auto' }, { env }); // no session_id
    let exists = true;
    try { await fs.stat(path.join(dir, 'sessions.json')); }
    catch (e) { if (e?.code === 'ENOENT') exists = false; else throw e; }
    assert.equal(exists, false);
  });

  it('maybeRecordSession derives prompt_preview from the LAST userArgv element (regression: must be USER argv, not finalArgv)', async () => {
    const dir = await tmpDir();
    const env = { CURSOR_AGENT_MCP_STATE_DIR: dir };
    // userArgv is what runCursorAgent assembles via buildPromptArgv — the
    // prompt is the last element. The buggy code used finalArgv which
    // includes trailing `--model auto`, so "auto" leaked in as prompt_preview.
    await maybeRecordSession(
      {
        structuredContent: { session_id: 'sess-x', model: 'auto' },
        userArgv: ['--mode', 'ask', 'Remember PURPLE-OTTER'],
      },
      { env },
    );
    const r = await loadRegistry({ env });
    assert.equal(r.sessions[0].prompt_preview, 'Remember PURPLE-OTTER');
    assert.notEqual(r.sessions[0].prompt_preview, 'auto', 'prompt_preview must NOT be the model name');
  });

  it('maybeRecordSession truncates prompt_preview to 80 chars', async () => {
    const dir = await tmpDir();
    const env = { CURSOR_AGENT_MCP_STATE_DIR: dir };
    const long = 'x'.repeat(200);
    await maybeRecordSession(
      { structuredContent: { session_id: 's1' }, userArgv: [long] },
      { env },
    );
    const r = await loadRegistry({ env });
    assert.equal(r.sessions[0].prompt_preview.length, 80);
  });

  it('maybeRecordSession no-ops when structuredContent has no session_id', async () => {
    const dir = await tmpDir();
    const env = { CURSOR_AGENT_MCP_STATE_DIR: dir };
    await maybeRecordSession(
      { structuredContent: { duration_ms: 100 }, userArgv: ['hi'] },
      { env },
    );
    let exists = true;
    try { await fs.stat(path.join(dir, 'sessions.json')); }
    catch (e) { if (e?.code === 'ENOENT') exists = false; else throw e; }
    assert.equal(exists, false);
  });
});
