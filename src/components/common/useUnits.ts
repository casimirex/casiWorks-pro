// CasiWorks Pro - The document's unit system for display (8.3)
import { useMemo } from 'react';
import { useCADStore } from '../../store/cadStore.ts';
import { SYSTEMS, formatArea, formatDensity, formatInertia, formatLength, formatMass, formatVolume, lengthUnit, massUnit, toLength, trimNumber, unitSystemOf } from '../../utils/units.ts';
import type { UnitSystem } from '../../utils/units.ts';

export interface Units {
  system: UnitSystem;
  lengthUnit: string;
  massUnit: string;
  /** "12.5 mm"; `decimals` extra over the system's default. */
  len(mm: number, opts?: { extra?: number; fixed?: boolean; unit?: boolean }): string;
  /** The number only, in the system's length unit. */
  num(mm: number, extra?: number): string;
  area(mm2: number): string;
  volume(mm3: number): string;
  mass(kg: number): string;
  density(kgPerM3: number): string;
  inertia(kgmm2: number): string;
}

export function unitsFor(system: UnitSystem): Units {
  const d = SYSTEMS[system].decimals;
  return {
    system,
    lengthUnit: lengthUnit(system),
    massUnit: massUnit(system),
    len: (mm, { extra = 0, fixed = false, unit = true } = {}) => formatLength(mm, system, { decimals: d + extra, fixed, unit }),
    num: (mm, extra = 0) => trimNumber(toLength(mm, system), d + extra),
    area: mm2 => formatArea(mm2, system),
    volume: mm3 => formatVolume(mm3, system),
    mass: kg => formatMass(kg, system),
    density: kgPerM3 => formatDensity(kgPerM3, system),
    inertia: kgmm2 => formatInertia(kgmm2, system),
  };
}

/** Formatters for the open document's unit system. */
export function useUnits(): Units {
  const system = unitSystemOf(useCADStore(s => s.settings.units));
  return useMemo(() => unitsFor(system), [system]);
}
