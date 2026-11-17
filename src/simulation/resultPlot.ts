// CasiWorks Pro - FEA result plot: the analysed mesh coloured by a result, optionally deformed
import * as THREE from 'three';
import type { SolidResult } from './FEAEngine.ts';

export type PlotQuantity = 'vonMises' | 'displacement';

/** The parts of the analysed mesh a plot needs (node positions in mm, surface triangles). */
export interface PlotMesh {
  nodes: Array<{ point: THREE.Vector3 }>;
  boundaryFaces: Array<{ nodes: ArrayLike<number> }>;
  size: THREE.Vector3;
}

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
  /** For probes: the mesh node behind each plot vertex. */
  vertexNodes: Int32Array;
  /** For probes: von Mises (MPa) and displacement magnitude (mm) of every node. */
  nodeVonMisesMPa: Float32Array;
  nodeDisplacementMM: Float32Array;
  /** For probes: undeformed node positions (mm), x y z per node. */
  nodePoints: Float32Array;
}

/** A result probe: the values at one mesh node. */
export interface FeaProbe {
  node: number;
  /** Undeformed position, mm. */
  point: { x: number; y: number; z: number };
  vonMisesMPa: number;
  displacementMM: number;
}

/** The probe for plot vertex `vertex` (a corner of the clicked triangle). */
export function probeAt(plot: ResultPlot, vertex: number): FeaProbe | null {
  const node = plot.vertexNodes[vertex];
  if (node === undefined || node < 0) return null;
  return {
    node,
    point: { x: plot.nodePoints[3 * node], y: plot.nodePoints[3 * node + 1], z: plot.nodePoints[3 * node + 2] },
    vonMisesMPa: plot.nodeVonMisesMPa[node],
    displacementMM: plot.nodeDisplacementMM[node],
  };
}

/** Where a node is drawn in the plot now (deformed or not), or null when it is not on the surface. */
export function plotPositionOf(plot: ResultPlot, node: number): [number, number, number] | null {
  const pos = plot.geometry.getAttribute('position');
  for (let v = 0; v < plot.vertexNodes.length; v++) {
    if (plot.vertexNodes[v] === node) return [pos.getX(v), pos.getY(v), pos.getZ(v)];
  }
  return null;
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
export function buildResultPlot(mesh: PlotMesh, result: Pick<SolidResult, 'nodalVonMisesMPa' | 'displacementVectors'>, options: PlotOptions = {}): ResultPlot {
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
  const vertexNodes: number[] = [];
  for (const face of boundaryFaces) {
    const ids = [face.nodes[0], face.nodes[1], face.nodes[2]];
    if (ids.some(i => i === undefined || !nodes[i])) continue;
    for (const i of ids) {
      const p = position(i);
      positions.push(p.x, p.y, p.z);
      colors.push(...colormap((values[i] - min) / range));
      vertexNodes.push(i);
    }
  }

  // Both quantities at every node, so a probe shows stress and displacement whatever is plotted
  const nodeVonMisesMPa = new Float32Array(nodes.length);
  const nodeDisplacementMM = new Float32Array(nodes.length);
  const nodePoints = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    const vm = result.nodalVonMisesMPa[i];
    const d = (result.displacementVectors[i]?.length() ?? 0) * 1000;
    nodeVonMisesMPa[i] = Number.isFinite(vm) ? vm : 0;
    nodeDisplacementMM[i] = Number.isFinite(d) ? d : 0;
    nodePoints[3 * i] = nodes[i].point.x; nodePoints[3 * i + 1] = nodes[i].point.y; nodePoints[3 * i + 2] = nodes[i].point.z;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return {
    geometry, quantity, unit: quantity === 'vonMises' ? 'MPa' : 'mm', min, max, deformationScale,
    vertexNodes: Int32Array.from(vertexNodes), nodeVonMisesMPa, nodeDisplacementMM, nodePoints,
  };
}
