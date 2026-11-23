/**
 * Toasts: a SINGLE active toast replaces the previous one, so rapid
 * save/export/load confirmations never stack up over content. The root is
 * positioned away from the compose card and stop cards (desktop: over the
 * map's lower-right; mobile: under the top cluster) purely via CSS.
 */

let root: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, tone: 'info' | 'bad' | 'warn' = 'info', ms = 4200): void {
  if (!root) root = document.getElementById('toast-root');
  if (!root) return;

  // Replace any active toast instead of stacking another one.
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  root.replaceChildren();

  const el = document.createElement('div');
  el.className = `toast${tone === 'info' ? '' : ` ${tone}`}`;
  el.textContent = message;
  // The draining timer line (CSS) runs for this toast's real lifetime.
  el.style.setProperty('--toast-ms', `${ms}ms`);
  root.appendChild(el);

  hideTimer = setTimeout(() => {
    el.style.transition = 'opacity 240ms var(--ease), transform 240ms var(--ease), filter 240ms var(--ease)';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px) scale(0.96)';
    el.style.filter = 'blur(6px)';
    setTimeout(() => {
      el.remove();
      if (root && root.childElementCount === 0) hideTimer = null;
    }, 260);
  }, ms);
}
