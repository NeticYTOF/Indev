import { describe, expect, it } from 'vitest';
import { CONNECTOR_EVIDENCE_VERSION, buildHostStationEvidence } from '../src/host-connector-evidence.js';
import { observedPowerFromEvidence } from '../src/observed-power.js';

const response = (chargers: unknown[], ok = true) => ({
  ok, live: true, retained: false, source: 'test',
  station: { stationId: 42, chargers },
});
const dc = (kw: unknown, note: string | null = null) => ({
  type: 'DC', kw, pricePerKwh: 20,
  connectors: [{ type: 'CCS-2', status: 'available', available: true, note }],
});
const CAVEAT = 'Observed power only; not eligibility or certification.';

describe('power-only observation projection', () => {
  it('reports mixed 30/120 kW counts without calling it all-over', () => {
    const evidence = buildHostStationEvidence(42,
      response([dc(120, 'PRIVATE_NOTE'), dc(30)]), [], false, 60);
    expect(observedPowerFromEvidence(evidence)).toEqual({
      capKw: 60, withinCapChargerCount: 1, overCapChargerCount: 1,
      unknownCapChargerCount: 0, category: 'some-within',
      advisoryOnly: true, note: CAVEAT,
    });
  });

  it('derives category from counts even when capState is incoherent', () => {
    const evidence = {
      version: CONNECTOR_EVIDENCE_VERSION, evidenceState: 'ok', capKw: 60,
      withinCapChargerCount: 1, overCapChargerCount: 0, unknownCapChargerCount: 0,
      rawChargerCount: 1, rawConnectorCount: 1,
      invalidChargerCount: 0, invalidConnectorCount: 0, capState: 'all-over-cap',
    };
    expect(observedPowerFromEvidence(evidence).category).toBe('some-within');
  });

  it('reports over-cap plus unknown power as mixed', () => {
    const evidence = buildHostStationEvidence(42,
      response([dc(120), dc(null)]), [], false, 60);
    expect(observedPowerFromEvidence(evidence)).toMatchObject({
      overCapChargerCount: 1, unknownCapChargerCount: 1,
      category: 'mixed-over-unknown',
    });
  });

  it('reports no DC-CCS2 evidence distinctly for a valid station', () => {
    const evidence = buildHostStationEvidence(42, response([{
      type: 'AC', kw: 60,
      connectors: [{ type: 'Type-2', status: 'available', available: true, note: 'PRIVATE_NOTE' }],
    }]), [], false, 60);
    expect(observedPowerFromEvidence(evidence).category).toBe('no-dc-ccs2');
  });

  it('fails closed for missing, nonfresh, identity, and invalid-shape evidence', () => {
    const missing = buildHostStationEvidence(42, null, [], false, 60);
    expect(observedPowerFromEvidence(missing).category).toBe('unknown');
    const nonfresh = buildHostStationEvidence(42, response([dc(30)], false), [], false, 60);
    expect(observedPowerFromEvidence(nonfresh, ['not_fresh']).category).toBe('unknown');
    const identity = buildHostStationEvidence(42, response([dc(30)]), ['identity_mismatch'], false, 60);
    expect(observedPowerFromEvidence(identity, ['identity_mismatch']).category).toBe('unknown');
    const invalid = buildHostStationEvidence(42, response([null]), ['schema_invalid'], false, 60);
    expect(observedPowerFromEvidence({
      version: CONNECTOR_EVIDENCE_VERSION, evidenceState: 'ok', capKw: 60,
      withinCapChargerCount: 2, overCapChargerCount: 0, unknownCapChargerCount: 0,
      rawChargerCount: 1, rawConnectorCount: 5,
      invalidChargerCount: 0, invalidConnectorCount: 0,
    }).category).toBe('unknown');
    expect(observedPowerFromEvidence(invalid, ['schema_invalid']).category).toBe('unknown');
  });

  it('rejects incoherent counts, infinite caps, and hostile getters', () => {
    expect(observedPowerFromEvidence({
      version: CONNECTOR_EVIDENCE_VERSION, evidenceState: 'ok', capKw: Infinity,
      withinCapChargerCount: 1, overCapChargerCount: 0, unknownCapChargerCount: 0,
      rawChargerCount: 1, rawConnectorCount: 1, invalidChargerCount: 0, invalidConnectorCount: 0,
    }).category).toBe('unknown');
    expect(observedPowerFromEvidence({
      version: CONNECTOR_EVIDENCE_VERSION, evidenceState: 'ok', capKw: 60,
      withinCapChargerCount: -1, overCapChargerCount: 0, unknownCapChargerCount: 0,
      rawChargerCount: 1, rawConnectorCount: 1, invalidChargerCount: 0, invalidConnectorCount: 0,
    }).category).toBe('unknown');
    expect(observedPowerFromEvidence({
      get version() { throw new Error('hostile'); },
    }).category).toBe('unknown');
  });

  it('exposes no health, status, note text, address, or private-observer fields', () => {
    const evidence = buildHostStationEvidence(42,
      response([dc(120, 'UNIQUE_PRIVATE_SENTINEL')]), [], false, 60);
    const text = JSON.stringify(observedPowerFromEvidence(evidence));
    expect(text).not.toMatch(/UNIQUE_PRIVATE_SENTINEL|health|status|available|occupied|charging|address|connector|evidenceState|matchedRule/i);
    expect(text).toContain('advisoryOnly');
  });
});
