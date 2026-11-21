/**
 * Browser-safe plug classification shared by core planning and the web
 * evidence workspace. This module has no runtime imports so bundlers never
 * pull server-side modules into the browser merely to classify a plug.
 */
import type { PlugHealth } from './types.js';

export interface PlugClassification {
  health: PlugHealth;
  /** status and fault/availability signals disagree */
  contradiction: boolean;
  /** Nominally usable status has present nonboolean availability evidence. */
  invalidAvailability?: true;
}

export interface ClassifiableConnector {
  status: string;
  available?: unknown;
  note?: string | null;
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const DEFAULT_WORDS: Record<string, true> = { default: true, defaults: true };
const CLEAN_NEGATED_FAULT_NOTES: Record<string, true> = {
  'no fault': true, nofault: true,
  'no faults': true, nofaults: true,
  'no fault detected': true, nofaultdetected: true,
  'no fault found': true, nofaultfound: true,
  'not faulted': true, notfaulted: true,
};
interface FaultSignals { positive: boolean; negated: boolean }
function faultSignals(text: string | null | undefined): FaultSignals {
  const clean = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const negated = CLEAN_NEGATED_FAULT_NOTES[clean] === true;
  const positive = !negated && (clean.match(/[a-z0-9]+/g) ?? [])
    .some((token) => DEFAULT_WORDS[token] !== true && /fault/.test(token));
  return { positive, negated };
}
/** Shared normalization for connector type vocabulary. */
export function connectorSlug(type: string): string {
  return norm(type);
}

/**
 * Authoritative plug health rules. `available` is accepted as unknown at this
 * boundary so malformed present values can be marked uncertain instead of
 * being coerced to null before classification.
 */
export function classifyPlugValues(c: ClassifiableConnector): PlugClassification {
  const status = norm(c.status);
  const note = norm(c.note ?? '');
  const available = c.available;
  const isUnavailable = status.includes('unavailable');
  const positiveStatus =
    !isUnavailable && /^(available|charging|preparing|finishing)$/.test(status);
  const faultInStatus = faultSignals(c.status).positive;
  const faultInNote = faultSignals(c.note).positive;
  const disconnectText = /disconnect|offline/.test(note) || /unavailable|offline/.test(status);

  if (faultInNote && positiveStatus) return { health: 'uncertain', contradiction: true };
  if (faultInStatus) return { health: 'faulted', contradiction: false };
  if (faultInNote) return { health: 'faulted', contradiction: false };
  if (isUnavailable || status.includes('offline')) return { health: 'offline', contradiction: false };
  if (positiveStatus && available != null && typeof available !== 'boolean') {
    return { health: 'uncertain', contradiction: true, invalidAvailability: true };
  }
  if (status === 'charging') {
    if (disconnectText) return { health: 'uncertain', contradiction: true };
    return { health: 'working-occupied', contradiction: false };
  }
  if (note.includes('finish') && disconnectText) return { health: 'uncertain', contradiction: true };
  if (status === 'finishing') {
    if (disconnectText) return { health: 'uncertain', contradiction: true };
    return { health: 'finishing', contradiction: false };
  }
  if (status === 'preparing') {
    if (available === false || disconnectText) return { health: 'uncertain', contradiction: true };
    return { health: 'working-free', contradiction: false };
  }
  if (status === 'available') {
    if (note.includes('charging') && available !== true) return { health: 'working-occupied', contradiction: false };
    if (available === false) return { health: 'uncertain', contradiction: true };
    if (disconnectText) return { health: 'uncertain', contradiction: true };
    return { health: 'working-free', contradiction: false };
  }
  if (disconnectText || status.includes('unavailable')) return { health: 'offline', contradiction: false };
  return { health: 'uncertain', contradiction: true };
}
