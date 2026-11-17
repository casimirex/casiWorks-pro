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
import { fixturesFor } from './studySetup.ts';
import type { Fixture } from './FEAEngine.ts';
import { symmetricEigen } from '../utils/jacobiEigen.ts';
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


/** A symmetric positive definite matrix in compressed rows (columns sorted), solved by IC(0)-preconditioned CG. */
export class SpdSolver {
  readonly n: number;
  private rowPtr: Int32Array;
  private cols: Int32Array;
  private vals: Float64Array;
  /** Incomplete Cholesky factor: the lower triangle (diagonal last in each row). */
  private lPtr!: Int32Array;
  private lCols!: Int32Array;
  private lVals!: Float64Array;
  iterations = 0;

  constructor(K: SparseMatrix) {
    const n = K.n;
    this.n = n;
    const rowPtr = new Int32Array(n + 1);
    let nnz = 0;
    for (let i = 0; i < n; i++) nnz += K.rows[i].size;
    const cols = new Int32Array(nnz), vals = new Float64Array(nnz);
    let k = 0;
    for (let i = 0; i < n; i++) {
      rowPtr[i] = k;
      const entries = [...K.rows[i]].sort((a, b) => a[0] - b[0]);
      for (const [j, v] of entries) { cols[k] = j; vals[k] = v; k++; }
    }
    rowPtr[n] = k;
    this.rowPtr = rowPtr; this.cols = cols; this.vals = vals;
    // IC(0); shift the diagonal a little if the factorisation breaks down
    for (let shift = 0; ; shift = shift ? shift * 4 : 1e-4) {
      if (this.factor(shift)) break;
      if (shift > 1) throw new Error('The stiffness matrix could not be factorised');
    }
  }

  private factor(shift: number): boolean {
    const { n, rowPtr, cols, vals } = this;
    const lPtr = new Int32Array(n + 1);
    let count = 0;
    for (let i = 0; i < n; i++) for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) if (cols[p] <= i) count++;
    const lCols = new Int32Array(count), lVals = new Float64Array(count);
    const dense = new Float64Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      lPtr[i] = k;
      const start = k;
      let diag = 0;
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
        const j = cols[p];
        if (j < i) { lCols[k] = j; lVals[k] = vals[p]; k++; } else if (j === i) diag = vals[p] * (1 + shift);
      }
      // L[i][j] = (A[i][j] − Σ L[i][m]·L[j][m]) / L[j][j], over the pattern of row i
      for (let q = start; q < k; q++) {
        const j = lCols[q];
        let sum = lVals[q];
        for (let r = lPtr[j]; r < lPtr[j + 1] - 1; r++) sum -= lVals[r] * dense[lCols[r]];
        const lij = sum / lVals[lPtr[j + 1] - 1];
        lVals[q] = lij;
        dense[j] = lij;
      }
      let d = diag;
      for (let q = start; q < k; q++) d -= lVals[q] * lVals[q];
      for (let q = start; q < k; q++) dense[lCols[q]] = 0;
      if (!(d > 0) || !Number.isFinite(d)) return false;
      lCols[k] = i; lVals[k] = Math.sqrt(d); k++;
    }
    lPtr[n] = k;
    this.lPtr = lPtr; this.lCols = lCols; this.lVals = lVals;
    return true;
  }

  private precondition(r: Float64Array, z: Float64Array): void {
    const { n, lPtr, lCols, lVals } = this;
    // L·y = r
    for (let i = 0; i < n; i++) {
      let s = r[i];
      const end = lPtr[i + 1] - 1;
      for (let p = lPtr[i]; p < end; p++) s -= lVals[p] * z[lCols[p]];
      z[i] = s / lVals[end];
    }
    // Lᵀ·z = y
    for (let i = n - 1; i >= 0; i--) {
      const end = lPtr[i + 1] - 1;
      z[i] /= lVals[end];
      const zi = z[i];
      for (let p = lPtr[i]; p < end; p++) z[lCols[p]] -= lVals[p] * zi;
    }
  }

  private mult(x: Float64Array, out: Float64Array): void {
    const { n, rowPtr, cols, vals } = this;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) s += vals[p] * x[cols[p]];
      out[i] = s;
    }
  }

  /** Solve K·x = b to a relative residual of `tol`. */
  solve(b: Float64Array, tol = 1e-9, maxIter = 5000): Float64Array {
    const n = this.n;
    const x = new Float64Array(n), r = Float64Array.from(b), z = new Float64Array(n), p = new Float64Array(n), Kp = new Float64Array(n);
    let bnorm = 0;
    for (let i = 0; i < n; i++) bnorm += b[i] * b[i];
    bnorm = Math.sqrt(bnorm);
    if (bnorm === 0) return x;
    this.precondition(r, z);
    p.set(z);
    let rz = 0;
    for (let i = 0; i < n; i++) rz += r[i] * z[i];
    for (let it = 0; it < maxIter; it++) {
      this.mult(p, Kp);
      let pKp = 0;
      for (let i = 0; i < n; i++) pKp += p[i] * Kp[i];
      const a = rz / pKp;
      let rr = 0;
      for (let i = 0; i < n; i++) { x[i] += a * p[i]; r[i] -= a * Kp[i]; rr += r[i] * r[i]; }
      this.iterations++;
      if (Math.sqrt(rr) <= tol * bnorm) break;
      this.precondition(r, z);
      let rzNew = 0;
      for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    return x;
  }
}

/** Most envelope entries a direct factorisation may use (≈ 100 MB); beyond it CG is used. */
export const DIRECT_LIMIT = 13_000_000;

/**
 * A symmetric positive definite matrix factorised directly: Reverse Cuthill–McKee
 * ordering, then an envelope (skyline) Cholesky. One factorisation, then each solve
 * is two triangular sweeps. Returns null when the envelope would be too large.
 */
export class EnvelopeCholesky {
  readonly n: number;
  private perm: Int32Array;
  private first: Int32Array;
  private start: Float64Array;
  private L: Float64Array;

  private constructor(n: number, perm: Int32Array, first: Int32Array, start: Float64Array, L: Float64Array) {
    this.n = n; this.perm = perm; this.first = first; this.start = start; this.L = L;
  }

  static create(K: SparseMatrix, limit = DIRECT_LIMIT): EnvelopeCholesky | null {
    const n = K.n;
    // Reverse Cuthill–McKee over the matrix graph
    const degree = K.rows.map(r => r.size);
    const visited = new Uint8Array(n);
    const order: number[] = [];
    while (order.length < n) {
      let startNode = -1;
      for (let i = 0; i < n; i++) if (!visited[i] && (startNode < 0 || degree[i] < degree[startNode])) startNode = i;
      const queue = [startNode];
      visited[startNode] = 1;
      for (let h = 0; h < queue.length; h++) {
        const v = queue[h];
        order.push(v);
        const next = [...K.rows[v].keys()].filter(u => !visited[u]).sort((a, b) => degree[a] - degree[b]);
        for (const u of next) { visited[u] = 1; queue.push(u); }
      }
    }
    order.reverse();
    const perm = Int32Array.from(order); // new index → old index
    const inv = new Int32Array(n);
    for (let i = 0; i < n; i++) inv[perm[i]] = i;
    // Envelope: the first column of each row
    const first = new Int32Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      let f = i;
      for (const j of K.rows[perm[i]].keys()) { const jj = inv[j]; if (jj < f) f = jj; }
      first[i] = f;
      total += i - f + 1;
      if (total > limit) return null;
    }
    const start = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + (i - first[i] + 1);
    const L = new Float64Array(total);
    for (let i = 0; i < n; i++) {
      for (const [j, v] of K.rows[perm[i]]) { const jj = inv[j]; if (jj <= i) L[start[i] + jj - first[i]] = v; }
    }
    // Cholesky row by row within the envelope
    for (let i = 0; i < n; i++) {
      const fi = first[i], si = start[i];
      for (let j = fi; j < i; j++) {
        const fj = first[j], sj = start[j];
        const k0 = fi > fj ? fi : fj;
        let sum = L[si + j - fi];
        for (let k = k0; k < j; k++) sum -= L[si + k - fi] * L[sj + k - fj];
        L[si + j - fi] = sum / L[sj + j - fj];
      }
      let d = L[si + i - fi];
      for (let k = fi; k < i; k++) { const v = L[si + k - fi]; d -= v * v; }
      if (!(d > 0)) throw new Error('The stiffness matrix is not positive definite (is the part held?)');
      L[si + i - fi] = Math.sqrt(d);
    }
    return new EnvelopeCholesky(n, perm, first, start, L);
  }

  solve(b: Float64Array): Float64Array {
    const { n, perm, first, start, L } = this;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = b[perm[i]];
    for (let i = 0; i < n; i++) {
      const fi = first[i], si = start[i];
      let s = y[i];
      for (let k = fi; k < i; k++) s -= L[si + k - fi] * y[k];
      y[i] = s / L[si + i - fi];
    }
    for (let i = n - 1; i >= 0; i--) {
      const fi = first[i], si = start[i];
      y[i] /= L[si + i - fi];
      const yi = y[i];
      for (let k = fi; k < i; k++) y[k] -= L[si + k - fi] * yi;
    }
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[perm[i]] = y[i];
    return x;
  }
}

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
    fixtures: fixturesFor({ fixedFace: study.fixedFace ?? 'zMin', loadFace: 'zMax', loadDirection: '-Y' }),
    modes: study.modes,
  });
  return { ...result, elements: info.elements };
}
