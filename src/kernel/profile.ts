// CasiWorks Pro - Sketch profile builder
//
// Turns sketch entities into closed 2D loops and then into THREE.Shapes:
//  1. every non-construction entity becomes a polyline (arcs counter-clockwise,
//     splines and ellipses sampled); circles, ellipses and rectangles are loops
//  2. open polylines are chained end-to-end into loops, reversing pieces as
//     needed, so the drawing direction of each line or arc does not matter
//  3. loops are nested by containment (even-odd): outermost loops are solids,
//     loops directly inside them are holes, loops inside holes are solids again
import * as THREE from 'three';
import type { Point2 } from '../types/cad.ts';


/**
 * Sketch entity as read by the profile builder. Besides the canonical fields it
 * accepts legacy aliases (start/end, x1..y2, cx/cy/r, corner1/corner2, rx/ry).
 */
export interface ProfileEntity {
  id?: string;
  type: string;
  construction?: boolean;
  p1?: Point2;
  p2?: Point2;
  start?: Point2;
  end?: Point2;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  center?: Point2;
  cx?: number;
  cy?: number;
  radius?: number;
  r?: number;
  /** Radians. */
  startAngle?: number;
  /** Radians. */
  endAngle?: number;
  corner1?: Point2;
  corner2?: Point2;
  controlPoints?: Point2[];
  radiusX?: number;
  radiusY?: number;
  rx?: number;
  ry?: number;
}

/** Endpoint matching tolerance when chaining entities (mm). */
const JOIN_TOLERANCE = 0.01;
const ARC_SEGMENTS = 64; // per full turn, same density as circles
const CIRCLE_SEGMENTS = 64;
const SPLINE_SEGMENTS = 32;

const lineStart = (e: ProfileEntity): Point2 => ({
  x: e.p1?.x ?? e.start?.x ?? e.x1 ?? 0,
  y: e.p1?.y ?? e.start?.y ?? e.y1 ?? 0,
});
const lineEnd = (e: ProfileEntity): Point2 => ({
  x: e.p2?.x ?? e.end?.x ?? e.x2 ?? 0,
  y: e.p2?.y ?? e.end?.y ?? e.y2 ?? 0,
});
const centerOf = (e: ProfileEntity): Point2 => ({ x: e.center?.x ?? e.cx ?? 0, y: e.center?.y ?? e.cy ?? 0 });

/** Points along a counter-clockwise arc from startAngle to endAngle (radians). */
export function arcPoints(center: Point2, radius: number, startAngle: number, endAngle: number, segments = ARC_SEGMENTS): Point2[] {
  let sweep = endAngle - startAngle;
  // Arcs run counter-clockwise; an end angle "below" the start wraps around
  while (sweep <= 0) sweep += Math.PI * 2;
  while (sweep > Math.PI * 2 + 1e-12) sweep -= Math.PI * 2;
  const n = Math.max(2, Math.ceil(segments * sweep / (Math.PI * 2)));
  const pts: Point2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = startAngle + (sweep * i) / n;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}

function circlePoints(center: Point2, radius: number): Point2[] {
  const pts: Point2[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a = (Math.PI * 2 * i) / CIRCLE_SEGMENTS;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}

/** Signed area (positive = counter-clockwise). */
export function signedArea(loop: Point2[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Even-odd point-in-polygon test. */
export function pointInLoop(pt: Point2, loop: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from `pt` to the closest edge of `loop`. */
function distanceToLoop(pt: Point2, loop: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * True when every vertex of `inner` is inside `outer` or on its boundary
 * (within the tessellation tolerance of curved edges). Loops that merely
 * overlap are not nested; they are separate regions and get unioned.
 */
export function loopInside(inner: Point2[], outer: Point2[], tol = 0.05): boolean {
  return inner.every(p => pointInLoop(p, outer) || distanceToLoop(p, outer) <= tol);
}

const near = (a: Point2, b: Point2) => Math.abs(a.x - b.x) < JOIN_TOLERANCE && Math.abs(a.y - b.y) < JOIN_TOLERANCE;

/** Remove consecutive duplicates and a duplicated closing point. */
function cleanLoop(pts: Point2[]): Point2[] {
  const out: Point2[] = [];
  for (const p of pts) if (!out.length || !near(out[out.length - 1], p)) out.push(p);
  if (out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
  return out;
}

/**
 * Closed loops of the profile. Construction geometry and points are ignored.
 * Open chains are closed with a straight segment (lenient, as before).
 */
export function profileLoops(entities: ProfileEntity[]): Point2[][] {
  const loops: Point2[][] = [];
  const open: Point2[][] = [];

  for (const e of entities) {
    if (e.construction) continue;
    switch (e.type) {
      case 'line':
        open.push([lineStart(e), lineEnd(e)]);
        break;
      case 'arc':
        open.push(arcPoints(centerOf(e), e.radius ?? e.r ?? 10, e.startAngle ?? 0, e.endAngle ?? Math.PI * 2));
        break;
      case 'spline':
        if (e.controlPoints && e.controlPoints.length >= 2) {
          const curve = new THREE.SplineCurve(e.controlPoints.map(p => new THREE.Vector2(p.x, p.y)));
          open.push(curve.getPoints(SPLINE_SEGMENTS).map(p => ({ x: p.x, y: p.y })));
        }
        break;
      case 'circle':
        loops.push(circlePoints(centerOf(e), e.radius ?? e.r ?? 10));
        break;
      case 'ellipse': {
        const c = centerOf(e);
        const curve = new THREE.EllipseCurve(c.x, c.y, e.radiusX ?? e.rx ?? 10, e.radiusY ?? e.ry ?? 5, 0, Math.PI * 2, false,
          (e as { rotation?: number }).rotation ?? 0);
        loops.push(curve.getPoints(CIRCLE_SEGMENTS).map(p => ({ x: p.x, y: p.y })));
        break;
      }
      case 'rect': {
        const x1 = e.x1 ?? e.corner1?.x ?? 0;
        const y1 = e.y1 ?? e.corner1?.y ?? 0;
        const x2 = e.x2 ?? e.corner2?.x ?? 0;
        const y2 = e.y2 ?? e.corner2?.y ?? 0;
        loops.push([{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }]);
        break;
      }
      default:
        break; // points and unknown entities do not form profiles
    }
  }

  // Chain open pieces into loops, reversing pieces whose direction disagrees
  const used = new Array<boolean>(open.length).fill(false);
  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const chain = [...open[s]];
    // Grow at the tail, then at the head (an open chain may start mid-way)
    for (const atTail of [true, false]) {
      let extended = true;
      while (extended && !near(chain[0], chain[chain.length - 1])) {
        extended = false;
        const endPt = atTail ? chain[chain.length - 1] : chain[0];
        for (let i = 0; i < open.length; i++) {
          if (used[i]) continue;
          const piece = open[i];
          let addition: Point2[];
          if (near(endPt, piece[0])) addition = atTail ? piece.slice(1) : [...piece].reverse().slice(0, -1);
          else if (near(endPt, piece[piece.length - 1])) addition = atTail ? [...piece].reverse().slice(1) : piece.slice(0, -1);
          else continue;
          if (atTail) chain.push(...addition);
          else chain.unshift(...addition);
          used[i] = true;
          extended = true;
          break;
        }
      }
    }
    loops.push(chain);
  }

  return loops.map(cleanLoop).filter(l => l.length >= 3 && Math.abs(signedArea(l)) > 1e-9);
}

/**
 * Shapes (with holes) for the profile, largest first. Loops at even nesting
 * depth are solids; odd depth loops are holes of their innermost container.
 * Solid shapes may overlap (e.g. a bore circle and a keyway); callers that
 * build solids from them must union, not concatenate (see extrudeProfile).
 */
export function shapesFromLoops(loops: Point2[][]): THREE.Shape[] {
  const sorted = [...loops].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  const parent: number[] = sorted.map(() => -1);
  const depth: number[] = sorted.map(() => 0);

  for (let i = 0; i < sorted.length; i++) {
    // Innermost larger loop containing this one (larger loops come first)
    for (let j = i - 1; j >= 0; j--) {
      if (loopInside(sorted[i], sorted[j])) {
        parent[i] = j;
        depth[i] = depth[j] + 1;
        break;
      }
    }
  }

  const toVectors = (loop: Point2[]) => loop.map(p => new THREE.Vector2(p.x, p.y));
  const shapes = new Map<number, THREE.Shape>();
  sorted.forEach((loop, i) => {
    if (depth[i] % 2 === 0) shapes.set(i, new THREE.Shape(toVectors(loop)));
  });
  sorted.forEach((loop, i) => {
    if (depth[i] % 2 === 1) shapes.get(parent[i])?.holes.push(new THREE.Path(toVectors(loop)));
  });
  return [...shapes.values()];
}
