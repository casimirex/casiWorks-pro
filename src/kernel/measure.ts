// CasiWorks Pro - Measuring between two picked points on the model
//
// A pick is a point on a face (with the face normal) or, when the click was
// near a corner, that vertex. Two picks give the straight distance and its
// x / y / z parts; with both normals also the angle between the faces, and
// for parallel faces the gap between them (a wall thickness in two clicks).

export interface Vec3 { x: number; y: number; z: number }

export interface MeasurePick {
  point: Vec3;
  /** Unit normal of the picked face (world space), when known. */
  normal?: Vec3 | null;
  /** 'vertex' when the click snapped to a corner. */
  kind: 'vertex' | 'face';
}

export interface Measurement {
  /** Straight-line distance, mm. */
  distance: number;
  dx: number;
  dy: number;
  dz: number;
  /** Angle between the two face normals, degrees (0 = same way, 180 = facing each other); null without normals. */
  angle: number | null;
  /** For parallel faces: the distance between their planes, mm (null otherwise). */
  gap: number | null;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const unit = (a: Vec3): Vec3 | null => { const l = len(a); return l > 1e-12 ? { x: a.x / l, y: a.y / l, z: a.z / l } : null; };

/** Faces count as parallel within this angle (degrees). */
export const PARALLEL_TOLERANCE_DEG = 0.5;

export function measure(a: MeasurePick, b: MeasurePick): Measurement {
  const d = sub(b.point, a.point);
  const na = a.normal ? unit(a.normal) : null;
  const nb = b.normal ? unit(b.normal) : null;
  let angle: number | null = null;
  let gap: number | null = null;
  if (na && nb) {
    angle = Math.acos(Math.max(-1, Math.min(1, dot(na, nb)))) * 180 / Math.PI;
    if (angle < PARALLEL_TOLERANCE_DEG || angle > 180 - PARALLEL_TOLERANCE_DEG) gap = Math.abs(dot(d, na));
  }
  return { distance: len(d), dx: d.x, dy: d.y, dz: d.z, angle, gap };
}

/**
 * The pick for a click at `hit` on a triangle with corners `corners`: the
 * nearest corner when it is within `tolerance` (mm), otherwise the hit itself.
 */
export function snapPick(hit: Vec3, corners: Vec3[], normal: Vec3 | null, tolerance: number): MeasurePick {
  let best: Vec3 | null = null;
  let bestD = tolerance;
  for (const c of corners) {
    const dist = len(sub(c, hit));
    if (dist <= bestD) { best = c; bestD = dist; }
  }
  const n = normal ? unit(normal) : null;
  return best ? { point: { ...best }, normal: n, kind: 'vertex' } : { point: { ...hit }, normal: n, kind: 'face' };
}

/** Numbers for display: up to 3 decimals, no trailing zeros, no "-0". */
export const formatMm = (v: number) => {
  const r = +v.toFixed(3);
  return String(Object.is(r, -0) ? 0 : r);
};
