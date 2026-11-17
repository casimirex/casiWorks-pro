// CasiWorks Pro - Degrees of freedom of an assembly: which components the mates hold fully, which can still move, which conflict
//
// Each mate is written as equations ("residuals") that are zero when it holds:
// a coincident mate, for example, is the gap between the faces and the two normals
// pointing at each other. Moving each free component a little along its six
// motions (three slides, three turns) and watching the residuals change gives the
// Jacobian; its rank is how many motions the mates take away, and its null space
// is the motions they leave. A mate whose residuals stay away from zero after
// solving conflicts with the others (over defined).
import * as THREE from 'three';
import { MATE_TYPES } from '../utils/constants.ts';
import { symmetricEigen } from '../utils/jacobiEigen.ts';
import { signedAngleAbout, wrapAngle } from './AssemblyManager.ts';
import type { AssemblyComponent, Mate } from './AssemblyManager.ts';

export type ComponentStatus = 'fixed' | 'fully-defined' | 'under-defined' | 'over-defined';

export interface ComponentDof {
  id: string;
  name: string;
  status: ComponentStatus;
  /** Motions the mates leave this component (0–6). */
  dof: number;
  /** What those motions are, e.g. ['turn about Y']; slides and turns along the model axes when they line up with one. */
  motions: string[];
}

export interface DofReport {
  /** Motions left in the whole assembly. */
  dof: number;
  status: 'fully-defined' | 'under-defined' | 'over-defined';
  components: ComponentDof[];
  /** Mates that do not hold after solving (they conflict with others). */
  conflicts: string[];
  /** Mates that repeat what others already fix (allowed, but they add nothing). */
  redundant: number;
}

const v3 = (r: THREE.Vector3) => [r.x, r.y, r.z];

/** The residuals of one mate (zero when it holds). Units: mm for distances, radians times `scale` for directions. */
export function mateResiduals(mate: Mate, c1: AssemblyComponent, c2: AssemblyComponent, scale = 1): number[] {
  const type = String(mate.type).toLowerCase();
  switch (type) {
    case MATE_TYPES.COINCIDENT:
    case MATE_TYPES.DISTANCE: {
      const f1 = c1.getFaceReference(mate.ref1), f2 = c2.getFaceReference(mate.ref2);
      const gap = f2.point.clone().sub(f1.point).dot(f1.normal);
      const along = type === MATE_TYPES.COINCIDENT ? gap + mate.offset : gap - mate.offset;
      return [along, ...v3(f1.normal.clone().add(f2.normal).multiplyScalar(scale))];
    }
    case MATE_TYPES.PARALLEL: {
      const f1 = c1.getFaceReference(mate.ref1), f2 = c2.getFaceReference(mate.ref2);
      return v3(f1.normal.clone().cross(f2.normal).multiplyScalar(scale));
    }
    case MATE_TYPES.PERPENDICULAR: {
      const f1 = c1.getFaceReference(mate.ref1), f2 = c2.getFaceReference(mate.ref2);
      return [f1.normal.dot(f2.normal) * scale];
    }
    case MATE_TYPES.ANGLE: {
      const f1 = c1.getFaceReference(mate.ref1), f2 = c2.getFaceReference(mate.ref2);
      const target = ((mate.angle ?? mate.offset ?? 0) * Math.PI) / 180;
      if (mate.axis) {
        const axis = new THREE.Vector3(mate.axis.x ?? 0, mate.axis.y ?? 0, mate.axis.z ?? 0).normalize().applyQuaternion(c1.quaternion);
        return [wrapAngle(target - signedAngleAbout(f1.normal, f2.normal, axis)) * scale];
      }
      return [(f1.normal.dot(f2.normal) - Math.cos(target)) * scale];
    }
    case MATE_TYPES.CONCENTRIC: {
      const a1 = c1.getAxisReference(mate.ref1), a2 = c2.getAxisReference(mate.ref2);
      const d = a2.point.clone().sub(a1.point);
      const perp = d.sub(a1.axis.clone().multiplyScalar(d.dot(a1.axis)));
      return [...v3(a1.axis.clone().cross(a2.axis).multiplyScalar(scale)), ...v3(perp)];
    }
    case MATE_TYPES.TANGENT: {
      const cylFirst = !(mate.ref2 === 'cylinder' || mate.ref2 === 'z' || mate.ref2 === 'axis');
      const cyl = cylFirst ? c1.getAxisReference(mate.ref1) : c2.getAxisReference(mate.ref2);
      const plane = cylFirst ? c2.getFaceReference(mate.ref2) : c1.getFaceReference(mate.ref1);
      const d = cyl.point.clone().sub(plane.point).dot(plane.normal);
      return [cyl.axis.dot(plane.normal) * scale, Math.abs(d) - cyl.radius - mate.offset];
    }
    case MATE_TYPES.WIDTH: {
      const ref1A = mate.ref1 || 'left';
      const f1A = c1.getFaceReference(ref1A);
      const f1B = c1.getFaceReference(mate.ref1Secondary || c1.getOpposingFaceName(ref1A));
      const ref2A = mate.ref2 || 'left';
      const f2A = c2.getFaceReference(ref2A);
      const f2B = c2.getFaceReference(mate.ref2Secondary || c2.getOpposingFaceName(ref2A));
      const mid1 = f1A.point.clone().add(f1B.point).multiplyScalar(0.5);
      const mid2 = f2A.point.clone().add(f2B.point).multiplyScalar(0.5);
      return [mid2.sub(mid1).dot(f1A.normal) + mate.offset, ...v3(f2A.normal.clone().cross(f1A.normal).multiplyScalar(scale))];
    }
    default:
      return []; // path and unknown types: not analysed (treated as holding nothing)
  }
}

/** Motions of a component: three slides, then three turns (scaled so a turn moves the part about as far as a slide). */
function perturb(c: AssemblyComponent, k: number, h: number, scale: number): void {
  if (k < 3) {
    c.position.setComponent(k, c.position.getComponent(k) + h);
  } else {
    const axis = new THREE.Vector3().setComponent(k - 3, 1);
    c.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, h / scale)).normalize();
  }
  c.updateMatrix();
}

const MOTION_NAMES = ['slide along X', 'slide along Y', 'slide along Z', 'turn about X', 'turn about Y', 'turn about Z'];

/** Name the motions a component keeps: model axes when the free directions line up with them, otherwise a count. */
function describe(basis: number[][]): string[] {
  // basis: orthonormal vectors over the six motions. A model motion is free when it lies in their span.
  const names = MOTION_NAMES.filter((_, e) => basis.reduce((s, b) => s + b[e] * b[e], 0) > 0.98);
  const extra = basis.length - names.length;
  return extra > 0 ? [...names, `${extra} combined motion${extra === 1 ? '' : 's'}`] : names;
}

/**
 * Analyse the assembly as it stands (solve first). `tolerance` is the residual
 * above which a mate counts as not holding.
 */
export function analyzeDof(components: AssemblyComponent[], mates: Mate[], tolerance = 1e-3): DofReport {
  const free = components.filter(c => !c.isFixed);
  const byId = new Map(components.map(c => [c.id, c]));
  const index = new Map(free.map((c, i) => [c.id, i]));
  // A typical part size makes turns and slides comparable
  const box = new THREE.Box3();
  for (const c of components) box.union(c.localBox());
  const scale = Math.max(1, box.isEmpty() ? 10 : box.getSize(new THREE.Vector3()).length() / 2);

  const live = mates.filter(m => byId.has(m.comp1Id) && byId.has(m.comp2Id) && !(byId.get(m.comp1Id)!.isFixed && byId.get(m.comp2Id)!.isFixed));
  const residualsOf = (m: Mate) => mateResiduals(m, byId.get(m.comp1Id)!, byId.get(m.comp2Id)!, scale);

  // Mates that do not hold
  const conflicts = live.filter(m => residualsOf(m).some(r => Math.abs(r) > tolerance * Math.max(1, scale / 10))).map(m => m.id);

  // Jacobian by central differences, one column per motion of each free component
  const n = free.length * 6;
  const lengths = live.map(m => residualsOf(m).length);
  const rows = lengths.reduce((s, l) => s + l, 0);
  const J: number[][] = Array.from({ length: rows }, () => new Array(n).fill(0));
  const h = 1e-4;
  free.forEach((c, ci) => {
    for (let k = 0; k < 6; k++) {
      const pos = c.position.clone(), q = c.quaternion.clone();
      const touching = live.filter(m => m.comp1Id === c.id || m.comp2Id === c.id);
      perturb(c, k, h, scale);
      const plus = new Map(touching.map(m => [m.id, residualsOf(m)]));
      c.position.copy(pos); c.quaternion.copy(q); c.updateMatrix();
      perturb(c, k, -h, scale);
      const minus = new Map(touching.map(m => [m.id, residualsOf(m)]));
      c.position.copy(pos); c.quaternion.copy(q); c.updateMatrix();
      let row = 0;
      for (const [mi_, m] of live.entries()) {
        const len = lengths[mi_];
        const p = plus.get(m.id), mi = minus.get(m.id);
        if (p && mi) for (let r = 0; r < len; r++) J[row + r][ci * 6 + k] = (p[r] - mi[r]) / (2 * h);
        row += len;
      }
    }
  });

  // JᵀJ: its zero eigenvalues are the free motions
  const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const r of J) for (let i = 0; i < n; i++) if (r[i] !== 0) for (let j = 0; j < n; j++) JtJ[i][j] += r[i] * r[j];
  const { values, vectors } = n > 0 ? symmetricEigen(JtJ) : { values: [], vectors: [] };
  const top = Math.max(1e-12, ...values.map(Math.abs));
  const nullCols = values.map((v, i) => ({ v, i })).filter(e => Math.abs(e.v) <= top * 1e-8).map(e => e.i);
  const rank = n - nullCols.length;

  const conflictSet = new Set(conflicts);
  const report: ComponentDof[] = components.map(c => {
    if (c.isFixed) return { id: c.id, name: c.name, status: 'fixed', dof: 0, motions: [] };
    const ci = index.get(c.id)!;
    // This component's part of the null space: its free motions are the rank of that 6 × k block
    const block = nullCols.map(col => Array.from({ length: 6 }, (_, k) => vectors[ci * 6 + k][col]));
    const G = Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (__, b) => block.reduce((s, v) => s + v[a] * v[b], 0)));
    const eig = symmetricEigen(G);
    const basis = eig.values.map((v, i) => ({ v, i })).filter(e => e.v > 1e-6)
      .map(e => Array.from({ length: 6 }, (_, k) => eig.vectors[k][e.i]));
    const dof = basis.length;
    const conflicted = live.some(m => conflictSet.has(m.id) && (m.comp1Id === c.id || m.comp2Id === c.id));
    return {
      id: c.id, name: c.name, dof,
      status: conflicted ? 'over-defined' : dof === 0 ? 'fully-defined' : 'under-defined',
      motions: describe(basis),
    };
  });

  const dof = n - rank;
  return {
    dof,
    status: conflicts.length ? 'over-defined' : dof === 0 ? 'fully-defined' : 'under-defined',
    components: report,
    conflicts,
    redundant: Math.max(0, live.reduce((s, m) => s + mateRank(m), 0) - rank),
  };
}

/** How many motions a mate can take away at most (its residuals are not all independent, e.g. a normal has 3 numbers but 2 directions). */
function mateRank(m: Mate): number {
  switch (String(m.type).toLowerCase()) {
    case MATE_TYPES.COINCIDENT: case MATE_TYPES.DISTANCE: return 3;
    case MATE_TYPES.PARALLEL: return 2;
    case MATE_TYPES.CONCENTRIC: return 4;
    case MATE_TYPES.WIDTH: return 3;
    case MATE_TYPES.TANGENT: return 2;
    case MATE_TYPES.PERPENDICULAR: case MATE_TYPES.ANGLE: return 1;
    default: return 0;
  }
}
