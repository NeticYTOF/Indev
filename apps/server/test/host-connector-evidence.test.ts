import { describe, expect, it } from 'vitest';
import { buildHostStationEvidence } from '../src/host-connector-evidence.js';

const plug = (type: string, status: string, available: unknown, note: string | null) => ({
  type, status, available, note,
});
const response = (chargers: unknown[], ok = true) => ({
  ok, live: true, retained: false, source: 'test',
  station: { stationId: 42, lat: 28.6, lon: 77.2, chargers },
});

describe('private connector evidence', () => {
  it('uses exact clean negation and never retains the note', () => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'DC', kw: 60, pricePerKwh: 20,
      connectors: [plug('CCS-2', 'available', true, 'NoFault')],
    }]), [], true);
    expect(evidence.connectors[0]).toMatchObject({
      health: 'working-free', positiveFaultWord: false, negatedFaultWord: true,
      connectorTypeKind: 'ccs2', availabilityKind: 'true',
    });
    expect(evidence.matchedRule).toBe('certified');
  });

  it('treats a suffixed negation as conservative positive but retains no raw text', () => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'DC', kw: 60, connectors: [plug('CCS-2', 'available', true, 'NoFault SENTINEL_CLEAN')],
    }]), [], true);
    expect(evidence.connectors[0]).toMatchObject({
      health: 'uncertain', positiveFaultWord: true,
    });
    expect(JSON.stringify(evidence)).not.toContain('SENTINEL_CLEAN');
  });

  it('records available-status fault policy exclusions without raw note text', () => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'DC', kw: 60, connectors: [plug('CCS-2', 'available', true, 'SENTINEL_FAULT')],
    }]), ['policy_fault_note'], false, 60);
    expect(evidence.includedPolicyExclusionCount).toBe(1);
    expect(evidence.connectors[0]).toMatchObject({
      health: 'uncertain', planningHealth: 'faulted', contradiction: true,
      policyExclusion: 'positive_fault_with_available_status',
    });
    expect(evidence.matchedRule).toBe('policy_fault_note');
    expect(JSON.stringify(evidence)).not.toContain('SENTINEL_FAULT');
  });

  it('counts within-cap and over-cap chargers independently of plug health', () => {
    const evidence = buildHostStationEvidence(42, response([
      { type: 'DC', kw: 120, connectors: [plug('CCS-2', 'available', true, 'Faulted')] },
      { type: 'DC', kw: 30, connectors: [plug('CCS-2', 'available', true, 'Faulted')] },
    ]), ['no_usable_ccs2'], false, 60);
    expect(evidence).toMatchObject({
      withinCapChargerCount: 1, overCapChargerCount: 1,
      capState: 'some-within-cap', maxObservedCcs2DcKw: 120,
      matchedRule: 'no_usable_ccs2',
    });
  });

  it('does not count AC chargers as CCS2 DC cap evidence', () => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'AC', kw: 120, connectors: [plug('CCS-2', 'available', true, null)],
    }]), [], false, 60);
    expect(evidence).toMatchObject({
      capState: 'no-ccs2-dc', withinCapChargerCount: 0,
      overCapChargerCount: 0, unknownCapChargerCount: 0,
    });
  });

  it('does not call an over-cap charger with unknown-power sibling all-over', () => {
    const evidence = buildHostStationEvidence(42, response([
      { type: 'DC', kw: 120, connectors: [plug('CCS-2', 'available', true, null)] },
      { type: 'DC', kw: null, connectors: [plug('CCS-2', 'available', true, null)] },
    ]), [], false, 60);
    expect(evidence).toMatchObject({
      overCapChargerCount: 1, unknownCapChargerCount: 1,
      capState: 'mixed-over-and-unknown',
    });
  });

  it('reconciles all omitted rows and omits raw text', () => {
    const chargers = Array.from({ length: 10 }, () => ({
      type: 'DC', kw: 60, pricePerKwh: 20,
      connectors: Array.from({ length: 10 }, () => plug('CCS-2', 'available', true, 'RAW_SENTINEL')),
    }));
    const evidence = buildHostStationEvidence(42, response(chargers), [], true);
    expect(evidence).toMatchObject({
      rawChargerCount: 10, rawConnectorCount: 100,
      includedChargerCount: 8, includedConnectorCount: 16,
      omittedChargerCount: 2, omittedConnectorCount: 84,
    });
    expect(JSON.stringify(evidence)).not.toContain('RAW_SENTINEL');
  });

  it('keeps invalid counts exclusive and evidence safe for hostile shapes', () => {
    const evidence = buildHostStationEvidence(42, response([
      null,
      { type: 'DC', kw: 60, connectors: ['bad', plug('CCS-2', 'available', true, null)] },
    ], false), ['not_fresh'], false);
    expect(evidence).toMatchObject({
      evidenceState: 'provenance', reasons: ['not_fresh'], matchedRule: 'not_fresh',
      rawChargerCount: 2, invalidChargerCount: 1, invalidConnectorCount: 1,
      rawConnectorCount: 2, includedChargerCount: 1, omittedChargerCount: 0,
      includedConnectorCount: 1, omittedConnectorCount: 0,
    });
  });

  it('redacts arbitrary reason strings and never infers certification', () => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'DC', kw: 60, connectors: [plug('CCS-2', 'available', true, null)],
    }]), ['ARBITRARY_REASON_SENTINEL'], true);
    expect(evidence.reasons).toEqual(['unknown_diagnostic']);
    expect(evidence.matchedRule).toBe('unknown_diagnostic');
    expect(JSON.stringify(evidence)).not.toContain('ARBITRARY_REASON_SENTINEL');
  });

  it('does not coerce malformed availability before classification', () => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'DC', kw: 60, connectors: [plug('CCS-2', 'available', 'yes', null)],
    }]), [], false);
    expect(evidence.connectors[0]).toMatchObject({
      availabilityKind: 'invalid', health: 'uncertain', contradiction: true,
    });
  });

  it.each([
    ['Default', false, 'working-free'],
    ['NoFault', false, 'working-free'],
    ['No fault', false, 'working-free'],
    ['NoFaultDetected', false, 'working-free'],
    ['No. Faulted', true, 'uncertain'],
    ['No; Faulted', true, 'uncertain'],
    ['Not fault free', true, 'uncertain'],
    ['Faulted Not fault free', true, 'uncertain'],
    ['Faulted', true, 'uncertain'],
  ])('keeps fault flags aligned with health for %s', (note, positive, health) => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'DC', kw: 60, connectors: [plug('CCS-2', 'available', true, note)],
    }]), [], false);
    expect(evidence.connectors[0]).toMatchObject({ positiveFaultWord: positive, health });
  });
});
