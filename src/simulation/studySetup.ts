// CasiWorks Pro - FEA study setup: which face is fixed, where the load acts and in which direction
//
// A face is one of the six sides of the part's bounding box, or 'faces': flat
// faces and cylinders picked on the model (studyFaces.ts, roadmap 6.3). Pure
// data and geometry helpers, so the panel, the viewport markers and the tests
// share one definition.
import type * as THREE from 'three';
import type { BoxPlane, Fixture, Load, SolidMesh } from './FEAEngine.ts';
import { nodesOnFace, resolveStudyFace, sameStudyFace, studyFaceLabel } from './studyFaces.ts';
import type { StudyFace } from './studyFaces.ts';
import type { UnitSystem } from '../utils/units.ts';

export type Direction = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

/** A bounding-box side, or the faces picked on the model. */
export type FaceChoice = BoxPlane | 'faces';

export interface StudySetup {
  fixedFace: FaceChoice;
  loadFace: FaceChoice;
  loadDirection: Direction;
  /** Faces held fixed when fixedFace is 'faces'. */
  fixedFaces?: StudyFace[];
  /** Faces the load is spread over when loadFace is 'faces'. */
  loadFaces?: StudyFace[];
}

/** The previous built-in study: fixed at the back (min Z), pushed down (−Y) at the front (max Z). */
export const DEFAULT_SETUP: StudySetup = { fixedFace: 'zMin', loadFace: 'zMax', loadDirection: '-Y' };

export const FACE_LABELS: Record<BoxPlane, string> = {
  xMin: 'Left (−X)', xMax: 'Right (+X)',
  yMin: 'Bottom (−Y)', yMax: 'Top (+Y)',
  zMin: 'Back (−Z)', zMax: 'Front (+Z)',
};
export const FACES = Object.keys(FACE_LABELS) as BoxPlane[];

/** What a face choice is, in words: "Back (−Z)", "Hole Ø10 mm", "2 faces: Hole Ø10 mm, Hole Ø10 mm". */
export function faceChoiceLabel(setup: StudySetup, which: 'fixed' | 'load', system: UnitSystem = 'MMGS'): string {
  const choice = which === 'fixed' ? setup.fixedFace : setup.loadFace;
  if (choice !== 'faces') return FACE_LABELS[choice];
  const faces = (which === 'fixed' ? setup.fixedFaces : setup.loadFaces) ?? [];
  if (!faces.length) return 'No face picked';
  const names = faces.map(f => studyFaceLabel(f, system));
  return faces.length === 1 ? names[0] : `${faces.length} faces: ${names.join(', ')}`;
}

export const DIRECTION_VECTORS: Record<Direction, [number, number, number]> = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};
export const DIRECTIONS = Object.keys(DIRECTION_VECTORS) as Direction[];

/** Problems with a setup, or [] when it can be solved. */
export function setupProblems(setup: StudySetup): string[] {
  const problems: string[] = [];
  const fixed = setup.fixedFaces ?? [], loaded = setup.loadFaces ?? [];
  if (setup.fixedFace === 'faces' && !fixed.length) problems.push('Pick a face to fix: click Pick, then a face on the model');
  if (setup.loadFace === 'faces' && !loaded.length) problems.push('Pick a face for the load: click Pick, then a face on the model');
  if (setup.fixedFace !== 'faces' && setup.fixedFace === setup.loadFace) problems.push('The load must act on a different face from the fixed one');
  if (setup.fixedFace === 'faces' && setup.loadFace === 'faces' && fixed.some(f => loaded.some(g => sameStudyFace(f, g)))) {
    problems.push('The load must act on a different face from the fixed one');
  }
  return problems;
}

/** Problems of a setup for a modal study (only the fixed face matters). */
export function modalSetupProblems(setup: StudySetup): string[] {
  return setup.fixedFace === 'faces' && !(setup.fixedFaces ?? []).length ? ['Pick a face to fix: click Pick, then a face on the model'] : [];
}

/** Fixtures and loads on bounding-box sides only (picked faces need the mesh: see studyBoundary). */
export function fixturesFor(setup: StudySetup): Fixture[] {
  return [{ type: 'fixed', plane: setup.fixedFace === 'faces' ? 'zMin' : setup.fixedFace }];
}

export function loadsFor(setup: StudySetup, magnitude: number): Load[] {
  return [{ type: 'force', plane: setup.loadFace === 'faces' ? 'zMax' : setup.loadFace, direction: DIRECTION_VECTORS[setup.loadDirection], magnitude: Math.abs(magnitude) }];
}

/** Mesh nodes on picked faces, or an error naming the face that has none. */
function pickedNodes(faces: StudyFace[], geometry: THREE.BufferGeometry, mesh: SolidMesh, what: string): number[] {
  const nodes = new Set<number>();
  for (const f of faces) {
    const tris = resolveStudyFace(geometry, f);
    if (!tris) throw new Error(`The ${what} face (${studyFaceLabel(f)}) is not on the part any more: pick it again`);
    const on = nodesOnFace(mesh, tris);
    if (!on.length) throw new Error(`The ${what} face (${studyFaceLabel(f)}) is smaller than the mesh cells: use a finer mesh`);
    on.forEach(n => nodes.add(n));
  }
  return [...nodes].sort((a, b) => a - b);
}

/**
 * Fixtures and loads of a setup on a meshed part: bounding-box sides as
 * planes, picked faces as the mesh nodes on them. The load is spread evenly
 * over the nodes of all its faces.
 */
export function studyBoundary(setup: StudySetup, geometry: THREE.BufferGeometry, mesh: SolidMesh, magnitude: number): { fixtures: Fixture[]; loads: Load[] } {
  const fixtures: Fixture[] = setup.fixedFace === 'faces'
    ? [{ type: 'fixed', nodeIndices: pickedNodes(setup.fixedFaces ?? [], geometry, mesh, 'fixed') }]
    : fixturesFor(setup);
  const loads: Load[] = setup.loadFace === 'faces'
    ? [{ type: 'force', nodeIndices: pickedNodes(setup.loadFaces ?? [], geometry, mesh, 'loaded'), direction: DIRECTION_VECTORS[setup.loadDirection], magnitude: Math.abs(magnitude) }]
    : loadsFor(setup, magnitude);
  return { fixtures, loads };
}

export interface Bounds { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

/** A bounding-box face as a rectangle: centre, outward normal, and its two in-plane sizes. */
export function faceRect(box: Bounds, plane: BoxPlane): { center: [number, number, number]; normal: [number, number, number]; size: [number, number] } {
  const c = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2] as [number, number, number];
  const s = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
  const axis = plane[0] as 'x' | 'y' | 'z';
  const k = { x: 0, y: 1, z: 2 }[axis];
  const isMax = plane.endsWith('Max');
  const center = [...c] as [number, number, number];
  center[k] = isMax ? box.max[axis] : box.min[axis];
  const normal = [0, 0, 0] as [number, number, number];
  normal[k] = isMax ? 1 : -1;
  const others = [0, 1, 2].filter(i => i !== k);
  return { center, normal, size: [s[others[0]], s[others[1]]] };
}

/** Points on a face where load arrows are drawn (an n × n grid, inset from the edges). */
export function arrowAnchors(box: Bounds, plane: BoxPlane, n = 3): Array<[number, number, number]> {
  const { center } = faceRect(box, plane);
  const k = { x: 0, y: 1, z: 2 }[plane[0] as 'x' | 'y' | 'z'];
  const others = [0, 1, 2].filter(i => i !== k);
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = [...center] as [number, number, number];
    p[others[0]] = lo[others[0]] + ((i + 0.5) / n) * (hi[others[0]] - lo[others[0]]);
    p[others[1]] = lo[others[1]] + ((j + 0.5) / n) * (hi[others[1]] - lo[others[1]]);
    out.push(p);
  }
  return out;
}
