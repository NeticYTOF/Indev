/** Shared presentation-only grouping of raw plan warnings. Never mutates plans. */
export const GENERIC_CANDIDATE_CHECK_WARNING = 'Station was not certified.';

export type PlanWarningKind = 'selected' | 'candidate' | 'malformed';

export interface PlanWarningEntry {
  readonly kind: PlanWarningKind;
  readonly text: string;
  readonly count: number;
}

export interface GroupedPlanWarnings {
  readonly selected: readonly PlanWarningEntry[];
  readonly candidates: readonly PlanWarningEntry[];
  readonly malformed: readonly PlanWarningEntry[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

/** Exact generic notices are candidate checks; every other string stays route/selected-stop detail. */
export function groupPlanWarnings(warnings: readonly unknown[]): GroupedPlanWarnings {
  const selected = new Map<string, PlanWarningEntry>();
  let candidateCount = 0;
  let malformedCount = 0;
  for (const warning of warnings) {
    if (typeof warning === 'string' && warning.trim() === GENERIC_CANDIDATE_CHECK_WARNING) {
      candidateCount += 1;
      continue;
    }
    if (typeof warning === 'string' && warning.trim().length > 0) {
      const existing = selected.get(warning);
      selected.set(warning, { kind: 'selected', text: warning.trim(),
        count: (existing?.count ?? 0) + 1 });
      continue;
    }
    malformedCount += 1;
  }
  return {
    selected: [...selected.values()],
    candidates: candidateCount > 0
      ? [{ kind: 'candidate', text: GENERIC_CANDIDATE_CHECK_WARNING, count: candidateCount }]
      : [],
    malformed: malformedCount > 0
      ? [{ kind: 'malformed', text: 'Warning detail unavailable', count: malformedCount }]
      : [],
  };
}

function repeatCount(count: number): string {
  return count > 1 ? ` <span class="hint">Repeated ${count} times.</span>` : '';
}

/** DOM-ready markup; raw warning arrays remain available on the original objects. */
export function renderWarningGroupsMarkup(warnings: readonly unknown[]): string {
  const groups = groupPlanWarnings(warnings);
  const sections: string[] = [];
  if (groups.selected.length > 0) {
    sections.push('<div class="warning-group" data-warning-group="route-selected">' +
      '<p class="hint">Route notes and warnings</p>' +
      groups.selected.map((entry) =>
        `<div class="banner banner-warn">${escapeHtml(entry.text)}${repeatCount(entry.count)}</div>`).join('') +
      '</div>');
  }
  if (groups.candidates.length > 0) {
    sections.push('<details class="warning-group" data-warning-group="candidate-checks">' +
      '<summary>' + groups.candidates.map((entry) =>
        `${entry.count} candidate-check notice${entry.count === 1 ? '' : 's'}`).join(', ') +
        '. Separate from chosen-stop problems</summary>' +
      groups.candidates.map((entry) =>
        `<p class="hint">${entry.count} candidate-check notice${entry.count === 1 ? '' : 's'}: ` +
        `${escapeHtml(entry.text)} Notices do not identify chosen stops.</p>`).join('') +
      '</details>');
  }
  if (groups.malformed.length > 0) {
    sections.push('<div class="warning-group" data-warning-group="malformed">' +
      groups.malformed.map((entry) =>
        `<div class="banner banner-warn">${escapeHtml(entry.text)}${repeatCount(entry.count)}</div>`).join('') +
      '</div>');
  }
  return sections.length > 0 ? `<div class="warning-groups">${sections.join('')}</div>` : '';
}
