// CasiWorks Pro - Automatic FEA meshing with a quality report
//
// The solid mesh is voxel based: grid cells whose centre lies inside the part
// become 6 tetrahedra each. The grid is fitted to the part (roadmap 6.2): grid
// lines run through every flat face square to an axis, so walls, steps and thin
// sheet are meshed at their true thickness; spacing halves across curved
// surfaces (holes, arcs) and is graded so neighbouring cells differ by at most
// 2.5×. Lines run through the whole part, so the mesh stays conforming (no
// hanging nodes). The spacing is chosen from an element budget; a few
// neighbouring spacings are tried and the one whose meshed volume is closest to
// the part's is kept, and that coverage is reported so users can judge it.
import * as THREE from 'three';
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
  /** Smallest and largest grid cell edge (mm). */
  cellRange?: [number, number];
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

/** Where the part's faces lie along each axis: flat faces square to it, and the spans of slanted or curved ones. */
export interface AxisFeatures { planes: number[]; /** mm², per plane */ areas?: number[]; zones: Array<[number, number]> }

const AXES = ['x', 'y', 'z'] as const;

/** Flat faces square to x, y, z (their coordinates) and the ranges covered by slanted or curved faces. */
export function axisFeatures(geometry: THREE.BufferGeometry): Record<'x' | 'y' | 'z', AxisFeatures> {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const n = index ? index.count : pos.count;
  geometry.computeBoundingBox();
  const diag = geometry.boundingBox!.getSize(new THREE.Vector3()).length() || 1;
  const raw = { x: [] as Array<[number, number]>, y: [] as Array<[number, number]>, z: [] as Array<[number, number]> };
  const zones = { x: [] as Array<[number, number]>, y: [] as Array<[number, number]>, z: [] as Array<[number, number]> };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  const COS_ALIGNED = Math.cos(Math.PI / 180);
  for (let t = 0; t + 2 < n; t += 3) {
    const [i, j, k] = [0, 1, 2].map(q => (index ? index.getX(t + q) : t + q));
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, j); c.fromBufferAttribute(pos, k);
    nrm.subVectors(b, a).cross(c.clone().sub(a));
    const area2 = nrm.length();
    if (area2 < 1e-12) continue;
    nrm.divideScalar(area2);
    AXES.forEach((ax, d) => {
      const comp = Math.abs(nrm.getComponent(d));
      if (comp > COS_ALIGNED) raw[ax].push([(a[ax] + b[ax] + c[ax]) / 3, area2 / 2]);
      else if (comp > 0.05) zones[ax].push([Math.min(a[ax], b[ax], c[ax]), Math.max(a[ax], b[ax], c[ax])]);
    });
  }
  const tol = 1e-5 * diag + 1e-6;
  const out = {} as Record<'x' | 'y' | 'z', AxisFeatures>;
  for (const ax of AXES) {
    // Planes: one coordinate per flat face level (triangles of a face share it)
    const sorted = raw[ax].sort((p, q) => p[0] - q[0]);
    const planes: number[] = [], areas: number[] = [];
    let sum = 0, weight = 0, last = -Infinity;
    for (const [v, w] of sorted) {
      if (v - last > tol && weight > 0) { planes.push(sum / weight); areas.push(weight); sum = 0; weight = 0; }
      sum += v * w; weight += w; last = v;
    }
    if (weight > 0) { planes.push(sum / weight); areas.push(weight); }
    // Zones: union of the slanted spans
    const zs = zones[ax].sort((p, q) => p[0] - q[0]);
    const merged: Array<[number, number]> = [];
    for (const z of zs) {
      const top = merged[merged.length - 1];
      if (top && z[0] <= top[1] + tol) top[1] = Math.max(top[1], z[1]);
      else merged.push([z[0], z[1]]);
    }
    out[ax] = { planes, areas, zones: merged };
  }
  return out;
}

/**
 * Grid lines from lo to hi: through each plane (planes closer than a tenth of
 * `h` are merged), cells of about `h` (h / 2 across zones, unless zones cover
 * most of the length), graded so neighbours differ by at most 2.5×.
 */
export function gridLines(lo: number, hi: number, f: AxisFeatures, h: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo, hi];
  const minGap = 0.1 * h;
  // Planes closer than minGap: keep the largest face of each cluster
  const reps: number[] = [];
  let cluster: Array<[number, number]> = [];
  const flush = () => { if (cluster.length) reps.push(cluster.reduce((a, b) => (b[1] > a[1] ? b : a))[0]); cluster = []; };
  // A face on (or a rounding error away from) an end is that end
  const endTol = 1e-6 * span + 1e-9;
  f.planes.forEach((p, i) => {
    if (p <= lo + endTol || p >= hi - endTol) return;
    if (cluster.length && p - cluster[cluster.length - 1][0] >= minGap) flush();
    cluster.push([p, f.areas?.[i] ?? 1]);
  });
  flush();
  // The ends stay on the bounding box (box-side fixtures need nodes there); a face just inside an end makes a thin end slice
  const breaks = [lo, ...reps.filter((p, i) => i === 0 || p - reps[i - 1] >= minGap), hi];
  const slices = new Set<number>();
  if (breaks.length > 2 && breaks[1] - lo < minGap) slices.add(0);
  if (breaks.length > 2 && hi - breaks[breaks.length - 2] < minGap) slices.add(breaks.length - 2);
  const zoneLength = f.zones.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, hi) - Math.max(a, lo)), 0);
  const useZones = zoneLength < 0.6 * span;
  const inZone = (a: number, b: number) => useZones && f.zones.some(([za, zb]) => za - h / 2 < b && zb + h / 2 > a);
  let sizes: number[] = [];
  const fixed = new Set<number>();
  for (let i = 1; i < breaks.length; i++) {
    const a = breaks[i - 1], b = breaks[i];
    if (slices.has(i - 1)) { fixed.add(sizes.length); sizes.push(b - a); continue; }
    const target = inZone(a, b) ? h / 2 : h;
    const n = Math.max(1, Math.ceil((b - a) / target - 1e-9));
    for (let k = 0; k < n; k++) sizes.push((b - a) / n);
  }
  // Grading: split a cell more than 2.5× its neighbour, next to that neighbour
  for (let pass = 0; pass < 64; pass++) {
    let changed = false;
    const next: number[] = [];
    const nextFixed = new Set<number>();
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      if (fixed.has(i)) { nextFixed.add(next.length); next.push(s); continue; }
      // End slices are not graded against (they lie mostly outside the part)
      const left = i > 0 && !fixed.has(i - 1) ? sizes[i - 1] : Infinity, right = i + 1 < sizes.length && !fixed.has(i + 1) ? sizes[i + 1] : Infinity;
      const small = Math.min(left, right);
      if (s > 2.5 * small) {
        const piece = 2 * small;
        const rest = s - piece;
        const [first, second] = rest < small ? [s / 2, s / 2] : left <= right ? [piece, rest] : [rest, piece];
        next.push(first, second);
        changed = true;
      } else next.push(s);
    }
    sizes = next;
    fixed.clear(); nextFixed.forEach(i => fixed.add(i));
    if (!changed) break;
  }
  const lines = [lo];
  for (const s of sizes) lines.push(lines[lines.length - 1] + s);
  lines[lines.length - 1] = hi;
  return lines;
}

/** The fitted grid of a part for a nominal cell size `h` (mm). */
export function fittedGrid(geometry: THREE.BufferGeometry, h: number, features = axisFeatures(geometry)): { x: number[]; y: number[]; z: number[] } {
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox!;
  return { x: gridLines(min.x, max.x, features.x, h), y: gridLines(min.y, max.y, features.y, h), z: gridLines(min.z, max.z, features.z, h) };
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
  const features = axisFeatures(geometry);
  const along = sx === longest ? 'x' : sy === longest ? 'y' : 'z';

  // A first spacing from the budget: elements ≈ 6 tets × filled cells (bisection on the fitted grid's size)
  const estimate = (h: number) => { const g = fittedGrid(geometry, h, features); return 6 * fill * (g.x.length - 1) * (g.y.length - 1) * (g.z.length - 1); };
  let lo = longest / 120, hi = longest / 2;
  for (let i = 0; i < 40; i++) { const mid = Math.sqrt(lo * hi); if (estimate(mid) > budget) lo = mid; else hi = mid; }
  let h = hi;

  const tried: MeshInfo['tried'] = [];
  const grids: Array<{ x: number[]; y: number[]; z: number[] }> = [];
  const meshAt = (size: number) => {
    const grid = fittedGrid(geometry, size, features);
    fea.generateMesh(geometry, { elementType, grid });
    const mesh = fea.solidMesh!;
    tried.push({ divisions: grid[along].length - 1, elements: mesh.numElements, coverage: meshVolume(mesh) / volume });
    grids.push(grid);
    return mesh.numElements;
  };
  // Correct the spacing once from the real count (partly filled cells, refinement), then try its neighbours
  const first = meshAt(h);
  if (first > budget * 1.3 || first < budget * 0.6) { h *= Math.cbrt(first / budget); meshAt(h); }
  meshAt(h * 1.08);
  meshAt(h * 0.93);

  const all = tried.map((t, i) => ({ ...t, i }));
  const affordable = all.filter(t => t.elements <= budget * 1.4);
  const pool = affordable.length ? affordable : [all.reduce((a, b) => (b.elements < a.elements ? b : a))];
  const best = pool.reduce((a, b) => (Math.abs(b.coverage - 1) < Math.abs(a.coverage - 1) - 1e-9 ? b : a));
  if (best.i !== tried.length - 1) fea.generateMesh(geometry, { elementType, grid: grids[best.i] });
  const mesh = fea.solidMesh!;
  const g = grids[best.i];
  const steps = [g.x, g.y, g.z].flatMap(c => c.slice(1).map((v, i) => v - c[i]));
  return {
    quality, divisions: best.divisions, elements: mesh.numElements, nodes: mesh.numNodes, coverage: best.coverage,
    cellRange: [Math.min(...steps), Math.max(...steps)], tried: tried.map(t => ({ divisions: t.divisions, elements: t.elements, coverage: t.coverage })),
  };
}
