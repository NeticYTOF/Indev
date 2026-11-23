/**
 * Motion layer for the "Milestone" design.
 *
 * Purely decorative and additive: it never changes text content, focus,
 * ARIA state or layout, so behaviour and tests are independent of it.
 * Observer-driven, so markup rendered later (plans, saved trips) picks it
 * up automatically. Under prefers-reduced-motion nothing is installed.
 */

let installed = false;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function installMotion(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  finishBoot();
  if (prefersReducedMotion()) return;
  installSwapTurn();
  installObservers();
}

/** The opening sequence plays once per tab session, then leaves the DOM. */
function finishBoot(): void {
  try {
    sessionStorage.setItem('indeev-booted', '1');
  } catch {
    // Storage may be unavailable (privacy mode); the sequence simply replays.
  }
  const boot = document.querySelector<HTMLElement>('.boot');
  if (!boot) return;
  if (!document.documentElement.classList.contains('boot-on')) {
    boot.remove();
    return;
  }
  window.setTimeout(() => boot.remove(), 1500);
}

/** Swap: the control turns half a revolution, alternating direction. */
function installSwapTurn(): void {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const swap = target?.closest<HTMLElement>('.planner-swap');
    if (swap) swap.classList.toggle('is-swapping');
  });
}

function installObservers(): void {
  const revealer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries, observer) => {
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target as HTMLElement;
        observer.unobserve(card);
        card.style.setProperty('--i', String(order++));
        card.classList.remove('reveal-pending');
        card.classList.add('reveal-in');
        card.addEventListener('animationend', () => card.classList.remove('reveal-in'), { once: true });
      }
    }, { threshold: 0.06 })
    : null;

  const enhance = (root: ParentNode): void => {
    if (!revealer) return;
    root.querySelectorAll<HTMLElement>('.stop-card:not([data-revealed])').forEach((card) => {
      card.dataset.revealed = '';
      // On-screen cards ride the results cascade; below-the-fold cards wait
      // until the planner scrolls them into view.
      if (card.getBoundingClientRect().top > window.innerHeight) {
        card.classList.add('reveal-pending');
        revealer.observe(card);
      }
    });
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const host = record.target instanceof Element ? record.target : record.target.parentElement;
      const stepper = host?.closest<HTMLElement>('.stepper-value');
      if (stepper) tick(stepper);
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) enhance(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  enhance(document);
}

function tick(element: HTMLElement): void {
  element.classList.remove('is-ticking');
  void element.offsetWidth;
  element.classList.add('is-ticking');
}
