/**
 * IndEV web app entry.
 */
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles.css';
import { api, type HealthInfo } from './api.js';
import { createMap } from './map.js';
import { renderPlanner } from './planner.js';
import { renderTripsDrawer, hideTripsDrawer } from './trips.js';
import { toast } from './toast.js';

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
renderPlanner(planner, map);

const isMobile = (): boolean => window.innerWidth <= 720;

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
    renderTripsDrawer(drawer, map);
    drawer.classList.remove('hidden');
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
