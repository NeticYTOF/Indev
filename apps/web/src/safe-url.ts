/**
 * Scheme allowlist for EXTERNAL urls that arrive from upstream data
 * (station page links). Source hardening, no attack claim: html-escaping
 * a url prevents attribute BREAKOUT, not scheme abuse - a value like
 * 'javascript:alert(1)' contains no html-special characters and would
 * otherwise render as a clickable, executable link.
 *
 * Only absolute http/https urls pass. Everything else - javascript:,
 * data:, vbscript:, file:, scheme-relative and relative paths -
 * yields null, and the caller renders NO link at all (honest absence),
 * never a sanitized-but-fake one.
 *
 * Handles the WHATWG url-parser normalizations that scheme tricks rely
 * on: leading/trailing whitespace and embedded tabs/newlines are
 * stripped by the parser BEFORE scheme resolution (so 'javasc\nript:'
 * resolves to the javascript scheme and is refused), and schemes are
 * lowercased (so 'JAVASCRIPT:' is refused too).
 *
 * Pure module - unit-testable in a plain node env (URL is global in
 * Node and browsers).
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // No scheme/base at all (relative path, bare word) - not a navigable
    // external url; render nothing.
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  return parsed.href;
}
