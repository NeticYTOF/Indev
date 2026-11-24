/**
 * Browser-safe plug classification shared by core planning and the web
 * evidence workspace. This module has no runtime imports so bundlers never
 * pull server-side modules into the browser merely to classify a plug.
 */
import type { PlugHealth } from './types.js';

export interface PlugClassification {
  health: PlugHealth;
  /** Planning-only eligibility state; may differ from observed health under an explicit policy. */
  planningHealth: PlugHealth;
  /** status and fault/availability signals disagree */
  contradiction: boolean;
  /** Nominally usable status has present nonboolean availability evidence. */
  invalidAvailability?: true;
  /**
   * Status says available but the note carries positive fault text. Owner
   * policy (23 Nov 2026): status wins for planning (the plug stays usable),
   * and every chosen stop with such a plug carries a visible warning. Live
   * Statiq data returns this pairing on most corridor plugs, so excluding it
   * made drivable routes look infeasible. Not proof either way.
   */
  faultNote?: 'positive_fault_with_available_status';
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
  const core = classifyPlugCore(c);
  // Status wins for planning unless availability explicitly says no.
  const planningHealth: PlugHealth = core.faultNote && (c.available === true || c.available == null)
    ? 'working-free' : core.health;
  return { ...core, planningHealth };
}
type CoreClassification = Omit<PlugClassification, 'planningHealth'>;
function classifyPlugCore(c: ClassifiableConnector): CoreClassification {
  const status = norm(c.status);
  const note = norm(c.note ?? '');
  const available = c.available;
  const isUnavailable = status.includes('unavailable');
  const positiveStatus =
    !isUnavailable && /^(available|charging|preparing|finishing)$/.test(status);
  const faultInStatus = faultSignals(c.status).positive;
  const faultInNote = faultSignals(c.note).positive;
  const disconnectText = /disconnect|offline/.test(note) || /unavailable|offline/.test(status);

  if (faultInNote && positiveStatus) return {
    health: 'uncertain', contradiction: true,
    ...(status === 'available'
      ? { faultNote: 'positive_fault_with_available_status' as const } : {}),
  };
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
