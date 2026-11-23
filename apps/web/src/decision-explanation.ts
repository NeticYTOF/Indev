/**
 * Charger decision explanation.
 *
 * Reads ONLY the candidate set already collected for a completed plan. It
 * never fetches, never invents a reliability score, and never claims to
 * reproduce the AI's private reasoning. "Reasons" below are deterministic
 * readings of the facts the run actually observed: which stations were
 * chosen, their power against the user's hard cap, evidence freshness and
 * any recorded contradictions.
 */
import type { PlanCandidate, TripPlan } from '@indeev/core';
import './decision-explanation.css';

export interface DecisionConstraints {
  /** The user's hard ceiling, when one was supplied for the run. */
  maxChargerKw?: number;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] ?? ch));
}

function num(value: number | null | undefined, suffix = ''): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${esc(String(value))}${esc(suffix)}`
    : 'Unknown';
}

function reasonTags(candidate: PlanCandidate, chosen: boolean, cap?: number): string[] {
  const tags = [chosen ? 'In chosen stop sequence' : 'Not in chosen stop sequence'];
  if (cap !== undefined) {
    if (candidate.maxKw == null) tags.push('Power unknown — hard-cap compliance unknown');
    else if (candidate.maxKw > cap) tags.push(`Above hard cap (${candidate.maxKw} kW > ${cap} kW)`);
    else tags.push(`Within hard cap (${candidate.maxKw} kW)`);
  }
  if (candidate.offRouteKm > 0) tags.push(`Off-route ${candidate.offRouteKm} km`);
  if (candidate.evidence.ccs2ContradictionCount > 0) tags.push('Connector contradiction recorded');
  if (candidate.evidence.chargers.length === 0) tags.push('No charger list in collected evidence');
  return tags;
}

function candidateMarkup(candidate: PlanCandidate, chosenIds: Set<number>, cap?: number): string {
  const e = candidate.evidence;
  const tags = reasonTags(candidate, chosenIds.has(candidate.stationId), cap)
    .map((tag) => `<li>${esc(tag)}</li>`)
    .join('');
  const amenities = e.amenities.length > 0
    ? e.amenities.map((a) => esc(a)).join(', ')
    : 'None recorded';
  return `<li class="decision-candidate" data-station-id="${candidate.stationId}">
    <div class="decision-head">
      <strong>${esc(candidate.name)}</strong>
      <span class="hint">Station ${candidate.stationId} · ${esc(candidate.brand)}</span>
    </div>
    <ul class="decision-reasons">${tags}</ul>
    <dl class="decision-facts">
      <dt>Power</dt><dd>${num(candidate.maxKw, ' kW')}</dd>
      <dt>Price</dt><dd>${num(candidate.pricePerKwh, ' /kWh')}</dd>
      <dt>Route position</dt><dd>${num(candidate.chainageKm, ' km')}</dd>
      <dt>Off-route</dt><dd>${num(candidate.offRouteKm, ' km')}</dd>
      <dt>Rating</dt><dd>${num(candidate.rating)} (${num(candidate.reviewCount)} reviews)</dd>
      <dt>Fetched at</dt><dd>${esc(e.fetchedAt || 'Unknown')}</dd>
      <dt>Hours</dt><dd>${esc(e.hours ?? e.openText ?? 'Unknown')}</dd>
      <dt>Access</dt><dd>${esc(e.accessType ?? 'Unknown')}</dd>
      <dt>CCS2 eligible / contradictory</dt>
      <dd>${num(e.ccs2EligibleCount)} / ${num(e.ccs2ContradictionCount)}</dd>
      <dt>Amenities</dt><dd>${amenities}</dd>
    </dl>
    <p class="hint">${esc(e.reliabilityNote)}</p>
  </li>`;
}

/** Complete, read-only markup for a plan. Empty candidate sets yield an
 *  honest "no collected candidate data" line, never an empty-looking success. */
export function renderDecisionExplanation(plan: TripPlan, constraints: DecisionConstraints = {}): string {
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const chosenIds = new Set(plan.stops.map((stop) => stop.station.stationId));
  const rows = candidates
    .map((candidate) => candidateMarkup(candidate, chosenIds, constraints.maxChargerKw))
    .join('');
  const body = rows.length > 0
    ? `<ol class="decision-list">${rows}</ol>`
    : '<p class="hint">This plan carries no collected candidate list; no per-station explanation is available.</p>';
  return `<section class="decision-explanation" aria-label="Charger decision explanation">
    <h3>Why these chargers</h3>
    <p class="hint">${num(plan.stationsSeen)} unique stations were checked live; ${candidates.length} candidates are in this plan's collected set; ${chosenIds.size} were chosen as stops.</p>
    ${body}
    <p class="hint">Reasons are a deterministic reading of collected facts and your hard limits. They are not the AI's private reasoning; its own note is kept in the plan's warnings.</p>
  </section>`;
}
