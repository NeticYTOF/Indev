import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiProviderError, chatCompletion, chatCompletionWithTools,
} from '../src/ai-provider.js';

const deps = {
  baseUrl: 'https://ai.test/v1', apiKey: 'test-key', model: 'test-model', timeoutMs: 1000,
};

afterEach(() => { vi.useRealTimers(); });


describe('AI provider deadline and caller cancel are distinct', () => {
  it('reports a headers timeout when headers never arrive', async () => {
    vi.useFakeTimers();
    const never = (() => new Promise<Response>(() => {})) as typeof fetch;
    const err = chatCompletionWithTools(
      { ...deps, fetchImpl: never }, [], [], [], undefined,
    );
    const assertion = expect(err).rejects.toMatchObject({ reason: 'headers_timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    const caught = await err.catch((e: unknown) => e) as AiProviderError;
    expect(caught.message).toContain('before response headers');
  });

  it('reports a body timeout when a body read ignores abort', async () => {
    vi.useFakeTimers();
    const slowBody = (async () => ({
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => {}),
    })) as unknown as typeof fetch;
    const err = chatCompletion({ ...deps, fetchImpl: slowBody }, [
      { role: 'user', content: 'x' },
    ]);
    const assertion = expect(err).rejects.toMatchObject({ reason: 'body_timeout' });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    const caught = await err.catch((e: unknown) => e) as AiProviderError;
    expect(caught.message).toContain('reading the response body');
  });

  it('reports caller cancel distinctly from a timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const never = (() => new Promise<Response>(() => {})) as typeof fetch;
    const err = chatCompletionWithTools({ ...deps, fetchImpl: never }, [], [], [], controller.signal);
    const assertion = expect(err).rejects.toMatchObject({ reason: 'cancelled' });
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('keeps malformed provider bodies as sanitized provider errors', async () => {
    const malformed = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await expect(chatCompletionWithTools({ ...deps, fetchImpl: malformed }, [], [], []))
      .rejects.toMatchObject({ reason: 'provider' });
  });

  it('keeps the first cause when a native-like fetch rejects on abort', async () => {
    vi.useFakeTimers();
    const nativeLike = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
    })) as typeof fetch;
    const controller = new AbortController();
    const chat = chatCompletion({ ...deps, fetchImpl: nativeLike },
      [{ role: 'user', content: 'x' }], controller.signal);
    const tools = chatCompletionWithTools({ ...deps, fetchImpl: nativeLike },
      [], [], [], controller.signal);
    const chatAssert = expect(chat).rejects.toMatchObject({ reason: 'cancelled' });
    const toolAssert = expect(tools).rejects.toMatchObject({ reason: 'cancelled' });
    controller.abort();
    await chatAssert;
    await toolAssert;
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('does not dispatch when the caller is already aborted', async () => {
    let dispatches = 0;
    const counting = (async () => {
      dispatches += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(chatCompletion({ ...deps, fetchImpl: counting },
      [{ role: 'user', content: 'x' }], controller.signal))
      .rejects.toMatchObject({ reason: 'cancelled' });
    await expect(chatCompletionWithTools({ ...deps, fetchImpl: counting },
      [], [], [], controller.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    expect(dispatches).toBe(0);
  });
});
