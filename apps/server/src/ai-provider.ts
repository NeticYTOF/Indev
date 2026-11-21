/**
 * OpenAI-compatible chat provider (off unless env is fully configured).
 * The API key is used only here and is never logged.
 */
export interface AiProviderDeps {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatToolMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AiChoiceRaw {
  chosenStationIds?: unknown;
  notes?: unknown;
}
export type AiToolCall = (
  messages: ChatToolMessage[],
  tools: ChatToolDefinition[],
  signal?: AbortSignal,
  maxCalls?: number,
) => Promise<{ content: string | null; toolCalls: ChatToolCall[] }>;

const HACKCLUB_BASE = 'https://ai.hackclub.com/proxy/v1';
const HACKCLUB_MODEL = 'z-ai/glm-5.3-flash';

/** Exact-model policy only. Mandatory reasoning stays enabled at low effort;
 *  no stream assembler, no broad config for unknown models. */
function completionOptions(baseUrl: string, model: string, payload: Record<string, unknown>) {
  const exact = baseUrl.replace(/\/+$/, '') === HACKCLUB_BASE && model === HACKCLUB_MODEL;
  return exact
    ? { ...payload, reasoning: { effort: 'low' }, max_tokens: 4096, stream: false }
    : payload;
}

function rejectTruncated(finishReason: unknown): void {
  if (finishReason === 'length') {
    throw new AiProviderError('AI response truncated before completion.', 'output_limit');
  }
}
export type AiFailureReason = 'provider' | 'cancelled' | 'headers_timeout' | 'body_timeout' | 'output_limit';

export class AiProviderError extends Error {
  constructor(message: string, readonly reason: AiFailureReason = 'provider') {
    super(message);
    this.name = 'AiProviderError';
  }
}

interface AbortWatch {
  signal: AbortSignal;
  promise: Promise<never>;
  timedOut: () => boolean;
  callerAborted: () => boolean;
  failure: () => AiProviderError | null;
  finish: () => void;
}

/** One deadline governs headers and body. A transport that ignores the
 *  AbortSignal still cannot make the adapter wait forever or accept a late
 *  result; no raw response body is ever included in the error. */
function watchAbort(
  external: AbortSignal | undefined,
  timeoutMs: number,
  phase: { value: 'headers' | 'body' },
): AbortWatch {
  const controller = new AbortController();
  let timedOut = false;
  let caller = false;
  let failure: AiProviderError | null = null;
  let reject!: (err: AiProviderError) => void;
  const promise = new Promise<never>((_, rej) => { reject = rej; });
  const fail = (err: AiProviderError): void => {
    // Store and publish the FIRST terminal cause before aborting: native
    // fetch listeners reject synchronously on abort and must not win the race.
    if (failure !== null) return;
    failure = err;
    reject(err);
    controller.abort();
  };
  const onTimer = () => {
    timedOut = true;
    fail(new AiProviderError(
      phase.value === 'headers'
        ? 'AI provider timed out before response headers.'
        : 'AI provider timed out while reading the response body.',
      phase.value === 'headers' ? 'headers_timeout' : 'body_timeout',
    ));
  };
  const onCaller = () => {
    caller = true;
    fail(new AiProviderError('AI request cancelled by caller.', 'cancelled'));
  };
  const timer = setTimeout(onTimer, Math.max(1, timeoutMs));
  if (external?.aborted) onCaller();
  else external?.addEventListener('abort', onCaller, { once: true });
  return {
    signal: controller.signal,
    promise,
    timedOut: () => timedOut,
    callerAborted: () => caller,
    failure: () => failure,
    finish: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onCaller);
    },
  };
}

export async function chatCompletion(
  deps: AiProviderDeps,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<{ content: string }> {
  if (signal?.aborted) throw new AiProviderError('AI request cancelled by caller.', 'cancelled');
  const phase: { value: 'headers' | 'body' } = { value: 'headers' };
  const watch = watchAbort(signal, deps.timeoutMs ?? 45_000, phase);
  try {
    const res = await Promise.race([
      (deps.fetchImpl ?? fetch)(`${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(completionOptions(deps.baseUrl, deps.model, {
          model: deps.model,
          temperature: 0.2,
          messages,
          response_format: { type: 'json_object' },
        })),
        signal: watch.signal,
      }),
      watch.promise,
    ]);
    if (!res.ok) throw new AiProviderError(`AI provider returned ${res.status}`);
    phase.value = 'body';
    const body = await Promise.race([res.json(), watch.promise]) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: unknown }>;
    };
    if (watch.callerAborted() || watch.timedOut()) {
      throw new AiProviderError('AI request ended before completion.', 'cancelled');
    }
    rejectTruncated(body.choices?.[0]?.finish_reason);
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiProviderError('AI provider returned an empty message');
    }
    return { content };
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    const terminal = watch.failure();
    if (terminal !== null) throw terminal;
    throw new AiProviderError('AI provider request failed.');
  } finally {
    watch.finish();
  }
}

/** Real tool-call exchange. Tool bodies returned by the model are DATA. */
export async function chatCompletionWithTools(
  deps: AiProviderDeps,
  messages: ChatToolMessage[],
  tools: ChatToolDefinition[],
  allowedToolNames: readonly string[],
  signal?: AbortSignal,
  maxCalls = 4,
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> {
  if (signal?.aborted) throw new AiProviderError('AI request cancelled by caller.', 'cancelled');
  const phase: { value: 'headers' | 'body' } = { value: 'headers' };
  const watch = watchAbort(signal, deps.timeoutMs ?? 45_000, phase);
  try {
    const res = await Promise.race([
      (deps.fetchImpl ?? fetch)(`${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(completionOptions(deps.baseUrl, deps.model, {
          model: deps.model, temperature: 0.2, messages,
          ...(tools.length > 0
            ? { tools, tool_choice: 'auto' }
            : { tool_choice: 'none' }),
        })),
        signal: watch.signal,
      }),
      watch.promise,
    ]);
    if (watch.callerAborted() || watch.timedOut()) {
      throw new AiProviderError('AI request ended before completion.', 'cancelled');
    }
    if (!res.ok) throw new AiProviderError(`AI provider returned ${res.status}`);
    phase.value = 'body';
    const body: unknown = await Promise.race([res.json(), watch.promise]);
    if (watch.callerAborted() || watch.timedOut()) {
      throw new AiProviderError('AI request ended before completion.', 'cancelled');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AiProviderError('malformed tool response');
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) throw new AiProviderError('malformed tool response');
    const first = choices[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) throw new AiProviderError('malformed tool response');
    if ('finish_reason' in first) rejectTruncated(first.finish_reason);
    const message = (first as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new AiProviderError('malformed tool response');
    const m = message as { content?: unknown; tool_calls?: unknown };
    const content = typeof m.content === 'string' && m.content.trim() ? m.content : null;
    if (m.tool_calls !== undefined && !Array.isArray(m.tool_calls)) throw new AiProviderError('malformed tool response');
    const calls: ChatToolCall[] = [];
    const seen = new Set<string>();
    for (const item of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (typeof item !== 'object' || item === null || Array.isArray(item) ||
          Object.getPrototypeOf(item) !== Object.prototype) throw new AiProviderError('malformed tool call');
      const c = item as { id?: unknown; type?: unknown; function?: unknown };
      if (typeof c.id !== 'string' || c.id.length < 1 || c.id.length > 128 || seen.has(c.id)) throw new AiProviderError('malformed tool call');
      if (c.type !== 'function' || typeof c.function !== 'object' || c.function === null || Array.isArray(c.function)) {
        throw new AiProviderError('malformed tool call');
      }
      const f = c.function as { name?: unknown; arguments?: unknown };
      if (typeof f.name !== 'string' || !allowedToolNames.includes(f.name)) throw new AiProviderError('unsupported tool call');
      if (typeof f.arguments !== 'string' || f.arguments.length > 8192) throw new AiProviderError('malformed tool call');
      if (calls.length >= maxCalls) throw new AiProviderError('too many tool calls');
      seen.add(c.id);
      calls.push({ id: c.id, type: 'function', function: { name: f.name, arguments: f.arguments } });
    }
    if (content == null && calls.length === 0) throw new AiProviderError('empty tool response');
    return { content, toolCalls: calls };
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    const terminal = watch.failure();
    if (terminal !== null) throw terminal;
    throw new AiProviderError('AI tool request failed.');
  } finally {
    watch.finish();
  }
}

export function safeEvidenceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch { return null; }
}

/** Parse the model's JSON answer defensively; strict shape checks after. */
export function parseChoiceJson(content: string): { stationIds?: number[]; notes?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AiProviderError('AI response was not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiProviderError('AI response was not a choice object');
  }
  const choice = parsed as AiChoiceRaw;
  // An explicit empty array is a valid zero-stop choice; physical reachability
  // is decided later by the same planner validator used for non-empty choices.
  if (!Array.isArray(choice.chosenStationIds) ||
      choice.chosenStationIds.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    // Never turn malformed model output into a different stop sequence by
    // dropping elements. Let the route return its computed base plan.
    throw new AiProviderError('AI response contained an invalid station sequence');
  }
  const notes = typeof choice.notes === 'string' ? choice.notes : undefined;
  return { stationIds: choice.chosenStationIds, notes };
}
