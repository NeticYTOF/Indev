import photoSources from '../public/vehicle-photo-sources.json';
import { safeHttpUrl } from './safe-url.js';

interface PhotoSource {
  id: string;
  src: string;
  alt: string;
  author: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  changes: string;
  sha256: string;
}

function isPhotoSource(value: unknown): value is PhotoSource {
  const r = value as Record<string, unknown> | null;
  return !!r && typeof r.id === 'string' && typeof r.src === 'string' &&
    r.src === `/vehicles/${r.id}.webp` && typeof r.alt === 'string' && r.alt.trim().length > 0 &&
    typeof r.author === 'string' && r.author.trim().length > 0 &&
    typeof r.sourceUrl === 'string' && safeHttpUrl(r.sourceUrl) === r.sourceUrl.trim() &&
    typeof r.license === 'string' && r.license.trim().length > 0 &&
    typeof r.licenseUrl === 'string' && safeHttpUrl(r.licenseUrl) === r.licenseUrl.trim() &&
    typeof r.changes === 'string' && r.changes.trim().length > 0 &&
    typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256);
}

const photos = new Map<string, PhotoSource>();
for (const entry of photoSources) {
  if (isPhotoSource(entry)) photos.set(entry.id, entry);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function creditLink(label: string, rawUrl: string): HTMLAnchorElement | null {
  const url = safeHttpUrl(rawUrl);
  if (!url) return null;
  const link = element('a', 'vehicle-photo-link', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function fallback(container: HTMLElement, message: string): void {
  const note = element('div', 'vehicle-photo-fallback', message);
  container.replaceChildren(note);
}

/** Render a selected preset's local photo or an honest neutral fallback. */
export function renderVehiclePhoto(container: HTMLElement, id: string | null, label: string): void {
  const source = id ? photos.get(id) : undefined;
  if (!source) {
    fallback(container, id === 'custom'
      ? 'Your custom vehicle — no vehicle image is used.'
      : `Photo unavailable for ${label}. No lookalike image is substituted.`);
    return;
  }

  const figure = element('figure', 'vehicle-photo-card');
  // Showroom stage: cutout car on a lit floor with a mirrored reflection.
  // Decorative layers are aria-hidden; the one <img> keeps the alt text.
  const stage = element('div', 'vehicle-stage');
  stage.appendChild(element('span', 'vehicle-stage-spot'));
  stage.appendChild(element('span', 'vehicle-stage-floor'));
  for (const node of stage.children) (node as HTMLElement).setAttribute('aria-hidden', 'true');
  const image = element('img', 'vehicle-photo-image');
  image.src = source.src;
  image.alt = `${source.alt} — illustrative vehicle photo.`;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    if (!figure.isConnected || figure.parentElement !== container || !figure.contains(image)) return;
    fallback(container, `Photo unavailable for ${label}. No lookalike image is substituted.`);
  });
  const reflection = element('img', 'vehicle-photo-reflection');
  reflection.src = source.src;
  reflection.alt = '';
  reflection.setAttribute('aria-hidden', 'true');
  reflection.decoding = 'async';
  const car = element('div', 'vehicle-stage-car');
  car.append(image, reflection);
  stage.appendChild(car);
  // Restart the drive-in each time a different preset is chosen.
  car.style.setProperty('--drive-from', container.dataset.lastPhoto && container.dataset.lastPhoto !== source.id ? '-38%' : '-24%');
  container.dataset.lastPhoto = source.id;
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    stage.style.setProperty('--tilt-x', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    stage.style.setProperty('--tilt-y', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  });
  stage.addEventListener('pointerleave', () => {
    stage.style.setProperty('--tilt-x', '0');
    stage.style.setProperty('--tilt-y', '0');
  });
  figure.appendChild(stage);

  const caption = element('figcaption', 'vehicle-photo-credit');
  caption.appendChild(element('span', 'vehicle-photo-disclaimer',
    'Illustrative vehicle photo; exact model year, trim, colour and wheels may vary.'));
  const sourceLink = creditLink('Source', source.sourceUrl);
  const licenseLink = creditLink(source.license, source.licenseUrl);
  caption.appendChild(element('span', '', `Photo: ${source.author}`));
  if (sourceLink) caption.appendChild(sourceLink);
  if (licenseLink) caption.appendChild(licenseLink);
  caption.appendChild(element('span', '', source.changes));
  figure.appendChild(caption);
  container.replaceChildren(figure);
}
