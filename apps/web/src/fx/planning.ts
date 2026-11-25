/** fx/planning — visual layer only. Never alters text, roles or accessible names.
 *
 *  1. A "corridor scan" stage: while the form is aria-busy, a decorative
 *     night highway runs under a glowing car, a radar sweep passes and
 *     charger bolts light up along the road. It is aria-hidden, inert and
 *     pointer-transparent; it never delays or hides the real result.
 *  2. A lane-line "zip" wipe when a fresh `.plan-results` lands.
 *  3. Idle form micro-interactions: travelling dot on the A→B connector,
 *     charge gauge ripple on change.
 */
import './planning.css';

function reduced(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.classList.contains('reduce-motion');
}

function deco<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function carGlyph(): string {
  return `<svg viewBox="0 0 64 28" width="64" height="28" aria-hidden="true" focusable="false">
    <path d="M6 18c0-2 1.2-3.4 3-3.8l7-1.6 7.5-6.2c1-.8 2.2-1.2 3.4-1.2h13c1.3 0 2.6.5 3.6 1.4l6.3 5.9 5.6 1.3c2 .5 3.6 2.3 3.6 4.4V21a2 2 0 0 1-2 2h-3.6a6 6 0 0 0-11.8 0H22.4a6 6 0 0 0-11.8 0H8a2 2 0 0 1-2-2Z" fill="#f5f5f2"/>
    <path d="M25 13l6-5h7.5v5Zm16 0V8h3.6l5.4 5Z" fill="#000" opacity=".85"/>
    <circle cx="16.5" cy="23" r="4.2" fill="#000" stroke="#f5f5f2" stroke-width="2"/>
    <circle cx="50.5" cy="23" r="4.2" fill="#000" stroke="#f5f5f2" stroke-width="2"/>
    <rect x="57" y="15.5" width="4" height="2.4" rx="1.2" fill="#ffc72c"/>
  </svg>`;
}

function boltGlyph(): string {
  return `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M9.4 1 3 9.2h4.3L6.4 15 13 6.6H8.7Z" fill="currentColor"/></svg>`;
}

/* ---------------- 1. corridor scan stage ---------------- */

const SCAN_LINES = [
  'Tracing the corridor',
  'Sweeping for chargers',
  'Reading plug types',
  'Checking live prices',
  'Balancing charge stops',
  'Picking the fastest mix',
];

function buildStage(): HTMLElement {
  const stage = deco('div', 'fxp-stage');
  stage.innerHTML = `
    <div class="fxp-sky">
      ${Array.from({ length: 14 }, (_, i) => `<i class="fxp-star" style="--i:${i}"></i>`).join('')}
    </div>
    <div class="fxp-sweep"></div>
    <div class="fxp-road">
      <div class="fxp-lane"></div>
      <div class="fxp-edge fxp-edge-top"></div>
      <div class="fxp-edge fxp-edge-bottom"></div>
      <div class="fxp-poles">${Array.from({ length: 6 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
      <div class="fxp-car"><span class="fxp-beam"></span>${carGlyph()}<span class="fxp-exhaust"></span></div>
    </div>
    <div class="fxp-bolts">
      ${Array.from({ length: 5 }, (_, i) => `<span class="fxp-bolt" style="--i:${i}">${boltGlyph()}</span>`).join('')}
    </div>
    <div class="fxp-readout">
      <span class="fxp-ticker"></span>
      <span class="fxp-dots"><i></i><i></i><i></i></span>
    </div>
    <div class="fxp-meter"><span></span></div>`;
  return stage;
}

let stage: HTMLElement | null = null;
let tickerTimer: number | null = null;
let stageShownAt = 0;
let hideTimer: number | null = null;

function startScan(): void {
  if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
  if (!stage) stage = buildStage();
  // A fixed overlay on <body>: it takes no layout space, so it can never
  // push results, errors or focused controls around the panel.
  if (!stage.isConnected) document.body.appendChild(stage);
  stage.classList.remove('is-leaving', 'is-done');
  void stage.offsetWidth;
  stage.classList.add('is-on');
  stageShownAt = performance.now();
  const ticker = stage.querySelector('.fxp-ticker') as HTMLElement;
  let i = 0;
  const tick = (): void => {
    ticker.classList.remove('swap');
    void ticker.offsetWidth;
    ticker.textContent = SCAN_LINES[i % SCAN_LINES.length] as string;
    ticker.classList.add('swap');
    i++;
  };
  tick();
  if (tickerTimer !== null) clearInterval(tickerTimer);
  tickerTimer = window.setInterval(tick, reduced() ? 2600 : 1300);
}

function stopScan(): void {
  if (!stage || !stage.classList.contains('is-on')) return;
  if (tickerTimer !== null) { clearInterval(tickerTimer); tickerTimer = null; }
  // A synthetic plan can be instant; let the scene finish one short beat so
  // the handoff reads, but never longer than ~900ms after the real result.
  const elapsed = performance.now() - stageShownAt;
  const wait = reduced() ? 0 : Math.max(0, Math.min(600, 800 - elapsed));
  const node = stage;
  node.classList.add('is-done');
  hideTimer = window.setTimeout(() => {
    node.classList.add('is-leaving');
    hideTimer = window.setTimeout(() => {
      node.classList.remove('is-on', 'is-leaving', 'is-done');
      node.remove();
      hideTimer = null;
    }, reduced() ? 0 : 420);
  }, wait);
}

/* ---------------- 2. results arrival zip ---------------- */

function zip(results: HTMLElement): void {
  if (reduced() || results.querySelector(':scope > .fxp-zip')) return;
  const bar = deco('div', 'fxp-zip');
  bar.innerHTML = '<i></i><i></i><i></i>';
  results.prepend(bar);
  window.setTimeout(() => bar.remove(), 1400);
}

/* ---------------- 3. idle form micro-interactions ---------------- */

function decorateConnector(form: HTMLElement): void {
  // Between the A and B pins: a travelling "lane dot" on the connector.
  const fields = form.querySelector<HTMLElement>('.route-fields');
  if (!fields || fields.querySelector(':scope > .fxp-link')) return;
  fields.classList.add('fxp-rel');
  const link = deco('span', 'fxp-link');
  link.innerHTML = '<i></i>';
  fields.appendChild(link);
}

function decorateGauge(form: HTMLElement): void {
  const row = form.querySelector<HTMLElement>('.soc-row');
  const gauge = row?.querySelector<HTMLElement>('.soc-gauge');
  if (!row || !gauge || row.dataset.fxpGauge) return;
  row.dataset.fxpGauge = '1';
  const wave = deco('span', 'fxp-wave');
  gauge.appendChild(wave);
  row.querySelectorAll<HTMLButtonElement>('.stepper-btn').forEach((b) => {
    b.addEventListener('click', () => {
      if (reduced()) return;
      const up = Number(b.dataset.step) > 0;
      gauge.classList.remove('fxp-ripple-up', 'fxp-ripple-down');
      void gauge.offsetWidth;
      gauge.classList.add(up ? 'fxp-ripple-up' : 'fxp-ripple-down');
    });
  });
}

export function installPlanningFx(): void {
  const boot = (): boolean => {
    const form = document.querySelector<HTMLElement>('.planner-form');
    if (!form) return false;
    decorateConnector(form);
    decorateGauge(form);

    new MutationObserver(() => {
      if (form.getAttribute('aria-busy') === 'true') startScan();
      else stopScan();
    }).observe(form, { attributes: true, attributeFilter: ['aria-busy'] });

    const panel = document.getElementById('planner-panel') ?? form.parentElement;
    if (panel) {
      let last: Element | null = null;
      new MutationObserver(() => {
        const results = panel.querySelector<HTMLElement>('.plan-results');
        if (results && results !== last) { last = results; zip(results); }
        if (!results) last = null;
      }).observe(panel, { childList: true, subtree: false });
    }
    return true;
  };
  if (!boot()) {
    const wait = new MutationObserver(() => { if (boot()) wait.disconnect(); });
    wait.observe(document.body, { childList: true, subtree: true });
  }
}

