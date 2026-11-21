import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SELECTIVE_TOOL_BUDGET, SELECTIVE_TOOL_BUDGETS, SelectiveToolLedger } from '../src/selective-tools.js';
import { chatCompletionWithTools, AiProviderError } from '../src/ai-provider.js';

const deps = {
  baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model',
  fetchImpl: (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
    const last = body.messages[body.messages.length - 1] as { role: string };
    if (last.role === 'tool') {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: {
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'get_station_details', arguments: '{"ids":[1]}' } }],
      } }],
    }), { status: 200 });
  }) as typeof fetch,
};

describe('strict model tool-call boundary', () => {
  it('rejects non-function calls, numeric names and array arguments', async () => {
    const bad = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: 1, type: 'not-function',
        function: { name: 9, arguments: [] } }] } }],
    }), { status: 200 })) as typeof fetch;
    await expect(chatCompletionWithTools({ ...deps, fetchImpl: bad },
      [], [], ['get_station_details'])).rejects.toBeInstanceOf(AiProviderError);
  });

  it('rejects duplicate call ids and unsupported names', async () => {
    const dup = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [
        { id: 'x', type: 'function', function: { name: 'get_station_details', arguments: '{}' } },
        { id: 'x', type: 'function', function: { name: 'get_station_details', arguments: '{}' } },
      ] } }],
    }), { status: 200 })) as typeof fetch;
    await expect(chatCompletionWithTools({ ...deps, fetchImpl: dup },
      [], [], ['get_station_details'])).rejects.toBeInstanceOf(AiProviderError);
  });

  it('rejects empty choices and empty messages', async () => {
    const empty = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
    await expect(chatCompletionWithTools({ ...deps, fetchImpl: empty },
      [], [], ['get_station_details'])).rejects.toBeInstanceOf(AiProviderError);
  });

  it('does not accept a post-cancel response from a fetch that ignores abort', async () => {
    const controller = new AbortController();
    const slow = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'late' } }] }), { status: 200 });
    }) as typeof fetch;
    const pending = chatCompletionWithTools({ ...deps, fetchImpl: slow },
      [], [], ['get_station_details'], controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AiProviderError);
    vi.restoreAllMocks();
  });
});

describe('selective coverage profiles', () => {
  it('keeps the standard profile at 20 unique details and four rounds', () => {
    expect(DEFAULT_SELECTIVE_TOOL_BUDGET).toEqual({
      maxRounds: 4, maxToolCalls: 12, maxIdsPerCall: 5, maxTotalIds: 20,
    });
    expect(SELECTIVE_TOOL_BUDGETS.standard20).toEqual(DEFAULT_SELECTIVE_TOOL_BUDGET);
  });

  it('admits 40 unique IDs in five-ID batches under the progressive profile', () => {
    const budget = SELECTIVE_TOOL_BUDGETS.progressive40;
    expect(budget).toEqual({
      maxRounds: 8, maxToolCalls: 12, maxIdsPerCall: 5, maxTotalIds: 40,
    });
    const allowed = new Set(Array.from({ length: 41 }, (_, i) => i + 1));
    const ledger = new SelectiveToolLedger(allowed, budget);
    for (let group = 0; group < 8; group += 1) {
      expect(ledger.nextRound()).toBe(true);
      const ids = Array.from({ length: 5 }, (_, i) => group * 5 + i + 1);
      expect(ledger.admit({ ids })?.newIds).toEqual(ids);
    }
    expect(ledger.admitted.size).toBe(40);
    expect(ledger.plannedNewIds).toBe(40);
    expect(ledger.calls).toBe(8);
    expect(ledger.admit({ ids: [41] })).toBeNull();
  });
});
