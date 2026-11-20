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
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
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

/** A Directions link is meaningful only for a real numeric coordinate pair. */
export function stationDirectionsUrl(lat: unknown, lon: unknown): string | null {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat}%2C${lon}`;
}

/** Preserve every waypoint or omit the entire route link. Never drop a stop. */
export function routeDirectionsUrl(
  origin: { lat: unknown; lon: unknown },
  destination: { lat: unknown; lon: unknown },
  stops: Array<{ lat: unknown; lon: unknown }>,
): string | null {
  if (![origin, destination, ...stops].every(point => stationDirectionsUrl(point.lat, point.lon) !== null)) return null;
  return `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${destination.lat},${destination.lon}${stops.length > 0 ? `&waypoints=${stops.map(point => `${point.lat}%2C${point.lon}`).join('%7C')}` : ''}`;
}
