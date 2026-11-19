/**
 * Charger brand detection from station names (the API has no brand field).
 * Preference order per spec: Statiq > Tata > BPCL > HP > others.
 */
import type { Brand } from './types.js';

export function detectBrand(name: string | null | undefined): Brand {
  const n = name ?? '';
  // The earliest matching brand in the preference order wins, so a
  // co-branded station like "Statiq x TATA.ev ..." counts as Statiq.
  if (/\bstatiq\b/i.test(n)) return 'statiq';
  if (/\btata\b/i.test(n)) return 'tata';
  if (/\bbpcl\b/i.test(n) || /\bbp\b/i.test(n)) return 'bpcl';
  if (/\bhpcl\b/i.test(n) || /\bhp\b/i.test(n)) return 'hp';
  return 'other';
}
