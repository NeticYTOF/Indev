import { describe, expect, it } from 'vitest';
import {
  parseTripIntentRequest,
  parseTripIntentResponse,
  TripIntentError,
} from '../src/trip-intent.js';

const validModel = JSON.stringify({
  origin: 'Delhi', destination: 'Jaipur', via: ['Ahmedabad'],
});

describe('trip intent request validation', () => {
  it('accepts validated text only', () => {
    expect(parseTripIntentRequest({ text: '  drive from Delhi to Jaipur  ' }))
      .toEqual({ text: 'drive from Delhi to Jaipur' });
  });

  it.each([
    [null], [[]], [{}], [{ text: '' }], [{ text: '   ' }],
    [{ text: 'x'.repeat(801) }], [{ text: 'A to B', origin: 'A' }],
    [{ text: 'A to B', via: ['A', 'B'] }],
  ])('rejects invalid request before any provider call: %j', (value) => {
    expect(() => parseTripIntentRequest(value)).toThrow(TripIntentError);
  });
});

describe('trip intent model output validation', () => {
  it('accepts only the exact three-field place-name shape', () => {
    expect(parseTripIntentResponse(validModel)).toEqual({
      origin: 'Delhi', destination: 'Jaipur', via: ['Ahmedabad'], reviewRequired: true,
    });
  });

  it('accepts a round trip with identical endpoint names and ordered via', () => {
    expect(parseTripIntentResponse(JSON.stringify({
      origin: 'Delhi', destination: 'Delhi', via: ['Agra', 'Jaipur'],
    }))).toEqual({
      origin: 'Delhi', destination: 'Delhi', via: ['Agra', 'Jaipur'], reviewRequired: true,
    });
  });

  it.each([
    ['markdown', '```json\n' + validModel + '\n```'],
    ['array', '[]'],
    ['ambiguous', JSON.stringify({ error: 'missing_or_ambiguous' })],
    ['extra key', JSON.stringify({ origin: 'A', destination: 'B', via: [], tools: [] })],
    ['missing via', JSON.stringify({ origin: 'A', destination: 'B' })],
    ['coordinates', JSON.stringify({ origin: '28.6,77.2', destination: 'B', via: [] })],
    ['long name', JSON.stringify({ origin: 'x'.repeat(161), destination: 'B', via: [] })],

    ['six via', JSON.stringify({ origin: 'A', destination: 'B', via: Array(6).fill('V') })],
    ['charger shape', JSON.stringify({ origin: 'A', destination: 'B', via: [{ stationId: 1 }] })],
  ])('rejects untrusted output: %s', (_name, content) => {
    expect(() => parseTripIntentResponse(content)).toThrow(TripIntentError);
  });

  it('does not expose model text in its error messages', () => {
    expect(() => parseTripIntentResponse('SECRET MODEL PAYLOAD'))
      .toThrow(/did not return usable trip JSON/i);
    try {
      parseTripIntentResponse('SECRET MODEL PAYLOAD');
      expect.unreachable();
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).not.toContain('SECRET');
    }
  });
});
