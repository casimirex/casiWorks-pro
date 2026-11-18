// CasiWorks Pro - Modal analysis: natural frequencies and mode shapes
//
// Solves K·φ = ω²·M·φ for the lowest modes of the meshed part, with the fixed
// face held. K is the same stiffness the static study uses; M is a lumped
// (diagonal) mass matrix: a Tet4 gives each corner a quarter of its mass, a
// Tet10 uses HRZ lumping (corners 1/36, mid-edge nodes 4/27 of the element mass).
// The eigenproblem is solved by shift-invert Lanczos with full
// re-orthogonalisation: each step is one solve with K (the static solver's
// preconditioned CG), and the largest eigenvalues of K⁻¹M are the lowest modes.
import type * as THREE from 'three';
import { ELEMENT_TYPES, FEAEngine, SparseMatrix } from './FEAEngine.ts';
import type { BoxPlane, ElementType } from './FEAEngine.ts';
import { autoMesh } from './autoMesh.ts';
import type { MeshQuality } from './autoMesh.ts';
import { studyBoundary } from './studySetup.ts';
import type { StudyFace } from './studyFaces.ts';
import type { Fixture } from './FEAEngine.ts';
import { symmetricEigen } from '../utils/jacobiEigen.ts';
import { EnvelopeCholesky, SpdSolver } from './linearSolvers.ts';
export { DIRECT_LIMIT, EnvelopeCholesky, SpdSolver } from './linearSolvers.ts';
export { symmetricEigen };

export interface ModalResult {
  /** Natural frequencies, Hz, lowest first. */
  frequencies: number[];
  /** Mode shapes: per mode, x y z per node, scaled so the largest displacement is 1. */
  shapes: Float64Array[];
  /** Mass that takes part (kg): the part's mass in the analysis. */
  mass: number;
}

export interface ModalOptions {
  youngsModulus: number;
  poissonRatio: number;
  /** kg/m³ */
  density: number;
  fixtures: Fixture[];
  /** How many modes (default 6). */
  modes?: number;
  onProgress?: (fraction: number) => void;
}

type Engine = FEAEngine & {
  computeTet4Stiffness(c: ArrayLike<number>[], E: number, nu: number): { Ke: Float64Array[] } | null;
  computeTet10Stiffness(c: ArrayLike<number>[], E: number, nu: number): { Ke: Float64Array[] } | null;
  _findNodesForFixture(f: Fixture): number[];
  _solvePCG(K: SparseMatrix, F: Float64Array, maxIter?: number, tol?: number): Float64Array;
};

const tetVolume = (p: ArrayLike<number>[]) => {
  const [a, b, c, d] = p;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
  return Math.abs(ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
};


/** The lowest modes of the mesh in `fea` (meshed already). */
export function solveModal(fea: FEAEngine, opts: ModalOptions): ModalResult {
  const engine = fea as Engine;
  const mesh = fea.solidMesh;
  if (!mesh) throw new Error('Mesh the part first');
  const { nodes, elements } = mesh;
  const n = nodes.length * 3;
  const E = opts.youngsModulus, nu = opts.poissonRatio, rho = opts.density;

  // Stiffness and lumped mass
  const K = new SparseMatrix(n);
  const M = new Float64Array(n);
  let mass = 0;
  for (const elem of elements) {
    const isTet10 = elem.nodes.length >= 10;
    const en = isTet10 ? elem.nodes.slice(0, 10) : elem.nodes.slice(0, 4);
    const coords = en.map(i => nodes[i].posMeters);
    const res = isTet10 ? engine.computeTet10Stiffness(coords, E, nu) : engine.computeTet4Stiffness(coords, E, nu);
    if (!res) continue;
    const dofs: number[] = [];
    for (const i of en) dofs.push(i * 3, i * 3 + 1, i * 3 + 2);
    for (let r = 0; r < dofs.length; r++) for (let c = 0; c < dofs.length; c++) K.add(dofs[r], dofs[c], res.Ke[r][c]);
    const m = tetVolume(coords.slice(0, 4)) * rho;
    mass += m;
    en.forEach((node, k) => {
      const share = !isTet10 ? m / 4 : k < 4 ? m / 36 : (4 * m) / 27;
      M[node * 3] += share; M[node * 3 + 1] += share; M[node * 3 + 2] += share;
    });
  }

  // The fixed face: those unknowns are held at zero (no mass, identity rows in K)
  const fixed = new Map<number, number>();
  for (const fix of opts.fixtures) {
    const ids = engine._findNodesForFixture(fix);
    if (ids.length === 0) throw new Error(`No mesh nodes on the fixed face${fix.plane ? ` (${fix.plane})` : ''}: the part does not reach it`);
    for (const i of ids) { fixed.set(i * 3, 0); fixed.set(i * 3 + 1, 0); fixed.set(i * 3 + 2, 0); }
  }
  if (fixed.size === 0) throw new Error('Modal analysis needs a fixed face');
  for (const d of fixed.keys()) M[d] = 0;
  K.applyDirichlet(fixed, new Float64Array(n));

  // A direct factorisation when it fits, otherwise preconditioned CG
  const direct = EnvelopeCholesky.create(K);
  const iterative = direct ? null : new SpdSolver(K);
  const solveK = (rhs: Float64Array) => (direct ? direct.solve(rhs) : iterative!.solve(rhs, 1e-9));
  const modes = Math.max(1, Math.min(20, Math.round(opts.modes ?? 6)));
  const free = n - fixed.size;
  const steps = Math.min(free, 2 * modes + 20);

  // M-orthonormal Lanczos on K⁻¹M
  const mdot = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * M[i] * b[i]; return s; };
  const Q: Float64Array[] = [];
  const alpha: number[] = [];
  const beta: number[] = [];
  // A deterministic start that excites every free unknown
  let q = new Float64Array(n);
  for (let i = 0; i < n; i++) q[i] = M[i] > 0 ? 1 + 0.37 * Math.sin(i * 12.9898) : 0;
  let norm = Math.sqrt(mdot(q, q));
  for (let i = 0; i < n; i++) q[i] /= norm;
  for (let j = 0; j < steps; j++) {
    Q.push(q);
    const rhs = new Float64Array(n);
    for (let i = 0; i < n; i++) rhs[i] = M[i] * q[i];
    const w = solveK(rhs);
    const a = mdot(w, q);
    alpha.push(a);
    for (let i = 0; i < n; i++) w[i] -= a * q[i] + (j > 0 ? beta[j - 1] * Q[j - 1][i] : 0);
    // Full re-orthogonalisation (twice) keeps the basis clean
    for (let pass = 0; pass < 2; pass++) {
      for (const qi of Q) {
        const h = mdot(w, qi);
        for (let i = 0; i < n; i++) w[i] -= h * qi[i];
      }
    }
    norm = Math.sqrt(mdot(w, w));
    opts.onProgress?.((j + 1) / steps);
    if (j === steps - 1 || norm < 1e-12 * Math.abs(a)) break;
    beta.push(norm);
    q = new Float64Array(n);
    for (let i = 0; i < n; i++) q[i] = w[i] / norm;
  }

  // Ritz values of the tridiagonal T: θ = 1/ω²
  const m = alpha.length;
  const T = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (__, k) => (i === k ? alpha[i] : Math.abs(i - k) === 1 ? beta[Math.min(i, k)] : 0)));
  const { values, vectors } = symmetricEigen(T);
  const order = values.map((v, i) => [v, i] as const).filter(([v]) => v > 0).sort((x, y) => y[0] - x[0]).slice(0, modes);

  const frequencies: number[] = [];
  const shapes: Float64Array[] = [];
  for (const [theta, idx] of order) {
    frequencies.push(Math.sqrt(1 / theta) / (2 * Math.PI));
    const phi = new Float64Array(n);
    for (let k = 0; k < m; k++) {
      const s = vectors[k][idx];
      if (s === 0) continue;
      for (let i = 0; i < n; i++) phi[i] += s * Q[k][i];
    }
    let max = 0;
    for (let i = 0; i < n; i += 3) max = Math.max(max, Math.hypot(phi[i], phi[i + 1], phi[i + 2]));
    if (max > 0) for (let i = 0; i < n; i++) phi[i] /= max;
    shapes.push(phi);
  }
  return { frequencies, shapes, mass };
}

export interface FrequencyStudy {
  /** The face held fixed (default zMin, the back face). */
  fixedFace?: BoxPlane;
  /** Faces picked on the model held fixed instead of fixedFace. */
  fixedFaces?: StudyFace[];
  /** How many modes (1–20, default 6). */
  modes?: number;
  /** Tet10 (default) is accurate in bending; Tet4 is a quick, too-stiff preview. */
  elementType?: ElementType;
  /** Mesh size (default coarse: Tet10 coarse is within ~1% of the beam formula). */
  quality?: MeshQuality;
}

/** Natural frequencies of a part (mm geometry) in a material: mesh, then solve. */
export function naturalFrequencies(
  geometry: THREE.BufferGeometry,
  material: { youngsModulus: number; poissonsRatio: number; density: number },
  study: FrequencyStudy = {},
): ModalResult & { elements: number } {
  const fea = new FEAEngine();
  const info = autoMesh(fea, geometry, study.elementType ?? ELEMENT_TYPES.TET10, study.quality ?? 'coarse');
  const result = solveModal(fea, {
    youngsModulus: material.youngsModulus, poissonRatio: material.poissonsRatio, density: material.density,
    fixtures: studyBoundary(study.fixedFaces?.length
      ? { fixedFace: 'faces', fixedFaces: study.fixedFaces, loadFace: 'zMax', loadDirection: '-Y' }
      : { fixedFace: study.fixedFace ?? 'zMin', loadFace: 'zMax', loadDirection: '-Y' }, geometry, fea.solidMesh!, 0).fixtures,
    modes: study.modes,
  });
  return { ...result, elements: info.elements };
}
