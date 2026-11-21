import { describe, expect, it } from 'vitest';
import { AiProviderError, parseChoiceJson } from '../src/ai-provider.js';

describe('AI sequence parser, synthetic JSON only', () => {
  it.each(['null', '[]', 'true', '1', '"choice"', '{}', '{"chosenStationIds":null}', '{"chosenStationIds":"705,711"}', '{"chosenStationIds":[""]}'])('rejects invalid top-level/sequence shape: %s', content => {
    expect(() => parseChoiceJson(content)).toThrow(AiProviderError);
  });
  it.each([null, '711', {}, [], false, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(value => ({ value })))('rejects the entire sequence rather than dropping $value', ({ value: invalid }) => {
    expect(() => parseChoiceJson(JSON.stringify({ chosenStationIds: [705, invalid, 711] }))).toThrow('invalid station sequence');
  });
  it.each([[null, 705, 711], [705, 711, null]].map(ids => ({ ids })))('rejects invalid leading and trailing elements: $ids', ({ ids }) => {
    expect(() => parseChoiceJson(JSON.stringify({ chosenStationIds: ids }))).toThrow('invalid station sequence');
  });
  it('distinguishes syntax errors from wrong shape without leaking raw output', () => {
    expect(() => parseChoiceJson('{')).toThrow('not valid JSON');
    expect(() => parseChoiceJson('[]')).toThrow('not a choice object');
  });
  it('accepts an explicit empty zero-stop choice with notes', () => {
    expect(parseChoiceJson('{"chosenStationIds":[],"notes":"Direct route is reachable"}')).toEqual({ stationIds: [], notes: 'Direct route is reachable' });
  });
  it('retains valid IDs and their order without coercion, pruning or deduplication', () => {
    expect(parseChoiceJson(JSON.stringify({ chosenStationIds: [711, 705, 705], notes: 'Fixture' }))).toEqual({ stationIds: [711, 705, 705], notes: 'Fixture' });
  });
  it('does not coerce malformed notes into display text', () => {
    expect(parseChoiceJson('{"chosenStationIds":[705],"notes":{"value":"fixture"}}').notes).toBeUndefined();
  });
});
