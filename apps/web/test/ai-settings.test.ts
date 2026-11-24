import { describe, expect, it } from 'vitest';
import {
  aiAuthHeaders, clampInstructions, FALLBACK_PROVIDERS, MAX_INSTRUCTIONS, providerOptions, validKey, validModel,
} from '../src/ai-settings.js';
import { createSecretStore, type SecretBackend } from '../src/secure-store.js';

function memoryBackend(): SecretBackend & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: async (id) => raw.get(id),
    put: async (id, value) => { raw.set(id, value); },
    delete: async (id) => { raw.delete(id); },
  };
}

describe('ai settings helpers', () => {
  it('builds headers only when a device key exists', () => {
    expect(aiAuthHeaders(undefined)).toEqual({});
    expect(aiAuthHeaders({ key: 'sk-123456789', provider: 'groq' })).toEqual({
      'x-indeev-ai-key': 'sk-123456789', 'x-indeev-ai-provider': 'groq',
    });
    expect(aiAuthHeaders({ key: 'sk-123456789', provider: 'groq', model: 'm-1' })['x-indeev-ai-model']).toBe('m-1');
  });

  it('validates keys and models like the server does', () => {
    expect(validKey('sk-12345678')).toBe(true);
    expect(validKey('short')).toBe(false);
    expect(validKey('has space 12345')).toBe(false);
    expect(validModel('')).toBe(true);
    expect(validModel('openai/gpt-4o-mini')).toBe(true);
    expect(validModel('bad model')).toBe(false);
  });

  it('clamps instructions to the server limit', () => {
    expect(clampInstructions('x'.repeat(MAX_INSTRUCTIONS + 50))).toHaveLength(MAX_INSTRUCTIONS);
  });

  it('accepts only well-formed provider lists and falls back otherwise', () => {
    expect(providerOptions(undefined)).toEqual(FALLBACK_PROVIDERS);
    expect(providerOptions([{ id: '<script>', label: 'x', defaultModel: 'm' }])).toEqual(FALLBACK_PROVIDERS);
    const good = [{ id: 'groq', label: 'Groq', defaultModel: 'llama-3.3-70b-versatile' }];
    expect(providerOptions(good)).toEqual(good);
  });
});

describe('encrypted secret store', () => {
  it('round-trips a secret without ever storing plaintext', async () => {
    const backend = memoryBackend();
    const store = createSecretStore(backend);
    await store.save('ai-api-key', 'sk-super-secret-value');
    expect(await store.load('ai-api-key')).toBe('sk-super-secret-value');
    expect(await store.has('ai-api-key')).toBe(true);
    const sealed = backend.raw.get('secret:ai-api-key') as { iv: Uint8Array; ciphertext: ArrayBuffer };
    const bytes = new TextDecoder().decode(new Uint8Array(sealed.ciphertext));
    expect(bytes).not.toContain('sk-super-secret-value');
    expect(sealed.iv.byteLength).toBe(12);
    const wrap = backend.raw.get('__device-wrap-key') as CryptoKey;
    expect(wrap.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', wrap)).rejects.toThrow();
  });

  it('uses a fresh IV for each save', async () => {
    const backend = memoryBackend();
    const store = createSecretStore(backend);
    await store.save('k', 'sk-same-value-1');
    const first = (backend.raw.get('secret:k') as { iv: Uint8Array }).iv.slice();
    await store.save('k', 'sk-same-value-1');
    const second = (backend.raw.get('secret:k') as { iv: Uint8Array }).iv;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  it('drops a secret whose wrap key was lost instead of returning garbage', async () => {
    const backend = memoryBackend();
    await createSecretStore(backend).save('k', 'sk-value-12345');
    backend.raw.delete('__device-wrap-key');
    const fresh = createSecretStore(backend);
    expect(await fresh.load('k')).toBeNull();
    expect(backend.raw.has('secret:k')).toBe(false);
  });

  it('drops a tampered ciphertext', async () => {
    const backend = memoryBackend();
    const store = createSecretStore(backend);
    await store.save('k', 'sk-value-12345');
    const sealed = backend.raw.get('secret:k') as { ciphertext: ArrayBuffer };
    new Uint8Array(sealed.ciphertext)[0]! ^= 0xff;
    expect(await store.load('k')).toBeNull();
  });

  it('remove deletes the secret', async () => {
    const backend = memoryBackend();
    const store = createSecretStore(backend);
    await store.save('k', 'sk-value-12345');
    await store.remove('k');
    expect(await store.load('k')).toBeNull();
    expect(await store.has('k')).toBe(false);
  });
});
