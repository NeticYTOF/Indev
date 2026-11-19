import { describe, expect, it } from 'vitest';
import { lastUsedLabel } from '../src/format.js';

/**
 * Malicious-LOOKING fixture regressions for the last-used label
 * (source hardening; fixtures are inert strings, no executable content).
 *
 * The function's contract is deliberately unchanged: canonical dd/mm/yyyy
 * values format to the most recent date, and a non-canonical value passes
 * through RAW - the literal upstream datum is preserved. The FIX is at the
 * render boundary (the card template now wraps this output in
 * escapeHtml), so these fixtures prove the passthrough that made the old
 * unescaped rendering dangerous, plus the unchanged normal behavior.
 */
describe('lastUsedLabel: raw passthrough stays literal, canonical dates format', () => {
  it('picks the MOST RECENT canonical dd/mm/yyyy value (behavior unchanged)', () => {
    expect(
      lastUsedLabel([
        { lastUsedOn: '19/11/2026' },
        { lastUsedOn: '02/01/2026' },
        { lastUsedOn: '05/07/2025' },
      ]),
    ).toBe('19/11/2026');
  });

  it('formats the single canonical value it finds', () => {
    expect(lastUsedLabel([{ lastUsedOn: '01/02/2027' }])).toBe('1/2/2027');
  });

  it('skips null lastUsedOn values and reports unknown when all are null', () => {
    expect(lastUsedLabel([{ lastUsedOn: null }, { lastUsedOn: null }])).toBe('unknown');
    expect(lastUsedLabel([])).toBe('unknown');
  });

  it('passes a NON-canonical upstream value through RAW (escape is the render site\\u0027s job)', () => {
    // Malicious-looking inert fixtures: these MUST come back literally
    // unchanged - the data is preserved and the render boundary escapes.
    // The old defect rendered exactly this raw output into innerHTML.
    const imgTag = '<img src=x onerror=alert(1)>';
    expect(lastUsedLabel([{ lastUsedOn: imgTag }])).toBe(imgTag);
    const scriptTag = '<script>alert(1)</script>';
    expect(lastUsedLabel([{ lastUsedOn: scriptTag }])).toBe(scriptTag);
    const isoLike = '2026-11-19T12:00:00Z';
    expect(lastUsedLabel([{ lastUsedOn: isoLike }])).toBe(isoLike);
  });

  it('mixed canonical + non-canonical: canonical wins (most recent among parsed)', () => {
    expect(lastUsedLabel([{ lastUsedOn: 'tomorrow maybe' }, { lastUsedOn: '19/11/2026' }])).toBe(
      '19/11/2026',
    );
  });
});
