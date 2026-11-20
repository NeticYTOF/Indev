/**
 * Shared station-evidence boundary for fresh plans and saved trips.
 *
 * The HTTP station endpoint returns a REDUCED live/mock station view, not the
 * raw provider detail: live connectors carry raw status/availability/note,
 * while the planned station uses already-derived plug health. This module
 * normalizes both shapes without mutating either source, keeps planned facts
 * separate from a manually fetched snapshot, and reports absent/malformed
 * evidence as Unknown rather than zero/available/reliable.
 */
import { classifyPlug, type PlanStop } from '@indeev/core';

export type EvidenceNumber = number | null;
export type EvidenceString = string | null;
export type PlugHealthView = 'working-free' | 'working-occupied' | 'finishing' | 'faulted' | 'uncertain' | 'offline' | 'unknown';
export type EvidenceProvenance = 'fresh' | 'retained' | 'unknown';

export interface StationConnectorEvidence {
  connectorId: EvidenceNumber;
  type: EvidenceString;
  /** Raw provider status where supplied; not invented from plug health. */
  status: EvidenceString;
  note: EvidenceString;
  /** Only an actual boolean is trusted; malformed input is marked separately. */
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
  provenance: EvidenceProvenance;
  synthetic: boolean;
  sourceKind: 'planned' | 'fetched';
  hasContradiction: boolean;
  maxKw: EvidenceNumber;
  tariffPerKwh: EvidenceNumber;
  counts: StationCountEvidence;
  chargers: StationChargerEvidence[];
  /** Missing evidence differs from an explicitly returned empty list. */
  chargersMissing: boolean;
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

function count(value: unknown): EvidenceNumber {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function suppliedHealth(value: unknown): PlugHealthView {
  if (value === 'working-free' || value === 'working-occupied' || value === 'finishing' ||
      value === 'faulted' || value === 'uncertain' || value === 'offline') return value;
  return 'unknown';
}

function validFetchedAt(value: unknown): EvidenceString {
  const raw = text(value);
  if (raw == null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? raw : null;
}

function normalizeConnector(
  value: unknown,
  warnings: string[],
  index: number,
  sourceKind: 'planned' | 'fetched',
): StationConnectorEvidence {
  const c = record(value);
  const id = number(c?.connectorId ?? c?.displayId, 1);
  const type = text(c?.type);
  const rawStatus = text(c?.status);
  const note = text(c?.note);
  const available = boolean(c?.available);
  // Planned StationLiveView plugs already carry derived health. Fetched
  // connectors MUST use the raw status/availability through the authoritative
  // classifier; a supplied `health` label is untrusted metadata there.
  const plannedHealth = sourceKind === 'planned' ? suppliedHealth(c?.health) : 'unknown';
  const rawAvailablePresent = c != null && Object.prototype.hasOwnProperty.call(c, 'available') && c.available != null;
  const invalidAvailability = rawAvailablePresent && !Object.is(c?.available, available);
  const derived = sourceKind === 'fetched' || plannedHealth === 'unknown'
    ? classifyPlug({
      displayId: typeof c?.displayId === 'number' ? c.displayId : (id ?? 0),
      connectorId: typeof c?.connectorId === 'number' ? c.connectorId : (id ?? 0),
      type: type ?? '',
      status: rawStatus ?? '',
      // Deliberately pass the raw untrusted value: classifyPlug rejects
      // present non-boolean availability as uncertain/contradictory.
      available: (rawAvailablePresent ? c?.available : null) as boolean | null,
      note,
    })
    : null;
  const health = plannedHealth !== 'unknown'
    ? plannedHealth
    : rawStatus == null
      ? 'unknown'
      : (derived?.health ?? 'unknown');
  const contradiction = plannedHealth !== 'unknown'
    ? c?.contradiction === true
    : (derived?.contradiction ?? false);
  if (!c) warnings.push(`Connector ${index} had no usable record.`);
  else if (health === 'unknown') warnings.push(`Connector ${index} status is Unknown.`);
  if (sourceKind === 'fetched' && c?.health != null && c.health !== health) {
    warnings.push(`Connector ${index} supplied a health label that conflicts with its status; status was used.`);
  }
  return {
    connectorId: id,
    type,
    status: rawStatus,
    note,
    available,
    health,
    contradiction,
    invalidAvailability: derived?.invalidAvailability === true || invalidAvailability,
  };
}

function normalizeCharger(
  value: unknown,
  warnings: string[],
  index: number,
  sourceKind: 'planned' | 'fetched',
): StationChargerEvidence {
  const ch = record(value);
  const rawConnectors = Array.isArray(ch?.connectors)
    ? ch!.connectors as unknown[]
    : Array.isArray(ch?.plugs)
      ? ch!.plugs as unknown[]
      : null;
  if (!ch) warnings.push(`Charger ${index} had no usable record.`);
  if (ch && rawConnectors == null) warnings.push(`Charger ${index} connectors are Unknown.`);
  const connectors = (rawConnectors ?? []).map((connector, connectorIndex) =>
    normalizeConnector(connector, warnings, connectorIndex + 1, sourceKind));
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
  const chargersMissing = !Array.isArray(raw.chargers);
  const chargersRaw = chargersMissing ? [] : raw.chargers as unknown[];
  if (chargersMissing) warnings.push('Charger list is Unknown.');
  const chargers = chargersRaw.map((charger, index) => normalizeCharger(charger, warnings, index + 1, sourceKind));
  const ccs2 = record(raw.ccs2);
  const fetchedAt = sourceKind === 'fetched' ? validFetchedAt(raw.fetchedAt) : text(raw.fetchedAt);
  if (sourceKind === 'fetched' && raw.fetchedAt != null && fetchedAt == null) {
    warnings.push('Fetch time was malformed; the snapshot time is Unknown.');
  }
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
    fetchedAt,
    provenance: 'unknown',
    synthetic: raw.synthetic === true,
    sourceKind,
    hasContradiction: contradiction(ccs2?.hasContradiction) ||
      chargers.some((charger) => charger.connectors.some((connector) => connector.contradiction)),
    maxKw: number(ccs2?.maxKw, 0.000001),
    tariffPerKwh: number(ccs2?.pricePerKwh, 0),
    counts: normalizeCounts(ccs2),
    chargers,
    chargersMissing,
    connectorTotal: chargers.reduce((sum, charger) => sum + charger.connectors.length, 0),
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
  const evidence = normalizeStation(raw.station, 'fetched');
  const explicitlyStale = raw.live === false || raw.retained === true;
  if (raw.live !== true && !explicitlyStale) {
    evidence.warnings.push('Freshness flags were not returned; do not treat this as verified live status.');
  } else if (!explicitlyStale && evidence.fetchedAt != null) {
    evidence.provenance = 'fresh';
  }
  if (explicitlyStale) {
    evidence.provenance = 'retained';
    evidence.warnings.push('This station response is marked retained or non-live; it is not a fresh fetch.');
  }
  return evidence;
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
