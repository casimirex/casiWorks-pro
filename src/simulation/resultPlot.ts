// CasiWorks Pro - FEA result plot: the analysed mesh coloured by a result, optionally deformed
import * as THREE from 'three';
import type { SolidMesh, SolidResult } from './FEAEngine.ts';

export type PlotQuantity = 'vonMises' | 'displacement';

export interface PlotOptions {
  quantity?: PlotQuantity;
  /** Show the deformed shape (exaggerated so it is visible). */
  deformed?: boolean;
  /**
   * Exaggeration of the displacements. 'auto' (default) draws the largest
   * displacement as 10% of the part's size.
   */
  deformationScale?: number | 'auto';
}

export interface ResultPlot {
  geometry: THREE.BufferGeometry;
  quantity: PlotQuantity;
  unit: 'MPa' | 'mm';
  min: number;
  max: number;
  /** Factor the displacements are multiplied by (0 when undeformed). */
  deformationScale: number;
}

/** Rainbow colour map: blue (low) → cyan → green → yellow → red (high), t in [0, 1]. */
export function colormap(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const stops: Array<[number, number, number]> = [[0, 0, 1], [0, 1, 1], [0, 1, 0], [1, 1, 0], [1, 0, 0]];
  const f = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const u = f - i;
  return [0, 1, 2].map(k => stops[i][k] + (stops[i + 1][k] - stops[i][k]) * u) as [number, number, number];
}

/** CSS gradient matching `colormap`, for legends. */
export const COLORMAP_CSS = 'linear-gradient(90deg, #0000ff 0%, #00ffff 25%, #00ff00 50%, #ffff00 75%, #ff0000 100%)';

/**
 * Surface of the analysed mesh coloured by the chosen result. Positions are in
 * mm like the model; displacements (m) are drawn exaggerated when `deformed`.
 */
export function buildResultPlot(mesh: Pick<SolidMesh, 'nodes' | 'boundaryFaces' | 'size'>, result: Pick<SolidResult, 'nodalVonMisesMPa' | 'displacementVectors'>, options: PlotOptions = {}): ResultPlot {
  const quantity = options.quantity ?? 'vonMises';
  const { nodes, boundaryFaces } = mesh;

  // Nodal values of the plotted quantity
  const values = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const v = quantity === 'vonMises'
      ? result.nodalVonMisesMPa[i]
      : (result.displacementVectors[i]?.length() ?? 0) * 1000; // m → mm
    values[i] = Number.isFinite(v) ? v : 0;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  const range = max - min > 1e-12 ? max - min : 1;

  // Exaggeration: largest displacement drawn as 10% of the model size
  let maxDispMM = 0;
  for (const d of result.displacementVectors) { const l = (d?.length() ?? 0) * 1000; if (Number.isFinite(l) && l > maxDispMM) maxDispMM = l; }
  const sizeMM = mesh.size.length() || 1;
  const deformationScale = !options.deformed ? 0
    : options.deformationScale === undefined || options.deformationScale === 'auto'
      ? (maxDispMM > 1e-12 ? (0.1 * sizeMM) / maxDispMM : 0)
      : Math.max(0, options.deformationScale);

  const position = (i: number) => {
    const p = nodes[i].point.clone();
    const d = result.displacementVectors[i];
    if (deformationScale && d) p.addScaledVector(d, 1000 * deformationScale); // m → mm, exaggerated
    return p;
  };

  const positions: number[] = [];
  const colors: number[] = [];
  for (const face of boundaryFaces) {
    const ids = face.nodes;
    if (!ids || ids.length < 3 || ids.some(i => !nodes[i])) continue;
    for (const i of ids.slice(0, 3)) {
      const p = position(i);
      positions.push(p.x, p.y, p.z);
      colors.push(...colormap((values[i] - min) / range));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return { geometry, quantity, unit: quantity === 'vonMises' ? 'MPa' : 'mm', min, max, deformationScale };
}
