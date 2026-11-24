/**
 * IndEV web app entry.
 */
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
import '@fontsource/doto/900.css';
import '@fontsource-variable/bricolage-grotesque';
import './styles.css';
import './delight.css';
import { installMotion } from './motion.js';
import { installDelight } from './delight.js';
import { installPlanningFx } from './fx/planning.js';
import { installResultsFx } from './fx/results.js';
import { installAmbientFx } from './fx/ambient.js';
import { installDrawerFx } from './fx/drawer.js';
import { installAliveFx } from './fx/alive.js';
import './ai-settings.css';
import './stop-sheet.css';
// Calm layer is imported last so its overrides win the cascade.
import './fx/calm.css';
import { api, type HealthInfo } from './api.js';
import { createMap } from './map.js';
import { renderPlanner } from './planner.js';
import { renderTripsDrawer, hideTripsDrawer } from './trips.js';
import { toast } from './toast.js';

installMotion();
const map = createMap(document.getElementById('map') as HTMLElement);

// Mode badge (top cluster): the synthetic-data label is always visible in
// mock mode, over the map.
void (async () => {
  try {
    const health: HealthInfo = await api.health();
    const badge = document.getElementById('health-badge');
    if (badge) {
      badge.classList.remove('hidden');
      badge.classList.add(health.mock ? 'synthetic' : 'live');
      badge.innerHTML = health.mock
        ? '<span class="dot"></span> Synthetic data — mock mode'
        : '<span class="dot"></span> Live charger data';
    }
  } catch {
    toast('Server status unavailable — the health check failed.', 'warn');
  }
})();

const planner = document.getElementById('planner-panel') as HTMLElement;
const plannerController = renderPlanner(planner, map);
// Decorative mascot + motion layer; reads the rendered DOM, never owns it.
installDelight();
installPlanningFx();
installResultsFx();
installAmbientFx();
installDrawerFx();
installAliveFx(map);

const mobileViewport = window.matchMedia('(max-width: 720px)');
const isMobile = (): boolean => mobileViewport.matches;

// mobile: the planner starts OPEN so the form is reachable first-paint;
// the FAB only appears once the sheet is dismissed. The FAB's expanded
// state is kept in sync so screen readers hear the sheet as open.
const sheetFab = document.getElementById('sheet-open') as HTMLButtonElement | null;
const setSheetOpen = (open: boolean): void => {
  planner.classList.toggle('open', open);
  sheetFab?.setAttribute('aria-expanded', String(open));
  if (open) {
    sheetFab?.classList.add('hidden');
  } else if (isMobile()) {
    sheetFab?.classList.remove('hidden');
  }
};
if (isMobile()) {
  planner.classList.add('open');
  sheetFab?.setAttribute('aria-expanded', 'true');
}

// CSS changes panel visibility at this breakpoint without a new page load.
// Preserve mobile open/closed state, but keep a visible entry when closed.
mobileViewport.addEventListener('change', () => {
  const visible = !isMobile() || planner.classList.contains('open');
  sheetFab?.classList.toggle('hidden', visible);
  sheetFab?.setAttribute('aria-expanded', String(visible));
});

sheetFab?.addEventListener('click', () => {
  setSheetOpen(true);
  // Move focus into the sheet so keyboard/AT users land inside it.
  const firstField = planner.querySelector<HTMLElement>('input, select, textarea, button');
  (firstField ?? planner).focus();
});

const drawer = document.getElementById('trips-drawer') as HTMLElement;
const tripsButton = document.getElementById('trips-button') as HTMLButtonElement;
tripsButton.addEventListener('click', () => {
  if (drawer.classList.contains('hidden')) {
    renderTripsDrawer(drawer, map, plannerController.loadSavedRoute);
    drawer.classList.remove('hidden');
    tripsButton.setAttribute('aria-expanded', 'true');
    drawer.querySelector<HTMLElement>('[data-close]')?.focus({ preventScroll: true });
  } else {
    // Canonical close: restore focus if the click path lost it to the
    // hide (here focus is already on the owner button - harmless no-op).
    hideTripsDrawer(drawer);
  }
});

// Escape closes the drawer first; on mobile it can also dismiss the sheet,
// returning focus to the FAB that owns its expanded state.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!drawer.classList.contains('hidden')) {
    hideTripsDrawer(drawer);
    return;
  }
  if (isMobile() && planner.classList.contains('open')) {
    setSheetOpen(false);
    sheetFab?.focus();
  }
});
