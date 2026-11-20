// Dev check: stdio MCP handshake against the real server (mock mode).
// Sends initialize -> notifications/initialized -> tools/list -> saved-trips call.
// Mock child credentials are stripped and .env is skipped by construction.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CREDENTIAL_KEYS = ['STATIQ_API_TOKEN', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'];
export const MCP_CHECK_RPC_TIMEOUT_MS = 10_000;

export class McpCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpCheckError';
  }
}

/** Credential-free child environment for the synthetic stdio check. */
export function mockStdioCheckEnv(parentEnv = process.env, root = ROOT) {
  const env = { ...parentEnv };
  for (const key of CREDENTIAL_KEYS) delete env[key];
  env.INDEV_MOCK = '1';
  env.INDEV_SKIP_DOTENV = '1';
  env.DATA_DIR = join(root, '.tmp-mcp-check');
  return env;
}

/** The only writer is the caller; requests and responses never mutate env. */
export function createStdioRpc({ write, timeoutMs = MCP_CHECK_RPC_TIMEOUT_MS }) {
  const pending = new Map();
  let nextId = 1;

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRpc(new McpCheckError(`RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveRpc, reject: rejectRpc, timer });
      try {
        write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        rejectRpc(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function notify(method, params = {}) {
    write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  function receive(message) {
    if (!message || typeof message !== 'object' || message.id == null) return false;
    const entry = pending.get(message.id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new McpCheckError(`RPC error: ${String(message.error.message ?? 'unknown')}`));
    } else {
      entry.resolve(message);
    }
    return true;
  }

  function failAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  return { rpc, notify, receive, failAll, get pendingCount() { return pending.size; } };
}

export function assertRpcResult(message, label) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new McpCheckError(`${label} returned a malformed JSON-RPC envelope`);
  }
  if (message.error) {
    throw new McpCheckError(`${label} returned an RPC error`);
  }
  if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
    throw new McpCheckError(`${label} returned a malformed result`);
  }
  return message.result;
}

export function assertSuccessfulToolCall(message, toolName) {
  const result = assertRpcResult(message, toolName);
  if (result.isError === true) throw new McpCheckError(`${toolName} returned isError`);
  if (!Array.isArray(result.content) || result.content.length === 0 ||
      !result.content.some((item) => item && item.type === 'text' && typeof item.text === 'string')) {
    throw new McpCheckError(`${toolName} returned malformed text content`);
  }
  return result;
}

/** Protocol sequence is exported for fake-transcript regression tests. */
export async function runMcpHandshake({ rpc, notify, log = () => {} }) {
  const init = assertRpcResult(await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dev-check', version: '0.0.0' },
  }), 'initialize');
  log('initialize ok:', Boolean(init));
  // The SDK requires the initialized notification AFTER the initialize reply.
  notify('notifications/initialized');

  const toolsResult = assertRpcResult(await rpc('tools/list', {}), 'tools/list');
  if (!Array.isArray(toolsResult.tools)) throw new McpCheckError('tools/list returned no tools array');
  const names = toolsResult.tools.map((t) => t && t.name).sort();
  log('tools:', JSON.stringify(names));
  if (JSON.stringify(names) !== JSON.stringify(['get_station', 'list_saved_trips', 'plan_trip'])) {
    throw new McpCheckError('TOOL SET MISMATCH');
  }

  const list = assertSuccessfulToolCall(
    await rpc('tools/call', { name: 'list_saved_trips', arguments: {} }),
    'list_saved_trips',
  );
  log('list_saved_trips ok:', Boolean(list));
  return { names };
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

  const client = createStdioRpc({ write: (line) => child.stdin.write(line) });

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += String(d);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        client.receive(JSON.parse(line));
      } catch {
        console.error('non-JSON on stdout:', line.slice(0, 120));
      }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));
  child.once('exit', (code, signal) => {
    client.failAll(new McpCheckError(`MCP child exited before RPC completion (code ${code}, signal ${signal ?? 'none'})`));
  });

  let failed = false;
  try {
    await runMcpHandshake({ rpc: client.rpc, notify: client.notify, log: console.log });
    console.log('MCP_STDIO_CHECK_OK');
  } catch (err) {
    failed = true;
    console.error('MCP check failed:', err instanceof Error ? err.message : err);
  } finally {
    client.failAll(new McpCheckError('MCP check finished'));
    child.kill();
  }
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) void main();
