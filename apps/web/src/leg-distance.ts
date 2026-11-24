/**
 * Distances between charging stops, derived only from plan facts.
 *
 * Per-stop `legKm` is authoritative (km driven from the previous stop or the
 * origin, detours included). The final leg uses the same math as the journey
 * briefing: totals.distanceKm - lastStop.chainageKm + lastStop.detourKm.
 * Missing or malformed numbers yield null: a distance is never invented.
 */

export interface LegInfo {
  /** 0-based index of the stop this leg ends at; stops.length = destination. */
  toIndex: number;
  fromLabel: string;
  toLabel: string;
  km: number | null;
  /** Route position (km from start) of the leg's start and end, if known. */
  startChainageKm: number | null;
  endChainageKm: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e6 ? value : null;
}

function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** Stop name for fresh PlanStops (station.name) or saved refs (name). */
export function stopName(stop: unknown): string {
  const s = record(stop);
  return label(record(s?.station)?.name ?? s?.name, 'Unknown station');
}

/** Every leg of the trip: origin → stop 1 → … → destination. */
export function tripLegs(input: {
  originLabel: unknown;
  destinationLabel: unknown;
  stops: readonly unknown[];
  totalDistanceKm: unknown;
}): LegInfo[] {
  const legs: LegInfo[] = [];
  let fromLabel = label(input.originLabel, 'Start');
  let fromChainage: number | null = 0;
  input.stops.forEach((raw, index) => {
    const stop = record(raw) ?? {};
    const toLabel = stopName(stop);
    const chainage = nonnegative(stop.chainageKm);
    legs.push({
      toIndex: index, fromLabel, toLabel,
      km: nonnegative(stop.legKm),
      startChainageKm: fromChainage, endChainageKm: chainage,
    });
    fromLabel = toLabel;
    fromChainage = chainage;
  });
  const total = nonnegative(input.totalDistanceKm);
  const last = record(input.stops.at(-1));
  let finalKm: number | null;
  if (!last) {
    finalKm = total;
  } else {
    const chainage = nonnegative(last.chainageKm);
    const detour = nonnegative(last.detourKm);
    finalKm = total != null && chainage != null && detour != null ? Math.max(0, total - chainage + detour) : null;
  }
  legs.push({
    toIndex: input.stops.length, fromLabel,
    toLabel: label(input.destinationLabel, 'Destination'),
    km: finalKm, startChainageKm: fromChainage, endChainageKm: total,
  });
  return legs;
}

export function formatLegKm(km: number | null): string {
  if (km == null) return 'Unknown';
  return km >= 100 ? `${Math.round(km)} km` : `${(Math.round(km * 10) / 10).toString()} km`;
}

const EARTH_KM = 6371.0088;
function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cumulative km along a [lon, lat] polyline; first entry is 0. */
export function cumulativeKm(geometry: ReadonlyArray<readonly [number, number]>): number[] {
  const out: number[] = [];
  let sum = 0;
  geometry.forEach((point, i) => {
    if (i > 0) sum += haversineKm(geometry[i - 1]!, point);
    out.push(sum);
  });
  return out;
}

/**
 * The [lon, lat] point at `km` along the route. `scaleToKm` maps plan
 * chainage onto the drawn geometry when the two disagree in total length.
 */
export function pointAtDistance(
  geometry: ReadonlyArray<readonly [number, number]>,
  km: number,
  scaleToKm?: number | null,
  cumulative: number[] = cumulativeKm(geometry),
): [number, number] | null {
  if (geometry.length < 2 || !Number.isFinite(km)) return null;
  const length = cumulative[cumulative.length - 1]!;
  if (!(length > 0)) return null;
  const target = scaleToKm != null && scaleToKm > 0 ? (km / scaleToKm) * length : km;
  const clamped = Math.max(0, Math.min(length, target));
  let lo = 0;
  let hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid]! <= clamped) lo = mid; else hi = mid;
  }
  const span = cumulative[hi]! - cumulative[lo]!;
  const t = span > 0 ? (clamped - cumulative[lo]!) / span : 0;
  const a = geometry[lo]!;
  const b = geometry[hi]!;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
