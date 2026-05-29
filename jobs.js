// Background job table for async cursor-agent calls. Refs #2.
//
// Defeats the 60s MCP client timeout: cursor_agent_start spawns the child
// and returns a job_id immediately; cursor_agent_poll reads the in-memory
// job entry without ever awaiting the spawn. A SIGKILL timer enforces the
// same hard-timeout discipline as the synchronous invokeCursorAgent path.
//
// Storage is purely in-process — restart wipes the table. Each terminal
// state is retained for JOB_TTL_MS so a slow poller still gets the result.

import crypto from 'node:crypto';
import { spawn as defaultSpawn } from 'node:child_process';
import process from 'node:process';

import {
  buildFinalArgv,
  resolveTimeoutMs,
  buildStructuredResult,
} from './argv-builder.js';
import { maybeRecordSession } from './session-registry.js';

export const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes after terminal state

const JOBS = new Map();

function resolveExecutableLocal(explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (process.env.CURSOR_AGENT_PATH && process.env.CURSOR_AGENT_PATH.trim()) {
    return process.env.CURSOR_AGENT_PATH.trim();
  }
  return 'cursor-agent';
}

function scheduleCleanup(job_id) {
  const t = setTimeout(() => JOBS.delete(job_id), JOB_TTL_MS);
  // unref so a pending cleanup timer doesn't keep the process alive
  if (typeof t?.unref === 'function') t.unref();
}

// Snapshot a job for external consumers — strips the live child handle and
// timer so callers can't accidentally hold onto OS resources.
function snapshot(job) {
  if (!job) return null;
  const { child, timer, ...rest } = job;
  return rest;
}

// Spawn cursor-agent (or any executable) asynchronously and register the job.
// Returns the job_id immediately. Polling is the only way to learn the result.
export function createJob(opts = {}, { spawnFn = defaultSpawn, resolveExecutable = resolveExecutableLocal } = {}) {
  const {
    argv,
    output_format = 'text',
    cwd,
    executable,
    model,
    force,
    print = true,
    timeout_ms,
    workspace,
    worktree,
    worktree_base,
    skip_worktree_setup,
    sandbox,
    trust,
  } = opts;

  const job_id = crypto.randomUUID();
  const cmd = resolveExecutable(executable);
  const finalArgv = buildFinalArgv({
    argv, output_format, model, force, print,
    workspace, worktree, worktree_base, skip_worktree_setup, sandbox, trust,
  });
  const timeoutMs = resolveTimeoutMs({ timeout_ms });

  const job = {
    job_id,
    status: 'running',
    stdout: '',
    stderr: '',
    output_format,
    final_argv: finalArgv,
    cmd,
    cwd: cwd || process.cwd(),
    started_at_ms: Date.now(),
    ended_at_ms: null,
    exit_code: null,
    error: null,
    timeout_ms: timeoutMs,
    child: null,
    timer: null,
  };
  JOBS.set(job_id, job);

  let child;
  try {
    child = spawnFn(cmd, finalArgv, {
      shell: false,
      cwd: job.cwd,
      env: process.env,
    });
  } catch (e) {
    job.status = 'failed';
    job.error = `Failed to spawn "${cmd}": ${e?.message || e}`;
    job.ended_at_ms = Date.now();
    scheduleCleanup(job_id);
    return job_id;
  }
  job.child = child;
  try { child.stdin?.end(); } catch {}

  child.stdout?.on('data', (d) => { job.stdout += d.toString(); });
  child.stderr?.on('data', (d) => { job.stderr += d.toString(); });

  child.on('error', (e) => {
    if (job.status !== 'running') return;
    job.status = 'failed';
    job.error = `${e?.code ? e.code + ': ' : ''}${e?.message || String(e)}`;
    job.ended_at_ms = Date.now();
    clearTimeout(job.timer);
    scheduleCleanup(job_id);
  });

  child.on('close', (code) => {
    if (job.status !== 'running') {
      // already cancelled / timed_out — do not overwrite, just clean up timers
      clearTimeout(job.timer);
      return;
    }
    job.exit_code = code;
    job.ended_at_ms = Date.now();
    if (code === 0) {
      job.status = 'completed';
      // Mirror invokeCursorAgent's post-success session-registry hook so async
      // calls participate in cursor_agent_list_sessions discovery too.
      const built = buildStructuredResult({
        stdout: job.stdout,
        output_format,
        started_at_ms: job.started_at_ms,
        ended_at_ms: job.ended_at_ms,
      });
      maybeRecordSession({
        structuredContent: built.structuredContent,
        userArgv: argv,
      }).catch(() => {});
    } else {
      job.status = 'failed';
    }
    clearTimeout(job.timer);
    scheduleCleanup(job_id);
  });

  job.timer = setTimeout(() => {
    if (job.status !== 'running') return;
    job.status = 'timed_out';
    job.ended_at_ms = Date.now();
    // If SIGKILL on the tracked pid throws, we've orphaned cursor-agent —
    // the operator needs to know so they can kill -9 by hand.
    try { child.kill('SIGKILL'); } catch (e) {
      try { console.error('[cursor-mcp] job', job_id, 'timeout SIGKILL failed:', e?.message || e); } catch {}
    }
    scheduleCleanup(job_id);
  }, timeoutMs);

  return job_id;
}

// Return the live job entry (including live child + timer — internal use only).
// External callers should NOT mutate this. Returns null if unknown.
export function getJob(job_id) {
  return JOBS.get(job_id) ?? null;
}

// Cancel a running job. SIGTERM the child, mark cancelled, return the snapshot.
// Idempotent: terminal states return their existing snapshot unchanged.
// Returns null for unknown job_id.
export function cancelJob(job_id) {
  const job = JOBS.get(job_id);
  if (!job) return null;
  if (job.status !== 'running') return snapshot(job);
  job.status = 'cancelled';
  job.ended_at_ms = Date.now();
  clearTimeout(job.timer);
  // SIGTERM failure on cancel deserves a stderr log: same orphan risk as the
  // timeout-SIGKILL path. We don't escalate to SIGKILL here — the job is
  // already marked cancelled; the close handler guards against status overwrite.
  try { job.child?.kill('SIGTERM'); } catch (e) {
    try { console.error('[cursor-mcp] job', job_id, 'cancel SIGTERM failed:', e?.message || e); } catch {}
  }
  scheduleCleanup(job_id);
  return snapshot(job);
}

// List active and recently-terminal jobs (those still inside the TTL window).
// Returns snapshots without the live child/timer handles.
export function listJobs() {
  return Array.from(JOBS.values()).map(snapshot);
}

// Test utility — clear the in-memory table. NOT exported via server.js.
export function _resetForTests() {
  for (const job of JOBS.values()) {
    clearTimeout(job.timer);
    try { job.child?.kill('SIGKILL'); } catch {}
  }
  JOBS.clear();
}
