// Dev check: stdio MCP handshake against the real server (mock mode).
// Sends initialize -> tools/list -> a saved-trips tool call per spec.
// Mock child credentials are stripped and .env is skipped by construction.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREDENTIAL_KEYS = ['STATIQ_API_TOKEN', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'];

/** Credential-free child environment for the synthetic stdio check. */
export function mockStdioCheckEnv(parentEnv = process.env, root = ROOT) {
  const env = { ...parentEnv };
  for (const key of CREDENTIAL_KEYS) delete env[key];
  env.INDEV_MOCK = '1';
  env.INDEV_SKIP_DOTENV = '1';
  env.DATA_DIR = join(root, '.tmp-mcp-check');
  return env;
}

async function main() {
  const child = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', join('apps/mcp/src/index.ts')],
    {
      cwd: ROOT,
      env: mockStdioCheckEnv(process.env, ROOT),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += String(d);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          cb(msg);
          pending.delete(msg.id);
        }
      } catch {
        console.error('non-JSON on stdout:', line.slice(0, 120));
      }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));

  let nextId = 1;
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolveRpc, rejectRpc) => {
      pending.set(id, (v) => {
        const r = v;
        if (r?.error && !r.result) rejectRpc(new Error(r.error.message));
        else resolveRpc(r);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  // notifications use null ids (no response expected)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dev-check', version: '0.0.0' },
    });
    console.log('initialize ok:', Boolean(init.result));

    const tools = await rpc('tools/list', {});
    const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
    console.log('tools:', JSON.stringify(names));
    if (JSON.stringify(names) !== JSON.stringify(['get_station', 'list_saved_trips', 'plan_trip'])) {
      console.error('TOOL SET MISMATCH');
      process.exit(1);
    }

    const list = await rpc('tools/call', { name: 'list_saved_trips', arguments: {} });
    console.log('list_saved_trips ok:', Boolean(list.result));
    child.kill();
    console.log('MCP_STDIO_CHECK_OK');
    process.exit(0);
  } catch (err) {
    console.error('MCP check failed:', err instanceof Error ? err.message : err);
    child.kill();
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) void main();
