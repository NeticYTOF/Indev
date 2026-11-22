import { describe, expect, it } from 'vitest';
import { classifyPlug, selectedCappedCharger, summarizeCcs2 } from '../src/plugs.js';
import { classifyPlugValues, connectorSlug } from '../src/plug-classifier.js';
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
    // Fault-substring false positives must not reject otherwise valid plugs.
    [conn('available', true, 'Default'), 'working-free', false],
    [conn('available', true, 'NoFault'), 'working-free', false],
    [conn('available', true, 'NoFaults'), 'working-free', false],
    [conn('available', true, 'NotFaulted'), 'working-free', false],
    [conn('available', true, 'NoFaultDetected'), 'working-free', false],
    // Negated-only notes never prove health on unknown vocabulary.
    [conn('unknown', null, 'Default'), 'uncertain', true],
    [conn('unknown', null, 'NoFault'), 'uncertain', true],
    // Genuine and later fault words still win over negation or positive status.
    [conn('available', true, 'Ground fault'), 'uncertain', true],
    [conn('available', true, 'No fault previously, now faulted'), 'uncertain', true],
    [conn('faulted', true, 'NoFault'), 'faulted', false],
    [conn('available', true, 'DefectiveFault'), 'uncertain', true],
    [conn('available', true, 'DefaultFault'), 'uncertain', true],
    [conn('available', true, 'NoFaultDetected Faulted'), 'uncertain', true],
    [conn('available', true, 'No. Faulted'), 'uncertain', true],
    [conn('available', true, 'No; Faulted'), 'uncertain', true],
    [conn('available', true, 'Faulted Not fault free'), 'uncertain', true],
    [conn('available', true, 'Not fault free'), 'uncertain', true],
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
    // Finishing does not override explicit disconnection/offline evidence.
    [conn('finishing', false, 'Disconnected'), 'uncertain', true],
    [conn('finishing', false, 'Offline'), 'uncertain', true],
    [conn('offline', false, 'Finished'), 'offline', false],
    [conn('unknown', null, 'Finished but disconnected'), 'uncertain', true],
    // finishing -> finishing
    [conn('finishing', false, 'Finished'), 'finishing', false],
    // status=available, available=false, note=Charging -> occupied (flags agree: busy)
    [conn('available', false, 'Charging'), 'working-occupied', false],
    // Unknown words containing a known token are not positive evidence.
    [conn('not available', null, null), 'uncertain', true],
    [conn('not charging', null, null), 'uncertain', true],
    [conn('not preparing', null, null), 'uncertain', true],
    [conn('not finishing', null, null), 'uncertain', true],
    [conn('maybe available', null, null), 'uncertain', true],
    [conn('unknown', null, 'Finished'), 'uncertain', true],
    // unknown vocabulary -> uncertain, never working
    [conn('suspendedev', null, null), 'uncertain', true],
    [conn('', null, null), 'uncertain', true],
  ];

  it.each(cases)('%s -> %s', (c, expected, contradiction) => {
    const r = classifyPlug(c);
    expect(r.health).toBe(expected);
    expect(r.contradiction).toBe(contradiction);
  });

  it('keeps the wrapper and browser-safe classifier identical across status/availability/note cases', () => {
    const statuses = [
      'available', 'Available', 'charging', 'faulted', 'unavailable',
      'preparing', 'finishing', 'offline', 'unknown', 'not available', '',
    ];
    const availabilityCases: unknown[] = [
      true, false, null, undefined, 'yes', 'false', 0, 1, [], {}, { value: true },
    ];
    const notes: Array<string | null> = [
      null, '', 'Faulted', 'Disconnected', 'Charging', 'Offline', 'Finished', 'Faulted but available',
    ];
    const positiveStatus = (status: string) =>
      /^(available|charging|preparing|finishing)$/i.test(status);
    const healthOutcomes = new Set<string>();
    let compared = 0;
    for (const status of statuses) {
      for (const available of availabilityCases) {
        for (const note of notes) {
          const wire = conn(status, available as boolean | null, note);
          const wrapped = classifyPlug(wire);
          const pure = classifyPlugValues({
            status: wire.status, available: wire.available, note: wire.note,
          });
          expect(wrapped, `${JSON.stringify({ status, available, note })}`).toEqual(pure);
          healthOutcomes.add(pure.health);
          if (positiveStatus(status) && available != null && typeof available !== 'boolean') {
            // Explicit fault text takes precedence before the availability
            // branch, so only assert invalidAvailability without that conflict.
            expect(pure.contradiction).toBe(true);
            if (!/fault/i.test(note ?? '')) expect(pure.invalidAvailability).toBe(true);
          }
          compared++;
        }
      }
    }
    expect(compared).toBe(statuses.length * availabilityCases.length * notes.length);
    expect([...healthOutcomes].sort()).toEqual([
      'faulted', 'finishing', 'offline', 'uncertain', 'working-free', 'working-occupied',
    ]);
  });

  it('normalizes only exact CCS2 connector vocabulary', () => {
    expect(connectorSlug('CCS-2')).toBe('ccs2');
    expect(connectorSlug('CCS2')).toBe('ccs2');
    expect(connectorSlug('ccs 2')).toBe('ccs2');
    expect(connectorSlug('CCS20')).toBe('ccs20');
  });
});

describe('available-status positive fault planning policy', () => {
  it('marks an available-status positive-fault connector as policy-excluded without changing observed health', () => {
    const result = classifyPlug(conn('available', true, 'Faulted'));
    expect(result).toMatchObject({
      health: 'uncertain', planningHealth: 'faulted', contradiction: true,
      policyExclusion: 'positive_fault_with_available_status',
    });
  });

  it('does not exclude a healthy sibling charger', () => {
    const detail = station([{
      type: 'DC', kw: 60, price: 20,
      connectors: [conn('available', true, 'Faulted'), conn('available', true, null)],
    }]);
    const summary = summarizeCcs2(detail);
    expect(summary.policyExcluded).toBe(1);
    expect(summary.usable).toBe(1);
    expect(summary.isUsable).toBe(true);
    expect(summary.maxKw).toBe(60);
    expect(selectedCappedCharger(detail, 60)?.kw).toBe(60);
  });

  it('does not widen the policy to merely positive-status occupied or preparing plugs', () => {
    expect(classifyPlug(conn('charging', false, 'Faulted')).policyExclusion).toBeUndefined();
    expect(classifyPlug(conn('preparing', true, 'Faulted')).policyExclusion).toBeUndefined();
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
  it('does not promote finishing/disconnected contradictions to usable-free', () => {
    const s = summarizeCcs2(station([{ type: 'DC', kw: 60, price: 20,
      connectors: [conn('finishing', false, 'Disconnected')] }]));
    expect(s.usable).toBe(0);
    expect(s.free).toBe(0);
    expect(s.uncertain).toBe(1);
    expect(s.hasContradiction).toBe(true);
    expect(s.isUsable).toBe(false);
    expect(s.maxKw).toBeNull();
  });

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

it.each([0, -60, '60', 'bad', NaN, Infinity, -Infinity])('does not use malformed usable charger power %j as numeric evidence', kw => {
  const input = station([{ type: 'DC', kw: 60, price: 20, connectors: [conn('available', true, null)] }]);
  Object.assign(input.chargers[0]!, { kw });
  const summary = summarizeCcs2(input);
  expect(summary.isUsable).toBe(true); expect(summary.usable).toBe(1);
  expect(summary.maxKw).toBeNull(); expect(summary.hasInvalidUsablePower).toBe(true);
});

it.each([null, undefined])('distinguishes legacy absent-only power %j from malformed power', kw => {
  const input = station([{ type: 'DC', kw: 60, price: 20, connectors: [conn('available', true, null)] }]);
  if (kw === undefined) delete (input.chargers[0] as Partial<import('../src/types.js').StatiqCharger>).kw;
  else Object.assign(input.chargers[0]!, { kw });
  const summary = summarizeCcs2(input);
  expect(summary.isUsable).toBe(true); expect(summary.maxKw).toBeNull();
  expect(summary.hasMissingUsablePower).toBe(true); expect(summary.hasInvalidUsablePower).toBe(false);
});

it.each([false, true])('selects the same valid power/tariff with malformed sibling first=%s', invalidFirst => {
  const input = station([
    { type: 'DC', kw: 60, price: 22, connectors: [conn('charging', false, 'Charging')] },
    { type: 'DC', kw: 120, price: 999, connectors: [conn('available', true, null)] },
  ]);
  Object.assign(input.chargers[1]!, { kw: 'bad' });
  if (invalidFirst) input.chargers.reverse();
  const summary = summarizeCcs2(input);
  expect(summary.maxKw).toBe(60); expect(summary.pricePerKwh).toBe(22);
  expect(summary.hasInvalidUsablePower).toBe(true); expect(summary.usable).toBe(2);
});

it.each([-1, '20', 'bad', NaN, Infinity, null, undefined])('keeps invalid or absent selected tariff %j unknown', pricePerKwh => {
  const input = station([{ type: 'DC', kw: 60, price: 20, connectors: [conn('available', true, null)] }]);
  if (pricePerKwh === undefined) delete (input.chargers[0] as Partial<import('../src/types.js').StatiqCharger>).pricePerKwh;
  else Object.assign(input.chargers[0]!, { pricePerKwh });
  expect(summarizeCcs2(input).pricePerKwh).toBeNull();
});

it('preserves zero tariffs and never borrows a slower sibling price', () => {
  const input = station([
    { type: 'DC', kw: 120, price: null, connectors: [conn('available', true, null)] },
    { type: 'DC', kw: 60, price: 0, connectors: [conn('available', true, null)] },
  ]);
  expect(summarizeCcs2(input).pricePerKwh).toBeNull();
  input.chargers[0]!.pricePerKwh = 0;
  expect(summarizeCcs2(input).pricePerKwh).toBe(0);
});

it('does not turn unrelated faulted invalid metadata into a usable-power hole', () => {
  const input = station([
    { type: 'DC', kw: 60, price: 22, connectors: [conn('available', true, null)] },
    { type: 'DC', kw: -1, price: -1, connectors: [conn('faulted', false, 'Faulted')] },
  ]);
  const summary = summarizeCcs2(input);
  expect(summary.maxKw).toBe(60); expect(summary.hasInvalidUsablePower).toBe(false);
  expect(summary.hasInvalidSelectedTariff).toBe(false); expect(summary.faulted).toBe(1);
});

it.each(['available', 'charging', 'preparing', 'finishing'].flatMap(status => ['false', 0, 1, {}, []].map(available => ({ status, available }))))('does not promote $status with malformed availability $available', ({ status, available }) => {
  const input = conn(status, true, null); Object.assign(input, { available });
  const result = classifyPlug(input);
  expect(result).toMatchObject({ health: 'uncertain', contradiction: true, invalidAvailability: true });
  const summary = summarizeCcs2(station([{ type: 'DC', kw: 120, price: 99, connectors: [input] }]));
  expect(summary.usable).toBe(0); expect(summary.free).toBe(0); expect(summary.maxKw).toBeNull(); expect(summary.pricePerKwh).toBeNull();
  expect(summary.hasInvalidUsableAvailability).toBe(true);
});

it.each(['faulted', 'offline', 'unavailable'])('preserves definite %s evidence despite malformed availability', status => {
  const input = conn(status, false, null); Object.assign(input, { available: 'false' });
  expect(classifyPlug(input).health).toBe(status === 'faulted' ? 'faulted' : 'offline');
  expect(summarizeCcs2(station([{ type: 'DC', kw: 60, price: 20, connectors: [input] }])).hasInvalidUsableAvailability).toBe(false);
});

it.each([null, undefined])('keeps legacy absent availability %j semantics', available => {
  const input = conn('available', true, null); Object.assign(input, { available });
  expect(classifyPlug(input)).toEqual({ health: 'working-free', planningHealth: 'working-free', contradiction: false });
});

it('keeps positive-status fault-note contradiction uncertain without calling it definitely faulted', () => {
  const input = conn('charging', false, 'Faulted'); Object.assign(input, { available: 'false' });
  expect(classifyPlug(input)).toEqual({ health: 'uncertain', planningHealth: 'uncertain', contradiction: true });
});

it.each([false, true])('keeps valid same-charger connector sibling and counts no false free plug, invalid-first=%s', invalidFirst => {
  const good = conn('charging', false, 'Charging'), bad = conn('available', true, null);
  Object.assign(bad, { available: 'false' });
  const summary = summarizeCcs2(station([{ type: 'DC', kw: 60, price: 20, connectors: invalidFirst ? [bad, good] : [good, bad] }]));
  expect(summary.usable).toBe(1); expect(summary.free).toBe(0); expect(summary.occupied).toBe(1); expect(summary.uncertain).toBe(1);
  expect(summary.maxKw).toBe(60); expect(summary.pricePerKwh).toBe(20);
});

describe('hard maximum charger power', () => {
  it('selects the mixed-site 60 kW CCS2 charger and its own tariff', () => {
    const input = station([
      { type: 'DC', kw: 180, price: 999, connectors: [conn('available', true, null)] },
      { type: 'DC', kw: 60, price: 22, connectors: [conn('charging', false, 'Charging')] },
    ]);
    const chosen = selectedCappedCharger(input, 100);
    expect(chosen).toMatchObject({ chargerId: 1, kw: 60, pricePerKwh: 22 });
    expect(chosen?.name).toBe('c1');
  });
  it('never certifies absent or malformed power against a cap', () => {
    const input = station([{ type: 'DC', kw: 60, price: 20, connectors: [conn('available', true, null)] }]);
    delete (input.chargers[0] as Partial<import('../src/types.js').StatiqCharger>).kw;
    expect(selectedCappedCharger(input, 100)).toBeNull();
  });
  it('keeps an unknown selected tariff separate from a known sibling tariff', () => {
    const input = station([
      { type: 'DC', kw: 180, price: 18, connectors: [conn('available', true, null)] },
      { type: 'DC', kw: 60, price: null, connectors: [conn('available', true, null)] },
    ]);
    const chosen = selectedCappedCharger(input, 100);
    expect(chosen).toMatchObject({ kw: 60, pricePerKwh: null });
  });
  it('preserves the uncapped maximum and tariff', () => {
    const input = station([
      { type: 'DC', kw: 60, price: 22, connectors: [conn('available', true, null)] },
      { type: 'DC', kw: 180, price: 18, connectors: [conn('available', true, null)] },
    ]);
    expect(summarizeCcs2(input).maxKw).toBe(180);
    expect(summarizeCcs2(input).pricePerKwh).toBe(18);
  });
});
