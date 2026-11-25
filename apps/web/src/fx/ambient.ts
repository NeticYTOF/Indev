/** fx/ambient — visual layer only. Never alters text, roles or accessible names.
 *
 *  - A solid seam on the panel/map edge with a scroll-position marker.
 *  (The map vignette, streaks, grain and chip sheen were retired: solid
 *  colour only, and fewer always-on effects.)
 */
import './ambient.css';

function deco(cls: string, html = ''): HTMLElement {
  const node = document.createElement('div');
  node.className = cls;
  node.setAttribute('aria-hidden', 'true');
  if (html) node.innerHTML = html;
  return node;
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
  const panel = document.querySelector<HTMLElement>('.panel');
  if (panel) mountSeam(panel);
}
