// CasiWorks Pro - Bill of materials for the assembly
//
// One row per distinct part (same name, shape and size), with its quantity.
// Volumes are exact for the primitive shapes (not the faceted display mesh);
// mass uses the document's material, which every component shares today.
import type { PrimitiveDims, PrimitiveShape } from '../store/cadStore.ts';

export interface BomComponent {
  id: string;
  name: string;
  geometryType?: PrimitiveShape;
  dimensions?: PrimitiveDims;
}

export interface BomRow {
  item: number;
  partNumber: string;
  description: string;
  quantity: number;
  material: string;
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

/** The bill of materials: parts in the order they were first inserted. */
export function buildBom(components: BomComponent[], material: { name: string; density: number }): Bom {
  const rows = new Map<string, BomRow>();
  for (const c of components) {
    const shape = c.geometryType ?? 'box';
    const dims = c.dimensions ?? {};
    const { description, volume } = shapeSize(shape, dims);
    const key = `${c.name}\u0000${description}`;
    const row = rows.get(key);
    if (row) {
      row.quantity += 1;
      row.componentIds.push(c.id);
      continue;
    }
    const unitMass = volume * 1e-9 * material.density;
    rows.set(key, {
      item: rows.size + 1, partNumber: c.name, description, quantity: 1, material: material.name,
      unitVolume: volume, unitMass, totalMass: unitMass, componentIds: [c.id],
    });
  }
  const list = [...rows.values()];
  for (const r of list) r.totalMass = r.unitMass * r.quantity;
  return {
    rows: list,
    totalQuantity: list.reduce((n, r) => n + r.quantity, 0),
    totalMass: list.reduce((m, r) => m + r.totalMass, 0),
    material: material.name,
  };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The BOM as CSV (spreadsheet-ready; masses in grams). */
export function bomCSV(bom: Bom): string {
  const head = ['Item', 'Part number', 'Description', 'Qty', 'Material', 'Unit mass (g)', 'Total mass (g)'];
  const lines = bom.rows.map(r => [r.item, r.partNumber, r.description, r.quantity, r.material, (r.unitMass * 1000).toFixed(2), (r.totalMass * 1000).toFixed(2)]);
  lines.push(['', 'Total', '', bom.totalQuantity, '', '', (bom.totalMass * 1000).toFixed(2)]);
  return [head, ...lines].map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
