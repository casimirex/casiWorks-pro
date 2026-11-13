// CasiWorks Pro - Math Utilities
import * as THREE from 'three';
import type { Point2 } from '../types/cad.ts';

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

/** Rotation that maps sketch-plane XY coordinates into model space. */
export function getSketchPlaneMatrix(plane: string): THREE.Matrix4 {
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
export function sketchToWorld(p: Point2, plane: string): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, 0).applyMatrix4(getSketchPlaneMatrix(plane));
}

/** Sketch coordinates of a world point on (or projected onto) a sketch plane. */
export function worldToSketch(v: THREE.Vector3, plane: string): Point2 {
  const local = v.clone().applyMatrix4(getSketchPlaneMatrix(plane).invert());
  return { x: local.x, y: local.y };
}

/** Unit normal of a sketch plane in world space. */
export function sketchPlaneNormal(plane: string): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyMatrix4(getSketchPlaneMatrix(plane));
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
