/** fx/drawer — visual layer only. Never alters text, roles or accessible names.
 *
 *  - Empty saved-trips state gets an animated "night garage" scene.
 *  - Trip rows stagger in.
 *  All injected nodes are aria-hidden and pointer-transparent.
 */
import './drawer.css';

function garage(): HTMLElement {
  const scene = document.createElement('div');
  scene.className = 'fxd-garage';
  scene.setAttribute('aria-hidden', 'true');
  scene.innerHTML = `
    <div class="fxd-moon"></div>
    ${Array.from({ length: 9 }, (_, i) => `<i class="fxd-star" style="--i:${i}"></i>`).join('')}
    <div class="fxd-shed">
      <div class="fxd-roof"></div>
      <div class="fxd-door"><span></span><span></span><span></span><span></span></div>
      <div class="fxd-sign">P</div>
    </div>
    <div class="fxd-bot">
      <div class="fxd-cap"></div>
      <div class="fxd-face"><i></i><i></i><b></b></div>
      <div class="fxd-zz"><span>z</span><span>z</span><span>z</span></div>
    </div>
    <div class="fxd-ground"><i></i></div>`;
  return scene;
}

function decorateDrawer(drawer: HTMLElement): void {
  const list = drawer.querySelector<HTMLElement>('.trip-list');
  if (!list) return;
  const empty = [...list.querySelectorAll<HTMLElement>(':scope > p.hint')]
    .find((p) => /No saved trips yet/.test(p.textContent ?? ''));
  const scene = list.querySelector<HTMLElement>(':scope > .fxd-garage');
  if (empty && !scene) list.insertBefore(garage(), empty);
  if (!empty && scene) scene.remove();
  list.querySelectorAll<HTMLElement>(':scope > .trip-row').forEach((row, i) => {
    row.style.setProperty('--fxd-i', String(Math.min(i, 8)));
  });
}

export function installDrawerFx(): void {
  let frame = 0;
  const run = (): void => {
    frame = 0;
    const drawer = document.getElementById('trips-drawer');
    if (drawer) decorateDrawer(drawer);
  };
  new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(run); })
    .observe(document.body, { childList: true, subtree: true });
  run();
}
