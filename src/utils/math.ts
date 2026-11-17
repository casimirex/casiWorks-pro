// CasiWorks Pro - Math Utilities
import * as THREE from 'three';
import type { PlaneFrame, Point2, Point3, SketchPlane, SketchPlaneRef } from '../types/cad.ts';

export const EPSILON = 1e-8;

export function vec3(x = 0, y = 0, z = 0): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

export function distance2D(p1: Point2, p2: Point2): number {
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}

/** Intersection of the infinite lines p1–p2 and p3–p4, or null when parallel. */
export function lineLineIntersection(p1: Point2, p2: Point2, p3: Point2, p4: Point2): Point2 | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < EPSILON) return null;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/** Shortest distance from `point` to the segment lineStart–lineEnd. */
export function pointToLineDistance(point: Point2, lineStart: Point2, lineEnd: Point2): number {
  const A = point.x - lineStart.x;
  const B = point.y - lineStart.y;
  const C = lineEnd.x - lineStart.x;
  const D = lineEnd.y - lineStart.y;
  const lenSq = C * C + D * D;
  const param = lenSq !== 0 ? (A * C + B * D) / lenSq : -1;
  let xx: number;
  let yy: number;
  if (param < 0) { xx = lineStart.x; yy = lineStart.y; }
  else if (param > 1) { xx = lineEnd.x; yy = lineEnd.y; }
  else { xx = lineStart.x + param * C; yy = lineStart.y + param * D; }
  return Math.sqrt((point.x - xx) ** 2 + (point.y - yy) ** 2);
}

let _idCounter = 0;
/** Unique id: `${prefix}_${timestamp}_${counter}`. */
export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now()}_${++_idCounter}`;
}

/** True for a plane given by its frame (not a standard plane name). */
export const isPlaneFrame = (plane: unknown): plane is PlaneFrame =>
  !!plane && typeof plane === 'object' && 'origin' in plane && 'normal' in plane && 'xAxis' in plane;

/** Matrix of a plane frame: sketch (x, y, z-along-normal) → model space. */
function frameMatrix(f: PlaneFrame): THREE.Matrix4 {
  const n = new THREE.Vector3(f.normal.x, f.normal.y, f.normal.z).normalize();
  // X made exactly perpendicular to the normal, so the basis stays orthonormal
  const x = new THREE.Vector3(f.xAxis.x, f.xAxis.y, f.xAxis.z);
  x.addScaledVector(n, -x.dot(n)).normalize();
  const y = new THREE.Vector3().crossVectors(n, x);
  return new THREE.Matrix4().makeBasis(x, y, n).setPosition(f.origin.x, f.origin.y, f.origin.z);
}

/** Rotation (and, for frames, translation) that maps sketch-plane XY coordinates into model space. */
export function getSketchPlaneMatrix(plane: string | PlaneFrame): THREE.Matrix4 {
  if (isPlaneFrame(plane)) return frameMatrix(plane);
  const matrix = new THREE.Matrix4();
  switch (plane) {
    case 'XY':
    case 'Front':
      break;
    case 'XZ':
    case 'Top':
      matrix.makeRotationX(-Math.PI / 2);
      break;
    case 'YZ':
    case 'Right':
      matrix.makeRotationY(Math.PI / 2);
      break;
    default:
      break;
  }
  return matrix;
}

/** World point of a sketch point on a sketch plane (the same mapping the kernel extrudes with). */
export function sketchToWorld(p: Point2, plane: string | PlaneFrame): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, 0).applyMatrix4(getSketchPlaneMatrix(plane));
}

/** Sketch coordinates of a world point on (or projected onto) a sketch plane. */
export function worldToSketch(v: THREE.Vector3, plane: string | PlaneFrame): Point2 {
  const local = v.clone().applyMatrix4(getSketchPlaneMatrix(plane).invert());
  return { x: local.x, y: local.y };
}

/** Unit normal of a sketch plane in world space. */
export function sketchPlaneNormal(plane: string | PlaneFrame): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).transformDirection(getSketchPlaneMatrix(plane));
}

/** The frame of any sketch plane (standard planes pass through the origin). */
export function planeFrameOf(plane: SketchPlaneRef): PlaneFrame {
  if (isPlaneFrame(plane)) return plane;
  const m = getSketchPlaneMatrix(plane);
  const v = (x: number, y: number, z: number): Point3 => { const r = new THREE.Vector3(x, y, z).transformDirection(m); return { x: r.x, y: r.y, z: r.z }; };
  return { origin: { x: 0, y: 0, z: 0 }, xAxis: v(1, 0, 0), normal: v(0, 0, 1) };
}

/** A reference plane: `base` moved `offset` mm along its normal, then tilted `angle`° about its own X axis. */
export function referencePlaneFrame(base: SketchPlane, offset = 0, angle = 0): PlaneFrame {
  const m = getSketchPlaneMatrix(base)
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, offset))
    .multiply(new THREE.Matrix4().makeRotationX(angle * Math.PI / 180));
  const o = new THREE.Vector3().applyMatrix4(m);
  const x = new THREE.Vector3(1, 0, 0).transformDirection(m);
  const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
  const clean = (v: THREE.Vector3): Point3 => ({ x: +v.x.toFixed(12) + 0, y: +v.y.toFixed(12) + 0, z: +v.z.toFixed(12) + 0 });
  return { origin: clean(o), xAxis: clean(x), normal: clean(n) };
}

/**
 * The plane of a face through `point` with outward `normal`. Its origin is the
 * model origin projected onto the plane. On a wall the sketch Y is model up; on a
 * floor or ceiling the sketch X is model X. Front, Top and Right faces therefore
 * line up exactly with the standard planes.
 */
export function faceFrame(point: Point3, normal: Point3): PlaneFrame {
  const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  const d = n.dot(new THREE.Vector3(point.x, point.y, point.z));
  const o = n.clone().multiplyScalar(d);
  let x: THREE.Vector3;
  if (Math.abs(n.y) < 0.9) {
    // A wall: sketch Y is model up, so the sketch is upright from any side
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    x = new THREE.Vector3().crossVectors(up, n).normalize();
  } else {
    // A floor or ceiling: sketch X is model X, like the Top plane
    x = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x).normalize();
  }
  const clean = (v: THREE.Vector3): Point3 => ({ x: +v.x.toFixed(9) + 0, y: +v.y.toFixed(9) + 0, z: +v.z.toFixed(9) + 0 });
  return { origin: clean(o), xAxis: clean(x), normal: clean(n) };
}

/** Unit vector of `v`; `fallback` (cloned) when `v` is missing, non-finite or ~zero length. */
export function safeNormalize(
  v: { x: number; y: number; z: number } | null | undefined,
  fallback: THREE.Vector3 = new THREE.Vector3(0, 0, 1),
): THREE.Vector3 {
  if (!v || typeof v.x !== 'number') return fallback.clone();
  const x = Number.isFinite(v.x) ? v.x : 0;
  const y = Number.isFinite(v.y) ? v.y : 0;
  const z = Number.isFinite(v.z) ? v.z : 0;
  const lenSq = x * x + y * y + z * z;
  if (!(lenSq >= 1e-14) || !Number.isFinite(lenSq)) return fallback.clone();
  const invLen = 1 / Math.sqrt(lenSq);
  return new THREE.Vector3(x * invLen, y * invLen, z * invLen);
}

/** Copy of `p` as a Vector3 with non-finite components replaced from `defaultVal`. */
export function sanitizePoint(
  p: { x?: number; y?: number; z?: number } | null | undefined,
  defaultVal: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
): THREE.Vector3 {
  if (!p) return defaultVal.clone();
  const pick = (value: number | undefined, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return new THREE.Vector3(pick(p.x, defaultVal.x), pick(p.y, defaultVal.y), pick(p.z, defaultVal.z));
}
