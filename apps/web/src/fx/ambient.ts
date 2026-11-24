/** fx/ambient — visual layer only. Never alters text, roles or accessible names.
 *
 *  - Map atmosphere: vignette, drifting "headlight" streaks along the
 *    corridor, and a very faint film grain (all aria-hidden, no pointer).
 *  - A glowing seam on the panel/map edge that brightens with scroll.
 *  - A scroll-progress "lane" on the panel edge.
 *  - Chrome sheen on the top-cluster chips.
 */
import './ambient.css';

function deco(cls: string, html = ''): HTMLElement {
  const node = document.createElement('div');
  node.className = cls;
  node.setAttribute('aria-hidden', 'true');
  if (html) node.innerHTML = html;
  return node;
}

function mountMapAtmosphere(app: HTMLElement): void {
  if (app.querySelector(':scope > .fxa-atmos')) return;
  const streaks = Array.from({ length: 7 }, (_, i) =>
    `<i class="fxa-streak" style="--i:${i};--y:${12 + ((i * 37) % 76)}%;--d:${7 + (i % 3) * 2.5}s"></i>`).join('');
  const atmos = deco('fxa-atmos', `<div class="fxa-vignette"></div><div class="fxa-streaks">${streaks}</div><div class="fxa-grain"></div>`);
  const map = document.getElementById('map');
  if (map?.nextSibling) app.insertBefore(atmos, map.nextSibling); else app.appendChild(atmos);
}

function mountSeam(panel: HTMLElement): void {
  const app = document.getElementById('app');
  if (!app || app.querySelector(':scope > .fxa-seam')) return;
  const seam = deco('fxa-seam', '<i></i><b></b>');
  app.appendChild(seam);
  let frame = 0;
  const update = (): void => {
    frame = 0;
    const max = panel.scrollHeight - panel.clientHeight;
    const p = max > 0 ? panel.scrollTop / max : 0;
    seam.style.setProperty('--fxa-p', p.toFixed(4));
  };
  panel.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(update); }).observe(panel);
  update();
}

export function installAmbientFx(): void {
  const app = document.getElementById('app');
  const panel = document.querySelector<HTMLElement>('.panel');
  if (app) mountMapAtmosphere(app);
  if (panel) mountSeam(panel);
  document.querySelectorAll<HTMLElement>('.top-cluster .chip-btn, #health-badge').forEach((chip) => {
    chip.classList.add('fxa-chrome');
  });
}
