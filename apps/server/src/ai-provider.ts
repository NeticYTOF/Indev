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

export interface AiChoiceRaw {
  chosenStationIds?: unknown;
  notes?: unknown;
}

export class AiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export async function chatCompletion(
  deps: AiProviderDeps,
  messages: ChatMessage[],
): Promise<{ content: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 45_000);
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
  }
}

/** Parse the model's JSON answer defensively; strict shape checks after. */
export function parseChoiceJson(content: string): { stationIds?: number[]; notes?: string } {
  try {
    const parsed = JSON.parse(content) as AiChoiceRaw;
    const ids = Array.isArray(parsed.chosenStationIds)
      ? parsed.chosenStationIds.filter((x): x is number => typeof x === 'number' && Number.isInteger(x))
      : undefined;
    const notes = typeof parsed.notes === 'string' ? parsed.notes : undefined;
    return { stationIds: ids, notes };
  } catch {
    throw new AiProviderError('AI response was not valid JSON');
  }
}
