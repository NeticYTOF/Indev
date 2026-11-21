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

export class AiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export async function chatCompletion(
  deps: AiProviderDeps,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<{ content: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 45_000);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetchImpl(`${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: deps.model,
        temperature: 0.2,
        messages,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new AiProviderError(`AI provider returned ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiProviderError('AI provider returned an empty message');
    }
    return { content };
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    throw new AiProviderError(
      `AI provider request failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
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
  if (signal?.aborted) throw new AiProviderError('AI tool request cancelled');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 45_000);
  const onExternalAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
  const cancelled = (): AiProviderError => new AiProviderError('AI tool request cancelled');
  try {
    const res = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: deps.model, temperature: 0.2, messages,
        ...(tools.length > 0
          ? { tools, tool_choice: 'auto' }
          : { tool_choice: 'none' }),
      }),
      signal: controller.signal,
    });
    // A fetch that ignores abort must not let a post-cancel result through.
    if (signal?.aborted || controller.signal.aborted) throw cancelled();
    if (!res.ok) throw new AiProviderError(`AI provider returned ${res.status}`);
    const body: unknown = await res.json();
    if (signal?.aborted || controller.signal.aborted) throw cancelled();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AiProviderError('malformed tool response');
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) throw new AiProviderError('malformed tool response');
    const first = choices[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) throw new AiProviderError('malformed tool response');
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
    throw new AiProviderError(`AI tool request failed: ${err instanceof Error ? err.message : 'unknown'}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
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
