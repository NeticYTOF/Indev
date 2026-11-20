import { expect, it } from 'vitest';
import {
  assertSuccessfulToolCall,
  createStdioRpc,
  McpCheckError,
  runMcpHandshake,
} from '../../../scripts/mcp-stdio-check.mjs';

it('initializes before sending the initialized notification', async () => {
  const calls: string[] = [];
  const fake = {
    rpc: async (method: string) => {
      calls.push(`rpc:${method}`);
      if (method === 'initialize') return { result: { protocolVersion: '2025-06-18' } };
      if (method === 'tools/list') return { result: { tools: [
        { name: 'plan_trip' }, { name: 'list_saved_trips' }, { name: 'get_station' },
      ] } };
      return { result: { content: [{ type: 'text', text: 'No saved trips yet.' }] } };
    },
    notify: (method: string) => { calls.push(`notify:${method}`); },
  };
  const result = await runMcpHandshake({ ...fake, log: () => {} });
  expect(result.names).toEqual(['get_station', 'list_saved_trips', 'plan_trip']);
  expect(calls).toEqual([
    'rpc:initialize',
    'notify:notifications/initialized',
    'rpc:tools/list',
    'rpc:tools/call',
  ]);
});

it('bounds a missing RPC reply and clears its pending entry', async () => {
  const client = createStdioRpc({ write: () => {}, timeoutMs: 10 });
  await expect(client.rpc('initialize', {})).rejects.toThrow(McpCheckError);
  expect(client.pendingCount).toBe(0);
});

it('rejects tool isError and malformed tool results', () => {
  expect(() => assertSuccessfulToolCall({ result: {
    isError: true,
    content: [{ type: 'text', text: 'failed' }],
  } }, 'list_saved_trips')).toThrow(/isError/);
  expect(() => assertSuccessfulToolCall({ result: {} }, 'list_saved_trips')).toThrow(/malformed text content/);
  expect(() => assertSuccessfulToolCall({ result: { content: [{ type: 'text', text: 'ok' }] } }, 'list_saved_trips')).not.toThrow();
});
