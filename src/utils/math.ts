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
