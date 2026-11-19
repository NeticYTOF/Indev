/** Minimal toast notifications (flat, no gradients). */

let root: HTMLElement | null = null;

export function toast(message: string, tone: 'info' | 'bad' | 'warn' = 'info', ms = 4200): void {
  if (!root) root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${tone === 'info' ? '' : ` ${tone}`}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 240ms var(--ease)';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}
