// CasiWorks Pro - FEA study setup: which face is fixed, where the load acts and in which direction
//
// Faces are the six sides of the part's bounding box until real faces can be
// picked (that needs the exact kernel). Pure data and geometry helpers, so the
// panel, the viewport markers and the tests share one definition.
import type { BoxPlane, Fixture, Load } from './FEAEngine.ts';

export type Direction = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface StudySetup {
  fixedFace: BoxPlane;
  loadFace: BoxPlane;
  loadDirection: Direction;
}

/** The previous built-in study: fixed at the back (min Z), pushed down (−Y) at the front (max Z). */
export const DEFAULT_SETUP: StudySetup = { fixedFace: 'zMin', loadFace: 'zMax', loadDirection: '-Y' };

export const FACE_LABELS: Record<BoxPlane, string> = {
  xMin: 'Left (−X)', xMax: 'Right (+X)',
  yMin: 'Bottom (−Y)', yMax: 'Top (+Y)',
  zMin: 'Back (−Z)', zMax: 'Front (+Z)',
};
export const FACES = Object.keys(FACE_LABELS) as BoxPlane[];

export const DIRECTION_VECTORS: Record<Direction, [number, number, number]> = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};
export const DIRECTIONS = Object.keys(DIRECTION_VECTORS) as Direction[];

/** Problems with a setup, or [] when it can be solved. */
export function setupProblems(setup: StudySetup): string[] {
  const problems: string[] = [];
  if (setup.fixedFace === setup.loadFace) problems.push('The load must act on a different face from the fixed one');
  return problems;
}

export function fixturesFor(setup: StudySetup): Fixture[] {
  return [{ type: 'fixed', plane: setup.fixedFace }];
}

export function loadsFor(setup: StudySetup, magnitude: number): Load[] {
  return [{ type: 'force', plane: setup.loadFace, direction: DIRECTION_VECTORS[setup.loadDirection], magnitude: Math.abs(magnitude) }];
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
