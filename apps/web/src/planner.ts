/**
 * Planner compose card: route fields with a connected A→B motif, vehicle
 * selection (claimed vs user real-world range strictly separated), start
 * charge stepper, and the plan action with honest error states.
 * Night Drive markup; all validation logic unchanged.
 */
import * as maplibregl from 'maplibre-gl';
import type { GeocodeHit, VehicleCatalogEntry } from '@indeev/core';
import { api, ApiError, type PlanRequest } from './api.js';
import type { TripPlan } from '@indeev/core';
import { drawTrip } from './map.js';
import { renderPlanPanel } from './plan-panel.js';
import { toast } from './toast.js';
import { formatElapsedMs, planFailureGuidance, type PlanFailureGuidance } from './plan-errors.js';
import { SubmitGate } from './submit-gate.js';
import { GeocodeSession } from './geocode-session.js';
import { savedRouteDraftReady, type SavedRouteDraft } from './saved-route.js';

export interface PlannerController {
  /** Copy a saved route into the composer for manual review; no network calls. */
  loadSavedRoute: (draft: SavedRouteDraft) => boolean;
}

interface PlaceInput {
  hit: GeocodeHit | null;
}

/** Start-charge stepper state (single source of truth for this card). */
const MIN_SOC = 10;
const MAX_SOC = 100;
const SOC_STEP = 5;

export function renderPlanner(root: HTMLElement, map: maplibregl.Map): PlannerController {
  root.innerHTML = '';

  const section = document.createElement('section');
  section.className = 'planner';
  root.appendChild(section);

  // Mobile sheet affordances: grab handle (decorative) + dismiss control.
  // The visible sheet must NOT inherit aria-hidden: the handle alone is
  // decorative; the dismiss button stays in the accessibility tree.
  const sheetHeader = el(`
    <div class="sheet-header">
      <span class="sheet-handle" aria-hidden="true"></span>
    </div>
  `);
  section.appendChild(sheetHeader);
  const dismiss = el(`<button type="button" class="btn btn-ghost btn-compact sheet-dismiss" aria-label="Hide trip planner">▾</button>`);
  sheetHeader.appendChild(dismiss);
  dismiss.addEventListener('click', () => {
    root.classList.remove('open');
    const fab = document.getElementById('sheet-open');
    if (fab) {
      fab.classList.remove('hidden');
      fab.setAttribute('aria-expanded', 'false');
      // Return focus to the control that owns the sheet state.
      if (window.innerWidth <= 720) fab.focus();
    }
  });

  const origin: PlaceInput = { hit: null };
  const destination: PlaceInput = { hit: null };

  const form = el(`<form class="planner-form" autocomplete="off" novalidate></form>`) as HTMLFormElement;
  section.appendChild(form);

  const savedReview = el(`<div class="saved-route-review hidden" role="status" aria-live="polite"></div>`);
  section.insertBefore(savedReview, form);

  // ---- brand header: the product identity lives in the card ----
  const head = el(`
    <div class="planner-head">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">IndEV</span>
      <span class="brand-tag">EV route planner · India</span>
    </div>
  `);
  form.appendChild(head);

  const intro = el(`<p class="planner-intro">Fastest route, fewest charging stops, planned over live Statiq chargers.</p>`);
  form.appendChild(intro);

  const originField = makeSearchField('From', 'Delhi', 'origin', (hit) => {
    origin.hit = hit;
  });
  const destField = makeSearchField('To', 'Jaipur', 'destination', (hit) => {
    destination.hit = hit;
  });

  const routeFields = el(`<div class="route-fields"></div>`);
  routeFields.append(originField.wrap);
  const swap = el(`<button type="button" class="planner-swap" aria-label="Swap origin and destination">⇅</button>`) as HTMLButtonElement;
  routeFields.appendChild(swap);
  routeFields.appendChild(destField.wrap);
  form.appendChild(routeFields);

  swap.addEventListener('click', () => {
    originField.invalidateSuggestions();
    destField.invalidateSuggestions();
    const tmp = origin.hit;
    origin.hit = destination.hit;
    destination.hit = tmp;
    originField.input.value = origin.hit?.label ?? '';
    destField.input.value = destination.hit?.label ?? '';
  });

  const errorBox = el(`<div class="error-box hidden" role="alert"></div>`);
  hideError(errorBox);

  // Health-check failure does not establish that all server endpoints are offline.
  const offline = el(`
    <div class="server-offline hidden" role="status">
      <span aria-hidden="true">●</span>
      <span>Server status unavailable — the health check failed. Planning may still work.</span>
    </div>
  `);

  // Mode provenance: the pending label must reflect the server mode from
  // /api/health - never assume live.
  let serverIsMock: boolean | null = null;
  void api
    .health()
    .then((h) => {
      serverIsMock = h.mock;
      offline.classList.add('hidden');
      if (h.ai) {
        aiBox.classList.remove('hidden');
      }
    })
    .catch(() => {
      offline.classList.remove('hidden');
    });

  // clearing stale validation: picking a suggestion (or typing anew) resolves
  // the "pick both places" error immediately, not only on the next submit
  for (const field of [originField, destField]) {
    field.input.addEventListener('picked', () => hideError(errorBox));
    field.input.addEventListener('input', () => hideError(errorBox));
  }

  // vehicle selector
  const vehicleWrap = el(`<div class="field-row vehicle-row"></div>`);
  const vehicleRow = el(`<div class="vehicle"></div>`);
  vehicleWrap.appendChild(vehicleRow);
  form.appendChild(vehicleWrap);

  let catalog: VehicleCatalogEntry[] = [];
  let defaultVehicle = 'tata-harrier-ev-75';
  let catalogState: 'loading' | 'ready' | 'unavailable' = 'loading';
  let pendingSavedVehicle: SavedRouteDraft['vehicle'] | null = null;
  const addVehicleFallbackNote = (draft: SavedRouteDraft['vehicle'], reason: string): void => {
    const note = document.createElement('li');
    note.textContent = `${reason} Saved vehicle “${draft.label || 'unknown label'}” uses the custom inputs with its stored battery and real-world range; do not infer either from a claim.`;
    savedReview.querySelector('ul')?.appendChild(note);
  };
  const restoreVehicleDraft = (draft: SavedRouteDraft['vehicle']): void => {
    if (catalogState === 'loading') {
      // The catalog response owns vehicleRow until it settles; reapply after it.
      pendingSavedVehicle = draft;
      return;
    }
    const selector = vehicleRow.querySelector<HTMLSelectElement>('select[data-vehicle]');
    if (!selector) return;

    const catalogMatch = catalogState === 'ready' && draft.catalogId != null
      ? catalog.find((entry) => entry.id === draft.catalogId)
      : undefined;
    const batteryMatchesCatalog = catalogMatch != null
      && catalogMatch.batteryKwh === draft.batteryKwh;
    const useCatalog = catalogMatch != null && batteryMatchesCatalog
      && catalogMatch.id !== defaultVehicle && draft.realWorldRangeKm != null;
    selector.value = useCatalog ? catalogMatch!.id : 'custom';
    selector.dispatchEvent(new Event('change'));

    if (useCatalog) {
      const range = vehicleRow.querySelector<HTMLInputElement>('input[data-real-world]');
      if (range) range.value = String(draft.realWorldRangeKm);
      return;
    }

    const battery = vehicleRow.querySelector<HTMLInputElement>('input[data-custom-kwh]');
    const range = vehicleRow.querySelector<HTMLInputElement>('input[data-real-world]');
    // Leave an unknown battery blank; never infer it from a stale/default catalog entry.
    if (battery && draft.batteryKwh != null) battery.value = String(draft.batteryKwh);
    if (range && draft.realWorldRangeKm != null) range.value = String(draft.realWorldRangeKm);
    const reason = catalogState === 'unavailable'
      ? 'Vehicle catalog could not be loaded.'
      : catalogMatch == null
        ? 'The saved catalog ID is not in the current catalog.'
        : !batteryMatchesCatalog
          ? 'The saved battery does not match the current catalog entry.'
          : 'The saved vehicle is the default catalog entry and needs its own range review.';
    addVehicleFallbackNote(draft, reason);
  };
  void api.vehicles().then((res) => {
    catalog = res.catalog;
    defaultVehicle = res.default;
    catalogState = 'ready';
    buildVehicleSelect(vehicleRow, catalog, defaultVehicle);
    const pending = pendingSavedVehicle;
    pendingSavedVehicle = null;
    if (pending) restoreVehicleDraft(pending);
  }).catch(() => {
    catalogState = 'unavailable';
    buildVehicleSelect(vehicleRow, [], defaultVehicle);
    const note = el('<p class="hint warn-hint">Vehicle catalog unavailable — only the custom vehicle inputs can be used.</p>');
    vehicleRow.appendChild(note);
    const pending = pendingSavedVehicle;
    pendingSavedVehicle = null;
    if (pending) restoreVehicleDraft(pending);
  });

  // ---- start charge stepper ----
  let startSoc = 100;
  const socRow = el(`
    <div class="field-row soc-row">
      <label id="soc-label">Current charge</label>
      <div class="stepper" role="group" aria-labelledby="soc-label">
        <button type="button" class="stepper-btn" data-step="-5" aria-label="Decrease charge">−</button>
        <span class="stepper-value" aria-live="polite">100%</span>
        <button type="button" class="stepper-btn" data-step="5" aria-label="Increase charge">＋</button>
      </div>
    </div>
  `);
  form.appendChild(socRow);
  const socValue = socRow.querySelector('.stepper-value') as HTMLElement;
  const renderSoc = (): void => {
    socValue.textContent = `${startSoc}%`;
    socRow.querySelectorAll<HTMLButtonElement>('.stepper-btn').forEach((b) => {
      const step = Number(b.dataset.step);
      b.disabled = step < 0 ? startSoc - SOC_STEP < MIN_SOC : startSoc + SOC_STEP > MAX_SOC;
    });
  };
  socRow.querySelectorAll<HTMLButtonElement>('.stepper-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const step = Number(b.dataset.step);
      startSoc = Math.min(MAX_SOC, Math.max(MIN_SOC, startSoc + step));
      renderSoc();
    });
  });
  renderSoc();

  form.appendChild(offline);

  // ---- action ----
  const actions = el(`<div class="planner-actions"></div>`);
  const planButton = el(`
    <button type="submit" class="btn btn-primary planner-go">
      <span class="spinner hidden" aria-hidden="true"></span>
      <span class="go-label">Plan route</span>
    </button>
  `) as HTMLButtonElement;
  actions.appendChild(planButton);
  form.appendChild(actions);
  const planLabel = planButton.querySelector('.go-label') as HTMLElement;
  const planSpinner = planButton.querySelector('.spinner') as HTMLElement;

  const setLoading = (loading: boolean, label: string): void => {
    planButton.disabled = loading;
    planLabel.textContent = label;
    planSpinner.classList.toggle('hidden', !loading);
  };

  // Honest live-mode progress: a REAL elapsed timer plus a truthful hint
  // about why a plan can take minutes. No fake progress, no invented
  // percentages. Hidden in mock mode - synthetic plans are instant and
  // must not borrow live-mode claims. Screen readers hear the hint ONCE
  // (role=status on the stable line); the ticking elapsed readout is
  // aria-hidden visual-only so a long wait is never live-region spam.
  const liveBusy = el(`
    <div class="plan-busy hidden">
      <p class="plan-busy-hint" role="status">Every candidate charger is fetched individually with safety pacing — a long corridor can take several minutes. The request stays open; nothing is cached between runs.</p>
      <p class="plan-busy-time"><span class="plan-busy-spinner" aria-hidden="true"></span><span class="plan-busy-elapsed" aria-hidden="true">0s elapsed</span></p>
    </div>
  `);
  const busyElapsed = liveBusy.querySelector('.plan-busy-elapsed') as HTMLElement;
  let busyTimer: number | null = null;
  let busyStartedAt = 0;
  const startBusy = (): void => {
    if (serverIsMock !== false) return; // only confirmed live mode gets live claims
    // Defensive cleanup: single-flight gives this timer one run owner.
    if (busyTimer !== null) window.clearInterval(busyTimer);
    busyStartedAt = Date.now();
    busyElapsed.textContent = '0s elapsed';
    liveBusy.classList.remove('hidden');
    // 5s cadence for the VISUAL readout; assistive tech never hears ticks.
    busyTimer = window.setInterval(() => {
      busyElapsed.textContent = `${formatElapsedMs(Date.now() - busyStartedAt)} elapsed`;
    }, 5000);
  };
  const stopBusy = (): void => {
    if (busyTimer !== null) {
      window.clearInterval(busyTimer);
      busyTimer = null;
    }
    liveBusy.classList.add('hidden');
  };
  form.appendChild(liveBusy);

  // AI planning (hidden unless the server has an AI provider configured).
  const aiBox = el(`
    <div class="ai-box hidden">
      <label for="ai-request" class="search-label">AI planning — custom requests (optional)</label>
      <textarea id="ai-request" rows="2" placeholder="e.g. Prefer stops with cafes, avoid single-plug stations"></textarea>
      <button type="button" class="btn btn-ghost" data-ai-plan>Plan with AI</button>
      <p class="hint">The AI picks from the same live candidates and every choice is validated against the configured leg ceiling and charge/reserve feasibility.</p>
    </div>
  `);
  form.appendChild(aiBox);
  aiBox.querySelector('[data-ai-plan]')?.addEventListener('click', () => {
    form.dispatchEvent(new CustomEvent('ai-plan'));
  });

  // ONE planning run at a time: the plan and AI submit paths are mutually
  // exclusive. Each planning run opens its own upstream request window
  // (per-run client + limiter on the server), so overlapping UI runs
  // would double the effective request rate against the charger API -
  // never assumed safe. Single flight also gives the shared busy/elapsed
  // readout exactly one owner, so one run's finally can never hide a
  // still-pending run (the shared-timer lifecycle defect from
  // independent review).
  const gate = new SubmitGate();
  let planInFlight = false;
  const setActionsBusy = (busy: boolean): void => {
    planButton.disabled = busy;
    const aiBtn = aiBox.querySelector<HTMLButtonElement>('[data-ai-plan]');
    if (aiBtn) aiBtn.disabled = busy;
  };

  section.appendChild(errorBox);

  const loadSavedRoute = (draft: SavedRouteDraft): boolean => {
    if (planInFlight) {
      showError(errorBox, 'A plan is already running. Wait for it to finish before editing this saved route.');
      return false;
    }
    if (!savedRouteDraftReady(draft)) {
      showError(errorBox, 'This saved route has invalid coordinates. Reopen it to inspect the record, then pick both places manually.');
      return false;
    }

    // Clear the old saved summary; it must never appear to describe a new plan.
    root.querySelector('.plan-results')?.remove();
    originField.setSavedPlace(draft.origin);
    destField.setSavedPlace(draft.destination);
    hideError(errorBox);

    savedReview.replaceChildren();
    const title = el('<p class="review-title">Editing saved route — review before planning</p>');
    const intro = el('<p>Origin, destination and known vehicle facts were copied from the saved trip. No saved record changes until you explicitly save a new plan.</p>');
    const list = el('<ul></ul>');
    for (const note of draft.reviewNotes) {
      const item = document.createElement('li');
      item.textContent = note;
      list.appendChild(item);
    }
    const submitNote = el('<p>Plan or Plan with AI starts a new manual run. Start charge remains at the value shown below and must be reviewed.</p>');
    savedReview.append(title, intro, list, submitNote);
    savedReview.classList.remove('hidden');
    restoreVehicleDraft(draft.vehicle);
    if (window.innerWidth <= 720) {
      root.classList.add('open');
      document.getElementById('sheet-open')?.setAttribute('aria-expanded', 'true');
      document.getElementById('sheet-open')?.classList.add('hidden');
    }
    originField.input.focus();
    return true;
  };

  const savedVehicleStillPending = (): boolean => catalogState === 'loading' && pendingSavedVehicle != null;
  const refusePendingSavedVehicle = (): boolean => {
    if (!savedVehicleStillPending()) return false;
    showError(errorBox, 'Waiting for the saved vehicle selection to finish loading — review it before planning.');
    return true;
  };

  form.addEventListener('ai-plan', async () => {
    if (refusePendingSavedVehicle()) return;
    if (!origin.hit || !destination.hit) {
      showError(errorBox, 'Pick both a starting point and a destination from the suggestions first.');
      return;
    }
    const aiRequestEl = document.getElementById('ai-request') as HTMLTextAreaElement | null;
    const customRequest = aiRequestEl?.value.trim() || undefined;
    const vehicleResult = readVehicleSelection(vehicleRow);
    if (vehicleResult.kind === 'invalid') {
      showError(errorBox, vehicleResult.reason);
      return;
    }
    // One planning run at a time - a second run while one is in flight
    // would double the upstream request window and orphan the shared
    // busy readout. Buttons are already disabled; this is the fail-closed
    // backstop for any submit that fires anyway.
    if (!gate.tryBegin()) return;
    planInFlight = true;
    setActionsBusy(true);
    const aiButton = aiBox.querySelector('[data-ai-plan]') as HTMLButtonElement | null;
    hideError(errorBox);
    startBusy();
    let focusOnSettle: HTMLElement | null = null;
    try {
      const { plan, ai } = await api.aiPlan({
        origin: { label: origin.hit.label, lat: origin.hit.lat, lon: origin.hit.lon },
        destination: { label: destination.hit.label, lat: destination.hit.lat, lon: destination.hit.lon },
        startSocPct: startSoc,
        ...(vehicleResult.kind === 'ok' ? { vehicle: vehicleResult.vehicle } : {}),
        ...(customRequest ? { request: customRequest } : {}),
      });
      onPlanAvailable(plan, map);
      if (ai.applied) {
        toast(ai.notes ? `AI plan applied: ${ai.notes}` : 'AI plan applied.');
      } else if (ai.reason) {
        toast(`Computed plan shown — ${ai.reason}`, 'warn', 6000);
      }
    } catch (err) {
      showPlanningError(errorBox, err, 'AI planning failed.');
      // Context restore: the disabled button lost focus to <body> during
      // the run - land back on the retry control once it re-enables.
      focusOnSettle = aiButton;
    } finally {
      stopBusy();
      setActionsBusy(false);
      gate.end();
      planInFlight = false;
      // Keyboard focus returns to the retry control WITHOUT scrolling:
      // the failure is already revealed in place (renderPlanFailure
      // aligned it to the top); a scrolling focus would push it back
      // below the fold (the mobile long-error defect from rendered
      // review).
      // Restore only focus actually lost by disabling the submit control.
      // Do not interrupt someone who moved to another field during the wait.
      if (document.activeElement === document.body) {
        focusOnSettle?.focus({ preventScroll: true });
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (refusePendingSavedVehicle()) return;
    if (!origin.hit || !destination.hit) {
      showError(errorBox, 'Pick both a starting point and a destination from the suggestions.');
      return;
    }
    const vehicleResult = readVehicleSelection(vehicleRow);
    if (vehicleResult.kind === 'invalid') {
      // Inline validation naming the missing input; the resolved origin and
      // destination are kept exactly as picked - nothing is cleared.
      showError(errorBox, vehicleResult.reason);
      return;
    }

    // One planning run at a time - see the gate declaration above.
    if (!gate.tryBegin()) return;
    planInFlight = true;
    setLoading(true, serverIsMock === null ? 'Planning route…' : serverIsMock ? 'Planning synthetic route…' : 'Planning live route…');
    setActionsBusy(true);
    hideError(errorBox);
    startBusy();
    let focusOnSettle: HTMLElement | null = null;
    try {
      const req: PlanRequest = {
        origin: { label: origin.hit.label, lat: origin.hit.lat, lon: origin.hit.lon },
        destination: { label: destination.hit.label, lat: destination.hit.lat, lon: destination.hit.lon },
        startSocPct: startSoc,
      };
      if (vehicleResult.kind === 'ok') req.vehicle = vehicleResult.vehicle;
      const { plan } = await api.plan(req);
      onPlanAvailable(plan, map);
    } catch (err) {
      showPlanningError(errorBox, err, 'Planning failed.');
      // Context restore: the disabled button lost focus to <body> during
      // the wait - land back on the retry control once it re-enables.
      focusOnSettle = planButton;
    } finally {
      stopBusy();
      setLoading(false, 'Plan route');
      setActionsBusy(false);
      gate.end();
      planInFlight = false;
      // Keyboard focus returns to the retry control WITHOUT scrolling:
      // the failure is already revealed in place (renderPlanFailure
      // aligned it to the top); a scrolling focus would push it back
      // below the fold (the mobile long-error defect from rendered
      // review).
      // Restore only focus actually lost by disabling the submit control.
      // Do not interrupt someone who moved to another field during the wait.
      if (document.activeElement === document.body) {
        focusOnSettle?.focus({ preventScroll: true });
      }
    }
  });

  return { loadSavedRoute };
}

export function onPlanAvailable(plan: TripPlan, map: maplibregl.Map): void {
  drawTrip(map, {
    geometry: plan.geometry.map((p) => [p.lon, p.lat] as [number, number]),
    origin: plan.origin,
    destination: plan.destination,
    stops: plan.stops.map((s) => ({
      lat: s.station.lat,
      lon: s.station.lon,
      label: s.station.name,
      brand: s.station.brand,
    })),
  });
  const panel = document.getElementById('planner-panel') as HTMLElement;
  panel.querySelector<HTMLElement>('.saved-route-review')?.classList.add('hidden');
  renderPlanPanel(panel, map, plan);
  if (window.innerWidth <= 720) {
    panel.classList.add('open');
    // keep the FAB's expanded state true for assistive tech
    document.getElementById('sheet-open')?.setAttribute('aria-expanded', 'true');
    document.getElementById('sheet-open')?.classList.add('hidden');
  }
  // A disabled submit can drop keyboard focus to body during the wait.
  // Reveal the completed summary in that case, but never take focus from
  // another field/control the user deliberately reached while waiting.
  if (document.activeElement === document.body) {
    const results = panel.querySelector<HTMLElement>('.plan-results');
    results?.setAttribute('tabindex', '-1');
    results?.scrollIntoView({ block: 'start' });
    results?.focus({ preventScroll: true });
  }
}

type VehicleSelectionResult =
  | { kind: 'none' }
  | { kind: 'ok'; vehicle: PlanRequest['vehicle'] }
  | { kind: 'invalid'; reason: string };

/**
 * Read the vehicle selection from the form. Returns 'invalid' with an
 * explicit reason when a required input is missing - the real-world range
 * is the user's input and can never be silently skipped (claims never
 * substitute for it).
 */
function readVehicleSelection(vehicleRow: HTMLElement): VehicleSelectionResult {
  const select = vehicleRow.querySelector<HTMLSelectElement>('select[data-vehicle]');
  if (!select) return { kind: 'none' };
  if (select.value === 'default') return { kind: 'none' };

  if (select.value === 'custom') {
    const kwh = Number(vehicleRow.querySelector<HTMLInputElement>('input[data-custom-kwh]')?.value);
    // custom real-world input lives in the custom box: read within vehicleRow
    const rw = Number(vehicleRow.querySelector<HTMLInputElement>('input[data-real-world]')?.value);
    if (!Number.isFinite(kwh) || kwh < 5 || kwh > 250) {
      return { kind: 'invalid', reason: 'Enter a plausible battery size (kWh) for the custom vehicle.' };
    }
    if (!Number.isFinite(rw) || rw < 20 || rw > 1500) {
      return {
        kind: 'invalid',
        reason: 'Enter your real-world range for the custom vehicle - it cannot be left empty, and manufacturer claims never substitute for it.',
      };
    }
    return { kind: 'ok', vehicle: { custom: { batteryKwh: kwh, realWorldRangeKm: rw } } };
  }

  const entry = select.value;
  const rw = Number(vehicleRow.querySelector<HTMLInputElement>('input[data-real-world]')?.value);
  if (!Number.isFinite(rw) || rw < 20 || rw > 1500) {
    return {
      kind: 'invalid',
      reason:
        'Enter your real-world range with this vehicle (km) - it is required for planning; the manufacturer claim cannot stand in for it.',
    };
  }
  return { kind: 'ok', vehicle: { entryId: entry, realWorldRangeKm: rw } };
}

function buildVehicleSelect(vehicleRow: HTMLElement, catalog: VehicleCatalogEntry[], defaultId: string): void {
  vehicleRow.innerHTML = '';

  const label = el(`<label class="vehicle-label" for="vehicle-select">Vehicle</label>`);
  const select = el(`
    <select id="vehicle-select" data-vehicle>
      <option value="default">Tata Harrier EV (75 kWh) — default</option>
      ${catalog
        .filter((c) => c.id !== defaultId)
        .map(
          (c) =>
            `<option value="${c.id}">${c.make} ${c.model} (${c.variantLabel}) — claim ${c.claimedRangeKm} km</option>`,
        )
        .join('')}
      <option value="custom">Custom vehicle…</option>
    </select>
  `) as unknown as HTMLSelectElement;
  vehicleRow.append(label, select);

  const claimNote = el(`<p class="hint vehicle-claim hidden"></p>`);
  const rangeWrap = el(`<div class="real-world-range hidden"></div>`);
  const customWrap = el(`<div class="custom-vehicle hidden"></div>`);
  vehicleRow.append(claimNote, rangeWrap, customWrap);

  select.addEventListener('change', () => {
    claimNote.classList.add('hidden');
    rangeWrap.classList.add('hidden');
    customWrap.classList.add('hidden');
    claimNote.textContent = '';
    rangeWrap.innerHTML = '';
    customWrap.innerHTML = '';

    if (select.value === 'default') {
      return;
    }
    if (select.value === 'custom') {
      customWrap.classList.remove('hidden');
      customWrap.innerHTML = `
        <div class="field-row"><label for="custom-kwh">Battery size (kWh)</label>
          <input id="custom-kwh" data-custom-kwh type="number" min="5" max="250" step="0.1" placeholder="60" /></div>
        <div class="field-row"><label for="custom-range">Your real-world range (km)</label>
          <input id="custom-range" data-real-world type="number" min="20" max="1500" step="1" placeholder="350" /></div>
        <p class="hint">Real-world range is your input — we never derive it from manufacturer claims.</p>`;
      return;
    }
    const entry = catalog.find((c) => c.id === select.value);
    if (!entry) return;
    claimNote.textContent = `Manufacturer claim: ${entry.claimedRangeKm} km (MIDC) — not real-world range.`;
    claimNote.classList.remove('hidden');
    rangeWrap.classList.remove('hidden');
    rangeWrap.innerHTML = `
      <div class="field-row">
        <label for="rw-range">Your real-world range with this car (km)</label>
        <input id="rw-range" data-real-world type="number" min="20" max="1500" step="1" placeholder="e.g. 300" />
      </div>
      <p class="hint warn-hint">Required: planning needs your real-world range. Claims cannot stand in for it.</p>`;
  });
}

/** One origin/destination search field with debounced autocomplete. */
function makeSearchField(
  labelText: string,
  placeholder: string,
  field: 'origin' | 'destination',
  onPicked: (hit: GeocodeHit | null) => void,
): {
  wrap: HTMLElement;
  input: HTMLInputElement;
  invalidateSuggestions: () => void;
  setSavedPlace: (place: { label: string; lat: number; lon: number }) => void;
} {
  const letter = field === 'origin' ? 'A' : 'B';
  const wrap = el(`
    <div class="search-field" data-field="${field}">
      <label class="search-label">${labelText}</label>
      <div class="search-box">
        <span class="search-icon" aria-hidden="true">${letter}</span>
        <input type="search" placeholder="${placeholder}" aria-label="${labelText}" />
        <div class="suggestions hidden" role="listbox"></div>
      </div>
    </div>
  `);
  const input = wrap.querySelector('input') as HTMLInputElement;
  const list = wrap.querySelector('.suggestions') as HTMLElement;

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let activeIndex = -1;
  // Ordering guard for this field's geocode responses: a stale response
  // (late after a newer query, after the query was cleared, or after a
  // pick) must never repopulate or reopen the list. Pure module - see
  // geocode-session.test.ts for the deterministic ordering regressions.
  const session = new GeocodeSession();

  // Swap changes the field without emitting input. Cancel both pending
  // debounce and response ownership without touching its picked coordinates.
  const invalidateSuggestions = (): void => {
    session.invalidate();
    if (debounce) clearTimeout(debounce);
    debounce = null;
    list.replaceChildren();
    list.classList.add('hidden');
    activeIndex = -1;
  };

  input.addEventListener('input', () => {
    onPicked(null);
    invalidateSuggestions(); // old query choices and responses are stale
    const q = input.value.trim();
    if (q.length < 2) {
      list.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    debounce = setTimeout(async () => {
      // This dispatched query owns the list from here: late responses for
      // older sessions (or after a clear/pick) are discarded by the guard.
      const token = session.begin();
      try {
        const { hits } = await api.geocode(q);
        // Stale response, or focus left the field (blur orphan: the list
        // must not reopen while the user is elsewhere) - apply nothing.
        if (!session.isCurrent(token) || document.activeElement !== input) return;
        list.innerHTML = '';
        activeIndex = -1;
        if (hits.length === 0) {
          list.innerHTML = `<div class="suggestion-item empty">No places found — try the nearest town.</div>`;
          list.classList.remove('hidden');
          return;
        }
        const seen = new Set<string>();
        for (const h of hits) {
          // identity: name + rounded coords + admin context - Photon can
          // return the same OSM place under slightly different labels
          const key = `${h.name}::${h.lat.toFixed(3)},${h.lon.toFixed(3)}::${h.state ?? ''}::${h.city ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const index = seen.size - 1;
          const item = el(`<button type="button" class="suggestion-item" role="option">${escapeHtml(h.label)}</button>`);
          item.addEventListener('click', () => {
            // The session is complete: pending stragglers must not reopen
            // the list over the finished selection.
            session.invalidate();
            input.value = h.label;
            onPicked(h);
            list.classList.add('hidden');
            input.dispatchEvent(new Event('picked'));
          });
          item.addEventListener('mousemove', () => setActive(index));
          list.appendChild(item);
        }
        function setActive(idx: number): void {
          const items = list.querySelectorAll('.suggestion-item');
          items.forEach((n, ni) => n.classList.toggle('active', ni === idx));
          activeIndex = idx;
        }
        list.classList.remove('hidden');
      } catch {
        // A stale request's error must not hide a NEWER query's list.
        if (!session.isCurrent(token)) return;
        list.classList.add('hidden');
      }
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !list.classList.contains('hidden')) {
      // Dismiss the innermost popup first. Do not clear the search input
      // through its native Escape action or close the entire mobile sheet.
      e.preventDefault();
      e.stopPropagation();
      invalidateSuggestions();
      return;
    }
    const items = Array.from(list.querySelectorAll('.suggestion-item'));
    if (items.length === 0 || list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = activeIndex < 0
        ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
        : (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((n, i) => n.classList.toggle('active', i === activeIndex));
      (items[activeIndex] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      (items[activeIndex] as HTMLElement)?.click();
    }
  });

  input.addEventListener('blur', () => {
    // Allow suggestion clicks to register, but do not let an old blur
    // hide choices after the user has already returned to this field.
    setTimeout(() => {
      if (document.activeElement !== input) list.classList.add('hidden');
    }, 180);
  });
  input.addEventListener('focus', () => {
    if (list.children.length > 0) list.classList.remove('hidden');
  });

  // mobile: open panel when focusing search
  input.addEventListener('focus', () => {
    const panel = document.getElementById('planner-panel');
    if (window.innerWidth <= 720 && panel && !panel.classList.contains('open')) {
      panel.classList.add('open');
      document.getElementById('sheet-open')?.setAttribute('aria-expanded', 'true');
      document.getElementById('sheet-open')?.classList.add('hidden');
    }
  });

  // Saved coordinates come from storage, never from the geocoder. Invalidate
  // any pending query/response first so a late result cannot replace the
  // exact place the user chose when replanning.
  const setSavedPlace = (place: { label: string; lat: number; lon: number }): void => {
    onPicked(null);
    invalidateSuggestions();
    input.value = place.label;
    onPicked({ ...place, name: place.label, city: null, state: null, country: null });
    input.dispatchEvent(new Event('picked'));
  };

  return { wrap, input, invalidateSuggestions, setSavedPlace };
}

function showError(box: HTMLElement, message: string): void {
  box.textContent = message;
  box.classList.remove('hidden');
}

/**
 * Cause-true planning-failure presentation: guidance naming the ACTUAL
 * server cause (throttle vs budget vs auth vs coverage) plus the server's
 * full evidence message, with an honest per-cause toast. The old behavior
 * told every failure "the API is throttling - retry in a minute" - a lie
 * for budget-exhausted, auth and coverage failures.
 */
function showPlanningError(box: HTMLElement, err: unknown, fallback: string): void {
  const message = err instanceof Error ? err.message : fallback;
  const code =
    err instanceof ApiError
      ? err.code
      : err instanceof Error && 'code' in err
        ? String((err as { code: string }).code)
        : undefined;
  const cause = err instanceof ApiError ? err.cause : undefined;
  if (code === 'not_determined') {
    const guidance = planFailureGuidance(cause);
    renderPlanFailure(box, guidance, message);
    toast(guidance.toast, 'warn', 6000);
  } else {
    showError(box, message);
  }
}

/** Structured error box: headline, honest guidance, full server evidence
 *  (coverage counts, attempts, estimate). DOM-built with textContent -
 *  never innerHTML - so server text cannot inject markup. */
function renderPlanFailure(box: HTMLElement, guidance: PlanFailureGuidance, serverMessage: string): void {
  box.replaceChildren();
  const title = document.createElement('p');
  title.className = 'error-title';
  title.textContent = guidance.title;
  const detail = document.createElement('p');
  detail.className = 'error-detail';
  detail.textContent = guidance.detail;
  const raw = document.createElement('p');
  raw.className = 'error-raw';
  raw.textContent = serverMessage;
  box.append(title, detail, raw);
  box.classList.remove('hidden');
  // Keyboard reveal: align the failure to the TOP of the scrollport so
  // a long error is readable from its title down ('start' - 'nearest'
  // left the title pinned at the bottom edge with the details below
  // the fold). The later focus restore uses preventScroll, so this
  // reveal is what the user keeps.
  box.scrollIntoView({ block: 'start' });
}

function hideError(box: HTMLElement): void {
  box.classList.add('hidden');
  box.textContent = '';
}

export function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
