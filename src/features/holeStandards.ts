// CasiWorks Pro - Hole Wizard: ISO metric hole sizes
//
// Sources (values in mm):
//  - Coarse thread pitch: ISO 261 / ISO 262.
//  - Clearance holes: ISO 273 (close / normal / loose series, "fine / medium / coarse").
//  - Counterbores for hexagon socket head cap screws (ISO 4762): Ø from DIN 974-1;
//    depth = head height k (= d) + 0.4 to 0.6 so the head sits just below the surface.
//  - Countersinks for countersunk socket head screws (ISO 10642): 90°, Ø = head dk max.
//  - Tap drill: d − P (the usual drill for ~75 % thread engagement).
// Threads are not modelled (the mesh kernel cannot cut a helix): a tapped hole is
// drilled at the tap drill size and named with its thread, e.g. "M8×1.25".

export type MetricSize = 'M3' | 'M4' | 'M5' | 'M6' | 'M8' | 'M10' | 'M12' | 'M16' | 'M20';
export type ClearanceFit = 'close' | 'normal' | 'loose';
export type HoleKind = 'simple' | 'counterbore' | 'countersink' | 'tapped';

interface SizeRow {
  d: number;
  pitch: number;
  clearance: Record<ClearanceFit, number>;
  counterbore: { diameter: number; depth: number };
  countersink: { diameter: number; angle: number };
}

export const METRIC: Readonly<Record<MetricSize, SizeRow>> = {
  M3: { d: 3, pitch: 0.5, clearance: { close: 3.2, normal: 3.4, loose: 3.6 }, counterbore: { diameter: 6.5, depth: 3.4 }, countersink: { diameter: 6.72, angle: 90 } },
  M4: { d: 4, pitch: 0.7, clearance: { close: 4.3, normal: 4.5, loose: 4.8 }, counterbore: { diameter: 8, depth: 4.4 }, countersink: { diameter: 8.96, angle: 90 } },
  M5: { d: 5, pitch: 0.8, clearance: { close: 5.3, normal: 5.5, loose: 5.8 }, counterbore: { diameter: 10, depth: 5.4 }, countersink: { diameter: 11.2, angle: 90 } },
  M6: { d: 6, pitch: 1, clearance: { close: 6.4, normal: 6.6, loose: 7 }, counterbore: { diameter: 11, depth: 6.4 }, countersink: { diameter: 13.44, angle: 90 } },
  M8: { d: 8, pitch: 1.25, clearance: { close: 8.4, normal: 9, loose: 10 }, counterbore: { diameter: 15, depth: 8.6 }, countersink: { diameter: 17.92, angle: 90 } },
  M10: { d: 10, pitch: 1.5, clearance: { close: 10.5, normal: 11, loose: 12 }, counterbore: { diameter: 18, depth: 10.6 }, countersink: { diameter: 22.4, angle: 90 } },
  M12: { d: 12, pitch: 1.75, clearance: { close: 13, normal: 13.5, loose: 14.5 }, counterbore: { diameter: 20, depth: 12.6 }, countersink: { diameter: 26.88, angle: 90 } },
  M16: { d: 16, pitch: 2, clearance: { close: 17, normal: 17.5, loose: 18.5 }, counterbore: { diameter: 26, depth: 16.6 }, countersink: { diameter: 33.6, angle: 90 } },
  M20: { d: 20, pitch: 2.5, clearance: { close: 21, normal: 22, loose: 24 }, counterbore: { diameter: 33, depth: 20.6 }, countersink: { diameter: 40.32, angle: 90 } },
};
export const METRIC_SIZES = Object.keys(METRIC) as MetricSize[];
export const CLEARANCE_FITS: readonly ClearanceFit[] = ['close', 'normal', 'loose'];

/** The sizes a standard hole resolves to; the feature stores these so rebuilds need no table. */
export interface StandardHole {
  diameter: number;
  cbDiameter?: number;
  cbDepth?: number;
  csDiameter?: number;
  csAngle?: number;
  /** e.g. 'M8×1.25' for tapped holes. */
  thread?: string;
  /** A short name for the feature tree, e.g. 'M8 Counterbore'. */
  label: string;
  /** One line describing the hole, e.g. 'Ø9 clearance (normal), counterbore Ø15 × 8.6 deep'. */
  description: string;
}

const f = (v: number) => String(+v.toFixed(2));

/** Resolve a standard hole: kind, size and (for clearance holes) the fit. */
export function standardHole(kind: HoleKind, size: MetricSize, fit: ClearanceFit = 'normal'): StandardHole {
  const row = METRIC[size];
  if (!row) throw new Error(`Unknown size ${size}; one of ${METRIC_SIZES.join(', ')}`);
  if (kind === 'tapped') {
    const drill = +(row.d - row.pitch).toFixed(2);
    const thread = `${size}×${f(row.pitch)}`;
    return { diameter: drill, thread, label: `${size} Tapped`, description: `Tap drill Ø${f(drill)} for ${thread} (thread not modelled)` };
  }
  if (!CLEARANCE_FITS.includes(fit)) throw new Error(`fit must be one of ${CLEARANCE_FITS.join(', ')}`);
  const diameter = row.clearance[fit];
  const base = `Ø${f(diameter)} clearance (${fit})`;
  if (kind === 'counterbore') {
    const cb = row.counterbore;
    return { diameter, cbDiameter: cb.diameter, cbDepth: cb.depth, label: `${size} Counterbore`, description: `${base}, counterbore Ø${f(cb.diameter)} × ${f(cb.depth)} deep for ISO 4762 heads` };
  }
  if (kind === 'countersink') {
    const cs = row.countersink;
    return { diameter, csDiameter: cs.diameter, csAngle: cs.angle, label: `${size} Countersink`, description: `${base}, countersink Ø${f(cs.diameter)} × ${cs.angle}° for ISO 10642 heads` };
  }
  return { diameter, label: `${size} Clearance`, description: base };
}
