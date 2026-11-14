// CasiWorks Pro - Automatic FEA meshing with a quality report
//
// The solid mesh is voxel based: grid cells whose centre lies inside the part
// become 6 tetrahedra each. Thin walls therefore round to whole cells, and the
// error depends on how the grid lines up with the part. This picks a grid size
// from an element budget, tries a few neighbouring sizes and keeps the one
// whose meshed volume is closest to the part's, and reports that coverage so
// users can judge the result.
import type * as THREE from 'three';
import type { ElementType, FEAEngine, SolidMesh } from './FEAEngine.ts';

export type MeshQuality = 'coarse' | 'medium' | 'fine';

/** Target element counts (Tet10 solve time grows quickly with size). */
export const MESH_BUDGET: Record<MeshQuality, number> = { coarse: 1500, medium: 5000, fine: 15000 };

/** Coverage further than this from 100% is reported as a warning. */
export const COVERAGE_TOLERANCE = 0.05;

export interface MeshInfo {
  quality: MeshQuality;
  /** Grid cells along the part's longest side. */
  divisions: number;
  elements: number;
  nodes: number;
  /** Meshed volume ÷ part volume (1 = the mesh has exactly the part's volume). */
  coverage: number;
  /** Grid sizes tried, with their coverage. */
  tried: Array<{ divisions: number; elements: number; coverage: number }>;
}

/** Enclosed volume of a closed triangle mesh (mm³). */
export function modelVolume(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const n = index ? index.count : pos.count;
  let v = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    const [a, b, c] = [0, 1, 2].map(k => (index ? index.getX(t + k) : t + k));
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}

/** Volume of the tetrahedral mesh (mm³), from each element's corner nodes. */
export function meshVolume(mesh: Pick<SolidMesh, 'nodes' | 'elements'>): number {
  let v = 0;
  for (const el of mesh.elements) {
    const [p0, p1, p2, p3] = el.nodes.slice(0, 4).map(i => mesh.nodes[i].point);
    const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
    const bx = p2.x - p0.x, by = p2.y - p0.y, bz = p2.z - p0.z;
    const cx = p3.x - p0.x, cy = p3.y - p0.y, cz = p3.z - p0.z;
    v += Math.abs(ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/** Mesh `geometry` in `fea` for the given quality and return the mesh report. */
export function autoMesh(fea: FEAEngine, geometry: THREE.BufferGeometry, elementType: ElementType, quality: MeshQuality = 'medium'): MeshInfo {
  const budget = MESH_BUDGET[quality];
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const sx = Math.max(box.max.x - box.min.x, 1e-6);
  const sy = Math.max(box.max.y - box.min.y, 1e-6);
  const sz = Math.max(box.max.z - box.min.z, 1e-6);
  const longest = Math.max(sx, sy, sz);
  const volume = modelVolume(geometry) || sx * sy * sz;
  const fill = Math.min(1, volume / (sx * sy * sz));

  // elements ≈ 6 tets × filled cells; cells ≈ D³ · (sx·sy·sz / longest³)
  const estimate = Math.cbrt(budget / (6 * fill * ((sx * sy * sz) / longest ** 3)));
  const center = Math.min(60, Math.max(4, Math.round(estimate)));
  const candidates = [...new Set([center - 1, center, center + 1].filter(d => d >= 4))];

  const tried: MeshInfo['tried'] = [];
  for (const divisions of candidates) {
    fea.generateMesh(geometry, { elementType, divisions });
    const mesh = fea.solidMesh!;
    tried.push({ divisions, elements: mesh.numElements, coverage: meshVolume(mesh) / volume });
  }
  // Closest volume within the budget allowance; otherwise the smallest mesh
  const affordable = tried.filter(t => t.elements <= budget * 1.4);
  const pool = affordable.length ? affordable : [tried.reduce((a, b) => (b.elements < a.elements ? b : a))];
  const best = pool.reduce((a, b) => (Math.abs(b.coverage - 1) < Math.abs(a.coverage - 1) ? b : a));

  if (best.divisions !== candidates[candidates.length - 1]) fea.generateMesh(geometry, { elementType, divisions: best.divisions });
  const mesh = fea.solidMesh!;
  return { quality, divisions: best.divisions, elements: mesh.numElements, nodes: mesh.numNodes, coverage: best.coverage, tried };
}
