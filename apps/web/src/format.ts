/**
 * Display formatters. Pure functions, unit-tested.
 */

/** "3 h 42 min" or "42 min"; unavailable input renders an em dash. */
export function formatDuration(totalMin: number | null | undefined): string {
  if (!Number.isFinite(totalMin) || totalMin < 0) return '—';
  const m = Math.round(totalMin);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem} min`;
  if (rem === 0) return `${h} h`;
  return `${h} h ${rem} min`;
}

/** "284.9 km" -> "285 km". */
export function formatKm(km: number): string {
  if (!Number.isFinite(km)) return '—';
  return `${Math.round(km)} km`;
}

/** "Rs. 1,234" (Indian digit grouping); null-safe. */
export function formatInr(rupees: number | null | undefined): string {
  if (rupees == null) return '—';
  return `Rs. ${Math.round(rupees).toLocaleString('en-IN')}`;
}

/** "Rs. 22.75/kWh". */
export function formatTariff(rupeesPerKwh: number | null | undefined): string {
  if (rupeesPerKwh == null) return '—';
  const v = Math.round(rupeesPerKwh * 100) / 100;
  return `Rs. ${v}/kWh`;
}

/** "18.4 kWh". */
export function formatKwh(kwh: number | null | undefined): string {
  if (kwh == null) return '—';
  return `${Math.round(kwh * 10) / 10} kWh`;
}

/**
 * Human label for a station's last-used date. Canonical dd/mm/yyyy
 * charger values format to the MOST RECENT date; a non-canonical value
 * passes through RAW (callers must escape it at the render boundary -
 * upstream strings are untrusted and one flowed into innerHTML).
 * Empty input yields 'unknown'.
 */
export function lastUsedLabel(chargers: unknown): string {
  const entries = Array.isArray(chargers) ? chargers : [];
  const dates = entries
    .map((entry) => entry != null && typeof entry === 'object' && typeof (entry as { lastUsedOn?: unknown }).lastUsedOn === 'string'
      ? (entry as { lastUsedOn: string }).lastUsedOn
      : null)
    .filter((d): d is string => d != null && d.trim().length > 0);
  if (dates.length === 0) return 'unknown';
  // dd/mm/yyyy; pick the most recent
  const parsed = dates.map(parseChargerDate).filter((d): d is Date => d !== null);
  if (parsed.length === 0) return dates[0] as string;
  const latest = parsed.sort((a, b) => b.getTime() - a.getTime())[0] as Date;
  return `${latest.getDate()}/${latest.getMonth() + 1}/${latest.getFullYear()}`;
}

/** "26%" battery. */
export function formatSoc(soc: number | null | undefined): string {
  if (soc == null) return '—';
  return `${Math.round(soc)}%`;
}

/** Parse calendar values without Date's silent rollover of invalid days. */
function parseChargerDate(raw: string): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = Number(match[3]);
  // setFullYear avoids the constructor's special 1900 offset for years 0..99.
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date : null;
}

/** dd/mm/yyyy (Statiq) -> "18 Nov 2026"; unparseable input returned as-is. */
export function formatLastUsed(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '—';
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m || !parseChargerDate(raw.trim())) return raw;
  const [, dd, mm, yyyy] = m;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = Number(mm) - 1;
  if (monthIndex < 0 || monthIndex > 11) return raw;
  return `${Number(dd)} ${months[monthIndex]} ${yyyy}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO date -> "19 Nov 2026, 14:05" (or compact for space-constrained chips). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date}, ${hh}:${mm}`;
}

/** "42 min ago" style relative label for fetched-at timestamps. */
export function formatTimeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'unknown time';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 15) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

/** "4.72" with a star glyph -> "★ 4.72"; null-safe. */
export function formatRating(rating: number | null | undefined, reviewCount?: number | null): string {
  if (rating == null) return 'No rating';
  const star = '★';
  const base = `${star} ${Math.round(rating * 10) / 10}`;
  if (reviewCount == null) return base;
  return `${base} (${Math.round(reviewCount).toLocaleString('en-IN')})`;
}

/** ETA minute offset from trip start -> "3 h 26 in" (relative to departure). */
export function formatEta(minuteOffset: number | null | undefined): string {
  if (minuteOffset == null) return '—';
  return formatDuration(minuteOffset);
}

export function socTone(soc: number | null | undefined): 'high' | 'mid' | 'low' {
  if (soc == null) return 'low';
  if (soc >= 45) return 'high';
  if (soc >= 20) return 'mid';
  return 'low';
}

/** "Reliability: unavailable" — the honest label (null, never 0). */
export const RELIABILITY_LABEL = 'Unavailable';

/** Provider counts are unknown unless they are nonnegative safe integers. */
export function formatReviewCount(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString('en-IN')
    : 'unknown';
}
