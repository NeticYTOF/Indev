import { describe, expect, it } from 'vitest';
import { lastUsedLabel, formatLastUsed } from '../src/format.js';

describe('charger dates never roll invalid calendar dates into different facts', () => {
  it.each(['31/02/2026', '00/11/2026', '19/13/2026', '29/02/2025'])(
    'keeps invalid upstream value %s literal', (raw) => {
      expect(lastUsedLabel([{ lastUsedOn: raw }])).toBe(raw);
      expect(formatLastUsed(raw)).toBe(raw);
    },
  );
  it('an invalid rollover cannot outrank a real latest charger date', () => {
    expect(lastUsedLabel([{ lastUsedOn: '31/02/2026' }, { lastUsedOn: '28/02/2026' }])).toBe('28/2/2026');
  });
  it('accepts leap days only in actual leap years', () => {
    expect(lastUsedLabel([{ lastUsedOn: '29/02/2024' }])).toBe('29/2/2024');
    expect(formatLastUsed('29/02/2024')).toBe('29 Feb 2024');
    expect(lastUsedLabel([{ lastUsedOn: '29/02/2100' }])).toBe('29/02/2100');
    expect(lastUsedLabel([{ lastUsedOn: '29/02/2000' }])).toBe('29/2/2000');
  });
});
