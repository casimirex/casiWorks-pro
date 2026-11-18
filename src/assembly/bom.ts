// CasiWorks Pro - Bill of materials for the assembly
//
// One row per distinct part (same name, shape, size and material), with its
// quantity. Volumes are exact for the primitive shapes (not the faceted display
// mesh); mass uses each component's material, or the document's when it has none.
import type { MassUnit } from '../utils/units.ts';
import type { PrimitiveDims, PrimitiveShape } from '../store/cadStore.ts';
import { MATERIALS } from '../utils/constants.ts';

export interface BomComponent {
  id: string;
  name: string;
  geometryType?: PrimitiveShape;
  dimensions?: PrimitiveDims;
  /** Material key; unset means the document material. */
  material?: string;
}

export interface BomRow {
  item: number;
  partNumber: string;
  description: string;
  quantity: number;
  /** Material name, as shown. */
  material: string;
  /** Material key (MATERIALS). */
  materialKey: string;
  /** True when it is the document material (the component has none of its own). */
  inherited: boolean;
  /** mm³ per part. */
  unitVolume: number;
  /** kg per part. */
  unitMass: number;
  /** kg for the whole quantity. */
  totalMass: number;
  componentIds: string[];
}

export interface Bom {
  rows: BomRow[];
  totalQuantity: number;
  /** kg */
  totalMass: number;
  /** Document material name (what components without their own use). */
  material: string;
}

/** Size of a primitive as it is built (same defaults as the assembly inserts it with). */
function shapeSize(shape: PrimitiveShape, dims: PrimitiveDims): { description: string; volume: number } {
  const f = (v: number) => +v.toFixed(2);
  switch (shape) {
    case 'cylinder': {
      const r = dims.radius || 10, h = dims.height || 30;
      return { description: `Cylinder Ø${f(2 * r)} × ${f(h)} mm`, volume: Math.PI * r * r * h };
    }
    case 'flange':
      return { description: 'Flange Ø50 × 8 mm', volume: Math.PI * 25 * 25 * 8 };
    case 'pin':
      return { description: 'Pin Ø12 × 40 mm', volume: Math.PI * 6 * 6 * 40 };
    case 'box':
    default: {
      const w = dims.width || 30, h = dims.height || 20, d = dims.depth || 30;
      return { description: `Block ${f(w)} × ${f(h)} × ${f(d)} mm`, volume: w * h * d };
    }
  }
}

const materialOf = (key: string) => MATERIALS[key] ?? MATERIALS.Steel_1020;

/** The bill of materials: parts in the order they were first inserted. */
export function buildBom(components: BomComponent[], documentMaterial: string): Bom {
  const rows = new Map<string, BomRow>();
  for (const c of components) {
    const shape = c.geometryType ?? 'box';
    const dims = c.dimensions ?? {};
    const { description, volume } = shapeSize(shape, dims);
    const own = c.material && c.material in MATERIALS ? c.material : null;
    const materialKey = own ?? (documentMaterial in MATERIALS ? documentMaterial : 'Steel_1020');
    const material = materialOf(materialKey);
    const key = `${c.name}\u0000${description}\u0000${materialKey}\u0000${own ? 'own' : 'doc'}`;
    const row = rows.get(key);
    if (row) {
      row.quantity += 1;
      row.componentIds.push(c.id);
      continue;
    }
    const unitMass = volume * 1e-9 * material.density;
    rows.set(key, {
      item: rows.size + 1, partNumber: c.name, description, quantity: 1, material: material.name, materialKey, inherited: !own,
      unitVolume: volume, unitMass, totalMass: unitMass, componentIds: [c.id],
    });
  }
  const list = [...rows.values()];
  for (const r of list) r.totalMass = r.unitMass * r.quantity;
  return {
    rows: list,
    totalQuantity: list.reduce((n, r) => n + r.quantity, 0),
    totalMass: list.reduce((m, r) => m + r.totalMass, 0),
    material: materialOf(documentMaterial).name,
  };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Kilograms per mass unit, and the decimals masses are written with. */
const MASS: Record<MassUnit, { kg: number; decimals: number }> = { g: { kg: 0.001, decimals: 2 }, kg: { kg: 1, decimals: 4 }, lb: { kg: 0.45359237, decimals: 4 } };

/** A mass (kg) as a number in `unit`, with that unit's decimals. */
export const massIn = (kg: number, unit: MassUnit = 'g') => (kg / MASS[unit].kg).toFixed(MASS[unit].decimals);

/** The BOM as CSV (spreadsheet-ready; masses in grams, or in `unit`). */
export function bomCSV(bom: Bom, unit: MassUnit = 'g'): string {
  const head = ['Item', 'Part number', 'Description', 'Qty', 'Material', `Unit mass (${unit})`, `Total mass (${unit})`];
  const lines = bom.rows.map(r => [r.item, r.partNumber, r.description, r.quantity, r.material, massIn(r.unitMass, unit), massIn(r.totalMass, unit)]);
  lines.push(['', 'Total', '', bom.totalQuantity, '', '', massIn(bom.totalMass, unit)]);
  return [head, ...lines].map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
