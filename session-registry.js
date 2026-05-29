// Persistent JSON registry of cursor-agent session_ids observed by this server.
// Best-effort I/O: read failures fall through to an empty registry, write
// failures are swallowed. Authoritative session list still lives inside
// cursor-agent itself; this file is a discovery convenience because
// `cursor-agent ls` is TTY-only and cannot be queried headlessly. Refs #1.

import fs from 'node:fs/promises';
import path from 'node:path';
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
      try { await fs.rename(filePath, backup); } catch {}
      return EMPTY();
    }
    throw e;
  }
}

// Atomic-ish write: write to a sibling temp file then rename into place.
// Creates parent directories as needed.
export async function writeRegistry(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

// Best-effort: read, upsert, write. Never throws. Skipped entirely when
// CURSOR_AGENT_MCP_DISABLE_REGISTRY is truthy.
export async function recordSession(entry, { env = process.env, home } = {}) {
  if (isRegistryDisabled(env)) return;
  if (!entry || !entry.session_id) return;
  const filePath = resolveSessionRegistryPath({ env, home });
  try {
    const reg = await readRegistry(filePath);
    const next = upsertSessionEntry(reg, entry);
    await writeRegistry(filePath, next);
  } catch {
    // best-effort — registry is a discovery convenience, not load-bearing
  }
}

// Return the full registry blob from disk (or an empty one if absent).
export async function loadRegistry({ env = process.env, home } = {}) {
  const filePath = resolveSessionRegistryPath({ env, home });
  return readRegistry(filePath);
}
