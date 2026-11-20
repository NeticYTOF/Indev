/**
 * Reusable station evidence panel and manual revalidation controller.
 *
 * Rendering is separated from fetching: expanding the details never triggers
 * a request. Each wired button performs one explicit `GET /api/stations/:id`,
 * guarded against duplicate clicks, late responses, mismatched station IDs,
 * and detached views. The underlying plan/saved-trip state is never mutated.
 */
import type { PlanStop, SavedStationRef } from '@indeev/core';
import { formatDateTime, formatDuration, formatTariff, lastUsedLabel } from './format.js';

import { safeHttpUrl, stationDirectionsUrl } from './safe-url.js';
import {
  displayEvidence,
  normalizeFetchedStationResponse,
  normalizePlannedStation,
  plugHealthLabel,
  stationMatchesId,
  type StationEvidence,
} from './station-evidence.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] as string);
}

export interface PlannedStopFacts {
  tariffPerKwh?: number | null;
  chargeKwh?: number | null;
  chargeTimeMin?: number | null;
  arrivalEtaMin?: number | null;
  departureEtaMin?: number | null;
  arriveSocPct?: number | null;
  leaveSocPct?: number | null;
}

interface EvidencePanelOptions {
  /** PlanStop station for a fresh plan; omitted for saved refs. */
  plannedStation?: PlanStop['station'];
  /** Minimal stored station ref for a saved trip. */
  savedStation?: SavedStationRef;
  plannedFacts: PlannedStopFacts;
  label?: string;
  includeLinks?: boolean;
}

function named(value: string | null): string {
  return value == null ? 'Unknown' : escapeHtml(value);
}

function concise(value: number | null, suffix = ''): string {
  return escapeHtml(displayEvidence(value, suffix));
}

function chargerIdentity(chargerId: number | null, index: number): string {
  return chargerId != null ? `Charger ${chargerId}` : `Charger ${index} (ID Unknown)`;
}

function connectorMarkup(connector: StationEvidence['chargers'][number]['connectors'][number], index: number): string {
  const status = connector.status == null ? 'Unknown' : connector.status;
  const note = connector.note == null ? 'No note returned' : connector.note;
  const flags: string[] = [];
  if (connector.contradiction) flags.push('<span class="evidence-flag evidence-flag-warn">Contradiction</span>');
  if (connector.invalidAvailability) flags.push('<span class="evidence-flag evidence-flag-warn">Invalid availability</span>');
  return `<li class="evidence-connector">` +
    `<span class="evidence-key">Plug ${index}</span>` +
    `<span class="evidence-value">${named(connector.type)} · ${escapeHtml(plugHealthLabel(connector.health))}</span>` +
    `<span class="hint">ID ${concise(connector.connectorId)} · status ${escapeHtml(status)} · ` +
    `available ${connector.available == null ? 'Unknown' : connector.available ? 'yes' : 'no'} · note ${escapeHtml(note)}</span>` +
    flags.join('') +
    `</li>`;
}

function chargerMarkup(charger: StationEvidence['chargers'][number], index: number): string {
  return `<li class="evidence-charger">` +
    `<div class="evidence-charger-head"><strong>${named(charger.name)}</strong>` +
    `<span class="hint">${chargerIdentity(charger.chargerId, index)} · ${named(charger.type)}</span></div>` +
    `<dl class="evidence-grid">` +
    `<div><dt>Power</dt><dd>${concise(charger.kw, ' kW')}</dd></div>` +
    `<div><dt>Tariff</dt><dd>${charger.pricePerKwh == null ? 'Unknown' : formatTariff(charger.pricePerKwh)}</dd></div>` +
    `<div><dt>Last used</dt><dd>${escapeHtml(lastUsedLabel([{ lastUsedOn: charger.lastUsedOn }]))}</dd></div>` +
    `</dl>` +
    `<ul class="evidence-connectors">${charger.connectors.map(connectorMarkup).join('') || '<li class="hint">No connectors returned.</li>'}</ul>` +
    `</li>`;
}

function evidenceMarkup(evidence: StationEvidence): string {
  const c = evidence.counts;
  const warnings = evidence.warnings.length > 0
    ? `<ul class="evidence-warnings">${evidence.warnings.map((warning) =>
      `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
    : '';
  return `<div class="evidence-summary" data-station-evidence-result data-evidence-station-id="${concise(evidence.stationId)}">` +
    `<div class="banners">` +
    `${evidence.synthetic ? '<div class="banner banner-synthetic">Synthetic station — fixed sample, not live charger data.</div>' : ''}` +
    `${evidence.sourceKind === 'fetched' && evidence.provenance === 'retained'
      ? '<div class="banner banner-warn">Provenance: this response is marked retained or non-live.</div>'
      : evidence.sourceKind === 'fetched' && evidence.provenance === 'unknown'
        ? '<div class="banner banner-warn">Provenance: snapshot time is Unknown; availability is not verified.</div>'
        : ''}` +
    `${evidence.reliability != null ? '' : '<div class="banner banner-soft">Reliability: unavailable — no verified score is supplied.</div>'}` +
    `</div>` +
    warnings +
    `<dl class="evidence-grid">` +
    `<div><dt>Fetched at</dt><dd${evidence.sourceKind === 'fetched' ? ' class="fetched"' : ''}>${named(evidence.fetchedAt == null ? null : formatDateTime(evidence.fetchedAt))}</dd></div>` +
    `<div><dt>Rating</dt><dd>${concise(evidence.rating)} · ${concise(evidence.reviewCount)} reviews</dd></div>` +
    `<div><dt>CCS2 DC</dt><dd>${concise(c.total)} total · ${concise(c.usable)} usable</dd></div>` +
    `<div><dt>Availability</dt><dd>${concise(c.free)} free · ${concise(c.occupied)} occupied</dd></div>` +
    `<div><dt>Uncertain</dt><dd>${concise(c.uncertain)} · faulted ${concise(c.faulted)} · offline ${concise(c.offline)}</dd></div>` +
    `<div><dt>Max known power</dt><dd>${concise(evidence.maxKw, ' kW')}</dd></div>` +
    `<div><dt>Selected tariff</dt><dd>${evidence.tariffPerKwh == null ? 'Unknown' : formatTariff(evidence.tariffPerKwh)}</dd></div>` +
    `<div><dt>Last used</dt><dd>${escapeHtml(lastUsedLabel(evidence.chargers))}</dd></div>` +
    `<div><dt>Address</dt><dd>${named(evidence.address)} · ${named(evidence.city)}</dd></div>` +
    `<div><dt>Hours</dt><dd>${named(evidence.hours)} ${evidence.openText == null ? '' : `· ${escapeHtml(evidence.openText)}`}</dd></div>` +
    `</dl>` +
    `<div class="chips">` +
    `<span class="chip">${concise(c.usable)} usable CCS2 plugs</span>` +
    `<span class="chip">${concise(c.free)} free</span>` +
    `<span class="chip">${concise(c.occupied)} occupied</span>` +
    `${c.faulted != null && c.faulted > 0 ? '<span class="chip chip-bad">Faulted plugs</span>' : ''}` +
    `${c.uncertain != null && c.uncertain > 0 ? '<span class="chip chip-uncertain">Uncertain status</span>' : ''}` +
    `${evidence.hasContradiction ? '<span class="chip chip-uncertain">Contradictory status</span>' : ''}` +
    `${evidence.synthetic ? '<span class="chip chip-synthetic">Synthetic</span>' : ''}` +
    `</div>` +
    `<ul class="evidence-chargers">${evidence.chargers.map(chargerMarkup).join('') ||
      (evidence.chargersMissing
        ? '<li class="hint">Charger list is Unknown.</li>'
        : '<li class="hint">No chargers returned.</li>')}</ul>` +
    `</div>`;
}

function finiteFact(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function plannedFactsMarkup(facts: PlannedStopFacts): string {
  const tariff = finiteFact(facts.tariffPerKwh, 0);
  const energy = finiteFact(facts.chargeKwh, 0);
  const chargeTime = finiteFact(facts.chargeTimeMin, 0);
  const arrive = finiteFact(facts.arriveSocPct, 0, 100);
  const leave = finiteFact(facts.leaveSocPct, 0, 100);
  return `<dl class="evidence-grid">` +
    `<div><dt>Planned tariff</dt><dd>${tariff == null ? 'Unknown' : formatTariff(tariff)}</dd></div>` +
    `<div><dt>Planned added energy</dt><dd>${energy == null ? 'Unknown' : `${Math.round(energy * 10) / 10} kWh`}</dd></div>` +
    `<div><dt>Planned charge time</dt><dd>${chargeTime == null ? 'Unknown' : formatDuration(chargeTime)}</dd></div>` +
    `<div><dt>Planned SoC</dt><dd>${arrive == null ? 'Unknown' : `${Math.round(arrive)}%`} → ` +
    `${leave == null ? 'Unknown' : `${Math.round(leave)}%`}</dd></div>` +
    `</dl>`;
}

function plannedEvidenceMarkup(options: EvidencePanelOptions): string {
  const evidence = options.plannedStation
    ? normalizePlannedStation(options.plannedStation)
    : options.savedStation
      ? normalizePlannedStation({
        ...options.savedStation,
        brand: 'other', rating: null, reviewCount: null, reliability: null,
        fetchedAt: '', synthetic: options.savedStation ? false : undefined,
        amenities: [], stationUrl: null, navUrl: null, chargers: [],
      } as unknown as PlanStop['station'])
      : null;
  const station = options.plannedStation ?? options.savedStation;
  const external = safeHttpUrl(options.plannedStation?.stationUrl);
  const directions = stationDirectionsUrl(station?.lat, station?.lon);
  const emptySnapshot = evidence?.chargersMissing
    ? '<p class="hint">Charger snapshot unavailable — the planned charger list is Unknown.</p>'
    : options.savedStation
      ? '<p class="hint">This saved trip stores planned charging facts, not a charger snapshot. Fetch current details below for station status.</p>'
      : '<p class="hint">No charger connectors were returned in this planned snapshot. Fetch current details below for station status.</p>';
  const snapshot = evidence && evidence.connectorTotal > 0
    ? `<div class="evidence-station"><strong>Planned charger snapshot</strong>${evidenceMarkup(evidence)}</div>`
    : `<div class="evidence-station">` +
      `${evidence?.synthetic ? '<div class="banner banner-synthetic">Synthetic planned station — fixed sample, not live charger data.</div>' : ''}` +
      `${emptySnapshot}</div>`;
  const links = options.includeLinks === false ? '' : `<div class="evidence-links">` +
    `${directions ? `<a class="btn btn-compact btn-ghost" href="${escapeHtml(directions)}" target="_blank" rel="noreferrer">Directions</a>` : '<span class="hint">Directions unavailable</span>'}` +
    `${external ? `<a class="btn btn-compact btn-ghost" href="${escapeHtml(external)}" target="_blank" rel="noreferrer">Station page</a>` : ''}` +
    `</div>`;
  return `<section class="evidence-section" aria-label="Planned charging facts">` +
    `<h4>Planned snapshot from the trip</h4>` +
    `<p class="hint">These values supported the original plan. They are not a live charger reading and are never changed by a manual fetch.</p>` +
    plannedFactsMarkup(options.plannedFacts) +
    snapshot + links +
    `</section>`;
}

export function renderStationEvidencePanel(options: EvidencePanelOptions): string {
  const stationId = options.plannedStation?.stationId ?? options.savedStation?.stationId;
  const label = options.label ?? options.plannedStation?.name ?? options.savedStation?.name ?? 'this station';
  return `<details class="station-evidence" data-station-evidence data-station-id="${escapeHtml(String(stationId ?? ''))}">` +
    `<summary><span class="evidence-summary-title">Charger evidence for ${escapeHtml(label)}</span>` +
    `<span class="hint">Open to inspect planned facts; fetching is a separate explicit action.</span></summary>` +
    `<div class="station-evidence-body">` +
    plannedEvidenceMarkup(options) +
    `<section class="evidence-section" aria-label="Manual station status">` +
    `<h4>Manual station status</h4>` +
    `<p class="hint">No automatic lookup runs when this panel opens. One click calls the station endpoint once.</p>` +
    `<div class="revalidate-box">` +
    `<div class="evidence-status" data-station-evidence-status role="status" aria-live="polite">No current status requested.</div>` +
    `<div class="evidence-fetched" data-station-evidence-fetched></div>` +
    `</div></section></div></details>`;
}

export interface StationRevalidationHandle {
  refresh: () => Promise<void>;
}

export function wireStationEvidence(
  root: HTMLElement,
  options: { buttonSelector: string; stationId: number; label?: string },
): StationRevalidationHandle | null {
  const button = root.querySelector<HTMLButtonElement>(options.buttonSelector);
  const panel = root.querySelector<HTMLElement>('[data-station-evidence]');
  const status = root.querySelector<HTMLElement>('[data-station-evidence-status]');
  const target = root.querySelector<HTMLElement>('[data-station-evidence-fetched]');
  if (!button || !panel || !status || !target || !Number.isSafeInteger(options.stationId) || options.stationId <= 0) {
    return null;
  }
  let pending = false;
  let generation = 0;

  const refresh = async (): Promise<void> => {
    if (pending || button.disabled) return;
    if (!button.isConnected || !panel.isConnected || !status.isConnected || !target.isConnected) return;
    panel.open = true; // open the details for the explicit fetch; opening alone never fetches
    pending = true;
    button.setAttribute('disabled', 'true');
    const requestGeneration = ++generation;
    status.textContent = 'Fetching station status…';
    target.replaceChildren();
    try {
      const response = await fetch(`/api/stations/${options.stationId}`);
      if (!response.ok) throw new Error('Station details unavailable right now.');
      const evidence = normalizeFetchedStationResponse(await response.json());
      if (!evidence || !stationMatchesId(evidence, options.stationId)) {
        throw new Error('Station details could not be verified for this stop.');
      }
      if (requestGeneration !== generation ||
          !button.isConnected || !panel.isConnected || !status.isConnected || !target.isConnected) return;
      const when = evidence.fetchedAt == null ? 'at an unknown time' : formatDateTime(evidence.fetchedAt);
      status.textContent = evidence.provenance === 'received'
        ? `Station details received ${when}. Charger availability is a snapshot, not guaranteed live.`
        : evidence.provenance === 'retained'
          ? `Retained station details received ${when}; not a fresh fetch.`
          : `Station details received ${when}; snapshot time is not verified.`;
      target.innerHTML = evidenceMarkup(evidence);
      panel.open = true;
    } catch {
      if (requestGeneration !== generation || !status.isConnected) return;
      status.textContent = 'Station details unavailable right now. You can try once more.';
      target.replaceChildren();
    } finally {
      if (requestGeneration === generation && button.isConnected) {
        pending = false;
        button.removeAttribute('disabled');
        if (document.activeElement === document.body) button.focus({ preventScroll: true });
      }
    }
  };

  button.addEventListener('click', () => void refresh());
  return { refresh };
}
