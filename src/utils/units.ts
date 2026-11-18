// CasiWorks Pro - Unit systems (roadmap 8.3)
//
// The model, the files and the public API are in millimetres, kilograms and
// seconds whatever the document's unit system. The unit system only changes
// what is shown and how typed numbers are read: a length field shows inches
// in IPS and takes "2" as 2 in (or "50 mm" with its unit).
//
//   MMGS  millimetre, gram, second
//   CGS   centimetre, gram, second
//   MKS   metre, kilogram, second
//   IPS   inch, pound, second

export type UnitSystem = 'MMGS' | 'CGS' | 'MKS' | 'IPS';
export const UNIT_SYSTEMS: readonly UnitSystem[] = ['MMGS', 'CGS', 'MKS', 'IPS'];

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export type MassUnit = 'g' | 'kg' | 'lb';

/** Millimetres per unit. */
export const MM_PER: Readonly<Record<LengthUnit, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
/** Kilograms per unit. */
export const KG_PER: Readonly<Record<MassUnit, number>> = { g: 0.001, kg: 1, lb: 0.45359237 };

export interface UnitSystemInfo {
  name: string;
  length: LengthUnit;
  mass: MassUnit;
  /** Decimals shown for lengths. */
  decimals: number;
}

export const SYSTEMS: Readonly<Record<UnitSystem, UnitSystemInfo>> = {
  MMGS: { name: 'MMGS (millimetre, gram, second)', length: 'mm', mass: 'g', decimals: 2 },
  CGS: { name: 'CGS (centimetre, gram, second)', length: 'cm', mass: 'g', decimals: 3 },
  MKS: { name: 'MKS (metre, kilogram, second)', length: 'm', mass: 'kg', decimals: 4 },
  IPS: { name: 'IPS (inch, pound, second)', length: 'in', mass: 'lb', decimals: 3 },
};

/** The unit system of a stored setting; older files say 'mm'. */
export function unitSystemOf(setting: unknown): UnitSystem {
  return UNIT_SYSTEMS.includes(setting as UnitSystem) ? (setting as UnitSystem) : 'MMGS';
}

export const lengthUnit = (system: UnitSystem): LengthUnit => SYSTEMS[system].length;
export const massUnit = (system: UnitSystem): MassUnit => SYSTEMS[system].mass;

/** A length in mm in the system's unit. */
export const toLength = (mm: number, system: UnitSystem): number => mm / MM_PER[lengthUnit(system)];
/** A length in the system's unit in mm. */
export const fromLength = (value: number, system: UnitSystem): number => value * MM_PER[lengthUnit(system)];

/** A number without trailing zeros (at most `decimals`), and no "-0". */
export function trimNumber(v: number, decimals: number): string {
  const r = +v.toFixed(decimals);
  return String(Object.is(r, -0) ? 0 : r);
}

/** "12.5 mm", "0.492 in". `fixed` keeps trailing zeros (for tables and sheets). */
export function formatLength(mm: number, system: UnitSystem, { decimals = SYSTEMS[system].decimals, fixed = false, unit = true } = {}): string {
  const v = toLength(mm, system);
  const text = fixed ? (Object.is(+v.toFixed(decimals), -0) ? 0 : v).toFixed(decimals) : trimNumber(v, decimals);
  return unit ? `${text} ${lengthUnit(system)}` : text;
}

/** An area given in mm². */
export function formatArea(mm2: number, system: UnitSystem, decimals = SYSTEMS[system].decimals): string {
  const f = MM_PER[lengthUnit(system)] ** 2;
  return `${trimNumber(mm2 / f, decimals + 1)} ${lengthUnit(system)}²`;
}

/** A volume given in mm³. */
export function formatVolume(mm3: number, system: UnitSystem, decimals = SYSTEMS[system].decimals): string {
  const f = MM_PER[lengthUnit(system)] ** 3;
  return `${trimNumber(mm3 / f, decimals + 2)} ${lengthUnit(system)}³`;
}

/** A mass given in kg. */
export function formatMass(kg: number, system: UnitSystem, decimals = 3): string {
  return `${trimNumber(kg / KG_PER[massUnit(system)], decimals)} ${massUnit(system)}`;
}

/** A density given in kg/m³, in the system's mass per length³. */
export function formatDensity(kgPerM3: number, system: UnitSystem): string {
  const len = MM_PER[lengthUnit(system)] / 1000; // metres per unit
  const v = (kgPerM3 / KG_PER[massUnit(system)]) * len ** 3;
  return `${+v.toPrecision(4)} ${massUnit(system)}/${lengthUnit(system)}³`;
}

/** A moment of inertia given in kg·mm². */
export function formatInertia(kgmm2: number, system: UnitSystem): string {
  const v = (kgmm2 / KG_PER[massUnit(system)]) / MM_PER[lengthUnit(system)] ** 2;
  return `${+v.toPrecision(5)} ${massUnit(system)}·${lengthUnit(system)}²`;
}

const UNIT_WORDS: Record<string, LengthUnit> = {
  mm: 'mm', millimeter: 'mm', millimetre: 'mm', millimeters: 'mm', millimetres: 'mm',
  cm: 'cm', centimeter: 'cm', centimetre: 'cm', centimeters: 'cm', centimetres: 'cm',
  m: 'm', meter: 'm', metre: 'm', meters: 'm', metres: 'm',
  in: 'in', inch: 'in', inches: 'in', '"': 'in', '″': 'in',
  ft: 'ft', foot: 'ft', feet: 'ft', "'": 'ft', '′': 'ft',
};

/**
 * A typed length in mm: a plain number is in the system's unit; a number
 * with a unit ("25.4 mm", "1in", "2.5\"", "1 ft") is in that unit. Null when
 * the text is not a length.
 */
export function parseLength(text: string, system: UnitSystem): number | null {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z"'″′]*)\s*$/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  if (!m[2]) return fromLength(value, system);
  const unit = UNIT_WORDS[m[2].toLowerCase()];
  return unit ? value * MM_PER[unit] : null;
}

/** A step for spin buttons in the system's unit, near `mm` millimetres: 1, 2 or 5 × a power of ten. */
export function niceStep(mm: number, system: UnitSystem): number {
  const v = toLength(mm, system);
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return +((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p).toPrecision(6);
}
