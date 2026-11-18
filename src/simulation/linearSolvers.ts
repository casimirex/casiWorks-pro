// CasiWorks Pro - Linear solvers for stiffness matrices: direct (envelope Cholesky) and IC(0)-preconditioned CG
//
// Shared by the static solve (FEAEngine) and modal analysis. The direct solver
// is exact whatever the matrix's conditioning (thin walls, slender parts and
// graded meshes make CG slow), so it is used whenever its envelope fits in
// memory; CG with an incomplete Cholesky preconditioner otherwise.
import type { SparseMatrix } from './FEAEngine.ts';

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
  /** Relative residual ‖r‖ / ‖b‖ after the last solve. */
  residual = 0;

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

  /** Solve K·x = b to a relative residual of `tol`, starting from `x0` (default zero). */
  solve(b: Float64Array, tol = 1e-9, maxIter = 5000, x0?: Float64Array): Float64Array {
    const n = this.n;
    const x = x0 ? Float64Array.from(x0) : new Float64Array(n), r = Float64Array.from(b), z = new Float64Array(n), p = new Float64Array(n), Kp = new Float64Array(n);
    if (x0) { this.mult(x, Kp); for (let i = 0; i < n; i++) r[i] -= Kp[i]; }
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
      this.residual = Math.sqrt(rr) / bnorm;
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

