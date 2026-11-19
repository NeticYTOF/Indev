/** Treat malformed response metadata as absent, never as a failed save. */
export function storageWarningText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const warnings = (response as { warnings?: unknown }).warnings;
  return Array.isArray(warnings) ? warnings.filter((item): item is string => typeof item === 'string').join(' ') : '';
}

export function storageWarningElement(message: string): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'banner banner-warn';
  banner.dataset.storageWarning = '';
  banner.setAttribute('role', 'status');
  banner.textContent = message;
  return banner;
}
