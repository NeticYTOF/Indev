/**
 * Bring-your-own-key AI configuration.
 *
 * A user's AI key lives on their own device and arrives only as a request
 * header on the AI request that uses it. The server uses it for that single
 * run and never persists, logs, echoes or exposes it. The client can choose
 * a provider from a fixed allowlist but can NEVER supply a base URL, so a
 * public deployment cannot be turned into a proxy to arbitrary hosts.
 */

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiProviderInfo {
  label: string;
  baseUrl: string;
  defaultModel: string;
}

export const AI_PROVIDERS = {
  hackclub: { label: 'Hack Club AI', baseUrl: 'https://ai.hackclub.com/proxy/v1', defaultModel: 'z-ai/glm-5.3-flash' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash' },
} as const satisfies Record<string, AiProviderInfo>;

export type AiProviderId = keyof typeof AI_PROVIDERS;
export const DEFAULT_AI_PROVIDER: AiProviderId = 'hackclub';

export const AI_KEY_HEADER = 'x-indeev-ai-key';
export const AI_PROVIDER_HEADER = 'x-indeev-ai-provider';
export const AI_MODEL_HEADER = 'x-indeev-ai-model';

const KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:/@+-]{1,128}$/;

export type RequestAi =
  | { ok: true; ai: AiConfig | undefined; source: 'device' | 'server' | 'none' }
  | { ok: false; error: string };

function isProviderId(value: string): value is AiProviderId {
  return Object.prototype.hasOwnProperty.call(AI_PROVIDERS, value);
}

/**
 * Resolve the AI config for ONE request. A device key header wins over the
 * server's own env key. Error messages never contain the key.
 */
export function readRequestAi(
  header: (name: string) => string | undefined,
  serverAi: AiConfig | undefined,
): RequestAi {
  const rawKey = header(AI_KEY_HEADER);
  if (rawKey === undefined || rawKey.trim() === '') {
    return { ok: true, ai: serverAi, source: serverAi ? 'server' : 'none' };
  }
  const apiKey = rawKey.trim();
  if (!KEY_PATTERN.test(apiKey)) {
    return { ok: false, error: 'The AI key sent from this device is not a valid key (8-512 printable characters, no spaces).' };
  }
  const rawProvider = header(AI_PROVIDER_HEADER)?.trim() || DEFAULT_AI_PROVIDER;
  if (!isProviderId(rawProvider)) {
    return { ok: false, error: 'Unknown AI provider. Choose one of the providers listed in AI settings.' };
  }
  const provider = AI_PROVIDERS[rawProvider];
  const rawModel = header(AI_MODEL_HEADER)?.trim();
  if (rawModel && !MODEL_PATTERN.test(rawModel)) {
    return { ok: false, error: 'The AI model name is not valid (letters, digits and . _ : / @ + - only, up to 128 characters).' };
  }
  return {
    ok: true,
    source: 'device',
    ai: { baseUrl: provider.baseUrl, apiKey, model: rawModel || provider.defaultModel },
  };
}

/** Public, secret-free provider list for /api/health. */
export function publicProviderList(): Array<{ id: AiProviderId; label: string; defaultModel: string }> {
  return (Object.keys(AI_PROVIDERS) as AiProviderId[]).map((id) => ({
    id, label: AI_PROVIDERS[id].label, defaultModel: AI_PROVIDERS[id].defaultModel,
  }));
}
