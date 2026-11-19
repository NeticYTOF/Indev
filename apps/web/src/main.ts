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
import { renderTripsDrawer } from './trips.js';
import { toast } from './toast.js';

const map = createMap(document.getElementById('map') as HTMLElement);

// Topbar health badge: the synthetic-data label is always visible in mock mode.
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
    toast('Server offline — start it with npm run dev at the repo root.');
  }
})();

const planner = document.getElementById('planner-panel') as HTMLElement;
renderPlanner(planner, map);

const drawer = document.getElementById('trips-drawer') as HTMLElement;
const tripsButton = document.getElementById('trips-button') as HTMLButtonElement;
tripsButton.addEventListener('click', () => {
  if (drawer.classList.contains('hidden')) {
    renderTripsDrawer(drawer, map);
    drawer.classList.remove('hidden');
  } else {
    drawer.classList.add('hidden');
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') drawer.classList.add('hidden');
});
