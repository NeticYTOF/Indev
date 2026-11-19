/**
 * Planner panel: origin/destination search with autocomplete, vehicle
 * selection (claimed vs user real-world range strictly separated),
 * start charge, and the plan action with honest error states.
 */
import * as maplibregl from 'maplibre-gl';
import type { GeocodeHit, VehicleCatalogEntry } from '@indeev/core';
import { api, type PlanRequest } from './api.js';
import type { TripPlan } from '@indeev/core';
import { drawTrip } from './map.js';
import { renderPlanPanel } from './plan-panel.js';
import { toast } from './toast.js';

interface PlaceInput {
  hit: GeocodeHit | null;
}

export function renderPlanner(root: HTMLElement, map: maplibregl.Map): void {
  root.innerHTML = '';

  const section = document.createElement('section');
  section.className = 'planner';
  root.appendChild(section);

  const origin: PlaceInput = { hit: null };
  const destination: PlaceInput = { hit: null };

  const form = el(`<form class="planner-form" autocomplete="off"></form>`) as HTMLFormElement;
  section.appendChild(form);

  const intro = el(`<p class="planner-intro">Fastest route with the fewest charging stops, planned over live Statiq chargers.</p>`);
  form.appendChild(intro);

  const originField = makeSearchField('From', 'Delhi', (hit) => {
    origin.hit = hit;
  });
  const destField = makeSearchField('To', 'Jaipur', (hit) => {
    destination.hit = hit;
  });
  form.append(originField.wrap, destField.wrap);

  const swap = el(`<button type="button" class="btn btn-ghost planner-swap" aria-label="Swap origin and destination">⇅</button>`) as HTMLButtonElement;
  swap.addEventListener('click', () => {
    const tmp = origin.hit;
    origin.hit = destination.hit;
    destination.hit = tmp;
    originField.input.value = origin.hit?.label ?? '';
    destField.input.value = destination.hit?.label ?? '';
  });
  form.appendChild(swap);

  // vehicle selector
  const vehicleWrap = el(`<div class="field-row vehicle-row"></div>`);
  const vehicleRow = el(`<div class="vehicle"></div>`);
  vehicleWrap.appendChild(vehicleRow);
  form.appendChild(vehicleWrap);

  let catalog: VehicleCatalogEntry[] = [];
  let defaultVehicle = 'tata-harrier-ev-75';
  void api.vehicles().then((res) => {
    catalog = res.catalog;
    defaultVehicle = res.default;
    buildVehicleSelect(vehicleRow, catalog, defaultVehicle);
  }).catch(() => {
    vehicleRow.innerHTML = '<p class="hint">Vehicle catalog unavailable (server offline?).</p>';
  });

  // start charge
  const socRow = el(`<div class="field-row soc-row"><label for="start-soc">Current charge</label><div class="soc-input"><input id="start-soc" type="number" min="5" max="100" step="1" value="100" inputmode="numeric" /><span class="unit">%</span></div></div>`);
  form.appendChild(socRow);

  // action
  const actions = el(`<div class="planner-actions"></div>`);
  const planButton = el(`<button type="submit" class="btn btn-primary planner-go">Plan route</button>`) as HTMLButtonElement;
  actions.appendChild(planButton);
  form.appendChild(actions);

  const errorBox = el(`<div class="error-box hidden" role="alert"></div>`);
  section.appendChild(errorBox);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!origin.hit || !destination.hit) {
      showError(errorBox, 'Pick both a starting point and a destination from the suggestions.');
      return;
    }
    const startSoc = Number((document.getElementById('start-soc') as HTMLInputElement).value);
    const vehicle = readVehicleSelection(vehicleRow);

    planButton.disabled = true;
    planButton.textContent = 'Planning live route…';
    hideError(errorBox);
    try {
      const req: PlanRequest = {
        origin: { label: origin.hit.label, lat: origin.hit.lat, lon: origin.hit.lon },
        destination: { label: destination.hit.label, lat: destination.hit.lat, lon: destination.hit.lon },
        startSocPct: Number.isFinite(startSoc) ? startSoc : undefined,
      };
      if (vehicle) req.vehicle = vehicle;
      const { plan } = await api.plan(req);
      onPlanAvailable(plan, map);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Planning failed.';
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'not_determined') {
        showError(errorBox, `${message}`);
        toast('Plan not determined — the charger API is throttling. Retry in a minute.', 'warn');
      } else {
        showError(errorBox, message);
      }
    } finally {
      planButton.disabled = false;
      planButton.textContent = 'Plan route';
    }
  });
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
  renderPlanPanel(panel, map, plan);
  if (window.innerWidth <= 720) {
    panel.classList.add('open');
  }
}

interface VehicleSelectionRead {
  entryId?: string;
  realWorldRangeKm?: number;
  custom?: { batteryKwh: number; claimedRangeKm?: number; realWorldRangeKm: number; label?: string };
}

function readVehicleSelection(vehicleRow: HTMLElement): VehicleSelectionRead | undefined {
  const select = vehicleRow.querySelector<HTMLSelectElement>('select[data-vehicle]');
  const rangeWrap = vehicleRow.querySelector<HTMLElement>('.real-world-range');
  if (!select) return undefined;
  if (select.value === 'default') return undefined;
  if (select.value === 'custom') {
    const kwh = Number(vehicleRow.querySelector<HTMLInputElement>('input[data-custom-kwh]')?.value);
    const rw = Number(rangeWrap?.querySelector<HTMLInputElement>('input[data-real-world]')?.value);
    if (!Number.isFinite(kwh) || !Number.isFinite(rw)) return undefined;
    return { custom: { batteryKwh: kwh, realWorldRangeKm: rw } };
  }
  const rwInput = rangeWrap?.querySelector<HTMLInputElement>('input[data-real-world]');
  const rw = rwInput && Number.isFinite(Number(rwInput.value)) ? Number(rwInput.value) : undefined;
  const sel: VehicleSelectionRead = { entryId: select.value };
  if (rw != null && rw > 0) sel.realWorldRangeKm = rw;
  return sel;
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
  onPicked: (hit: GeocodeHit | null) => void,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el(`
    <div class="search-field">
      <label class="search-label">${labelText}</label>
      <div class="search-box">
        <input type="search" placeholder="${placeholder}" aria-label="${labelText}" />
        <div class="suggestions hidden" role="listbox"></div>
      </div>
    </div>
  `);
  const input = wrap.querySelector('input') as HTMLInputElement;
  const list = wrap.querySelector('.suggestions') as HTMLElement;

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let activeIndex = -1;

  input.addEventListener('input', () => {
    onPicked(null);
    if (debounce) clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 2) {
      list.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    debounce = setTimeout(async () => {
      try {
        const { hits } = await api.geocode(q);
        list.innerHTML = '';
        activeIndex = -1;
        if (hits.length === 0) {
          list.innerHTML = `<div class="suggestion-item empty">No places found — try the nearest town.</div>`;
          list.classList.remove('hidden');
          return;
        }
        const pickedWrapper = wrap;
        hits.forEach((h, i) => {
          const item = el(`<button type="button" class="suggestion-item" role="option">${escapeHtml(h.label)}</button>`);
          item.addEventListener('click', () => {
            input.value = h.label;
            onPicked(h);
            list.classList.add('hidden');
            input.dispatchEvent(new Event('picked'));
            void pickedWrapper;
          });
          item.addEventListener('mousemove', () => setActive(i));
          list.appendChild(item);
        });
        function setActive(idx: number): void {
          const items = list.querySelectorAll('.suggestion-item');
          items.forEach((n, ni) => n.classList.toggle('active', ni === idx));
          activeIndex = idx;
        }
        void setActive;
        list.classList.remove('hidden');
      } catch {
        list.classList.add('hidden');
      }
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll('.suggestion-item'));
    if (items.length === 0 || list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = e.key === 'ArrowDown' ? (activeIndex + 1) % items.length : (activeIndex - 1 + items.length) % items.length;
      items.forEach((n, i) => n.classList.toggle('active', i === activeIndex));
      (items[activeIndex] as HTMLElement)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      (items[activeIndex] as HTMLElement)?.click();
    }
  });

  input.addEventListener('blur', () => {
    // slight delay so click on suggestion registers before the list hides
    setTimeout(() => list.classList.add('hidden'), 180);
  });
  input.addEventListener('focus', () => {
    if (list.children.length > 0) list.classList.remove('hidden');
  });

  // mobile: open panel when focusing search
  input.addEventListener('focus', () => {
    const panel = document.getElementById('planner-panel');
    if (window.innerWidth <= 720 && panel && !panel.classList.contains('open')) {
      panel.classList.add('open');
    }
  });

  return { wrap, input };
}

function showError(box: HTMLElement, message: string): void {
  box.textContent = message;
  box.classList.remove('hidden');
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
