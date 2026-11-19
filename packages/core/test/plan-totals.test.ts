import { describe, expect, it } from 'vitest';
import { computeTotals } from '../src/planner.js';
import { DEFAULT_PLAN_OPTIONS, type PlanStop } from '../src/plan-types.js';
import { HARIER_EV_75 } from '../src/vehicle.js';

function totals(prices: Array<number | null>) {
  const stops = prices.map((estPriceInr, index) => ({
    estPriceInr, chargeTimeMin: 10, chargeKwh: 5,
    chainageKm: (index + 1) * 50, detourKm: 0, leaveSocPct: 80,
  })) as PlanStop[];
  return computeTotals(stops, 200, { distanceKm: 200, durationMin: 180 }, DEFAULT_PLAN_OPTIONS, HARIER_EV_75);
}

describe('trip total price completeness', () => {
  it.each([{ prices: [100, null] }, { prices: [null, 100] }, { prices: [0, null] }])(
    'does not show a partial subtotal as total: %j', ({ prices }) => {
      expect(totals(prices).estPriceInr).toBeNull();
    },
  );
  it('sums complete known prices including a free stop', () => {
    expect(totals([100, 0, 50]).estPriceInr).toBe(150);
  });
  it('preserves unavailable behavior for all unknown prices and no stops', () => {
    expect(totals([null, null]).estPriceInr).toBeNull();
    expect(totals([]).estPriceInr).toBeNull();
  });
});
