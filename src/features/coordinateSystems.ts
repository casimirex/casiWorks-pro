// CasiWorks Pro - Reference coordinate systems
//
// A coordinate system is an origin (a typed point, or a reference point it
// follows) and three axes: the model axes turned about model X, then model Y,
// then model Z by the given angles (degrees). Mass properties can be reported
// in one: the centre of mass in its coordinates and the inertia about its
// origin along its axes.
import type { Feature, InertiaTensor, MassProperties, Point3, ReferenceFeature } from '../types/cad.ts';

export interface CoordinateFrame {
  origin: Point3;
  x: Point3;
  y: Point3;
  z: Point3;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** The frame for an origin and X-then-Y-then-Z rotations (degrees, about the model axes). */
export function coordinateFrame(origin: Point3, rotation: Point3 = { x: 0, y: 0, z: 0 }): CoordinateFrame {
  const [cx, sx] = [Math.cos(rad(rotation.x)), Math.sin(rad(rotation.x))];
  const [cy, sy] = [Math.cos(rad(rotation.y)), Math.sin(rad(rotation.y))];
  const [cz, sz] = [Math.cos(rad(rotation.z)), Math.sin(rad(rotation.z))];
  // R = Rz · Ry · Rx; its columns are the axes
  const R = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
  const col = (j: number) => ({ x: R[0][j], y: R[1][j], z: R[2][j] });
  return { origin: { ...origin }, x: col(0), y: col(1), z: col(2) };
}

const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** A model point in the frame's coordinates. */
export function toFrame(frame: CoordinateFrame, p: Point3): Point3 {
  const d = { x: p.x - frame.origin.x, y: p.y - frame.origin.y, z: p.z - frame.origin.z };
  return { x: dot(d, frame.x), y: dot(d, frame.y), z: dot(d, frame.z) };
}

/** A point given in the frame's coordinates, in model coordinates. */
export function fromFrame(frame: CoordinateFrame, p: Point3): Point3 {
  const { origin: o, x, y, z } = frame;
  return {
    x: o.x + p.x * x.x + p.y * y.x + p.z * z.x,
    y: o.y + p.x * x.y + p.y * y.y + p.z * z.y,
    z: o.z + p.x * x.z + p.y * y.z + p.z * z.z,
  };
}

/** The frame of a coordinate-system feature (its origin follows a reference point when it names one); null when that point is gone. */
export function featureFrame(feature: Feature, features: Feature[]): CoordinateFrame | null {
  const r = feature as ReferenceFeature;
  let origin = r.point ?? { x: 0, y: 0, z: 0 };
  if (r.throughRef) {
    const ref = features.find(f => f.id === r.throughRef && !f.suppressed) as ReferenceFeature | undefined;
    if (!ref?.point) return null;
    origin = ref.point;
  }
  return coordinateFrame(origin, r.rotation ?? { x: 0, y: 0, z: 0 });
}

/**
 * Mass properties reported in a coordinate system: the centre of mass in its
 * coordinates and the inertia about its origin along its axes. Mass, volume and
 * area do not change; the inertia about the centre of mass is turned to its axes.
 */
export function massPropertiesIn(mp: MassProperties, frame: CoordinateFrame): MassProperties {
  const axes = [frame.x, frame.y, frame.z];
  // Second moments S = ∫ r rᵀ dm from the inertia tensor (Ixx = Syy + Szz, Ixy = Sxy)
  const second = (t: InertiaTensor) => {
    const sxx = (t.Iyy + t.Izz - t.Ixx) / 2, syy = (t.Ixx + t.Izz - t.Iyy) / 2, szz = (t.Ixx + t.Iyy - t.Izz) / 2;
    return [[sxx, t.Ixy, t.Ixz], [t.Ixy, syy, t.Iyz], [t.Ixz, t.Iyz, szz]];
  };
  const turned = (S: number[][]) => axes.map(a => axes.map(b => {
    const av = [a.x, a.y, a.z], bv = [b.x, b.y, b.z];
    let s = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += av[i] * S[i][j] * bv[j];
    return s;
  }));
  const tensor = (S: number[][]): InertiaTensor => ({
    Ixx: S[1][1] + S[2][2], Iyy: S[0][0] + S[2][2], Izz: S[0][0] + S[1][1],
    Ixy: S[0][1], Ixz: S[0][2], Iyz: S[1][2],
  });
  const atCom = turned(second(mp.momentOfInertia));
  const c = toFrame(frame, mp.centerOfMass);
  const cv = [c.x, c.y, c.z];
  // Parallel axes: S_origin = S_com + m·c·cᵀ (c in the frame's coordinates)
  const atOrigin = atCom.map((row, i) => row.map((v, j) => v + mp.mass * cv[i] * cv[j]));
  return { ...mp, centerOfMass: c, momentOfInertia: tensor(atCom), momentOfInertiaAtOrigin: tensor(atOrigin) };
}
