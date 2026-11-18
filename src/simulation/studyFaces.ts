// CasiWorks Pro - FEA fixtures and loads on faces picked on the model (roadmap 6.3)
//
// A picked face is a flat face or a cylinder of the part's triangle mesh, found
// the same way as assembly mates find faces (assembly/facePick.ts). It is kept
// as geometry, not as triangle numbers, so it is found again after the part is
// rebuilt: a plate made thicker keeps its top face, a hole that moved keeps its
// hole. When solving, the nodes of the voxel FEA mesh lying on the face are
// fixed or loaded. The voxel mesh is a staircase within half a cell of the
// true surface, so "on the face" means within that distance and facing the
// same way.
import * as THREE from 'three';
import { connectedTriangles, faceAt, findFace, nearestTriangle, trianglePositions } from '../assembly/facePick.ts';
import type { PickedFace } from '../assembly/facePick.ts';
import type { SolidMesh } from './FEAEngine.ts';
import { formatArea, formatLength } from '../utils/units.ts';
import type { UnitSystem } from '../utils/units.ts';

type P3 = { x: number; y: number; z: number };

/** A face picked for a study, in model coordinates (mm). */
export type StudyFace =
  | { kind: 'plane'; point: P3; normal: P3; area: number }
  | { kind: 'cylinder'; point: P3; axis: P3; radius: number; area: number; hole: boolean };

const v3 = (p: P3) => new THREE.Vector3(p.x, p.y, p.z);
const plain = (v: THREE.Vector3): P3 => ({ x: v.x, y: v.y, z: v.z });

function triCentroid(pos: Float32Array, i: number): THREE.Vector3 {
  return new THREE.Vector3(
    (pos[i * 9] + pos[i * 9 + 3] + pos[i * 9 + 6]) / 3,
    (pos[i * 9 + 1] + pos[i * 9 + 4] + pos[i * 9 + 7]) / 3,
    (pos[i * 9 + 2] + pos[i * 9 + 5] + pos[i * 9 + 8]) / 3,
  );
}
function triNormal(pos: Float32Array, i: number): THREE.Vector3 {
  const a = new THREE.Vector3().fromArray(pos, i * 9), b = new THREE.Vector3().fromArray(pos, i * 9 + 3), c = new THREE.Vector3().fromArray(pos, i * 9 + 6);
  return b.sub(a).cross(c.sub(a)).normalize();
}
function areaOf(pos: Float32Array): number {
  let a = 0;
  for (let i = 0; i < pos.length / 9; i++) {
    const p = new THREE.Vector3().fromArray(pos, i * 9), q = new THREE.Vector3().fromArray(pos, i * 9 + 3), r = new THREE.Vector3().fromArray(pos, i * 9 + 6);
    a += q.sub(p).cross(r.sub(p)).length() / 2;
  }
  return a;
}

/** One connected piece of a flat face (faceAt gives every triangle in the plane). */
function planePiece(geometry: THREE.BufferGeometry, face: PickedFace, seed: number): number[] {
  return face.kind === 'plane' ? connectedTriangles(geometry, face.triangles, seed) : face.triangles;
}

/** The study face a click on triangle `triangle` of the part lands on, or null. */
export function studyFaceAt(geometry: THREE.BufferGeometry, triangle: number): StudyFace | null {
  const face = faceAt(geometry, triangle);
  if (!face) return null;
  if (face.kind === 'cylinder') {
    // A hole when the surface faces the axis
    const pos = trianglePositions(geometry, [triangle]);
    const radial = triCentroid(pos, 0).sub(v3(face.point));
    const a = v3(face.axis);
    radial.addScaledVector(a, -radial.dot(a));
    const hole = radial.dot(triNormal(pos, 0)) < 0;
    return { kind: 'cylinder', point: face.point, axis: face.axis, radius: face.radius, area: face.area, hole };
  }
  const tris = planePiece(geometry, face, triangle);
  const pos = trianglePositions(geometry, tris);
  // A point that is on the face (the centre of an L-shaped face may not be)
  return { kind: 'plane', point: plain(triCentroid(trianglePositions(geometry, [triangle]), 0)), normal: face.normal, area: areaOf(pos) };
}

/** The triangles (positions, 9 numbers each) of a study face on the current part, or null when it is gone. */
export function resolveStudyFace(geometry: THREE.BufferGeometry, ref: StudyFace): Float32Array | null {
  if (ref.kind === 'cylinder') {
    const face = findFace({ point: ref.point, axis: ref.axis, normal: ref.axis, radius: ref.radius }, geometry);
    return face && face.kind === 'cylinder' ? trianglePositions(geometry, face.triangles) : null;
  }
  // The picked point usually still lies on the face; otherwise the nearest face facing the same way
  const near = nearestTriangle(geometry, ref.point);
  let face = near >= 0 ? faceAt(geometry, near) : null;
  let seed = near;
  const n = v3(ref.normal);
  const onIt = face?.kind === 'plane' && v3(face.normal).dot(n) > Math.cos(Math.PI / 180)
    && Math.abs(v3(face.point).sub(v3(ref.point)).dot(n)) < 1e-3 * (1 + Math.sqrt(ref.area));
  if (!onIt) {
    face = findFace({ point: ref.point, normal: ref.normal }, geometry);
    if (!face || face.kind !== 'plane') return null;
    // Seed: the face's triangle nearest the reference point
    const pos = trianglePositions(geometry, face.triangles);
    const p = v3(ref.point);
    let best = Infinity;
    face.triangles.forEach((t, i) => { const d = triCentroid(pos, i).distanceToSquared(p); if (d < best) { best = d; seed = t; } });
  }
  return trianglePositions(geometry, planePiece(geometry, face!, seed));
}

/** "Flat face, 1200 mm²", "Hole Ø10 mm", "Cylinder Ø20 mm". */
export function studyFaceLabel(f: StudyFace, system: UnitSystem = 'MMGS'): string {
  if (f.kind === 'cylinder') return `${f.hole ? 'Hole' : 'Cylinder'} Ø${formatLength(2 * f.radius, system)}`;
  return `Flat face, ${formatArea(f.area, system)}`;
}

/** The same face (for toggling a pick off and for spotting a face both fixed and loaded). */
export function sameStudyFace(a: StudyFace, b: StudyFace): boolean {
  if (a.kind !== b.kind) return false;
  const tol = 1e-3 * (1 + Math.sqrt(Math.max(a.area, b.area)));
  if (a.kind === 'cylinder' && b.kind === 'cylinder') {
    const ax = v3(a.axis);
    const d = v3(b.point).sub(v3(a.point));
    return Math.abs(Math.abs(ax.dot(v3(b.axis))) - 1) < 1e-4 && d.addScaledVector(ax, -d.dot(ax)).length() < tol && Math.abs(a.radius - b.radius) < tol;
  }
  if (a.kind === 'plane' && b.kind === 'plane') {
    const n = v3(a.normal);
    return n.dot(v3(b.normal)) > 1 - 1e-4 && Math.abs(v3(b.point).sub(v3(a.point)).dot(n)) < tol && Math.abs(a.area - b.area) < tol * Math.sqrt(a.area);
  }
  return false;
}

/**
 * Nodes of the FEA mesh on a face (its triangle positions): corner nodes of the
 * mesh's boundary triangles within half a grid cell of the face and facing its
 * way, and for Tet10 the mid-edge nodes between them.
 */
export function nodesOnFace(mesh: SolidMesh, facePositions: Float32Array): number[] {
  const cell = mesh.cellSize ?? mesh.size.clone().divideScalar(8);
  // The grid may be graded: each boundary triangle is judged by its own cell (its longest edge is a cell face's diagonal)
  const tol = 0.75 * Math.max(cell.x, cell.y, cell.z);
  const pts = mesh.nodes.map(n => n.point);
  const count = facePositions.length / 9;
  const tris = Array.from({ length: count }, (_, i) => new THREE.Triangle(
    new THREE.Vector3().fromArray(facePositions, i * 9), new THREE.Vector3().fromArray(facePositions, i * 9 + 3), new THREE.Vector3().fromArray(facePositions, i * 9 + 6)));
  const normals = tris.map((_, i) => triNormal(facePositions, i));
  const box = new THREE.Box3().setFromArray(facePositions).expandByScalar(tol);
  const q = new THREE.Vector3();
  const corners = new Set<number>();
  const edges = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const bf of mesh.boundaryFaces) {
    if (!box.containsPoint(bf.centroid)) continue;
    const [na, nb, nc] = bf.nodes;
    const local = 0.55 * Math.max(pts[na].distanceTo(pts[nb]), pts[nb].distanceTo(pts[nc]), pts[nc].distanceTo(pts[na]));
    let best = Infinity, bestN: THREE.Vector3 | null = null;
    for (let i = 0; i < tris.length; i++) {
      tris[i].closestPointToPoint(bf.centroid, q);
      const d = q.distanceToSquared(bf.centroid);
      if (d < best) { best = d; bestN = normals[i]; }
    }
    if (best > local * local || !bestN || bf.normal.dot(bestN) < 0.3) continue;
    const [a, b, c] = bf.nodes;
    corners.add(a); corners.add(b); corners.add(c);
    edges.add(key(a, b)); edges.add(key(b, c)); edges.add(key(c, a));
  }
  const out = new Set(corners);
  if (mesh.elementType === 'tet10') {
    // Mid-edge nodes in element order e01, e12, e20, e03, e13, e23
    const PAIRS = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
    for (const el of mesh.elements) {
      if (el.nodes.length < 10) continue;
      PAIRS.forEach(([i, j], k) => { if (edges.has(key(el.nodes[i], el.nodes[j]))) out.add(el.nodes[4 + k]); });
    }
  }
  return [...out].sort((x, y) => x - y);
}

/** Up to `n` points spread over a face (for load arrows): farthest-point sampling of triangle centres. */
export function faceAnchors(facePositions: Float32Array, n = 7): THREE.Vector3[] {
  const count = facePositions.length / 9;
  if (!count) return [];
  const cs = Array.from({ length: count }, (_, i) => triCentroid(facePositions, i));
  const mean = cs.reduce((a, c) => a.add(c), new THREE.Vector3()).divideScalar(count);
  let first = 0;
  cs.forEach((c, i) => { if (c.distanceToSquared(mean) < cs[first].distanceToSquared(mean)) first = i; });
  const picked = [cs[first]];
  const dist = cs.map(c => c.distanceToSquared(cs[first]));
  while (picked.length < Math.min(n, count)) {
    let far = 0;
    dist.forEach((d, i) => { if (d > dist[far]) far = i; });
    if (dist[far] <= 1e-12) break;
    picked.push(cs[far]);
    cs.forEach((c, i) => { dist[i] = Math.min(dist[i], c.distanceToSquared(cs[far])); });
  }
  return picked;
}

/** Study faces at points (mm): each the face of the triangle nearest the point; null when the part has no triangles. */
export function studyFacesAtPoints(geometry: THREE.BufferGeometry, points: P3[]): StudyFace[] | null {
  const out: StudyFace[] = [];
  for (const p of points) {
    const t = nearestTriangle(geometry, p);
    const f = t >= 0 ? studyFaceAt(geometry, t) : null;
    if (!f) return null;
    if (!out.some(o => sameStudyFace(o, f))) out.push(f);
  }
  return out;
}
