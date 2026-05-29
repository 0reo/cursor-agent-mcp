// Integration tests for the async job lifecycle in jobs.js.
// Uses local /bin/sh — never cursor-agent — so no billing. Refs #2.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createJob, getJob, cancelJob, listJobs, JOB_TTL_MS } from '../jobs.js';

function waitUntil(fn, { timeoutMs = 2000, stepMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fn()) return resolve();
      } catch (e) { return reject(e); }
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe('jobs.js lifecycle (Refs #2)', () => {
  it('createJob returns a job_id immediately (does not await spawn)', () => {
    const job_id = createJob({
      executable: '/bin/sh',
      argv: ['-c', 'echo hello; sleep 0.5'],
      print: false,
      output_format: 'text',
    });
    assert.equal(typeof job_id, 'string');
    assert.ok(job_id.length > 0);
    const job = getJob(job_id);
    assert.equal(job.status, 'running');
    cancelJob(job_id); // cleanup; we don't care about the result
  });

  it('a short successful command transitions to completed with full stdout', async () => {
    const job_id = createJob({
      executable: '/bin/sh',
      argv: ['-c', 'printf "hi\\nbye"'],
      print: false,
      output_format: 'text',
    });
    await waitUntil(() => getJob(job_id)?.status === 'completed');
    const job = getJob(job_id);
    assert.equal(job.status, 'completed');
    assert.equal(job.stdout, 'hi\nbye');
    assert.equal(job.exit_code, 0);
    assert.equal(typeof job.ended_at_ms, 'number');
  });

  it('a failing command (nonzero exit) transitions to failed with stderr captured', async () => {
    const job_id = createJob({
      executable: '/bin/sh',
      argv: ['-c', 'echo problem >&2; exit 7'],
      print: false,
      output_format: 'text',
    });
    await waitUntil(() => getJob(job_id)?.status === 'failed');
    const job = getJob(job_id);
    assert.equal(job.status, 'failed');
    assert.equal(job.exit_code, 7);
    assert.match(job.stderr, /problem/);
  });

  it('cancelJob on a running job transitions it to cancelled and SIGTERMs the child', async () => {
    const job_id = createJob({
      executable: '/bin/sh',
      argv: ['-c', 'sleep 5'],
      print: false,
      output_format: 'text',
    });
    // give the spawn a moment to actually start
    await new Promise((r) => setTimeout(r, 30));
    const before = getJob(job_id);
    assert.equal(before.status, 'running');
    const cancelled = cancelJob(job_id);
    assert.equal(cancelled.status, 'cancelled');
    // wait for the close event to fire (it might race ahead)
    await waitUntil(() => getJob(job_id)?.ended_at_ms != null);
    assert.equal(getJob(job_id).status, 'cancelled', 'close event must not overwrite cancelled status');
  });

  it('cancelJob on unknown id returns null', () => {
    assert.equal(cancelJob('nonexistent-id'), null);
  });

  it('cancelJob on already-completed job is idempotent (returns the completed job)', async () => {
    const job_id = createJob({
      executable: '/bin/sh',
      argv: ['-c', 'true'],
      print: false,
      output_format: 'text',
    });
    await waitUntil(() => getJob(job_id)?.status === 'completed');
    const r = cancelJob(job_id);
    assert.equal(r.status, 'completed');
  });

  it('timeout_ms triggers SIGKILL and a timed_out status', async () => {
    const job_id = createJob({
      executable: '/bin/sh',
      argv: ['-c', 'sleep 5'],
      print: false,
      output_format: 'text',
      timeout_ms: 80,
    });
    await waitUntil(() => getJob(job_id)?.status === 'timed_out', { timeoutMs: 1500 });
    assert.equal(getJob(job_id).status, 'timed_out');
  });

  it('listJobs returns active jobs without the raw child handle', async () => {
    const job_id = createJob({
      executable: '/bin/sh',
      argv: ['-c', 'true'],
      print: false,
      output_format: 'text',
    });
    const all = listJobs();
    assert.ok(all.some((j) => j.job_id === job_id));
    const entry = all.find((j) => j.job_id === job_id);
    assert.equal(entry.child, undefined, 'child handle must not be exposed by listJobs');
    assert.equal(entry.timer, undefined);
    await waitUntil(() => getJob(job_id)?.status === 'completed');
  });

  it('JOB_TTL_MS is a sensible positive number (regression guard)', () => {
    assert.ok(JOB_TTL_MS > 60_000, 'TTL must be > 1 minute');
  });
});
