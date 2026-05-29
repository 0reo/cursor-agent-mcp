// Verifies the new first-class params: mode (plan/ask) and resume/continue_session.
// Spawns a FRESH server process (picks up current server.js) and exercises real cursor-agent calls.
// Run: node verify_modes.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function textOf(res) {
  return (res?.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./server.js'],
    cwd: new URL('.', import.meta.url).pathname.replace(/verify_modes\.mjs$/, ''),
    env: {
      ...process.env,
      CURSOR_AGENT_PATH: process.env.CURSOR_AGENT_PATH ?? '/home/oreo/.local/bin/cursor-agent',
      CURSOR_AGENT_MODEL: process.env.CURSOR_AGENT_MODEL ?? 'auto',
      CURSOR_AGENT_IDLE_EXIT_MS: '0',
      CURSOR_AGENT_TIMEOUT_MS: process.env.CURSOR_AGENT_TIMEOUT_MS ?? '120000',
      DEBUG_CURSOR_MCP: '1', // so server.js logs the actual spawn argv to stderr
    },
  });

  const client = new Client({ name: 'verify-modes', version: '0.0.1' });
  await client.connect(transport);

  // 1) PLAN MODE — should run --mode plan and the agent should report it cannot edit.
  console.log('\n=== [1] mode:"plan" (expect read-only confirmation) ===');
  const plan = await client.callTool({
    name: 'cursor_agent_chat',
    arguments: {
      prompt: 'In one short sentence: what mode are you in, and may you edit files?',
      mode: 'plan',
      model: 'auto',
      output_format: 'text',
    },
  }, undefined, { timeout: 240000 });
  console.log('RESULT:', textOf(plan).trim());

  // 2) RESUME ROUND-TRIP — first call (json) yields session_id; second call resumes it.
  console.log('\n=== [2a] seed a session (json, capture session_id) ===');
  const seed = await client.callTool({
    name: 'cursor_agent_chat',
    arguments: {
      prompt: 'Remember this codeword: PURPLE-OTTER-42. Reply only with: stored.',
      mode: 'ask',
      model: 'auto',
      output_format: 'json',
    },
  }, undefined, { timeout: 240000 });
  const seedText = textOf(seed).trim();
  let sessionId = null;
  try { sessionId = JSON.parse(seedText).session_id; } catch {}
  console.log('session_id:', sessionId);

  if (sessionId) {
    console.log('\n=== [2b] resume that session — does it recall the codeword? ===');
    const resumed = await client.callTool({
      name: 'cursor_agent_chat',
      arguments: {
        prompt: 'What was the codeword I asked you to remember? Reply with just the codeword.',
        resume: sessionId,
        model: 'auto',
        output_format: 'text',
      },
    });
    const recalled = textOf(resumed).trim();
    console.log('RESULT:', recalled);
    console.log('RECALL OK:', /PURPLE-OTTER-42/i.test(recalled));
  } else {
    console.log('(could not extract session_id; resume check skipped)');
  }

  await client.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('verify failed:', e); process.exit(1); });
