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

export interface PlugClassification {
  health: PlugHealth;
  /** status and fault/availability signals disagree */
  contradiction: boolean;
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const USABLE: readonly PlugHealth[] = ['working-free', 'working-occupied', 'finishing'];

export function classifyPlug(c: StatiqConnector): PlugClassification {
  const status = norm(c.status);
  const note = norm(c.note ?? '');
  const available = c.available;
  const isUnavailable = status.includes('unavailable');
  const positiveStatus =
    !isUnavailable && /^(available|charging|preparing|finishing)$/.test(status);
  const faultInStatus = status.includes('fault');
  const faultInNote = note.includes('fault'); // fault text
  const disconnectText = /disconnect|offline/.test(note) || /unavailable|offline/.test(status);

  // Fault text contradicting a positive status -> uncertain, never "working".
  if (faultInNote && positiveStatus) {
    return { health: 'uncertain', contradiction: true };
  }

  // Explicit fault in status (note, if present, agrees or is disconnected).
  if (faultInStatus) {
    return { health: 'faulted', contradiction: false };
  }
  if (faultInNote) {
    return { health: 'faulted', contradiction: false };
  }

  // Explicitly unavailable / disconnected without fault text -> offline.
  if (isUnavailable || status.includes('offline')) {
    return { health: 'offline', contradiction: false };
  }

  // Occupied but working.
  if (status === 'charging') {
    if (disconnectText) return { health: 'uncertain', contradiction: true };
    return { health: 'working-occupied', contradiction: false };
  }

  if (note.includes('finish') && disconnectText) {
    return { health: 'uncertain', contradiction: true };
  }

  if (status === 'finishing') {
    if (disconnectText) return { health: 'uncertain', contradiction: true };
    return { health: 'finishing', contradiction: false };
  }

  if (status === 'preparing') {
    if (available === false || disconnectText) {
      return { health: 'uncertain', contradiction: true };
    }
    return { health: 'working-free', contradiction: false };
  }

  if (status === 'available') {
    if (note.includes('charging') && available !== true) {
      return { health: 'working-occupied', contradiction: false };
    }
    if (available === false && disconnectText) {
      return { health: 'uncertain', contradiction: true };
    }
    if (available === false) {
      return { health: 'uncertain', contradiction: true };
    }
    if (disconnectText) {
      return { health: 'uncertain', contradiction: true };
    }
    return { health: 'working-free', contradiction: false };
  }

  if (disconnectText || status.includes('unavailable')) {
    return { health: 'offline', contradiction: false };
  }

  // Unknown vocabulary: never call it working.
  return { health: 'uncertain', contradiction: true };
}

/** Normalize connector type: CCS-2, CCS2, ccs-2 all -> 'ccs2'. */
export function connectorSlug(type: string): string {
  return norm(type);
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
    hasMissingUsablePower: false,
    hasInvalidSelectedTariff: false,
    hasContradiction: false,
    isUsable: false,
  };
  for (const ch of station.chargers ?? []) {
    for (const c of ch.connectors ?? []) {
      if (!isCcs2Dc(ch, c)) continue;
      s.total++;
      const { health, contradiction } = classifyPlug(c);
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
