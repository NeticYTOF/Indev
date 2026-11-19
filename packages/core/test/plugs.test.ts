import { describe, expect, it } from 'vitest';
import { classifyPlug, summarizeCcs2 } from '../src/plugs.js';
import type { StatiqConnector, StatiqStationDetail } from '../src/types.js';

function conn(status: string, available: boolean | null, note: string | null, type = 'CCS-2'): StatiqConnector {
  return { displayId: 1, connectorId: 1, type, status, available, note };
}

describe('classifyPlug (observed Statiq vocabulary)', () => {
  const cases: Array<[StatiqConnector, ReturnType<typeof classifyPlug>['health'], boolean]> = [
    // available + Faulted note -> contradiction -> uncertain (most common real case, 19x)
    [conn('available', true, 'Faulted'), 'uncertain', true],
    // consistent available
    [conn('available', true, null), 'working-free', false],
    [conn('Available', true, ''), 'working-free', false],
    // occupied but working -> kept
    [conn('charging', false, 'Charging'), 'working-occupied', false],
    // consistent faulted -> excluded
    [conn('faulted', false, 'Faulted'), 'faulted', false],
    // available flag + disconnected note contradict status -> uncertain
    [conn('available', false, 'Disconnected'), 'uncertain', true],
    // unavailable + disconnected -> offline
    [conn('unavailable', false, 'Disconnected'), 'offline', false],
    // charging + disconnected note contradict -> uncertain
    [conn('charging', false, 'Disconnected'), 'uncertain', true],
    // preparing but faulted -> uncertain
    [conn('preparing', true, 'Faulted'), 'uncertain', true],
    // preparing plainly -> free
    [conn('preparing', true, null), 'working-free', false],
    // finishing -> finishing
    [conn('finishing', false, 'Finished'), 'finishing', false],
    // status=available, available=false, note=Charging -> occupied (flags agree: busy)
    [conn('available', false, 'Charging'), 'working-occupied', false],
    // unknown vocabulary -> uncertain, never working
    [conn('suspendedev', null, null), 'uncertain', true],
    [conn('', null, null), 'uncertain', true],
  ];

  it.each(cases)('%s -> %s', (c, expected, contradiction) => {
    const r = classifyPlug(c);
    expect(r.health).toBe(expected);
    expect(r.contradiction).toBe(contradiction);
  });
});

const station = (chargers: Array<{ type: string; kw: number; price: number | null; connectors: StatiqConnector[] }>): StatiqStationDetail =>
  ({
    stationId: 1,
    name: 'x',
    lat: 0,
    lon: 0,
    address: null,
    area: null,
    city: null,
    landmark: null,
    hours: null,
    openText: null,
    rating: null,
    reviewCount: null,
    accessType: null,
    navUrl: '',
    stationUrl: '',
    imageUrl: null,
    amenities: [],
    stepsToReach: null,
    chargers: chargers.map((ch, i) => ({
      chargerId: i,
      name: `c${i}`,
      type: ch.type,
      kw: ch.kw,
      pricePerKwh: ch.price,
      currency: 'INR',
      lastUsedOn: null,
      connectors: ch.connectors,
    })),
    summary: null,
  }) as unknown as StatiqStationDetail;

describe('summarizeCcs2', () => {
  it('counts only DC CCS2 plugs', () => {
    const s = summarizeCcs2(
      station([
        { type: 'DC', kw: 60, price: 22, connectors: [conn('available', true, null), conn('available', true, null)] },
        { type: 'AC', kw: 7, price: 10, connectors: [conn('available', true, null, 'Type-2')] },
        { type: 'AC', kw: 5, price: 8, connectors: [conn('available', true, null, 'Wall')] },
      ]),
    );
    expect(s.total).toBe(2);
    expect(s.usable).toBe(2);
    expect(s.free).toBe(2);
    expect(s.maxKw).toBe(60);
    expect(s.pricePerKwh).toBe(22);
  });

  it('is usable when plugs are occupied but working, and reports uncertainty', () => {
    const s = summarizeCcs2(
      station([
        {
          type: 'DC',
          kw: 120,
          price: 22.75,
          connectors: [conn('charging', false, 'Charging'), conn('available', true, 'Faulted')],
        },
      ]),
    );
    expect(s.total).toBe(2);
    expect(s.usable).toBe(1);
    expect(s.occupied).toBe(1);
    expect(s.uncertain).toBe(1);
    expect(s.hasContradiction).toBe(true);
    expect(s.isUsable).toBe(true);
    expect(s.maxKw).toBe(120);
    // matches the real observed Suryaa station shape
    expect(s.pricePerKwh).toBe(22.75);
  });

  it('is NOT usable when all CCS2 DC plugs are faulted', () => {
    const s = summarizeCcs2(
      station([
        { type: 'DC', kw: 60, price: 20, connectors: [conn('faulted', false, 'Faulted')] },
        { type: 'DC', kw: 50, price: 20, connectors: [conn('available', false, 'Disconnected')] },
      ]),
    );
    expect(s.isUsable).toBe(false);
    expect(s.faulted).toBe(1);
    expect(s.uncertain).toBe(1);
  });

  it('counts finishing as usable-free', () => {
    const s = summarizeCcs2(
      station([{ type: 'DC', kw: 60, price: 20, connectors: [conn('finishing', false, 'Finished')] }]),
    );
    expect(s.usable).toBe(1);
    expect(s.free).toBe(1);
    expect(s.isUsable).toBe(true);
  });
});
