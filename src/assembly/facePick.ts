// CasiWorks Pro - Faces of a component's mesh: the flat face or cylinder a click lands on
//
// The mesh kernel has no named faces, so a face is found from the clicked
// triangle: its flat neighbours lying in the same plane form a planar face; if
// the neighbours bend round one axis, they form a cylinder, whose axis and radius
// come from a least-squares circle through its points. The result is a mate
// reference in the component's own coordinates ({ point, normal } for a plane,
// { point, axis, radius } for a cylinder).
import * as THREE from 'three';

export interface PlaneFace {
  kind: 'plane';
  /** Centre of the face (component coordinates). */
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  /** Triangles of the face (for highlighting). */
  triangles: number[];
  /** mm² */
  area: number;
}

export interface CylinderFace {
  kind: 'cylinder';
  /** A point on the axis, half way along the face. */
  point: { x: number; y: number; z: number };
  axis: { x: number; y: number; z: number };
  radius: number;
  triangles: number[];
  area: number;
}

export type PickedFace = PlaneFace | CylinderFace;

interface Mesh {
  /** Triangle corners, 9 numbers per triangle. */
  tri: Float32Array;
  normals: THREE.Vector3[];
  areas: number[];
  /** Triangles sharing an edge. */
  neighbours: number[][];
}

const meshCache = new WeakMap<THREE.BufferGeometry, Mesh>();

function meshOf(geometry: THREE.BufferGeometry): Mesh {
  const cached = meshCache.get(geometry);
  if (cached) return cached;
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const count = Math.floor(pos.count / 3);
  const tri = new Float32Array(count * 9);
  for (let i = 0; i < count * 3; i++) { tri[i * 3] = pos.getX(i); tri[i * 3 + 1] = pos.getY(i); tri[i * 3 + 2] = pos.getZ(i); }
  const normals: THREE.Vector3[] = [], areas: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    a.fromArray(tri, t * 9); b.fromArray(tri, t * 9 + 3); c.fromArray(tri, t * 9 + 6);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    areas.push(n.length() / 2);
    normals.push(n.lengthSq() > 0 ? n.normalize() : new THREE.Vector3(0, 0, 0));
  }
  // Edge adjacency by welded corner positions
  const key = (i: number) => `${Math.round(tri[i * 3] * 1e4)},${Math.round(tri[i * 3 + 1] * 1e4)},${Math.round(tri[i * 3 + 2] * 1e4)}`;
  const vertexId = new Map<string, number>();
  const ids = new Int32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    const k = key(i);
    let id = vertexId.get(k);
    if (id === undefined) { id = vertexId.size; vertexId.set(k, id); }
    ids[i] = id;
  }
  // Triangles sharing a corner are neighbours (sharing an edge would miss the T-junctions boolean results have)
  const byVertex = new Map<number, number[]>();
  for (let i = 0; i < count * 3; i++) {
    let list = byVertex.get(ids[i]);
    if (!list) { list = []; byVertex.set(ids[i], list); }
    list.push(Math.floor(i / 3));
  }
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < count; t++) {
    const set = new Set<number>();
    for (let k = 0; k < 3; k++) for (const u of byVertex.get(ids[t * 3 + k])!) if (u !== t) set.add(u);
    neighbours[t] = [...set];
  }
  const mesh = { tri, normals, areas, neighbours };
  meshCache.set(geometry, mesh);
  return mesh;
}

const COS_FLAT = Math.cos((1 * Math.PI) / 180);

/** Grow a region from `seed` over neighbours that `accept`. */
function grow(mesh: Mesh, seed: number, accept: (t: number) => boolean): number[] {
  const seen = new Set([seed]);
  const out = [seed];
  for (let i = 0; i < out.length; i++) {
    for (const n of mesh.neighbours[out[i]]) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (accept(n)) out.push(n);
    }
  }
  return out;
}

const centroid = (mesh: Mesh, t: number) => new THREE.Vector3(
  (mesh.tri[t * 9] + mesh.tri[t * 9 + 3] + mesh.tri[t * 9 + 6]) / 3,
  (mesh.tri[t * 9 + 1] + mesh.tri[t * 9 + 4] + mesh.tri[t * 9 + 7]) / 3,
  (mesh.tri[t * 9 + 2] + mesh.tri[t * 9 + 5] + mesh.tri[t * 9 + 8]) / 3,
);
const plain = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });

function planeFace(mesh: Mesh, seed: number): PlaneFace {
  const n0 = mesh.normals[seed];
  const p0 = centroid(mesh, seed);
  const tol = 1e-3 * (Math.sqrt(mesh.areas[seed]) + 1);
  // Every triangle in the same plane facing the same way: for a mate the plane is what matters
  const tris: number[] = [];
  for (let t = 0; t < mesh.normals.length; t++) {
    if (mesh.normals[t].dot(n0) > COS_FLAT && Math.abs(centroid(mesh, t).sub(p0).dot(n0)) < tol) tris.push(t);
  }
  let area = 0;
  const c = new THREE.Vector3();
  for (const t of tris) { area += mesh.areas[t]; c.addScaledVector(centroid(mesh, t), mesh.areas[t]); }
  c.divideScalar(area || 1);
  return { kind: 'plane', point: plain(c), normal: plain(n0), triangles: tris, area };
}

/** Circle through 2D points by least squares (Kåsa): centre and radius. */
function fitCircle(pts: Array<[number, number]>): { cx: number; cy: number; r: number } | null {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = pts.length;
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c] = [sxz syz sz]; centre (a/2, b/2)
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], r = [sxz, syz, sz];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  const col = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)));
  const A = det(col(0)) / D, B = det(col(1)) / D, C = det(col(2)) / D;
  const cx = A / 2, cy = B / 2;
  const rr = C + cx * cx + cy * cy;
  return rr > 0 ? { cx, cy, r: Math.sqrt(rr) } : null;
}

function cylinderFace(mesh: Mesh, seed: number): CylinderFace | null {
  const n0 = mesh.normals[seed];
  // The axis is across the normals of the seed and a neighbour that bends away from it
  let axis: THREE.Vector3 | null = null;
  for (const nb of mesh.neighbours[seed]) {
    const n1 = mesh.normals[nb];
    const d = n0.dot(n1);
    if (d < COS_FLAT && d > Math.cos((40 * Math.PI) / 180)) { axis = n0.clone().cross(n1).normalize(); break; }
  }
  if (!axis) return null;
  const ax = axis;
  const tris = grow(mesh, seed, t => Math.abs(mesh.normals[t].dot(ax)) < 0.02 && mesh.normals[t].lengthSq() > 0);
  if (tris.length < 3) return null;
  // Points of the face in a frame across the axis
  const u = Math.abs(ax.x) < 0.9 ? new THREE.Vector3(1, 0, 0).cross(ax).normalize() : new THREE.Vector3(0, 1, 0).cross(ax).normalize();
  const v = ax.clone().cross(u);
  const pts: Array<[number, number]> = [];
  let tMin = Infinity, tMax = -Infinity, area = 0;
  for (const t of tris) {
    area += mesh.areas[t];
    for (let k = 0; k < 3; k++) {
      const p = new THREE.Vector3().fromArray(mesh.tri, t * 9 + k * 3);
      pts.push([p.dot(u), p.dot(v)]);
      const h = p.dot(ax);
      tMin = Math.min(tMin, h); tMax = Math.max(tMax, h);
    }
  }
  const circle = fitCircle(pts);
  if (!circle || !Number.isFinite(circle.r)) return null;
  // Everything on the same cylinder (pieces a boolean split apart included)
  const axisAt = u.clone().multiplyScalar(circle.cx).add(v.clone().multiplyScalar(circle.cy));
  const radial = (p: THREE.Vector3) => p.clone().sub(ax.clone().multiplyScalar(p.dot(ax))).sub(axisAt);
  const inSet = new Set(tris);
  for (let t = 0; t < mesh.normals.length; t++) {
    if (inSet.has(t) || Math.abs(mesh.normals[t].dot(ax)) >= 0.02) continue;
    const r = radial(centroid(mesh, t));
    const d = r.length();
    if (Math.abs(d - circle.r) < 0.03 * circle.r + 0.05 && r.normalize().dot(mesh.normals[t]) > 0.9) {
      tris.push(t); inSet.add(t); area += mesh.areas[t];
      for (let k = 0; k < 3; k++) {
        const h = new THREE.Vector3().fromArray(mesh.tri, t * 9 + k * 3).dot(ax);
        tMin = Math.min(tMin, h); tMax = Math.max(tMax, h);
      }
    }
  }
  const centre = u.clone().multiplyScalar(circle.cx).add(v.clone().multiplyScalar(circle.cy)).add(ax.clone().multiplyScalar((tMin + tMax) / 2));
  // Make the axis point a consistent way (towards +X/+Y/+Z first) so the same cylinder gives the same reference
  const flip = ax.x + ax.y * 1e-3 + ax.z * 1e-6 < 0 ? -1 : 1;
  return { kind: 'cylinder', point: plain(centre), axis: plain(ax.clone().multiplyScalar(flip)), radius: circle.r, triangles: tris, area };
}

/**
 * The face of `geometry` (component coordinates) that contains triangle `triangle`
 * (the raycast's face index, which is the same in the placed copy of the mesh).
 */
export function faceAt(geometry: THREE.BufferGeometry, triangle: number): PickedFace | null {
  const mesh = meshOf(geometry);
  if (triangle < 0 || triangle >= mesh.normals.length || mesh.normals[triangle].lengthSq() === 0) return null;
  const plane = planeFace(mesh, triangle);
  // A lone thin strip of a faceted cylinder is part of the cylinder, not a face of its own
  const cyl = cylinderFace(mesh, triangle);
  if (cyl && cyl.area > plane.area * 2.5) return cyl;
  return plane;
}

/** The mate reference for a face: what AssemblyManager understands as explicit geometry. */
export function mateRefOf(face: PickedFace): { point: { x: number; y: number; z: number }; normal?: { x: number; y: number; z: number }; axis?: { x: number; y: number; z: number }; radius?: number } {
  return face.kind === 'plane'
    ? { point: face.point, normal: face.normal }
    : { point: face.point, normal: face.axis, axis: face.axis, radius: face.radius };
}

/** The mate types that suit two picked faces, the usual one first. */
export function matesFor(a: PickedFace, b: PickedFace): string[] {
  if (a.kind === 'cylinder' && b.kind === 'cylinder') return ['concentric', 'parallel', 'perpendicular'];
  if (a.kind === 'plane' && b.kind === 'plane') return ['coincident', 'distance', 'parallel', 'perpendicular', 'angle'];
  return ['tangent', 'parallel', 'perpendicular'];
}

/** Triangles of a face as a mesh in component coordinates (for highlighting). */
export function faceGeometry(geometry: THREE.BufferGeometry, triangles: number[]): THREE.BufferGeometry {
  const mesh = meshOf(geometry);
  const out = new Float32Array(triangles.length * 9);
  triangles.forEach((t, i) => out.set(mesh.tri.subarray(t * 9, t * 9 + 9), i * 9));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

/** The triangle of `geometry` closest to `point` (both in component coordinates); -1 for an empty mesh. */
export function nearestTriangle(geometry: THREE.BufferGeometry, point: { x: number; y: number; z: number }): number {
  const mesh = meshOf(geometry);
  const p = new THREE.Vector3(point.x, point.y, point.z);
  const tri = new THREE.Triangle(), q = new THREE.Vector3();
  let best = -1, bestD = Infinity;
  for (let t = 0; t < mesh.normals.length; t++) {
    if (mesh.areas[t] <= 0) continue;
    tri.a.fromArray(mesh.tri, t * 9); tri.b.fromArray(mesh.tri, t * 9 + 3); tri.c.fromArray(mesh.tri, t * 9 + 6);
    tri.closestPointToPoint(p, q);
    const d = q.distanceToSquared(p);
    if (d < bestD - 1e-9) { bestD = d; best = t; }
  }
  return best;
}

type RefLike = { point?: { x?: number; y?: number; z?: number }; normal?: { x?: number; y?: number; z?: number }; axis?: { x?: number; y?: number; z?: number }; radius?: number };

/**
 * Find a face reference again on a changed shape: the face of the same kind and
 * orientation nearest to where the old one was (a plate made thicker keeps its top
 * face; a hole that moved keeps its hole). Returns null when nothing like it is left.
 */
export function remapRef(ref: RefLike, geometry: THREE.BufferGeometry): ReturnType<typeof mateRefOf> | null {
  const face = findFace(ref, geometry);
  return face ? mateRefOf(face) : null;
}

/** The face of the same kind and orientation nearest to a reference (see remapRef), or null. */
export function findFace(ref: RefLike, geometry: THREE.BufferGeometry): PickedFace | null {
  const mesh = meshOf(geometry);
  const p = new THREE.Vector3(ref.point?.x ?? 0, ref.point?.y ?? 0, ref.point?.z ?? 0);
  const isCyl = !!ref.axis && ref.radius !== undefined;
  const dir = new THREE.Vector3(...(['x', 'y', 'z'] as const).map(k => Number((isCyl ? ref.axis : ref.normal)?.[k] ?? 0)) as [number, number, number]).normalize();
  if (dir.lengthSq() === 0) return null;
  const tri = new THREE.Triangle(), q = new THREE.Vector3();
  let best: PickedFace | null = null, bestD = Infinity;
  const tried = new Set<number>();
  // Candidate triangles: facing the same way (planes), or lying round a parallel axis (cylinders)
  const order = mesh.normals.map((n, t) => t).filter(t => (isCyl ? Math.abs(mesh.normals[t].dot(dir)) < 0.02 : mesh.normals[t].dot(dir) > COS_FLAT));
  for (const t of order) {
    if (tried.has(t)) continue;
    const face = faceAt(geometry, t);
    if (!face) continue;
    face.triangles.forEach(x => tried.add(x));
    if (isCyl) {
      if (face.kind !== 'cylinder') continue;
      const a = new THREE.Vector3(face.axis.x, face.axis.y, face.axis.z);
      if (Math.abs(a.dot(dir)) < COS_FLAT) continue;
      // Distance between the axes, plus a penalty for a different size
      const d = new THREE.Vector3(face.point.x, face.point.y, face.point.z).sub(p);
      const across = d.sub(a.clone().multiplyScalar(d.dot(a))).length() + Math.abs(face.radius - ref.radius!) * 2;
      if (across < bestD) { bestD = across; best = face; }
    } else {
      if (face.kind !== 'plane') continue;
      // Nearest point of the face to the old reference point
      let dmin = Infinity;
      for (const ft of face.triangles) {
        tri.a.fromArray(mesh.tri, ft * 9); tri.b.fromArray(mesh.tri, ft * 9 + 3); tri.c.fromArray(mesh.tri, ft * 9 + 6);
        tri.closestPointToPoint(p, q);
        dmin = Math.min(dmin, q.distanceTo(p));
      }
      if (dmin < bestD) { bestD = dmin; best = face; }
    }
  }
  return best;
}

/** The triangles of `triangles` joined to `seed` through shared corners (one piece of a face). */
export function connectedTriangles(geometry: THREE.BufferGeometry, triangles: number[], seed: number): number[] {
  const mesh = meshOf(geometry);
  const allowed = new Set(triangles);
  if (!allowed.has(seed)) return triangles;
  return grow(mesh, seed, t => allowed.has(t));
}

/** Corner positions of triangles, 9 numbers each (component coordinates). */
export function trianglePositions(geometry: THREE.BufferGeometry, triangles: number[]): Float32Array {
  const mesh = meshOf(geometry);
  const out = new Float32Array(triangles.length * 9);
  triangles.forEach((t, i) => out.set(mesh.tri.subarray(t * 9, t * 9 + 9), i * 9));
  return out;
}
