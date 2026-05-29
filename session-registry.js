// Persistent JSON registry of cursor-agent session_ids observed by this server.
// Best-effort I/O: read failures fall through to an empty registry, write
// failures are swallowed. Authoritative session list still lives inside
// cursor-agent itself; this file is a discovery convenience because
// `cursor-agent ls` is TTY-only and cannot be queried headlessly. Refs #1.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSessionRegistryPath, upsertSessionEntry } from './argv-builder.js';

const EMPTY = () => ({ sessions: [] });

export function isRegistryDisabled(env = process.env) {
  const v = String(env?.CURSOR_AGENT_MCP_DISABLE_REGISTRY || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Read the registry from disk. ENOENT and corruption both yield an empty
// registry (corrupted files are renamed aside so the next write succeeds).
export async function readRegistry(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return EMPTY();
  } catch (e) {
    if (e?.code === 'ENOENT') return EMPTY();
    if (e instanceof SyntaxError) {
      const backup = `${filePath}.corrupted.${Date.now()}`;
      try {
        await fs.rename(filePath, backup);
      } catch (renameErr) {
        // If the rename failed (read-only mount, EACCES, etc.) the next write
        // will hit the same SyntaxError forever. Surface the diagnosis under
        // DEBUG_CURSOR_MCP so an operator looking at logs sees what's wrong.
        if (process.env.DEBUG_CURSOR_MCP === '1') {
          try { console.error('[cursor-mcp] registry corruption at', filePath, 'rename to backup failed:', renameErr?.message || renameErr); } catch {}
        }
      }
      return EMPTY();
    }
    throw e;
  }
}

// Atomic-ish write: write to a sibling temp file then rename into place.
// Creates parent directories as needed. The temp suffix includes a
// crypto-random tag so concurrent writers in the same process never collide
// on the same temp path (a regression mode that could leave a partially-
// written file in place after an interleaved truncate+rename race).
export async function writeRegistry(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

// Per-filePath write-serialization queue. Two concurrent recordSession
// callers would otherwise hit a read-upsert-write race where writer A
// observes [X], writer B observes [X], both upsert their entry against the
// same base, and whichever rename wins overwrites the other's entry. The
// queue chains read+upsert+write so each entry sees the previous writer's
// committed view. One entry per filePath; size stays O(1) at steady state.
const writeQueues = new Map();

// Best-effort: read, upsert, write. Never throws. Skipped entirely when
// CURSOR_AGENT_MCP_DISABLE_REGISTRY is truthy. Concurrent callers are
// serialized per-filePath via writeQueues so two writers cannot overwrite
// each other's entries.
export async function recordSession(entry, { env = process.env, home } = {}) {
  if (isRegistryDisabled(env)) return;
  if (!entry || !entry.session_id) return;
  const filePath = resolveSessionRegistryPath({ env, home });

  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const reg = await readRegistry(filePath);
      const updated = upsertSessionEntry(reg, entry);
      await writeRegistry(filePath, updated);
    } catch (e) {
      // best-effort — registry is a discovery convenience, not load-bearing.
      // We don't re-throw filesystem errors (EACCES, ENOSPC, EROFS, EDQUOT)
      // because the user's tool call should still succeed. But surface ALL
      // errors under DEBUG so programmer bugs (TypeError from a bad entry,
      // ReferenceError from a refactor) and silent-disk-full conditions
      // aren't permanently invisible.
      if (process.env.DEBUG_CURSOR_MCP === '1') {
        try { console.error('[cursor-mcp] recordSession swallowed error:', e?.message || e); } catch {}
      }
    }
  });
  writeQueues.set(filePath, next);
  await next;
}

// Return the full registry blob from disk (or an empty one if absent).
export async function loadRegistry({ env = process.env, home } = {}) {
  const filePath = resolveSessionRegistryPath({ env, home });
  return readRegistry(filePath);
}

// Convenience hook used by both invokeCursorAgent and the async jobs.js
// completion handler: if a structured result carried a session_id, persist
// it to the registry with a prompt_preview derived from the trailing
// non-flag entry of `userArgv`. Best-effort — never throws.
//
// IMPORTANT — pass the USER argv (the one runCursorAgent builds via
// buildPromptArgv: [...sessionFlags, ...extra_args, prompt]), NOT the
// finalArgv that buildFinalArgv produces. finalArgv has trailing `--model
// <m>` / `-f` flags appended that would otherwise be mistaken for the prompt.
export async function maybeRecordSession(
  { structuredContent, userArgv } = {},
  { env, home } = {},
) {
  const sid = structuredContent?.session_id;
  if (!sid) return;
  const lastArg =
    Array.isArray(userArgv) && userArgv.length
      ? String(userArgv[userArgv.length - 1])
      : '';
  const prompt_preview =
    lastArg && !lastArg.startsWith('-') ? lastArg.slice(0, 80) : undefined;
  await recordSession(
    {
      session_id: sid,
      model: structuredContent?.model,
      prompt_preview,
    },
    { env, home },
  );
}
