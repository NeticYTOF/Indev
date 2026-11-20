function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}
function nullable(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === null || check(value);
}
function soc(value: unknown): boolean {
  return nonnegative(value) && value <= 100;
}
function fields(value: Record<string, unknown>, keys: string[], check = nonnegative): boolean {
  return keys.every(key => check(value[key]));
}

/** New save requests must contain the scalar metadata the persisted form uses.
 * This is not a legacy-file migration or a stricter reader for old snapshots.
 * Route geometry, coordinates, station IDs and provenance have separate gates.
 */
export function validSavedPlanMetadata(plan: unknown): boolean {
  if (!record(plan) || !record(plan.vehicle) || !record(plan.totals) || !Array.isArray(plan.stops)) return false;
  const vehicle = plan.vehicle;
  const totals = plan.totals;
  if (typeof plan.createdAt !== 'string' || !Number.isFinite(Date.parse(plan.createdAt)) ||
      (plan.status !== 'ok' && plan.status !== 'degraded') ||
      !fields(plan, ['routeDistanceKm', 'routeDurationMin']) ||
      typeof vehicle.label !== 'string' ||
      !(vehicle.catalogId === null || typeof vehicle.catalogId === 'string') ||
      !positive(vehicle.batteryKwh) ||
      !nullable(vehicle.claimedRangeKm, positive) || !nullable(vehicle.realWorldRangeKm, positive) ||
      !fields(totals, ['distanceKm', 'driveTimeMin', 'chargeTimeMin', 'totalTimeMin', 'chargeKwh']) ||
      !nullable(totals.estPriceInr, nonnegative) || !soc(totals.finalSocPct)) return false;
  return plan.stops.every(stop => record(stop) &&
    fields(stop, ['chainageKm', 'legKm', 'detourKm', 'chargeKwh', 'chargeTimeMin']) &&
    soc(stop.arriveSocPct) && soc(stop.leaveSocPct) &&
    nullable(stop.pricePerKwh, nonnegative) && nullable(stop.estPriceInr, nonnegative));
}
