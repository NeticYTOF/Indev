/**
 * Delight layer — "Chhotu's Highway".
 *
 * Everything here is decorative and observer-driven: it watches the DOM
 * the app already renders and reacts (mascot moods, confetti, counters,
 * ripples, spotlight). It never writes into nodes the app owns except
 * for adding classes/CSS variables, and every node it creates is
 * aria-hidden and non-focusable. Text the app shows stays byte-identical:
 * numbers "count up" on an aria-hidden overlay, never on the real text.
 *
 * Under prefers-reduced-motion: Chhotu still appears and speaks (static),
 * but no confetti, counters, ripples, magnetism or parallax run.
 */
import { createMascot, type MascotHandle, type Mood } from './mascot.js';
import { line, greetingKey, type LineKey } from './voice.js';

let installed = false;
let hero: MascotHandle | null = null;
let dock: MascotHandle | null = null;
let lastSpoken = 0;

function reduced(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Both mascots react together (hero in the planner, dock over the map). */
function react(mood: Mood, key?: LineKey, opts: { hold?: number; base?: boolean; force?: boolean } = {}): void {
  for (const m of [hero, dock]) {
    if (!m) continue;
    if (opts.base) m.setMood(mood);
    else m.setMood(mood, opts.hold ?? 1800);
  }
  if (key) {
    const t = performance.now();
    // Don't chatter: at most one new line every 900ms unless forced.
    if (!opts.force && t - lastSpoken < 900) return;
    lastSpoken = t;
    const text = line(key);
    visibleMascot()?.say(text);
  }
}

/** The mascot the user can actually see right now. */
function visibleMascot(): MascotHandle | null {
  const panel = document.getElementById('planner-panel');
  const heroVisible = hero?.root.isConnected && hero.root.getBoundingClientRect().height > 0
    && panel && getComputedStyle(panel).visibility !== 'hidden';
  if (heroVisible) {
    const r = hero!.root.getBoundingClientRect();
    if (r.bottom > 0 && r.top < window.innerHeight) return hero;
  }
  return dock ?? hero;
}

export function installDelight(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.documentElement.classList.add('delight');
  mountDock();
  mountHero();
  watchApp();
  installEasterEggs();
  installFieldStates();
  installQuickRoutes();
  installGaugeDrag();
  installSheetDrag();
  installShortcuts();
  installConnectivity();
  if (!reduced()) {
    installSpotlight();
    installRipples();
    installMagnets();
    installTilt();
  }
  greet();
}

/* ------------------------------------------------------------------ */
/* Mascot mounts                                                       */
/* ------------------------------------------------------------------ */

function mountHero(): void {
  const head = document.querySelector<HTMLElement>('.planner-head');
  if (!head || head.querySelector('.hero-stage')) return;
  const stage = document.createElement('div');
  stage.className = 'hero-stage';
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML = `
    <div class="hero-sky">${'<i></i>'.repeat(14)}</div>
    <div class="hero-road"><span class="hero-lane"></span></div>
    <div class="hero-km"><b>IndEV</b><span>0 km</span></div>`;
  head.after(stage);
  hero = createMascot(stage, { size: '92px', plate: 'EV 0' });
  hero.root.classList.add('hero-mascot');
}

function mountDock(): void {
  const app = document.getElementById('app');
  if (!app || document.querySelector('.mascot-dock')) return;
  const dockEl = document.createElement('div');
  dockEl.className = 'mascot-dock';
  dockEl.setAttribute('aria-hidden', 'true');
  app.appendChild(dockEl);
  dock = createMascot(dockEl, { size: '64px', plate: 'EV' });
}

function greet(): void {
  let returning = false;
  try {
    returning = localStorage.getItem('indeev-met-chhotu') === '1';
    localStorage.setItem('indeev-met-chhotu', '1');
  } catch {
    // storage may be blocked; Chhotu just introduces itself again
  }
  const booting = document.documentElement.classList.contains('boot-on');
  window.setTimeout(() => {
    hero?.hop();
    react('cheer', greetingKey(new Date().getHours(), returning), { hold: 1400, force: true });
  }, booting ? 1700 : 500);
}

/* ------------------------------------------------------------------ */
/* Watching the app                                                    */
/* ------------------------------------------------------------------ */

function watchApp(): void {
  const form = document.querySelector<HTMLFormElement>('.planner-form');
  const panel = document.getElementById('planner-panel');
  if (!form || !panel) return;

  // Typing & picking places
  let typingTimer: number | null = null;
  form.addEventListener('input', (e) => {
    const t = e.target as HTMLElement | null;
    if (!(t instanceof HTMLInputElement) || t.getAttribute('role') !== 'combobox') return;
    const field = t.closest<HTMLElement>('.search-field')?.dataset.field;
    if (typingTimer === null) react('typing', field === 'destination' ? 'typingTo' : 'typingFrom', { hold: 2400 });
    else for (const m of [hero, dock]) m?.setMood('typing', 2400);
    if (typingTimer !== null) window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => { typingTimer = null; }, 2600);
  });
  form.addEventListener('picked', (e) => {
    const t = e.target as HTMLElement | null;
    const box = t?.closest<HTMLElement>('.search-box');
    if (box && !reduced()) {
      box.classList.remove('just-picked');
      void box.offsetWidth;
      box.classList.add('just-picked');
      burst(box, 10, 'pick');
    }
    hero?.hop();
    const field = t?.closest<HTMLElement>('.search-field');
    field?.setAttribute('data-picked', '');
    field?.removeAttribute('data-pending');
    const picked = document.querySelectorAll('.route-fields .search-field[data-picked]').length;
    react('cheer', picked >= 2 ? 'ready' : field?.dataset.field === 'origin' ? 'nowTo' : 'picked', { hold: 1300, force: true });
    updateRoadProgress();
  }, true);

  // Swap
  form.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (t?.closest('.planner-swap')) {
      react('dizzy', 'swap', { hold: 900 });
      document.querySelector('.route-fields')?.classList.remove('swapped');
      void (document.querySelector('.route-fields') as HTMLElement | null)?.offsetWidth;
      document.querySelector('.route-fields')?.classList.add('swapped');
    }
    const step = t?.closest<HTMLButtonElement>('.stepper-btn');
    if (step) {
      window.setTimeout(() => {
        const v = parseInt(document.querySelector('.stepper-value')?.textContent ?? '', 10);
        if (!Number.isFinite(v)) return;
        for (const m of [hero, dock]) m?.plate(`EV ${v}%`);
        if (v >= 100) react('love', 'chargeFull', { hold: 1600 });
        else if (v <= 20) react('worried', 'chargeLow', { hold: 1800 });
        else react('charging', Number(step.dataset.step) > 0 ? 'chargeUp' : 'chargeDown', { hold: 900 });
        const gauge = document.querySelector<HTMLElement>('.soc-gauge');
        if (gauge && !reduced() && Number(step.dataset.step) > 0) sparkAt(gauge, v);
      }, 0);
    }
  });

  // Planning state: aria-busy on the form is the app's own truth.
  const busyObserver = new MutationObserver(() => {
    const busy = form.getAttribute('aria-busy') === 'true';
    document.documentElement.classList.toggle('is-planning', busy);
    if (busy) {
      react('thinking', 'planning', { base: true, force: true });
      startPlanningChatter();
    } else {
      stopPlanningChatter();
      for (const m of [hero, dock]) m?.setMood('idle');
    }
  });
  busyObserver.observe(form, { attributes: true, attributeFilter: ['aria-busy'] });

  // Errors (role=alert box) and new results.
  const errorObserver = new MutationObserver(() => {
    const box = panel.querySelector<HTMLElement>('.error-box');
    if (box && !box.classList.contains('hidden') && box.textContent?.trim()) {
      const text = box.textContent;
      react('worried', /Pick both/.test(text) ? 'needPlaces' : 'failed', { hold: 3200, force: true });
    }
  });
  const watchError = (): void => {
    const box = panel.querySelector<HTMLElement>('.error-box');
    if (box) errorObserver.observe(box, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });
  };
  watchError();

  let lastResults: Element | null = null;
  const panelObserver = new MutationObserver(() => {
    const results = panel.querySelector('.plan-results');
    if (results && results !== lastResults) {
      lastResults = results;
      onResults(results as HTMLElement);
    } else if (results && results.childElementCount > 0 && !results.hasAttribute('data-delight')) {
      onResults(results as HTMLElement);
    }
    if (!results) lastResults = null;
  });
  panelObserver.observe(panel, { childList: true, subtree: true });

  // Saved-trip drawer
  const drawer = document.getElementById('trips-drawer');
  if (drawer) {
    new MutationObserver(() => {
      if (drawer.classList.contains('hidden')) return;
      decorateDrawer(drawer);
    }).observe(drawer, { attributes: true, attributeFilter: ['class'], childList: true });
  }

  // Toasts: Chhotu echoes tone.
  const toastRoot = document.getElementById('toast-root');
  if (toastRoot) {
    new MutationObserver(() => {
      const t = toastRoot.querySelector('.toast');
      if (!t) return;
      const text = t.textContent ?? '';
      if (/^Trip saved\./.test(text)) { react('love', 'saved', { hold: 1800, force: true }); confetti(28); }
      else if (/downloaded/i.test(text)) react('cheer', 'exported', { hold: 1400 });
      else if (/Server status unavailable/.test(text)) react('worried', 'offline', { hold: 2600, force: true });
      else if (t.classList.contains('bad')) react('worried', 'failed', { hold: 2200 });
    }).observe(toastRoot, { childList: true });
  }

  // Save-unknown storage warning
  new MutationObserver(() => {
    const warn = panel.querySelector('[data-storage-warning]:not([data-delight])');
    if (warn) { warn.setAttribute('data-delight', ''); react('worried', 'unsure', { hold: 2400, force: true }); }
  }).observe(panel, { childList: true, subtree: true });

  updateRoadProgress();
}

let chatterTimer: number | null = null;
function startPlanningChatter(): void {
  stopPlanningChatter();
  let n = 0;
  chatterTimer = window.setInterval(() => {
    n += 1;
    visibleMascot()?.say(line(n > 3 ? 'planningLong' : 'planning'), 2600);
  }, 6500);
}
function stopPlanningChatter(): void {
  if (chatterTimer !== null) window.clearInterval(chatterTimer);
  chatterTimer = null;
}

/** The mini road in the hero fills as places get picked. */
function updateRoadProgress(): void {
  const stage = document.querySelector<HTMLElement>('.hero-stage');
  if (!stage) return;
  const filled = Array.from(document.querySelectorAll<HTMLInputElement>('.route-fields input[role="combobox"]'))
    .filter((i) => i.value.trim().length > 0).length;
  stage.dataset.progress = String(filled);
}

function onResults(results: HTMLElement): void {
  if (results.childElementCount === 0) return;
  results.setAttribute('data-delight', '');
  const synthetic = Boolean(results.querySelector('.banner-synthetic'));
  const incomplete = Boolean(results.querySelector('.banner-warn'));
  const noStops = Boolean(results.querySelector('.no-stops'));
  const stopCount = results.querySelectorAll('.stop-card').length;
  hero?.hop();
  dock?.hop();
  let key: LineKey = 'planned';
  if (incomplete) key = 'plannedIncomplete';
  else if (noStops) key = 'plannedNoStops';
  else if (stopCount >= 3) key = 'plannedManyStops';
  // Synthetic is said second so the honest "pretend data" note lands last.
  react(incomplete ? 'curious' : 'cheer', key, { hold: 2600, force: true });
  if (synthetic) window.setTimeout(() => react('pretend', 'plannedSynthetic', { hold: 2600, force: true }), 2600);
  if (!incomplete) confetti(stopCount >= 3 ? 70 : 46);
  decorateResults(results);
}

/* ------------------------------------------------------------------ */
/* Results decoration (aria-hidden overlays only)                      */
/* ------------------------------------------------------------------ */

function decorateResults(results: HTMLElement): void {
  // Number tickers: an aria-hidden twin counts up over the real number,
  // which stays in the DOM (and readable) the whole time.
  if (!reduced()) {
    results.querySelectorAll<HTMLElement>('.strip-num').forEach((num, i) => countUp(num, 160 + i * 90));
  }
  // Road "story" ribbon between head and strip: one chip per leg.
  const strip = results.querySelector('.trip-strip');
  const stops = results.querySelectorAll('.stop-card');
  if (strip && !results.querySelector('.trip-ribbon')) {
    const ribbon = document.createElement('div');
    ribbon.className = 'trip-ribbon';
    ribbon.setAttribute('aria-hidden', 'true');
    const nodes = ['<span class="rb-node rb-a">A</span>'];
    stops.forEach((_, i) => nodes.push(`<span class="rb-leg"><i></i></span><span class="rb-node rb-stop" style="--n:${i + 1}"><svg viewBox="0 0 12 16"><path d="M7 0 1 9h4l-1 7 6-9H6z"/></svg></span>`));
    nodes.push('<span class="rb-leg"><i></i></span><span class="rb-node rb-b">B</span>');
    ribbon.innerHTML = `<div class="rb-track">${nodes.join('')}</div><div class="rb-car">${carSvg()}</div>`;
    strip.before(ribbon);
  }
  // Stop cards get their index for staggered entrances.
  stops.forEach((card, i) => (card as HTMLElement).style.setProperty('--si', String(i)));
}

function carSvg(): string {
  return `<svg viewBox="0 0 40 22" aria-hidden="true"><path class="car-body" d="M4 14c0-3 1-5 4-6l5-5c1-1 2-1 3-1h9c2 0 3 1 4 2l4 4c3 0 5 2 5 5v2c0 1-1 2-2 2H6c-1 0-2-1-2-2z"/><path class="car-glass" d="M14 4h6v5h-10zM22 4h3c1 0 2 1 3 2l2 3h-8z"/><circle class="car-wheel" cx="11" cy="17" r="3.4"/><circle class="car-wheel" cx="30" cy="17" r="3.4"/><path class="car-bolt" d="M21 10l-3 4h2l-1 3 3-4h-2z"/></svg>`;
}

function countUp(num: HTMLElement, delay: number): void {
  if (num.classList.contains('is-counting') || num.classList.contains('counted')) return;
  // The real text is never touched: the rolling digits are a CSS
  // generated overlay (::after content from --tick, empty alt text), so
  // innerText and the accessible name stay exact throughout.
  const first = num.firstChild;
  const raw = first && first.nodeType === Node.TEXT_NODE ? first.textContent ?? '' : '';
  const match = raw.match(/^(\D*)(\d[\d,]*)(.*)$/s);
  if (!match) return;
  const [, pre, digits, post] = match as unknown as [string, string, string, string];
  const target = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(target) || target === 0) return;
  const unit = num.querySelector('.unit')?.textContent ?? '';
  const grouped = digits.includes(',');
  const fmt = (n: number): string => grouped ? n.toLocaleString('en-IN') : String(n);
  const set = (n: number): void => {
    num.style.setProperty('--tick', JSON.stringify(`${pre}${fmt(n)}${post}${unit ? ` ${unit}` : ''}`));
  };
  num.classList.add('is-counting');
  set(0);
  const dur = 900;
  const t0 = performance.now() + delay;
  const step = (t: number): void => {
    if (!num.isConnected) return;
    const p = Math.max(0, Math.min(1, (t - t0) / dur));
    set(Math.round(target * (1 - Math.pow(1 - p, 4))));
    if (p < 1) requestAnimationFrame(step);
    else {
      num.classList.remove('is-counting');
      num.style.removeProperty('--tick');
      num.classList.add('counted');
    }
  };
  requestAnimationFrame(step);
}

function decorateDrawer(drawer: HTMLElement): void {
  const head = drawer.querySelector('.drawer-head');
  if (head && !head.querySelector('.drawer-mascot')) {
    const slot = document.createElement('div');
    slot.className = 'drawer-mascot';
    slot.setAttribute('aria-hidden', 'true');
    head.prepend(slot);
    const m = createMascot(slot, { size: '46px', bubble: false, plate: 'DIARY' });
    m.setMood('curious', 1400);
    react('curious', 'drawerOpen', { hold: 1400 });
  }
  const list = drawer.querySelector('.trip-list');
  if (list && !list.querySelector('.trip-row') && /No saved trips yet/.test(list.textContent ?? '') && !list.querySelector('.empty-road')) {
    const art = document.createElement('div');
    art.className = 'empty-road';
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML = `<div class="er-road"><i></i><i></i><i></i><i></i><i></i></div><p>${line('drawerEmpty')}</p>`;
    list.prepend(art);
  }
  drawer.querySelectorAll<HTMLElement>('.trip-row').forEach((row, i) => row.style.setProperty('--ri', String(i)));
}

/* ------------------------------------------------------------------ */
/* Particles                                                           */
/* ------------------------------------------------------------------ */

const CONFETTI_COLORS = ['#ffc72c', '#f5f5f2', '#4ade80', '#6cb4ff', '#ff7a59', '#a9b6ff'];

function fxLayer(): HTMLElement {
  let layer = document.querySelector<HTMLElement>('.fx-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

/** Confetti rendered with Web Animations, removed on finish. */
export function confetti(count = 40, origin?: { x: number; y: number }): void {
  if (reduced()) return;
  const layer = fxLayer();
  const panel = document.getElementById('planner-panel')?.getBoundingClientRect();
  const ox = origin?.x ?? (panel && panel.width < window.innerWidth ? panel.left + panel.width / 2 : window.innerWidth / 2);
  const oy = origin?.y ?? Math.min(window.innerHeight * 0.35, 280);
  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('i');
    const shape = i % 3;
    p.className = `confetti c${shape}`;
    p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length] as string;
    p.style.left = `${ox}px`;
    p.style.top = `${oy}px`;
    layer.appendChild(p);
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const power = 120 + Math.random() * 260;
    const dx = Math.cos(angle) * power;
    const dy = Math.sin(angle) * power * 0.7 - 140;
    const spin = (Math.random() - 0.5) * 900;
    const anim = p.animate([
      { transform: 'translate(-50%,-50%) scale(0.4) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy * 0.7}px)) scale(1) rotate(${spin * 0.6}deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 380}px)) scale(0.9) rotate(${spin}deg)`, opacity: 0 },
    ], { duration: 1400 + Math.random() * 900, easing: 'cubic-bezier(.2,.7,.3,1)' });
    anim.onfinish = () => p.remove();
    anim.oncancel = () => p.remove();
  }
}

function burst(el: HTMLElement, count: number, kind: string): void {
  const r = el.getBoundingClientRect();
  const layer = fxLayer();
  for (let i = 0; i < count; i += 1) {
    const p = document.createElement('i');
    p.className = `spark spark-${kind}`;
    p.style.left = `${r.right - 22}px`;
    p.style.top = `${r.top + r.height / 2}px`;
    layer.appendChild(p);
    const a = (Math.PI * 2 * i) / count;
    const d = 18 + Math.random() * 22;
    const anim = p.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(0)`, opacity: 0 },
    ], { duration: 520 + Math.random() * 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
    anim.onfinish = () => p.remove();
    anim.oncancel = () => p.remove();
  }
}

function sparkAt(gauge: HTMLElement, pct: number): void {
  const r = gauge.getBoundingClientRect();
  const x = r.left + (r.width - 9) * Math.min(1, pct / 100);
  const layer = fxLayer();
  for (let i = 0; i < 7; i += 1) {
    const p = document.createElement('i');
    p.className = 'spark spark-bolt';
    p.style.left = `${x}px`;
    p.style.top = `${r.top + r.height / 2}px`;
    layer.appendChild(p);
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const d = 16 + Math.random() * 26;
    const anim = p.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(0.2)`, opacity: 0 },
    ], { duration: 460 + Math.random() * 240, easing: 'ease-out' });
    anim.onfinish = () => p.remove();
    anim.oncancel = () => p.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Pointer delights                                                    */
/* ------------------------------------------------------------------ */

function installSpotlight(): void {
  let raf = 0;
  let x = 0;
  let y = 0;
  window.addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      document.documentElement.style.setProperty('--mx', `${x}px`);
      document.documentElement.style.setProperty('--my', `${y}px`);
      const panel = document.getElementById('planner-panel');
      if (panel) {
        const r = panel.getBoundingClientRect();
        panel.style.setProperty('--px', `${x - r.left}px`);
        panel.style.setProperty('--py', `${y - r.top + panel.scrollTop}px`);
      }
    });
  }, { passive: true });
}

/** Click ripples on every button/chip (aria-hidden span, self-removing). */
function installRipples(): void {
  document.addEventListener('pointerdown', (e) => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.btn, .chip-btn, .sheet-fab, .stepper-btn, .planner-swap, .suggestion-item') : null;
    if (!target || (target as HTMLButtonElement).disabled) return;
    const r = target.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.setAttribute('aria-hidden', 'true');
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - r.left - size / 2}px`;
    ripple.style.top = `${e.clientY - r.top - size / 2}px`;
    target.appendChild(ripple);
    const anim = ripple.animate([
      { transform: 'scale(0)', opacity: 0.38 },
      { transform: 'scale(1)', opacity: 0 },
    ], { duration: 620, easing: 'cubic-bezier(.2,.7,.2,1)' });
    anim.onfinish = () => ripple.remove();
    anim.oncancel = () => ripple.remove();
  });
}

/** Primary buttons lean toward the cursor a little (transform only). */
function installMagnets(): void {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  document.addEventListener('pointermove', (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('.planner-go, .sheet-fab, .plan-actions [data-save], .chip-btn') : null;
    document.querySelectorAll<HTMLElement>('.magnet-on').forEach((m) => {
      if (m !== t) { m.classList.remove('magnet-on'); m.style.removeProperty('--mag-x'); m.style.removeProperty('--mag-y'); }
    });
    if (!t || (t as HTMLButtonElement).disabled) return;
    const r = t.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    t.classList.add('magnet-on');
    t.style.setProperty('--mag-x', `${(dx * 4).toFixed(2)}px`);
    t.style.setProperty('--mag-y', `${(dy * 3).toFixed(2)}px`);
    t.style.setProperty('--glow-x', `${((dx + 1) * 50).toFixed(1)}%`);
  }, { passive: true });
}

/** Stat cells and stop cards tilt subtly under the pointer. */
function installTilt(): void {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let current: HTMLElement | null = null;
  document.addEventListener('pointermove', (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('.strip-cell, .trip-row') : null;
    if (current && current !== t) { current.style.removeProperty('--tilt-x'); current.style.removeProperty('--tilt-y'); current.style.removeProperty('--shine-x'); }
    current = t;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    t.style.setProperty('--tilt-x', `${((py - 0.5) * -6).toFixed(2)}deg`);
    t.style.setProperty('--tilt-y', `${((px - 0.5) * 8).toFixed(2)}deg`);
    t.style.setProperty('--shine-x', `${(px * 100).toFixed(1)}%`);
  }, { passive: true });
}

/* ------------------------------------------------------------------ */
/* Easter eggs                                                         */
/* ------------------------------------------------------------------ */

function installEasterEggs(): void {
  let typed = '';
  const konami = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let k = 0;
  window.addEventListener('keydown', (e) => {
    k = e.key === konami[k] ? k + 1 : e.key === konami[0] ? 1 : 0;
    if (k === konami.length) {
      k = 0;
      document.documentElement.classList.toggle('disco');
      react('love', undefined, { hold: 2000 });
      visibleMascot()?.say(document.documentElement.classList.contains('disco') ? 'DISCO HIGHWAY 🪩' : 'okay, back to normal');
    }
    if (e.key.length === 1) {
      typed = (typed + e.key.toLowerCase()).slice(-4);
      if (typed === 'chai') {
        react('love', 'chai', { hold: 2400, force: true });
        chaiStorm();
      }
    }
  });
}

function chaiStorm(): void {
  if (reduced()) return;
  const layer = fxLayer();
  for (let i = 0; i < 22; i += 1) {
    const cup = document.createElement('i');
    cup.className = 'chai-cup';
    cup.textContent = '☕';
    cup.style.left = `${Math.random() * 100}vw`;
    layer.appendChild(cup);
    const anim = cup.animate([
      { transform: `translateY(-10vh) rotate(${(Math.random() - 0.5) * 60}deg)`, opacity: 0 },
      { opacity: 1, offset: 0.1 },
      { transform: `translateY(110vh) rotate(${(Math.random() - 0.5) * 360}deg)`, opacity: 1 },
    ], { duration: 1800 + Math.random() * 1600, delay: Math.random() * 700, easing: 'cubic-bezier(.4,.1,.6,1)' });
    anim.onfinish = () => cup.remove();
    anim.oncancel = () => cup.remove();
  }
}

/* ------------------------------------------------------------------ */
/* Friendliness: field states, quick routes, gauge drag, sheet drag,   */
/* shortcuts, connectivity. Conveniences route through the app's own   */
/* controls (inputs, stepper buttons, dismiss) — never around them.    */
/* ------------------------------------------------------------------ */

/** data-picked / data-pending on each place field drives a ✓ or a nudge. */
function installFieldStates(): void {
  const fields = Array.from(document.querySelectorAll<HTMLElement>('.route-fields .search-field'));
  fields.forEach((field) => {
    const input = field.querySelector<HTMLInputElement>('input[role="combobox"]');
    const box = field.querySelector<HTMLElement>('.search-box');
    if (!input || !box || box.querySelector('.field-tick')) return;
    const tick = document.createElement('span');
    tick.className = 'field-tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
    box.appendChild(tick);
    const nudge = document.createElement('span');
    nudge.className = 'field-nudge';
    nudge.setAttribute('aria-hidden', 'true');
    nudge.textContent = 'pick one from the list ↓';
    field.appendChild(nudge);
    input.addEventListener('input', () => {
      field.removeAttribute('data-picked');
      field.toggleAttribute('data-pending', input.value.trim().length >= 2);
      updateRoadProgress();
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (field.hasAttribute('data-pending') && document.activeElement !== input) {
          field.classList.remove('nudge');
          void field.offsetWidth;
          field.classList.add('nudge');
        }
      }, 260);
    });
    input.addEventListener('focus', () => field.classList.remove('nudge'));
  });
  // Swap moves picks between fields without input events: mirror state.
  document.querySelector('.planner-swap')?.addEventListener('click', () => {
    window.setTimeout(() => {
      const [a, b] = fields;
      if (!a || !b) return;
      const ap = a.hasAttribute('data-picked');
      const bp = b.hasAttribute('data-picked');
      a.toggleAttribute('data-picked', bp && Boolean(a.querySelector('input')?.value.trim()));
      b.toggleAttribute('data-picked', ap && Boolean(b.querySelector('input')?.value.trim()));
      a.removeAttribute('data-pending');
      b.removeAttribute('data-pending');
      updateRoadProgress();
    }, 0);
  });
}

const QUICK_ROUTES: ReadonlyArray<readonly [string, string, string]> = [
  ['Delhi', 'Jaipur', '🏰'],
  ['Mumbai', 'Pune', '🌧️'],
  ['Bengaluru', 'Mysuru', '🌴'],
  ['Chennai', 'Puducherry', '🌊'],
  ['Delhi', 'Agra', '🕌'],
  ['Ahmedabad', 'Vadodara', '🪁'],
];

/**
 * One-tap classic routes. They only TYPE town names into the real search
 * fields; the user still confirms exact places from the suggestions, so
 * no coordinates are ever invented here.
 */
function installQuickRoutes(): void {
  const routeFields = document.querySelector('.route-fields');
  if (!routeFields || document.querySelector('.quick-routes')) return;
  const wrap = document.createElement('div');
  wrap.className = 'quick-routes';
  wrap.innerHTML = `<span class="qr-label" aria-hidden="true">or try a classic</span><div class="qr-row">${QUICK_ROUTES.map(([a, b, e], i) =>
    `<button type="button" class="qr-chip" style="--qi:${i}" data-from="${a}" data-to="${b}" aria-label="Search ${a} to ${b}"><span aria-hidden="true">${e}</span> ${a} → ${b}</button>`).join('')}</div>`;
  routeFields.after(wrap);
  let pendingTo: string | null = null;
  const fromInput = document.querySelector<HTMLInputElement>('.search-field[data-field="origin"] input');
  const toInput = document.querySelector<HTMLInputElement>('.search-field[data-field="destination"] input');
  const typeInto = (input: HTMLInputElement, value: string): void => {
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  wrap.addEventListener('click', (e) => {
    const chip = (e.target as Element | null)?.closest<HTMLButtonElement>('.qr-chip');
    if (!chip || !fromInput || !toInput) return;
    if (document.querySelector('.planner-form')?.getAttribute('aria-busy') === 'true') return;
    chip.classList.remove('pressed');
    void chip.offsetWidth;
    chip.classList.add('pressed');
    pendingTo = chip.dataset.to ?? null;
    typeInto(fromInput, chip.dataset.from ?? '');
    react('cheer', 'quickRoute', { hold: 1200, force: true });
  });
  fromInput?.addEventListener('picked', () => {
    if (!pendingTo || !toInput) return;
    const next = pendingTo;
    pendingTo = null;
    window.setTimeout(() => typeInto(toInput, next), 260);
  });
  fromInput?.addEventListener('input', (e) => {
    if (e.isTrusted) pendingTo = null; // the user took over typing
  });
}

/** Tap or drag across the battery cells: drives the real stepper buttons. */
function installGaugeDrag(): void {
  const gauge = document.querySelector<HTMLElement>('.soc-gauge');
  const minus = document.querySelector<HTMLButtonElement>('.stepper-btn[data-step="-5"]');
  const plus = document.querySelector<HTMLButtonElement>('.stepper-btn[data-step="5"]');
  const value = document.querySelector<HTMLElement>('.stepper-value');
  if (!gauge || !minus || !plus || !value) return;
  gauge.classList.add('is-interactive');
  const current = (): number => parseInt(value.textContent ?? '', 10);
  const setTo = (target: number): void => {
    for (let guard = 0; guard < 40; guard += 1) {
      const v = current();
      if (!Number.isFinite(v) || v === target) break;
      const btn = target > v ? plus : minus;
      if (btn.disabled) break;
      btn.click();
    }
  };
  const fromPointer = (clientX: number): number => {
    const r = gauge.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width - 9)));
    return Math.max(10, Math.min(100, Math.round((f * 100) / 5) * 5));
  };
  let dragging = false;
  gauge.addEventListener('pointerdown', (e) => {
    dragging = true;
    gauge.setPointerCapture?.(e.pointerId);
    gauge.classList.add('dragging');
    setTo(fromPointer(e.clientX));
  });
  gauge.addEventListener('pointermove', (e) => { if (dragging) setTo(fromPointer(e.clientX)); });
  const end = (): void => { dragging = false; gauge.classList.remove('dragging'); };
  gauge.addEventListener('pointerup', end);
  gauge.addEventListener('pointercancel', end);
}

/** Mobile: drag the sheet header down to dismiss (clicks the real dismiss). */
function installSheetDrag(): void {
  const panel = document.getElementById('planner-panel');
  const header = panel?.querySelector<HTMLElement>('.sheet-header');
  const dismiss = panel?.querySelector<HTMLButtonElement>('.sheet-dismiss');
  if (!panel || !header || !dismiss) return;
  let startY = -1;
  let dy = 0;
  header.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('button') || window.innerWidth > 720) return;
    startY = e.clientY;
    dy = 0;
    header.setPointerCapture?.(e.pointerId);
    panel.classList.add('sheet-dragging');
  });
  header.addEventListener('pointermove', (e) => {
    if (startY < 0) return;
    dy = Math.max(0, e.clientY - startY);
    panel.style.setProperty('--drag-y', `${dy}px`);
  });
  const end = (): void => {
    if (startY < 0) return;
    startY = -1;
    panel.classList.remove('sheet-dragging');
    panel.style.removeProperty('--drag-y');
    if (dy > 90) dismiss.click();
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
}

/** `/` jumps to the From search; `?` toggles a shortcut card. */
function installShortcuts(): void {
  const card = document.createElement('div');
  card.className = 'shortcut-card hidden';
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML = '<b>shortcuts</b><span><kbd>/</kbd> search From</span><span><kbd>↑</kbd><kbd>↓</kbd> move in suggestions</span><span><kbd>Enter</kbd> pick / plan</span><span><kbd>Esc</kbd> close things</span><span><kbd>?</kbd> this card</span><em>psst… try typing “chai”</em>';
  document.getElementById('app')?.appendChild(card);
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing = t != null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      const from = document.querySelector<HTMLInputElement>('.search-field[data-field="origin"] input');
      const panel = document.getElementById('planner-panel');
      if (from && panel && getComputedStyle(panel).visibility !== 'hidden' && from.offsetParent !== null) {
        e.preventDefault();
        from.focus();
        from.select();
      }
    } else if (e.key === '?') {
      card.classList.toggle('hidden');
    } else if (e.key === 'Escape') {
      card.classList.add('hidden');
    }
  });
  card.addEventListener('click', () => card.classList.add('hidden'));
}

function installConnectivity(): void {
  window.addEventListener('offline', () => {
    document.documentElement.classList.add('is-offline');
    react('worried', 'wentOffline', { base: true, force: true });
  });
  window.addEventListener('online', () => {
    document.documentElement.classList.remove('is-offline');
    for (const m of [hero, dock]) m?.setMood('idle');
    react('cheer', 'backOnline', { hold: 1600, force: true });
  });
}
