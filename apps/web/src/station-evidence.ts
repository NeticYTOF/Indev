/**
 * Shared station-evidence boundary for fresh plans and saved trips.
 *
 * The HTTP station endpoint returns a REDUCED live/mock station view, not the
 * raw provider detail: connector health is already mapped into `plugs`, while
 * the core planner's StationLiveView uses the same plug-health vocabulary.
 * This module normalizes both shapes without mutating either source, keeps
 * planned facts separate from a manually fetched snapshot, and reports
 * absent/malformed evidence as Unknown rather than zero/available/reliable.
 */
import { classifyPlug, type PlanStop } from '@indeev/core';

export type EvidenceNumber = number | null;
export type EvidenceString = string | null;
export type PlugHealthView = 'working-free' | 'working-occupied' | 'finishing' | 'faulted' | 'uncertain' | 'offline' | 'unknown';

export interface StationConnectorEvidence {
  connectorId: EvidenceNumber;
  type: EvidenceString;
  /** Raw provider status where supplied; not invented from plug health. */
  status: EvidenceString;
  note: EvidenceString;
  available: boolean | null;
  health: PlugHealthView;
  contradiction: boolean;
  invalidAvailability: boolean;
}

export interface StationChargerEvidence {
  chargerId: EvidenceNumber;
  name: EvidenceString;
  type: EvidenceString;
  kw: EvidenceNumber;
  pricePerKwh: EvidenceNumber;
  lastUsedOn: EvidenceString;
  connectors: StationConnectorEvidence[];
}

export interface StationCountEvidence {
  total: EvidenceNumber;
  usable: EvidenceNumber;
  free: EvidenceNumber;
  occupied: EvidenceNumber;
  uncertain: EvidenceNumber;
  faulted: EvidenceNumber;
  offline: EvidenceNumber;
}

export interface StationEvidence {
  stationId: EvidenceNumber;
  name: EvidenceString;
  address: EvidenceString;
  city: EvidenceString;
  hours: EvidenceString;
  openText: EvidenceString;
  rating: EvidenceNumber;
  reviewCount: EvidenceNumber;
  /** No provider supplies a verified reliability score; null is intentional. */
  reliability: null;
  fetchedAt: EvidenceString;
  synthetic: boolean;
  sourceKind: 'planned' | 'fetched';
  hasContradiction: boolean;
  maxKw: EvidenceNumber;
  tariffPerKwh: EvidenceNumber;
  counts: StationCountEvidence;
  chargers: StationChargerEvidence[];
  connectorTotal: number;
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): EvidenceString {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function number(value: unknown, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): EvidenceNumber {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function count(value: unknown): EvidenceNumber {
  return number(value, 0);
}

function health(value: unknown): PlugHealthView {
  if (value === 'working-free' || value === 'working-occupied' || value === 'finishing' ||
      value === 'faulted' || value === 'uncertain' || value === 'offline') return value;
  return 'unknown';
}

function contradiction(value: unknown): boolean {
  return value === true;
}

function normalizeConnector(value: unknown, warnings: string[], index: number): StationConnectorEvidence {
  const c = record(value);
  const id = number(c?.connectorId ?? c?.displayId, 1);
  const type = text(c?.type);
  const rawStatus = text(c?.status);
  const note = text(c?.note);
  const available = boolean(c?.available);
  const suppliedHealth = health(c?.health);
  // Planned StationLiveView plugs already carry derived health; raw fetched
  // connectors must go through the same authoritative core classifier.
  const derived = rawStatus == null
    ? null
    : classifyPlug({
      displayId: typeof c?.displayId === 'number' ? c.displayId : (id ?? 0),
      connectorId: typeof c?.connectorId === 'number' ? c.connectorId : (id ?? 0),
      type: type ?? '',
      status: rawStatus,
      available: (c?.available === true || c?.available === false) ? c.available : null,
      note,
    });
  const mappedHealth = suppliedHealth !== 'unknown' ? suppliedHealth : (derived?.health ?? 'unknown');
  const mappedContradiction = suppliedHealth !== 'unknown'
    ? contradiction(c?.contradiction)
    : (derived?.contradiction ?? false);
  if (!c) warnings.push(`Connector ${index} had no usable record.`);
  else if (mappedHealth === 'unknown') {
    warnings.push(`Connector ${index} status is Unknown.`);
  }
  return {
    connectorId: id,
    type,
    status: rawStatus,
    note,
    available,
    health: mappedHealth,
    contradiction: mappedContradiction,
    invalidAvailability: derived?.invalidAvailability === true ||
      (c != null && c.available != null && !Object.is(c.available, available)),
  };
}

function normalizeCharger(value: unknown, warnings: string[], index: number): StationChargerEvidence {
  const ch = record(value);
  const rawConnectors = Array.isArray(ch?.connectors) ? ch!.connectors as unknown[] : [];
  if (!ch) warnings.push(`Charger ${index} had no usable record.`);
  if (ch && !Array.isArray(ch.connectors)) warnings.push(`Charger ${index} connectors are Unknown.`);
  const connectors = rawConnectors.map((connector, connectorIndex) =>
    normalizeConnector(connector, warnings, connectorIndex + 1));
  return {
    chargerId: number(ch?.chargerId, 1),
    name: text(ch?.name),
    type: text(ch?.type),
    kw: number(ch?.kw, 0.000001),
    pricePerKwh: number(ch?.pricePerKwh, 0),
    lastUsedOn: text(ch?.lastUsedOn),
    connectors,
  };
}

function normalizeCounts(value: unknown): StationCountEvidence {
  const c = record(value);
  return {
    total: count(c?.total),
    usable: count(c?.usable),
    free: count(c?.free),
    occupied: count(c?.occupied),
    uncertain: count(c?.uncertain),
    faulted: count(c?.faulted),
    offline: count(c?.offline),
  };
}

function normalizeStation(value: unknown, sourceKind: 'planned' | 'fetched'): StationEvidence {
  const raw = record(value) ?? {};
  const warnings: string[] = [];
  const chargersRaw = Array.isArray(raw.chargers) ? raw.chargers as unknown[] : [];
  if (raw.chargers != null && !Array.isArray(raw.chargers)) warnings.push('Charger list is Unknown.');
  const chargers = chargersRaw.map((charger, index) => normalizeCharger(charger, warnings, index + 1));
  const connectorTotal = chargers.reduce((sum, charger) => sum + charger.connectors.length, 0);
  const ccs2 = record(raw.ccs2);
  const summaryKw = number(ccs2?.maxKw, 0.000001);
  const summaryTariff = number(ccs2?.pricePerKwh, 0);
  // Do not infer aggregate max power/tariff from raw chargers: the server's
  // ccs2 summary pairs the tariff with the selected known-power plug. Raw
  // charger fields remain visible individually below.
  const knownPowerChargers = chargers.filter((charger) => charger.kw != null);
  if (knownPowerChargers.length > 0 && knownPowerChargers.every((charger) => charger.pricePerKwh == null)) {
    warnings.push('Known-power chargers have no numeric tariff; cost is Unknown.');
  }
  if (ccs2 != null && ccs2.hasInvalidUsablePower === true) {
    warnings.push('Usable charger power was malformed; it is Unknown.');
  }
  if (ccs2 != null && ccs2.hasInvalidSelectedTariff === true) {
    warnings.push('Selected charger tariff was malformed; it is Unknown.');
  }
  return {
    stationId: number(raw.stationId, 1),
    name: text(raw.name),
    address: text(raw.address),
    city: text(raw.city),
    hours: text(raw.hours),
    openText: text(raw.openText),
    rating: number(raw.rating, 0, 5),
    reviewCount: count(raw.reviewCount),
    reliability: null,
    fetchedAt: text(raw.fetchedAt),
    synthetic: raw.synthetic === true,
    sourceKind,
    hasContradiction: contradiction(ccs2?.hasContradiction) ||
      chargers.some((charger) => charger.connectors.some((connector) => connector.contradiction)),
    maxKw: summaryKw,
    tariffPerKwh: summaryTariff,
    counts: normalizeCounts(ccs2),
    chargers,
    connectorTotal,
    warnings,
  };
}

/** Normalize the planned station snapshot stored on a TripPlan/PlanStop. */
export function normalizePlannedStation(station: PlanStop['station']): StationEvidence {
  return normalizeStation(station, 'planned');
}

/**
 * Normalize an endpoint JSON body. The endpoint contract is `{ station }`;
 * every field is treated as untrusted because HTTP responses can be stale,
 * malformed, or replaced in tests/proxies.
 */
export function normalizeFetchedStationResponse(body: unknown): StationEvidence | null {
  const raw = record(body);
  if (!raw || !('station' in raw)) return null;
  return normalizeStation(raw.station, 'fetched');
}

export function stationMatchesId(evidence: StationEvidence, stationId: number): boolean {
  return Number.isSafeInteger(stationId) && stationId > 0 && evidence.stationId === stationId;
}

/** Display helper: Unknown is a distinct state, never zero or "available". */
export function displayEvidence(value: EvidenceNumber | EvidenceString | undefined, suffix = ''): string {
  if (value == null) return 'Unknown';
  return `${value}${suffix}`;
}

export function plugHealthLabel(value: PlugHealthView): string {
  switch (value) {
    case 'working-free': return 'Working · free';
    case 'working-occupied': return 'Working · occupied';
    case 'finishing': return 'Finishing';
    case 'faulted': return 'Faulted';
    case 'uncertain': return 'Uncertain';
    case 'offline': return 'Offline';
    default: return 'Unknown';
  }
}
