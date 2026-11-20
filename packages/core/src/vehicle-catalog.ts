/**
 * Vehicle catalog for the India market.
 *
 * IMPORTANT distinction baked into this model:
 * - `batteryKwh` and `claimedRangeKm` are PUBLISHED manufacturer specs
 *   (MIDC/ARAI claims). They are display/reference data only, and the UI
 *   must always label the range as a manufacturer claim.
 * - Real-world (safe) range is NEVER invented here. It is a USER input
 *   (`realWorldRangeKm`). The consumption model derives from what the user
 *   provides; the default Harrier profile runs on the app's working
 *   estimates (see MODEL_WORKING_ESTIMATES) until the user supplies one.
 *
 * Charging-curve parameters come from MODEL_WORKING_ESTIMATES too: generic
 * working estimates, NOT per-model manufacturer specs.
 */
import { HARIER_EV_75, MODEL_WORKING_ESTIMATES, type VehicleConfig } from './vehicle.js';

export interface VehicleCatalogEntry {
  id: string;
  make: string;
  model: string;
  variantLabel: string;
  /** Published nominal pack size, kWh. */
  batteryKwh: number;
  /** Manufacturer-claimed range (MIDC/ARAI), km. A claim, never a promise. */
  claimedRangeKm: number;
}

export const DEFAULT_HARRIER_ENTRY_ID = 'tata-harrier-ev-75';

/** Starter catalog of popular India-market EVs (published manufacturer claims). */
export const VEHICLE_CATALOG: VehicleCatalogEntry[] = [
  {
    id: 'tata-harrier-ev-75',
    make: 'Tata',
    model: 'Harrier EV',
    variantLabel: '75 kWh',
    batteryKwh: 75,
    claimedRangeKm: 627,
  },
  {
    id: 'tata-nexon-ev-lr-45',
    make: 'Tata',
    model: 'Nexon EV',
    variantLabel: 'Long Range 45 kWh',
    batteryKwh: 45,
    claimedRangeKm: 465,
  },
  {
    id: 'tata-punch-ev-lr-35',
    make: 'Tata',
    model: 'Punch EV',
    variantLabel: 'Long Range 35 kWh',
    batteryKwh: 35,
    claimedRangeKm: 421,
  },
  {
    id: 'tata-curvv-ev-55',
    make: 'Tata',
    model: 'Curvv EV',
    variantLabel: '55 kWh',
    batteryKwh: 55,
    claimedRangeKm: 585,
  },
  {
    id: 'tata-tiago-ev-24',
    make: 'Tata',
    model: 'Tiago EV',
    variantLabel: '24 kWh',
    batteryKwh: 24,
    claimedRangeKm: 315,
  },
  {
    id: 'mg-zs-ev-50',
    make: 'MG',
    model: 'ZS EV',
    variantLabel: '50.3 kWh',
    batteryKwh: 50.3,
    claimedRangeKm: 461,
  },
  {
    id: 'mg-windsor-ev-38',
    make: 'MG',
    model: 'Windsor EV',
    variantLabel: '38 kWh',
    batteryKwh: 38,
    claimedRangeKm: 332,
  },
  {
    id: 'mg-comet-ev-17',
    make: 'MG',
    model: 'Comet EV',
    variantLabel: '17.3 kWh',
    batteryKwh: 17.3,
    claimedRangeKm: 230,
  },
  {
    id: 'mahindra-be6-79',
    make: 'Mahindra',
    model: 'BE 6',
    variantLabel: '79 kWh',
    batteryKwh: 79,
    claimedRangeKm: 682,
  },
  {
    id: 'hyundai-ioniq5-72',
    make: 'Hyundai',
    model: 'Ioniq 5',
    variantLabel: '72.6 kWh',
    batteryKwh: 72.6,
    claimedRangeKm: 631,
  },
];

export interface CustomVehicleInput {
  label?: string;
  /** Nominal pack size, kWh (user-provided). */
  batteryKwh: number;
  /** Manufacturer-claimed range if known, display-only. */
  claimedRangeKm?: number;
  /** User's real-world/safe range, km. Required: never invented. */
  realWorldRangeKm: number;
}

export interface VehicleSelection {
  /** Catalog entry id; omit for custom vehicles or the default Harrier. */
  entryId?: string;
  /** Fully user-defined vehicle. */
  custom?: CustomVehicleInput;
  /**
   * User's real-world/safe range in km. Required for every vehicle except
   * the default Harrier EV 75 kWh profile (owner's documented assumption).
   */
  realWorldRangeKm?: number;
}

/** Resolved vehicle: derived config plus clearly separated claim vs input. */
export interface ResolvedVehicle {
  config: VehicleConfig;
  label: string;
  /** Catalog entry id, or null for a custom vehicle. */
  catalogId: string | null;
  batteryKwh: number;
  /** Manufacturer-claimed range (display-only, may be absent for customs). */
  claimedRangeKm: number | null;
  /**
   * The real-world/safe range the USER provided, km. Null when running on
   * the default Harrier working estimates (not an owner figure).
   */
  realWorldRangeKm: number | null;
}

const USABLE_FRACTION = MODEL_WORKING_ESTIMATES.usableFraction; // working estimate

export class VehicleSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VehicleSelectionError';
  }
}

function derivationError(label: string, issue: string): never {
  throw new VehicleSelectionError(`${label}: ${issue}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selectionError(message: string): never {
  throw new VehicleSelectionError(message);
}

function optionalString(value: unknown, field: string, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') selectionError(`${label}: ${field} must be a string`);
  return value;
}

function optionalNumber(value: unknown, field: string, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    selectionError(`${label}: ${field} must be a finite number`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string, label: string): number {
  if (value === undefined || value === null) selectionError(`${label}: ${field} is required`);
  return optionalNumber(value, field, label) as number;
}

function deriveConfig(
  label: string,
  batteryKwh: number,
  realWorldRangeKm: number,
): VehicleConfig {
  if (!Number.isFinite(batteryKwh) || batteryKwh < 5 || batteryKwh > 250) {
    derivationError(label, `implausible battery size ${batteryKwh} kWh`);
  }
  if (!Number.isFinite(realWorldRangeKm) || realWorldRangeKm < 20 || realWorldRangeKm > 1500) {
    derivationError(label, `implausible real-world range ${realWorldRangeKm} km`);
  }
  const usable = batteryKwh * USABLE_FRACTION;
  const whPerKm = (usable / realWorldRangeKm) * 1000;
  if (whPerKm < 60 || whPerKm > 500) {
    derivationError(
      label,
      `real-world range ${realWorldRangeKm} km implies ${Math.round(whPerKm)} Wh/km, outside plausible bounds`,
    );
  }
  return {
    batteryKwh,
    usableFraction: USABLE_FRACTION,
    whPerKm,
    // generic working estimates, deliberately NOT per-model manufacturer specs
    maxDcKw: MODEL_WORKING_ESTIMATES.maxDcKw,
    taperStartSocPct: MODEL_WORKING_ESTIMATES.taperStartSocPct,
    taperEndPowerKw: MODEL_WORKING_ESTIMATES.taperEndPowerKw,
  };
}

/**
 * Resolve a vehicle selection into a model config + metadata.
 *
 * - No selection (or Harrier without user range): the owner's default
 *   Harrier EV 75 kWh profile, exactly as it has always been.
 * - Catalog entry: requires `realWorldRangeKm` from the user. We never
 *   invent real-world range from the manufacturer claim.
 * - Custom vehicle: user must provide battery + real-world range.
 */
export function resolveVehicle(selection?: VehicleSelection): ResolvedVehicle {
  if (selection === undefined) return defaultHarrier();

  const sel = selection as unknown;
  if (!record(sel)) selectionError('vehicle selection must be an object');

  const vehicleLabel = 'Vehicle selection';
  const range = optionalNumber(sel.realWorldRangeKm, 'real-world range', vehicleLabel);
  if (range != null && range <= 0) selectionError(`${vehicleLabel}: real-world range must be positive`);

  if (sel.custom !== undefined && sel.custom !== null) {
    if (!record(sel.custom)) selectionError(`${vehicleLabel}: custom vehicle must be an object`);
    const custom = sel.custom;
    const batteryKwh = requiredNumber(custom.batteryKwh, 'battery size', 'Custom vehicle');
    const customLabelHint = optionalString(custom.label, 'label', `Custom (${batteryKwh} kWh)`);
    const label = customLabelHint?.trim() || `Custom (${batteryKwh} kWh)`;
    const realWorldRangeKm = requiredNumber(custom.realWorldRangeKm, 'real-world range', label);
    if (realWorldRangeKm <= 0) derivationError(label, 'real-world range must be positive');
    const claimedRangeKm = optionalNumber(custom.claimedRangeKm, 'claimed range', label);
    if (claimedRangeKm != null && claimedRangeKm <= 0) {
      derivationError(label, 'claimed range must be positive');
    }
    return {
      config: deriveConfig(label, batteryKwh, realWorldRangeKm),
      label,
      catalogId: null,
      batteryKwh,
      claimedRangeKm,
      realWorldRangeKm,
    };
  }

  let entryId = optionalString(sel.entryId, 'catalog id', vehicleLabel);
  // A range-only selection refers to the default vehicle. An explicit user
  // range must not disappear just because the optional id is absent.
  if (entryId == null && range != null) entryId = DEFAULT_HARRIER_ENTRY_ID;
  if (entryId == null) return defaultHarrier();

  const entry = VEHICLE_CATALOG.find((e) => e.id === entryId);
  if (!entry) {
    throw new VehicleSelectionError(`Unknown vehicle catalog id "${entryId}"`);
  }
  const label = `${entry.make} ${entry.model} (${entry.variantLabel})`;

  // Default Harrier: runs on the app's working estimates (unchanged default).
  if (entryId === DEFAULT_HARRIER_ENTRY_ID && range == null) {
    return {
      config: HARIER_EV_75,
      label,
      catalogId: entryId,
      batteryKwh: entry.batteryKwh,
      claimedRangeKm: entry.claimedRangeKm,
      realWorldRangeKm: null,
    };
  }

  if (range == null) {
    throw new VehicleSelectionError(
      `${label}: enter your real-world range. The manufacturer claim of ${entry.claimedRangeKm} km cannot be used as real-world range.`,
    );
  }

  return {
    config: deriveConfig(label, entry.batteryKwh, range),
    label,
    catalogId: entryId,
    batteryKwh: entry.batteryKwh,
    claimedRangeKm: entry.claimedRangeKm,
    realWorldRangeKm: range,
  };
}

function defaultHarrier(): ResolvedVehicle {
  return {
    config: HARIER_EV_75,
    label: 'Tata Harrier EV (75 kWh)',
    catalogId: DEFAULT_HARRIER_ENTRY_ID,
    batteryKwh: HARIER_EV_75.batteryKwh,
    claimedRangeKm: 627,
    realWorldRangeKm: null,
  };
}
