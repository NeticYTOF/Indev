/** fx/results — visual layer only. Never alters text, roles or accessible names.
 *
 *  - Scroll-driven reveal: result blocks spring in as they enter the panel.
 *  - Route spine: an energy pulse flows down the stop timeline.
 *  - Pointer-follow glow edges on cards (CSS vars only).
 *  - Arrival-charge mini battery that fills to the real arrival %.
 *  All injected nodes are aria-hidden and pointer-transparent.
 */
import './results.css';

function reduced(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.classList.contains('reduce-motion');
}

function deco(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

const REVEAL = [
  '.plan-head', '.trip-strip', '.plan-actions', '.journey-briefing',
  '.journey-leg', '.journey-battery-point', '.briefing-itinerary',
  '.decision-explanation', '.no-stops',
].join(',');

let io: IntersectionObserver | null = null;
let ioRoot: Element | null = null;

/** One long-lived observer per scroll root: re-creating it on every DOM
 *  change would drop targets that were queued but not yet revealed. */
function revealer(root: Element): IntersectionObserver {
  if (io && ioRoot === root) return io;
  io?.disconnect();
  ioRoot = root;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const t = e.target as HTMLElement;
      t.classList.add('fxr-in');
      io?.unobserve(t);
    }
  }, { root, rootMargin: '0px 0px -4% 0px', threshold: 0 });
  return io;
}

function arrivalBattery(results: HTMLElement): void {
  const cell = results.querySelector<HTMLElement>('.trip-strip .strip-cell.accent');
  if (!cell || cell.querySelector('.fxr-batt')) return;
  const num = cell.querySelector('.strip-num')?.textContent ?? '';
  const pct = Number(/(\d+(?:\.\d+)?)/.exec(num)?.[1]);
  if (!Number.isFinite(pct)) return;
  const batt = deco('span', 'fxr-batt');
  batt.style.setProperty('--pct', String(Math.max(0, Math.min(100, pct))));
  batt.dataset.tone = pct >= 45 ? 'high' : pct >= 20 ? 'mid' : 'low';
  batt.innerHTML = '<span class="fxr-batt-fill"><i></i></span><span class="fxr-batt-bolt">' +
    '<svg viewBox="0 0 12 16" width="9" height="12" focusable="false"><path d="M7 0 1 9h4l-1 7 6-9H6z" fill="currentColor"/></svg></span>';
  cell.appendChild(batt);
}

function spine(results: HTMLElement): void {
  // A travelling energy pulse inside each card's own rail line (the cards are
  // opaque black, so a shared spine behind them would be hidden).
  results.querySelectorAll<HTMLElement>('.stop-card .node-line').forEach((line, i) => {
    if (line.querySelector('.fxr-flow')) return;
    const flow = deco('span', 'fxr-flow');
    flow.style.setProperty('--fxr-i', String(i));
    line.appendChild(flow);
  });
}

function exitSigns(results: HTMLElement): void {
  results.querySelectorAll<HTMLElement>('.stop-node').forEach((node) => {
    if (node.querySelector('.fxr-exit')) return;
    const tag = deco('span', 'fxr-exit');
    tag.textContent = 'EXIT';
    node.appendChild(tag);
  });
}

function glowFollow(results: HTMLElement): void {
  if (results.dataset.fxrGlow) return;
  results.dataset.fxrGlow = '1';
  let frame = 0;
  let pending: { el: HTMLElement; x: number; y: number } | null = null;
  results.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const el = (ev.target as Element).closest<HTMLElement>('.stop-card, .plan-head, .trip-strip, .journey-briefing');
    if (!el) return;
    const r = el.getBoundingClientRect();
    pending = { el, x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      pending.el.style.setProperty('--fxr-x', `${pending.x}px`);
      pending.el.style.setProperty('--fxr-y', `${pending.y}px`);
      pending.el.classList.add('fxr-lit');
    });
  });
  results.addEventListener('pointerout', (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>('.fxr-lit');
    const to = ev.relatedTarget as Node | null;
    if (el && !(to && el.contains(to))) el.classList.remove('fxr-lit');
  });
}

function decorate(results: HTMLElement, panel: Element): void {
  arrivalBattery(results);
  spine(results);
  exitSigns(results);
  glowFollow(results);
  const items = results.querySelectorAll<HTMLElement>(REVEAL);
  if (reduced()) { items.forEach((i) => i.classList.add('fxr-in')); return; }
  const obs = revealer(panel);
  let n = 0;
  items.forEach((item) => {
    if (item.classList.contains('fxr-in') || item.classList.contains('fxr-wait')) return;
    item.classList.add('fxr-wait');
    item.style.setProperty('--fxr-d', `${Math.min(n++, 6) * 55}ms`);
    obs.observe(item);
  });
}

export function installResultsFx(): void {
  const boot = (): boolean => {
    const panel = document.getElementById('planner-panel');
    if (!panel) return false;
    const scroller = panel.closest('.panel') ?? panel;
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const results = panel.querySelector<HTMLElement>('.plan-results');
        if (results) decorate(results, scroller);
      });
    }).observe(panel, { childList: true, subtree: true });
    return true;
  };
  if (!boot()) {
    const wait = new MutationObserver(() => { if (boot()) wait.disconnect(); });
    wait.observe(document.body, { childList: true, subtree: true });
  }
}
