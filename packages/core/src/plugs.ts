/**
 * Plug health classification.
 *
 * Rules (from the spec, validated against observed Statiq data):
 * - Explicitly faulted plugs are excluded from planning.
 * - Working CCS2 plugs that are occupied are KEPT as options.
 * - When status and fault text contradict each other, the plug is
 *   "uncertain": never counted as working, and the UI shows uncertainty.
 * - Unknown vocabulary falls back to uncertain (never "working").
 */
import type { PlugHealth, StatiqCharger, StatiqConnector, StatiqStationDetail } from './types.js';
import type { ChargerView, PlanSelectedCharger } from './plan-types.js';
import { classifyPlugValues, connectorSlug as slug, type PlugClassification } from './plug-classifier.js';

export type { PlugClassification } from './plug-classifier.js';

const norm = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const USABLE: readonly PlugHealth[] = ['working-free', 'working-occupied', 'finishing'];

export function classifyPlug(c: StatiqConnector): PlugClassification {
  return classifyPlugValues({
    status: c.status,
    available: c.available,
    note: c.note,
  });
}

/** Normalize connector type: CCS-2, CCS2, ccs-2 all -> 'ccs2'. */
export function connectorSlug(type: string): string {
  return slug(type);
}

/** Is this connector a DC CCS2 plug (the Harrier EV's fast-charge standard)? */
export function isCcs2Dc(charger: StatiqCharger, connector: StatiqConnector): boolean {
  return norm(charger.type) === 'dc' && connectorSlug(connector.type) === 'ccs2';
}

export interface Ccs2Summary {
  total: number;
  usable: number;
  free: number;
  occupied: number;
  uncertain: number;
  faulted: number;
  offline: number;
  maxKw: number | null;
  pricePerKwh: number | null;
  /** Numeric evidence is independent of connector health/availability. */
  hasInvalidUsablePower: boolean;
  hasInvalidUsableAvailability: boolean;
  hasMissingUsablePower: boolean;
  hasInvalidSelectedTariff: boolean;
  /** Any status/fault contradictions among CCS2 DC plugs (UI shows uncertainty). */
  hasContradiction: boolean;
  /** Exists at least one usable CCS2 DC plug. */
  isUsable: boolean;
}

/** Summarize a station's CCS2 DC plugs for planning and UI. */
export function summarizeCcs2(station: StatiqStationDetail): Ccs2Summary {
  const s: Ccs2Summary = {
    total: 0,
    usable: 0,
    free: 0,
    occupied: 0,
    uncertain: 0,
    faulted: 0,
    offline: 0,
    maxKw: null,
    pricePerKwh: null,
    hasInvalidUsablePower: false,
    hasInvalidUsableAvailability: false,
    hasMissingUsablePower: false,
    hasInvalidSelectedTariff: false,
    hasContradiction: false,
    isUsable: false,
  };
  for (const ch of station.chargers ?? []) {
    for (const c of ch.connectors ?? []) {
      if (!isCcs2Dc(ch, c)) continue;
      s.total++;
      const { health, contradiction, invalidAvailability } = classifyPlug(c);
      if (invalidAvailability) s.hasInvalidUsableAvailability = true;
      if (contradiction) s.hasContradiction = true;
      switch (health) {
        case 'working-free':
          s.free++;
          break;
        case 'working-occupied':
          s.occupied++;
          break;
        case 'finishing':
          s.free++; // finishing wraps up; free shortly
          break;
        case 'uncertain':
          s.uncertain++;
          break;
        case 'faulted':
          s.faulted++;
          break;
        case 'offline':
          s.offline++;
          break;
      }
      if (USABLE.includes(health)) {
        s.usable++;
        if (ch.kw == null) {
          s.hasMissingUsablePower = true;
        } else if (typeof ch.kw !== 'number' || !Number.isFinite(ch.kw) || ch.kw <= 0) {
          s.hasInvalidUsablePower = true;
        } else if (s.maxKw == null || ch.kw > s.maxKw) {
          // Keep the tariff paired with this known-power charger. Do not
          // borrow a sibling's price or turn unknown into free charging.
          s.maxKw = ch.kw;
          const validTariff = typeof ch.pricePerKwh === 'number' && Number.isFinite(ch.pricePerKwh) && ch.pricePerKwh >= 0;
          s.pricePerKwh = validTariff ? ch.pricePerKwh : null;
          s.hasInvalidSelectedTariff = ch.pricePerKwh != null && !validTariff;
        }
      }
    }
  }
  s.isUsable = s.usable > 0;
  return s;
}

/** Select the fastest usable CCS2 DC charger known to satisfy a hard kW cap. */
export type CappedChargerCertification =
  | { status: 'selected'; selected: PlanSelectedCharger }
  | { status: 'policy-ineligible' | 'incomplete'; selected: null };
export function selectedCappedCharger(
  station: StatiqStationDetail,
  maxChargerKw: number,
): PlanSelectedCharger | null {
  const certified = certifyCappedCharger(station, maxChargerKw);
  return certified.status === 'selected' ? certified.selected : null;
}
interface CertifiedChargerEvidence {
  chargerId: number;
  name: string;
  type: string;
  kw: number;
  pricePerKwh: number | null;
  connectors: ReadonlyArray<{ type: string; health: PlugHealth; contradiction: boolean }>;
}
function certifyEvidence(
  chargers: readonly CertifiedChargerEvidence[],
  maxChargerKw: number,
): CappedChargerCertification {
  let best: PlanSelectedCharger | null = null;
  let incomplete = false;
  for (const ch of chargers) {
    const usableConnector = norm(ch.type) === 'dc' &&
      ch.connectors.some(c => connectorSlug(c.type) === 'ccs2' && !c.contradiction && USABLE.includes(c.health));
    if (!usableConnector) continue;
    if (typeof ch.kw !== 'number' || !Number.isFinite(ch.kw) || ch.kw <= 0) { incomplete = true; continue; }
    if (ch.kw > maxChargerKw) continue;
    const tariff = ch.pricePerKwh;
    const pricePerKwh = typeof tariff === 'number' && Number.isFinite(tariff) && tariff >= 0 ? tariff : null;
    const candidate = { chargerId: ch.chargerId, name: ch.name, kw: ch.kw, pricePerKwh };
    if (!best || candidate.kw > best.kw ||
        (candidate.kw === best.kw && candidate.chargerId < best.chargerId)) best = candidate;
  }
  if (best) return { status: 'selected', selected: best };
  return { status: incomplete ? 'incomplete' : 'policy-ineligible', selected: null };
}
export function certifyCappedCharger(
  station: StatiqStationDetail,
  maxChargerKw: number,
): CappedChargerCertification {
  const evidence: CertifiedChargerEvidence[] = (station.chargers ?? []).map(ch => ({
    chargerId: ch.chargerId, name: ch.name, type: ch.type, kw: ch.kw, pricePerKwh: ch.pricePerKwh,
    connectors: (ch.connectors ?? []).map(c => ({
      type: c.type, health: classifyPlug(c).health, contradiction: classifyPlug(c).contradiction,
    })),
  }));
  return certifyEvidence(evidence, maxChargerKw);
}
export function certifyCappedViewChargers(
  chargers: readonly ChargerView[],
  maxChargerKw: number,
): CappedChargerCertification {
  return certifyEvidence(chargers.map(ch => ({
    chargerId: ch.chargerId, name: ch.name, type: ch.type, kw: ch.kw, pricePerKwh: ch.pricePerKwh,
    connectors: ch.plugs.map(p => ({ type: p.type, health: p.health, contradiction: p.contradiction })),
  })), maxChargerKw);
}
