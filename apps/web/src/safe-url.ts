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

function validLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

/** A Directions link is meaningful only for a real numeric coordinate pair. */
export function stationDirectionsUrl(lat: unknown, lon: unknown): string | null {
  if (!validLatitude(lat) || !validLongitude(lon)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat}%2C${lon}`;
}

/**
 * SavedTrip.geometry uses [lat, lon] tuples. Validate every vertex before
 * returning MapLibre [lon, lat] coordinates; malformed input rejects the
 * whole route and is NEVER filtered, reordered or stitched into a shorter one.
 */
export function savedRouteGeometry(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const coordinates: Array<[number, number]> = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [lat, lon] = point as [unknown, unknown];
    if (!validLatitude(lat) || !validLongitude(lon)) return null;
    coordinates.push([lon, lat]);
  }
  return coordinates;
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

export interface RouteDirectionsLink {
  readonly url: string;
  readonly part: number;
  readonly total: number;
  /** Inclusive 1-based stop indices represented by this link. */
  readonly firstStop: number;
  readonly lastStop: number;
  readonly startsAtOrigin: boolean;
  readonly endsAtDestination: boolean;
}

/** Current Google Maps URL guidance: mobile-safe 3 waypoints, 2048 encoded chars. */
const MAX_WAYPOINTS_PER_LINK = 3;
const MAX_URL_LENGTH = 1800;

/**
 * Build an ordered [origin, ...stops, destination] route. A link carries at
 * most a start, 3 waypoints and an end; consecutive links share exactly the
 * previous end point, so the flattened sequence has no omission, interior
 * duplication or backtracking.
 */
export function routeDirectionsLinks(
  origin: { lat: unknown; lon: unknown },
  destination: { lat: unknown; lon: unknown },
  stops: Array<{ lat: unknown; lon: unknown }>,
): RouteDirectionsLink[] | null {
  const points = [origin, ...stops, destination];
  if (!points.every(point => stationDirectionsUrl(point.lat, point.lon) !== null)) return null;
  const single = routeDirectionsUrl(origin, destination, stops);
  if (single != null && stops.length <= MAX_WAYPOINTS_PER_LINK && single.length <= MAX_URL_LENGTH) {
    return [{
      url: single, part: 1, total: 1, firstStop: 1, lastStop: stops.length,
      startsAtOrigin: true, endsAtDestination: true,
    }];
  }
  const links: RouteDirectionsLink[] = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(start + MAX_WAYPOINTS_PER_LINK + 1, points.length - 1);
    const segmentOrigin = points[start] as { lat: unknown; lon: unknown };
    const segmentDestination = points[end] as { lat: unknown; lon: unknown };
    const waypoints = points.slice(start + 1, end);
    const url = routeDirectionsUrl(segmentOrigin, segmentDestination, waypoints);
    if (url == null || url.length > MAX_URL_LENGTH) return null;
    links.push({
      url,
      part: links.length + 1,
      total: 0,
      firstStop: Math.max(start, 1),
      lastStop: Math.min(end, stops.length),
      startsAtOrigin: start === 0,
      endsAtDestination: end === points.length - 1,
    });
    start = end;
  }
  return links.map((link) => ({ ...link, total: links.length }));
}
