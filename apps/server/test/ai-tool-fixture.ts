/**
 * Test seam adapter: legacy fixtures supplied a single text reply. The
 * selective engine needs a real tool-call turn first, then a final text
 * reply. This adapter derives the tool IDs from the on-route candidate
 * metadata actually sent to the model and never touches the network.
 */
import type { AiToolCall } from '../src/ai-provider.js';

export function toolFixture(reply: string, chosen?: number[]): AiToolCall {
  return async (messages) => {
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') return { content: reply, toolCalls: [] };
    const user = messages.find((m) => m.role === 'user');
    if (!user || user.role !== 'user') return { content: reply, toolCalls: [] };
    let ids = chosen;
    if (!ids) {
      try {
        const payload = JSON.parse(user.content) as { candidates?: Array<{ stationId: number }> };
        ids = (payload.candidates ?? []).slice(0, 3).map((c) => c.stationId);
      } catch {
        ids = [];
      }
    }
    if (ids.length === 0) return { content: reply, toolCalls: [] };
    return {
      content: null,
      toolCalls: [{
        id: 'fixture-tool-1', type: 'function',
        function: { name: 'get_station_details', arguments: JSON.stringify({ ids }) },
      }],
    };
  };
}
