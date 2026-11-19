import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-structure contracts for untrusted-data rendering hardening
 * (plan-panel.ts imports maplibre, so its template wiring cannot run in
 * this node env - the contracts lock the wiring; the pure guards are
 * unit-tested separately with malicious-looking fixtures).
 */
const planPanelSrc = readFileSync(new URL('../src/plan-panel.ts', import.meta.url), 'utf8');

describe('station page link: upstream urls pass a scheme allowlist', () => {
  it('renders the link only from safeHttpUrl output, never the raw value', () => {
    // Old defect: href="${escapeHtml(s.stationUrl)}" - html-escaping does
    // not touch 'javascript:...' (no html-special chars), so a scheme
    // value from upstream data rendered as an executable link.
    expect(planPanelSrc).toContain('const stationPageUrl = safeHttpUrl(s.stationUrl);');
    expect(planPanelSrc).toContain('${stationPageUrl ? `<a class="btn btn-compact btn-ghost" href="${escapeHtml(stationPageUrl)}"');
    // The raw upstream value must appear in NO href anywhere.
    expect(planPanelSrc).not.toContain('href="${escapeHtml(s.stationUrl)}"');
  });
});
