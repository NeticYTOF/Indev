/** Host-only structured connector evidence. Never sent to AI or HTTP. */
import { classifyPlugValues, type PlugClassification, type PlugHealth } from '@indeev/core';

export const CONNECTOR_EVIDENCE_VERSION = 'connector-evidence-v2/fault-phrases-v1';
const CHARGER_LIMIT = 8;
const CONNECTOR_LIMIT = 8;
const ROW_LIMIT = 16;
const DEFAULT_WORDS: Record<string, true> = { default: true, defaults: true };
const CLEAN_NEGATIONS: Record<string, true> = {
  'no fault': true, nofault: true, 'no faults': true, nofaults: true,
  'no fault detected': true, nofaultdetected: true,
  'no fault found': true, nofaultfound: true,
  'not faulted': true, notfaulted: true,
};
const ALLOWED_REASONS: Record<string, true> = {
  invalid_cap: true, not_fresh: true, identity_mismatch: true, missing_evidence: true,
  schema_invalid: true, no_dc_charger: true, no_ccs2_connector: true,
  no_usable_ccs2: true, unknown_power: true, not_within_cap: true,
  policy_fault_note: true,
  evidence_failure: true,
  unknown_diagnostic: true,
};

type Kind = 'dc' | 'ac' | 'other' | 'unknown';
interface Row {
  chargerIndex: number; connectorIndex: number;
  chargerTypeKind: Kind; connectorTypeKind: 'ccs2' | 'other' | 'unknown';
  powerState: number | 'absent' | 'invalid' | 'nonpositive';
  priceState: 'valid' | 'absent' | 'invalid';
  statusKind: 'available' | 'charging' | 'preparing' | 'finishing' | 'faulted' | 'offline' | 'unavailable' | 'unknown';
  availabilityKind: 'true' | 'false' | 'absent' | 'invalid';
  health: PlugHealth; contradiction: boolean;
  planningHealth: PlugHealth;
  positiveFaultWord: boolean; negatedFaultWord: boolean; disconnectFlag: boolean;
  policyExclusion?: PlugClassification['policyExclusion'];
}
export interface HostStationEvidence {
  version: string; stationId: number | null; reasons: string[]; matchedRule: string;
  evidenceState: 'ok' | 'provenance' | 'missing' | 'invalid';
  rawChargerCount: number; rawConnectorCount: number;
  includedChargerCount: number; includedConnectorCount: number;
  omittedChargerCount: number; omittedConnectorCount: number;
  invalidChargerCount: number; invalidConnectorCount: number;
  capKw: number | null; maxObservedCcs2DcKw: number | null;
  capState: 'some-within-cap' | 'all-over-cap' | 'mixed-over-and-unknown' | 'all-unknown-power' | 'no-ccs2-dc' | 'invalid-cap';
  withinCapChargerCount: number; overCapChargerCount: number; unknownCapChargerCount: number;
  /** Counts bounded included rows only; omitted rows may also carry policy exclusions. */
  includedPolicyExclusionCount: number;
  connectors: Row[];
}

const record = (v: unknown): Record<string, unknown> | null =>
  v != null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string => typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : '';
const slug = (v: unknown): string => text(v).replace(/[^a-z0-9]/g, '');
const field = (o: Record<string, unknown>, k: string): unknown => o[k];
const array = (o: Record<string, unknown>, k: string): unknown[] | null =>
  Array.isArray(field(o, k)) ? field(o, k) as unknown[] : null;
function chargerKind(v: unknown): Kind {
  const s = slug(v);
  return s === 'dc' || s === 'ac' ? s : s.length > 0 ? 'other' : 'unknown';
}
function statusKind(v: unknown): Row['statusKind'] {
  const s = slug(v);
  const known: Row['statusKind'][] = ['available', 'charging', 'preparing', 'finishing', 'faulted', 'offline', 'unavailable'];
  return known.find((k) => k === s) ?? 'unknown';
}
function powerState(v: unknown): Row['powerState'] {
  if (v == null) return 'absent';
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'invalid';
  return v > 0 ? v : 'nonpositive';
}
function faultFlags(v: unknown): { positive: boolean; negated: boolean } {
  const clean = text(v);
  const negated = CLEAN_NEGATIONS[clean] === true;
  const positive = !negated && (clean.match(/[a-z0-9]+/g) ?? [])
    .some((token) => DEFAULT_WORDS[token] !== true && /fault/.test(token));
  return { positive, negated };
}
function capEvidence(chargers: readonly { charger: Record<string, unknown>; plugs: unknown[] }[], capKw: number | undefined) {
  const base = { capKw: capKw ?? null, maxObservedCcs2DcKw: null as number | null,
    withinCapChargerCount: 0, overCapChargerCount: 0, unknownCapChargerCount: 0 };
  if (capKw !== undefined && !(typeof capKw === 'number' && Number.isFinite(capKw) && capKw > 0)) {
    return { ...base, capKw: null, capState: 'invalid-cap' as const };
  }
  for (const { charger, plugs } of chargers) {
    if (chargerKind(field(charger, 'type')) !== 'dc') continue;
    if (!plugs.some((p) => slug(field(record(p) ?? {}, 'type')) === 'ccs2')) continue;
    const power = powerState(field(charger, 'kw'));
    if (typeof power !== 'number') { base.unknownCapChargerCount += 1; continue; }
    base.maxObservedCcs2DcKw = base.maxObservedCcs2DcKw === null
      ? power : Math.max(base.maxObservedCcs2DcKw, power);
    if (capKw === undefined || power <= capKw) base.withinCapChargerCount += 1;
    else base.overCapChargerCount += 1;
  }
  const total = base.withinCapChargerCount + base.overCapChargerCount + base.unknownCapChargerCount;
  const capState: HostStationEvidence['capState'] = total === 0 ? 'no-ccs2-dc'
    : base.withinCapChargerCount > 0 ? 'some-within-cap'
      : base.overCapChargerCount > 0 && base.unknownCapChargerCount > 0 ? 'mixed-over-and-unknown'
        : base.overCapChargerCount > 0 ? 'all-over-cap' : 'all-unknown-power';
  return { ...base, capState };
}

function buildEvidence(
  stationId: number, response: { ok?: unknown; station?: unknown } | null | undefined,
  reasons: readonly string[], certified: boolean, maxChargerKw?: number,
): HostStationEvidence {
  const responseObj = record(response);
  const station = responseObj === null ? null : record(field(responseObj, 'station'));
  const chargers = station === null ? [] : array(station, 'chargers') ?? [];
  const valid: Array<{ index: number; charger: Record<string, unknown>; plugs: unknown[] }> = [];
  let rawConnectorCount = 0;
  let invalidChargerCount = 0;
  let invalidConnectorCount = 0;
  for (let i = 0; i < chargers.length; i += 1) {
    const charger = record(chargers[i]);
    const plugs = charger === null ? null : array(charger, 'connectors');
    if (charger === null || plugs === null) { invalidChargerCount += 1; continue; }
    valid.push({ index: i, charger, plugs });
    rawConnectorCount += plugs.length;
    for (const plug of plugs) if (record(plug) === null) invalidConnectorCount += 1;
  }
  const includedChargers = valid.slice(0, CHARGER_LIMIT);
  const connectors: Row[] = [];
  for (const { index, charger, plugs } of includedChargers) {
    const room = ROW_LIMIT - connectors.length;
    for (let j = 0; j < Math.min(plugs.length, CONNECTOR_LIMIT, room); j += 1) {
      const plug = record(plugs[j]);
      if (plug === null) continue;
      const statusRaw = field(plug, 'status');
      const noteRaw = field(plug, 'note');
      const status = typeof statusRaw === 'string' ? statusRaw : '';
      const note = typeof noteRaw === 'string' ? noteRaw : null;
      const noteFault = faultFlags(note);
      const statusFault = faultFlags(status);
      const available = field(plug, 'available');
      const priceRaw = field(charger, 'pricePerKwh');
      const priceValid = typeof priceRaw === 'number' && Number.isFinite(priceRaw) && priceRaw >= 0;
      const noteSlug = slug(note);
      const statusSlug = slug(status);
      const cls = classifyPlugValues({
        status, available, ...(note === null ? {} : { note }),
      });
      connectors.push({
        chargerIndex: index, connectorIndex: j,
        chargerTypeKind: chargerKind(field(charger, 'type')),
        connectorTypeKind: slug(field(plug, 'type')) === 'ccs2' ? 'ccs2'
          : slug(field(plug, 'type')).length > 0 ? 'other' : 'unknown',
        powerState: powerState(field(charger, 'kw')),
        priceState: priceRaw == null ? 'absent' : priceValid ? 'valid' : 'invalid',
        statusKind: statusKind(status),
        availabilityKind: available == null ? 'absent'
          : typeof available === 'boolean' ? available ? 'true' : 'false' : 'invalid',
        health: cls.health, planningHealth: cls.planningHealth, contradiction: cls.contradiction,
        policyExclusion: cls.policyExclusion,
        positiveFaultWord: noteFault.positive || statusFault.positive,
        negatedFaultWord: noteFault.negated || statusFault.negated,
        disconnectFlag: /disconnect|offline/.test(noteSlug) || /unavailable|offline/.test(statusSlug),
      });
    }
  }
  const filteredReasons = reasons.filter((r): r is string => typeof r === 'string' && ALLOWED_REASONS[r] === true);
  const hasUnknownReason = reasons.some((r) => typeof r === 'string' && ALLOWED_REASONS[r] !== true);
  const safeReasons = [...new Set(hasUnknownReason ? [...filteredReasons, 'unknown_diagnostic'] : filteredReasons)]
    .slice(0, 8);
  const evidenceState = response?.ok !== true ? 'provenance' : station === null || chargers.length === 0
    ? 'missing' : invalidChargerCount > 0 || invalidConnectorCount > 0 ? 'invalid' : 'ok';
  return {
    version: CONNECTOR_EVIDENCE_VERSION, stationId, reasons: safeReasons,
    matchedRule: safeReasons[0] ?? (certified === true ? 'certified' : 'not_evaluated'), evidenceState,
    rawChargerCount: chargers.length, rawConnectorCount,
    includedChargerCount: includedChargers.length, includedConnectorCount: connectors.length,
    omittedChargerCount: chargers.length - invalidChargerCount - includedChargers.length,
    omittedConnectorCount: Math.max(0, rawConnectorCount - invalidConnectorCount - connectors.length),
    invalidChargerCount, invalidConnectorCount,
    includedPolicyExclusionCount: connectors.filter((row) => row.policyExclusion !== undefined).length,
    ...capEvidence(valid, maxChargerKw), connectors,
  };
}

/** Diagnostics must never affect planning; all failures collapse to safe counts. */
export function buildHostStationEvidence(
  stationId: number, response: { ok?: unknown; station?: unknown } | null | undefined,
  reasons: readonly string[], certified: boolean, maxChargerKw?: number,
): HostStationEvidence {
  try {
    return buildEvidence(stationId, response, reasons, certified, maxChargerKw);
  } catch {
    return buildEvidence(stationId, { ok: true, station: { chargers: [] } }, ['evidence_failure'], false, maxChargerKw);
  }
}
