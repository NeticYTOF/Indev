/** fx/alive — "the app is working" feedback. Visual layer only: never alters
 *  text, roles, aria attributes or accessible names of app-owned nodes, and
 *  never delays or reorders any real request or result.
 *
 *  1. Activity rail: a thin indeterminate line on the panel's top edge while
 *     any same-origin /api/ request has been in flight for >140ms.
 *  2. Search pulse: a scanning underline on a place field from the moment the
 *     user types until its suggestion list updates (or the field is left).
 *  3. Map wake-up: a quiet radar overlay until the basemap's first load; if it
 *     takes long, a reassurance that planning still works without it.
 *  4. Skeleton rows while the saved-trips list says "Loading…".
 *  5. Connection pill when the browser reports it is offline.
 *  6. Press feedback: any button that flips to disabled right after a click
 *     gets a short "accepted" pulse, so a click never looks ignored.
 *  All injected nodes are aria-hidden and pointer-transparent.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import './alive.css';

function reduced(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.classList.contains('reduce-motion');
}

function deco(cls: string, html = ''): HTMLElement {
  const node = document.createElement('div');
  node.className = cls;
  node.setAttribute('aria-hidden', 'true');
  if (html) node.innerHTML = html;
  return node;
}

/* ---------------- 1. activity rail ---------------- */

let inflight = 0;
let showTimer: number | null = null;
let hideTimer: number | null = null;
let rail: HTMLElement | null = null;

function railNode(): HTMLElement | null {
  if (rail?.isConnected) return rail;
  rail = deco('fxl-rail', '<i></i>');
  document.body.appendChild(rail);
  return rail;
}

function activityStart(): void {
  inflight++;
  if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
  if (inflight === 1 && showTimer === null) {
    showTimer = window.setTimeout(() => {
      showTimer = null;
      if (inflight > 0) railNode()?.classList.add('is-on');
    }, 140);
  }
}

function activityEnd(): void {
  inflight = Math.max(0, inflight - 1);
  if (inflight > 0) return;
  if (showTimer !== null) { clearTimeout(showTimer); showTimer = null; }
  // A short tail so back-to-back polls read as one continuous activity.
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    const r = railNode();
    if (!r || !r.classList.contains('is-on')) return;
    r.classList.add('is-done');
    window.setTimeout(() => r.classList.remove('is-on', 'is-done'), 420);
  }, 260);
}

function isApiRequest(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    return url.origin === location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Transparent observer: the caller receives the original promise untouched. */
function watchFetch(): void {
  const original = window.fetch;
  if ((original as { __fxl?: boolean }).__fxl) return;
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const promise = original.call(window, input, init);
    if (isApiRequest(input)) {
      activityStart();
      promise.then(activityEnd, activityEnd);
    }
    return promise;
  };
  (wrapped as { __fxl?: boolean }).__fxl = true;
  window.fetch = wrapped as typeof window.fetch;
}

/* ---------------- 2. search pulse ---------------- */

function watchSearch(): void {
  const timers = new WeakMap<HTMLElement, number>();
  const watched = new WeakSet<HTMLElement>();
  const stop = (box: HTMLElement): void => {
    box.classList.remove('fxl-searching');
    const t = timers.get(box);
    if (t !== undefined) clearTimeout(t);
  };
  document.addEventListener('input', (ev) => {
    const input = ev.target as HTMLElement | null;
    if (!(input instanceof HTMLInputElement) || input.getAttribute('role') !== 'combobox') return;
    const box = input.closest<HTMLElement>('.search-box');
    if (!box) return;
    stop(box);
    if (input.value.trim().length < 2) return;
    void box.offsetWidth;
    box.classList.add('fxl-searching');
    // Safety net: stale or failed lookups never leave the pulse running.
    timers.set(box, window.setTimeout(() => box.classList.remove('fxl-searching'), 6000));
    const list = box.querySelector<HTMLElement>('.suggestions');
    if (list && !watched.has(list)) {
      watched.add(list);
      new MutationObserver(() => {
        if (!box.classList.contains('fxl-searching')) return;
        // The app clears and hides the list on every keystroke; only a
        // populated, visible list means the lookup actually answered.
        if (list.childElementCount === 0 || list.classList.contains('hidden')) return;
        stop(box);
        if (!list.classList.contains('hidden') && !reduced()) {
          list.classList.remove('fxl-landed');
          void list.offsetWidth;
          list.classList.add('fxl-landed');
        }
      }).observe(list, { childList: true, attributes: true, attributeFilter: ['class'] });
    }
  }, true);
  document.addEventListener('focusout', (ev) => {
    const box = (ev.target as Element | null)?.closest?.('.search-box');
    if (box instanceof HTMLElement) stop(box);
  }, true);
}

/* ---------------- 3. map wake-up ---------------- */

function watchMap(map: MapLibreMap): void {
  const app = document.getElementById('app');
  if (!app || app.querySelector(':scope > .fxl-map')) return;
  if (map.loaded()) return;
  const overlay = deco('fxl-map', `
    <div class="fxl-radar"><i></i><i></i><i></i><b></b></div>
    <p class="fxl-map-note"><span class="fxl-map-line">Waking up the map</span><span class="fxl-map-slow">The map is taking a while. Route planning still works.</span></p>`);
  app.appendChild(overlay);
  const slow = window.setTimeout(() => overlay.classList.add('is-slow'), 9000);
  const done = (): void => {
    clearTimeout(slow);
    overlay.classList.add('is-leaving');
    window.setTimeout(() => overlay.remove(), reduced() ? 0 : 700);
  };
  map.once('load', done);
}

/* ---------------- 4. skeleton rows ---------------- */

function watchTripList(): void {
  let frame = 0;
  const run = (): void => {
    frame = 0;
    document.querySelectorAll<HTMLElement>('.trip-list').forEach((list) => {
      const loading = [...list.querySelectorAll<HTMLElement>(':scope > p.hint')]
        .some((p) => (p.textContent ?? '').trim() === 'Loading…');
      const skel = list.querySelector<HTMLElement>(':scope > .fxl-skel');
      if (loading && !skel) {
        list.prepend(deco('fxl-skel', Array.from({ length: 3 }, (_, i) =>
          `<div class="fxl-skel-row" style="--i:${i}"><i></i><span><b></b><b></b></span></div>`).join('')));
      } else if (!loading && skel) {
        skel.remove();
      }
    });
  };
  new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(run); })
    .observe(document.body, { childList: true, subtree: true });
}

/* ---------------- 5. connection pill ---------------- */

function watchConnection(): void {
  const pill = deco('fxl-net', '<i></i><span>Offline: waiting for connection</span>');
  document.body.appendChild(pill);
  const sync = (): void => {
    if (navigator.onLine) {
      if (pill.classList.contains('is-on')) {
        pill.classList.add('is-back');
        window.setTimeout(() => pill.classList.remove('is-on', 'is-back'), 1400);
      }
    } else {
      pill.classList.remove('is-back');
      pill.classList.add('is-on');
    }
  };
  pill.querySelector('span')!.dataset.back = 'Back online';
  addEventListener('online', sync);
  addEventListener('offline', sync);
  sync();
}

/* ---------------- 6. press feedback ---------------- */

function watchPresses(): void {
  document.addEventListener('click', (ev) => {
    const btn = (ev.target as Element | null)?.closest?.('button');
    if (!(btn instanceof HTMLButtonElement) || reduced()) return;
    // Let the app's own handler run, then look at what it did.
    requestAnimationFrame(() => {
      if (!btn.isConnected) return;
      if (btn.disabled || btn.getAttribute('aria-busy') === 'true') {
        btn.classList.remove('fxl-took');
        void btn.offsetWidth;
        btn.classList.add('fxl-took');
        window.setTimeout(() => btn.classList.remove('fxl-took'), 700);
      }
    });
  }, true);
}

export function installAliveFx(map: MapLibreMap): void {
  watchFetch();
  watchSearch();
  watchMap(map);
  watchTripList();
  watchConnection();
  watchPresses();
}
