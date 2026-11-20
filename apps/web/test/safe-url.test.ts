import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from '../src/safe-url.js';

/**
 * Malicious-LOOKING fixture regressions for the station-url scheme guard
 * (source hardening; fixtures are inert strings, no executable content).
 */
describe('safeHttpUrl: scheme allowlist for upstream station links', () => {
  it('refuses script-scheme values that html-escaping does not touch', () => {
    // The original rendering defect: these carry NO html-special characters,
    // so escapeHtml left them intact inside href="...".
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('javascript:void(0)//statiq.in')).toBeNull();
    expect(safeHttpUrl('data:text/html,<b>hi</b>')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
  });

  it('refuses scheme tricks through the parser normalizations', () => {
    // Uppercase scheme: the parser lowercases before resolving.
    expect(safeHttpUrl('JAVASCRIPT:alert(1)')).toBeNull();
    // Embedded tab/newline: the parser strips them BEFORE scheme
    // resolution, so this resolves to the javascript scheme - refused.
    expect(safeHttpUrl('java\nscript:alert(1)')).toBeNull();
    expect(safeHttpUrl('java\tscript:alert(1)')).toBeNull();
    // Leading whitespace gets trimmed - same resolution, refused.
    expect(safeHttpUrl('   javascript:alert(1)')).toBeNull();
    // Relative / scheme-relative values: no navigable scheme at all.
    expect(safeHttpUrl('/station/1790')).toBeNull();
    expect(safeHttpUrl('//evil.example/station')).toBeNull();
    expect(safeHttpUrl('statiq.in/station/1790')).toBeNull();
  });

  it('keeps real https/http station urls (normalized href form)', () => {
    expect(safeHttpUrl('https://statiq.in/station/1790')).toBe('https://statiq.in/station/1790');
    expect(safeHttpUrl('http://example.com/page?id=1')).toBe('http://example.com/page?id=1');
    // Trimmed and normalized but preserved as the same resource.
    expect(safeHttpUrl('  https://statiq.in/station/1790  ')).toBe('https://statiq.in/station/1790');
    expect(safeHttpUrl('HTTPS://STATIQ.IN/Station/1790')).toBe('https://statiq.in/Station/1790');
  });

  it('renders NO link (null) for empty or missing values', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl('    ')).toBeNull();
  });

  it('the mock fixture url is honestly absent, not a fake link', () => {
    // Mock station fixtures use stationUrl values like 's'/'n' (deliberate
    // non-navigable markers): after the guard they render no link at all.
    expect(safeHttpUrl('s')).toBeNull();
    expect(safeHttpUrl('n')).toBeNull();
  });
});

it('refuses nonstring station URLs without coercion or throwing', () => {
  for (const value of [42, true, {}, [], ['https://example.com/']]) expect(safeHttpUrl(value)).toBeNull();
});
