/** Coarse power observations only. Never eligibility, health, or availability. */
import { CONNECTOR_EVIDENCE_VERSION, type HostStationEvidence } from './host-connector-evidence.js';

export type ObservedPowerCategory =
  | 'some-within' | 'all-over' | 'mixed-over-unknown'
  | 'all-unknown' | 'no-dc-ccs2' | 'unknown';

export interface ObservedPower {
  capKw: number | null;
  withinCapChargerCount: number;
  overCapChargerCount: number;
  unknownCapChargerCount: number;
  category: ObservedPowerCategory;
  advisoryOnly: true;
  note: string;
}
const UNSAFE_REASONS: Record<string, true> = {
  not_fresh: true, identity_mismatch: true, missing_evidence: true,
  schema_invalid: true, invalid_cap: true, evidence_failure: true,
  unknown_diagnostic: true,
};
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

const UNKNOWN: ObservedPower = {
  capKw: null, withinCapChargerCount: 0, overCapChargerCount: 0,
  unknownCapChargerCount: 0, category: 'unknown', advisoryOnly: true,
  note: 'Observed power only; not eligibility or certification.',
};
export function observedPowerFromEvidence(value: unknown, reasons: readonly string[] = []): ObservedPower {
  try {
    if (reasons.some((r) => typeof r === 'string' && UNSAFE_REASONS[r] === true)) return UNKNOWN;
    const e = value as Partial<HostStationEvidence> | null;
    if (e == null || typeof e !== 'object' || e.version !== CONNECTOR_EVIDENCE_VERSION ||
        e.evidenceState !== 'ok') return UNKNOWN;
    const allReasons = [...reasons,
      ...(Array.isArray(e.reasons) ? e.reasons.filter((r): r is string => typeof r === 'string') : [])];
    if (allReasons.some((r) => UNSAFE_REASONS[r] === true)) return UNKNOWN;
    if (e.capKw !== null && !(typeof e.capKw === 'number' && Number.isFinite(e.capKw) && e.capKw > 0)) {
      return UNKNOWN;
    }
    const within = count(e.withinCapChargerCount);
    const over = count(e.overCapChargerCount);
    const unknown = count(e.unknownCapChargerCount);
    const rawChargers = count(e.rawChargerCount);
    const rawConnectors = count(e.rawConnectorCount);
    const invalidChargers = count(e.invalidChargerCount);
    const invalidConnectors = count(e.invalidConnectorCount);
    if ([within, over, unknown, rawChargers, rawConnectors, invalidChargers, invalidConnectors]
      .some((v) => v === null)) return UNKNOWN;
    if (invalidChargers !== 0 || invalidConnectors !== 0) return UNKNOWN;
    const total = (within as number) + (over as number) + (unknown as number);
    if (total > (rawChargers as number) || total > (rawConnectors as number)) return UNKNOWN;
    const category: ObservedPowerCategory = (within as number) > 0 ? 'some-within'
      : (over as number) > 0 && (unknown as number) > 0 ? 'mixed-over-unknown'
        : (over as number) > 0 ? 'all-over'
          : (unknown as number) > 0 ? 'all-unknown'
            : (rawChargers as number) > 0 && (rawConnectors as number) > 0 ? 'no-dc-ccs2' : 'unknown';
    return {
      capKw: e.capKw ?? null,
      withinCapChargerCount: within as number,
      overCapChargerCount: over as number,
      unknownCapChargerCount: unknown as number,
      category, advisoryOnly: true, note: UNKNOWN.note,
    };
  } catch {
    return UNKNOWN;
  }
}
