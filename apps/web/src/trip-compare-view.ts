/**
 * DOM shell for the read-only saved trip comparison workspace.
 *
 * This module only renders the pure comparison model and forwards explicit
 * user actions. It never requests trips, plans, geocodes, stations, AI or
 * storage writes; Open/Edit callers are provided by the existing saved-trips
 * controller so their established contracts remain unchanged.
 */
import { buildTripComparisonHtml, renderTripComparisonMarkup, type TripComparison } from './trip-compare.js';
import { el } from './planner.js';
import { toast } from './toast.js';

export interface ComparisonViewHandlers {
  onBack: () => void;
  onClear: () => void;
  onSwap: () => void;
  onRemove: (slot: 'A' | 'B') => void;
  onOpen: (slot: 'A' | 'B') => void;
  onEdit: (slot: 'A' | 'B') => void;
}

export function renderTripComparisonWorkspace(
  panel: HTMLElement,
  comparison: TripComparison,
  handlers: ComparisonViewHandlers,
): HTMLElement {
  let results = panel.querySelector<HTMLElement>('.plan-results');
  if (!results) {
    results = el('<section class="plan-results" aria-label="Saved trip comparison"></section>') as HTMLElement;
    panel.appendChild(results);
  }
  results.setAttribute('tabindex', '-1');
  results.setAttribute('aria-label', 'Saved trip comparison');
  results.innerHTML = renderTripComparisonMarkup(comparison);
  document.body.classList.add('comparing-trips');

  const root = results.querySelector<HTMLElement>('[data-trip-compare]');
  root?.querySelector('[data-compare-back]')?.addEventListener('click', handlers.onBack);
  root?.querySelector('[data-compare-clear]')?.addEventListener('click', handlers.onClear);
  root?.querySelector('[data-compare-swap]')?.addEventListener('click', handlers.onSwap);
  root?.querySelectorAll<HTMLElement>('[data-compare-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      const slot = button.dataset.compareRemove === 'B' ? 'B' : 'A';
      handlers.onRemove(slot);
    });
  });
  root?.querySelectorAll<HTMLElement>('[data-compare-open]').forEach((button) => {
    button.addEventListener('click', () => {
      handlers.onOpen(button.dataset.compareOpen === 'B' ? 'B' : 'A');
    });
  });
  root?.querySelectorAll<HTMLElement>('[data-compare-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      handlers.onEdit(button.dataset.compareEdit === 'B' ? 'B' : 'A');
    });
  });
  root?.querySelector('[data-compare-download]')?.addEventListener('click', () => {
    try {
      const html = buildTripComparisonHtml(comparison);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'indev-saved-trip-comparison.html';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Trip comparison downloaded.');
    } catch {
      toast('Comparison download failed.', 'bad');
    }
  });
  root?.querySelector('[data-compare-print]')?.addEventListener('click', () => {
    try {
      window.print();
    } catch {
      toast('Print is unavailable in this browser.', 'bad');
    }
  });
  return results;
}

export function clearTripComparisonView(): void {
  document.body.classList.remove('comparing-trips');
  const results = document.querySelector<HTMLElement>('#planner-panel .plan-results');
  if (results?.querySelector('[data-trip-compare]')) results.innerHTML = '';
}
