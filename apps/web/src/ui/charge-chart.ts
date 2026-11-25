/**
 * Battery-along-the-route chart, in the Bklit UI style (clean area/line
 * chart, a scrubbing crosshair and a live readout), built on d3 directly
 * because Bklit is React-only and this app is vanilla.
 *
 * - X is route distance (km), Y is battery % (0-100). The series is the
 *   real planned profile: start charge, then for each stop the arrival dip
 *   and the post-charge jump at the same chainage, then destination arrival.
 * - Solid colour only. The area under the line is a flat translucent fill.
 * - The readout uses NumberFlow so values roll instead of snapping.
 * - Pure presentation: built from plan facts, nothing is estimated. When
 *   the facts needed for a truthful line are missing, no chart renders.
 */
import { area, line } from 'd3-shape';
import { scaleLinear } from 'd3-scale';
import { bisector } from 'd3-array';
import 'number-flow';
import type NumberFlow from 'number-flow';

export interface ChargePoint {
  /** Route chainage in km. */
  km: number;
  /** Battery percentage at this point. */
  soc: number;
  /** What happens here: departure, arrival at a stop, leaving it, or arriving. */
  kind: 'start' | 'arrive' | 'leave' | 'destination';
  label: string;
}

export interface ChargeChartSource {
  startSocPct?: unknown;
  stops?: readonly unknown[] | null;
  totals?: { distanceKm?: unknown; finalSocPct?: unknown } | null;
  origin?: { label?: unknown } | null;
  destination?: { label?: unknown } | null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function num(v: unknown, min = -Infinity, max = Infinity): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
function text(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/**
 * Builds the series from plan facts. Returns null (no chart) when any fact
 * the line needs is missing or out of order, rather than drawing a guess.
 */
export function chargeSeries(plan: ChargeChartSource): ChargePoint[] | null {
  const start = num(plan.startSocPct, 0, 100);
  const totalKm = num(plan.totals?.distanceKm, 0);
  const finalSoc = num(plan.totals?.finalSocPct, 0, 100);
  if (start == null || totalKm == null || totalKm <= 0 || finalSoc == null || !Array.isArray(plan.stops)) return null;
  const points: ChargePoint[] = [{ km: 0, soc: start, kind: 'start', label: text(plan.origin?.label, 'Start') }];
  let lastKm = 0;
  for (const raw of plan.stops) {
    const stop = rec(raw);
    const km = num(stop?.chainageKm, 0);
    const arrive = num(stop?.arriveSocPct, 0, 100);
    const leave = num(stop?.leaveSocPct, 0, 100);
    if (km == null || arrive == null || leave == null || km < lastKm || km > totalKm) return null;
    const name = text(rec(stop?.station)?.name, 'Charging stop');
    points.push({ km, soc: arrive, kind: 'arrive', label: name });
    points.push({ km, soc: leave, kind: 'leave', label: name });
    lastKm = km;
  }
  points.push({ km: totalKm, soc: finalSoc, kind: 'destination', label: text(plan.destination?.label, 'Destination') });
  return points;
}

const M = { top: 18, right: 14, bottom: 26, left: 34 };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function kindText(p: ChargePoint): string {
  switch (p.kind) {
    case 'start': return 'Leaving';
    case 'arrive': return 'Arriving at';
    case 'leave': return 'Leaving';
    default: return 'Arriving at';
  }
}

/** Mounts the chart into `host`. Returns false (and renders nothing) without a truthful series. */
export function mountChargeChart(host: HTMLElement, plan: ChargeChartSource): boolean {
  const series = chargeSeries(plan);
  if (!series) return false;
  // chargeSeries always yields start + destination, so these exist.
  const first = series[0] as ChargePoint;
  const last = series[series.length - 1] as ChargePoint;
  host.classList.add('cc');
  const totalKm = last.km;
  const minSoc = Math.min(...series.map((p) => p.soc));
  const low = series.find((p) => p.soc === minSoc) as ChargePoint;
  const summary = `Battery along the route: starts at ${Math.round(first.soc)}%, ` +
    `lowest ${Math.round(minSoc)}% at ${low.label}, arrives with ${Math.round(last.soc)}% after ${Math.round(totalKm)} km.`;
  host.innerHTML =
    `<header class="cc-head">` +
      `<div><h4 class="cc-title">Battery along the route</h4>` +
      `<p class="cc-sub">Planned charge at every kilometre. Hover or drag to scrub.</p></div>` +
      `<div class="cc-readout" aria-hidden="true">` +
        `<span class="cc-read-soc"><number-flow class="cc-nf-soc"></number-flow><i>%</i></span>` +
        `<span class="cc-read-km"><number-flow class="cc-nf-km"></number-flow> km</span>` +
        `<span class="cc-read-where"></span>` +
      `</div>` +
    `</header>` +
    `<div class="cc-plot"><svg role="img" aria-label="${esc(summary)}"></svg></div>`;

  const plot = host.querySelector('.cc-plot') as HTMLElement;
  const svg = host.querySelector('svg') as SVGSVGElement;
  const nfSoc = host.querySelector('.cc-nf-soc') as NumberFlow;
  const nfKm = host.querySelector('.cc-nf-km') as NumberFlow;
  const where = host.querySelector('.cc-read-where') as HTMLElement;
  nfSoc.format = { maximumFractionDigits: 0 };
  nfKm.format = { maximumFractionDigits: 0 };

  const byKm = bisector<ChargePoint, number>((d) => d.km).right;
  /** SoC at a chainage: linear between facts; at a stop, the post-charge value. */
  const socAt = (km: number): number => {
    const i = Math.min(Math.max(byKm(series, km), 1), series.length - 1);
    const a = series[i - 1] as ChargePoint;
    const b = series[i] as ChargePoint;
    const t = b.km === a.km ? 1 : (km - a.km) / (b.km - a.km);
    return a.soc + (b.soc - a.soc) * Math.min(Math.max(t, 0), 1);
  };

  let x = scaleLinear();
  let y = scaleLinear();
  let drawn = false;
  let width = 0;

  const draw = (): void => {
    const W = Math.round(plot.clientWidth);
    const H = Math.round(plot.clientHeight);
    if (W < 40 || H < 40 || W === width) return;
    width = W;
    x = scaleLinear().domain([0, totalKm]).range([M.left, W - M.right]);
    y = scaleLinear().domain([0, 100]).range([H - M.bottom, M.top]);
    // Linear between facts: a smoothing curve could overshoot a real reading.
    const linePath = line<ChargePoint>().x((d) => x(d.km)).y((d) => y(d.soc))(series) ?? '';
    const areaPath = area<ChargePoint>().x((d) => x(d.km)).y0(y(0)).y1((d) => y(d.soc))(series) ?? '';
    const yTicks = [0, 25, 50, 75, 100];
    const xTicks = x.ticks(W < 420 ? 3 : 5).filter((t) => t > 0 && x(totalKm) - x(t) > 46);
    const stops = series.filter((p) => p.kind === 'arrive' || p.kind === 'leave');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.innerHTML =
      `<g class="cc-grid">${yTicks.map((t) => `<line x1="${M.left}" x2="${W - M.right}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>` +
      `<g class="cc-yaxis">${yTicks.map((t) => `<text x="${M.left - 8}" y="${y(t)}" dy="0.32em">${t}</text>`).join('')}</g>` +
      `<g class="cc-xaxis">${xTicks.map((t) => `<text x="${x(t)}" y="${H - 6}">${t}</text>`).join('')}` +
        `<text x="${W - M.right}" y="${H - 6}" class="cc-x-end">${Math.round(totalKm)} km</text></g>` +
      `<path class="cc-area" d="${areaPath}"/>` +
      `<path class="cc-line" d="${linePath}" pathLength="1"/>` +
      `<g class="cc-stops">${stops.map((p, i) => `<circle class="cc-stop" data-kind="${p.kind}" style="--i:${i >> 1}" cx="${x(p.km)}" cy="${y(p.soc)}" r="4"/>`).join('')}</g>` +
      `<g class="cc-cursor"><line class="cc-cursor-line" y1="${M.top}" y2="${H - M.bottom}"/><circle class="cc-cursor-dot" r="5"/></g>`;
    // Entrance motion plays once; later resizes redraw without replaying it.
    if (drawn) svg.classList.add('cc-settled');
    drawn = true;
  };

  const show = (km: number, label: string, on: boolean): void => {
    const soc = socAt(km);
    const cursor = svg.querySelector('.cc-cursor');
    const cline = svg.querySelector('.cc-cursor-line');
    const cdot = svg.querySelector('.cc-cursor-dot');
    if (cursor && cline && cdot) {
      const px = String(x(km));
      cline.setAttribute('x1', px);
      cline.setAttribute('x2', px);
      cdot.setAttribute('cx', px);
      cdot.setAttribute('cy', String(y(soc)));
      cursor.classList.toggle('is-on', on);
    }
    nfSoc.update(Math.round(soc));
    nfKm.update(Math.round(km));
    where.textContent = label;
  };
  const rest = (): void => {
    show(last.km, `${kindText(last)} ${last.label}`, false);
  };

  const fromEvent = (ev: PointerEvent): void => {
    const box = svg.getBoundingClientRect();
    if (box.width <= 0) return;
    const px = ev.clientX - box.left;
    const km = Math.min(Math.max(x.invert(px), 0), totalKm);
    // Snap to a stop when the pointer is close, so stop values are exact.
    const stop = series.find((p) => p.kind === 'leave' && Math.abs(x(p.km) - px) <= 10);
    if (stop) {
      const arrived = series[series.indexOf(stop) - 1] ?? stop;
      show(stop.km, `${stop.label}: ${Math.round(arrived.soc)}% → ${Math.round(stop.soc)}%`, true);
    } else {
      show(km, km <= 0 ? `Leaving ${first.label}` : 'On the road', true);
    }
  };
  svg.addEventListener('pointermove', fromEvent);
  svg.addEventListener('pointerdown', (ev) => fromEvent(ev));
  svg.addEventListener('pointerleave', rest);
  svg.addEventListener('pointerup', (ev) => { if (ev.pointerType !== 'mouse') rest(); });

  draw();
  rest();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!host.isConnected) { ro.disconnect(); return; }
      draw();
      rest();
    });
    ro.observe(plot);
  }
  return true;
}
