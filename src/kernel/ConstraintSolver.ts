// CasiWorks Pro - 2D Geometric Constraint Solver
// - Levenberg-Marquardt with Householder QR (column pivoting)
// - Numerical Jacobian via central finite differences
// - Degrees of Freedom analysis (nVars - rank(J))
// - Status: under-constrained, fully constrained, over-constrained
// - Diagnostics: redundant vs conflicting constraints
// - Constraints: coincident, horizontal, vertical, parallel, perpendicular, equal,
//   fix, midpoint, concentric, colinear, tangent, dimension, angle, symmetric
//
// Entity references: a constraint names entities by id and, optionally, a point
// on them (point1/point2: 'p1' | 'p2' | 'center' | 0 | 1). For COINCIDENT and
// DIMENSION, naming a line, circle or arc WITHOUT a point means the curve itself
// (point on line, point on circle, point-to-line distance).

import { distance2D } from '../utils/math.ts';
import { CONSTRAINT_TYPES } from '../utils/constants.ts';
import type { ConstraintType } from '../utils/constants.ts';
import type { Point2 } from '../types/cad.ts';

// =====================================================================
// Types
// =====================================================================

/** A point on an entity: endpoint, center, or 0/1 for p1/p2. */
export type PointRef = 0 | 1 | 'p1' | 'p2' | 'start' | 'end' | 'center';

/** Any sketch entity, viewed structurally (lines, circles, arcs, points, …). */
export interface SolverEntity {
  id: string;
  type?: string;
  p1?: Point2;
  p2?: Point2;
  center?: Point2;
  radius?: number;
  x?: number;
  y?: number;
}

export interface SketchConstraint {
  /** Assigned automatically when missing. */
  id?: string;
  type: ConstraintType;
  entity1Id?: string;
  /** Alias of entity1Id. */
  entityId?: string;
  entity2Id?: string;
  /** Symmetry axis (also axisId / axisEntityId). */
  entity3Id?: string;
  axisId?: string;
  axisEntityId?: string;
  point1?: PointRef;
  point2?: PointRef;
  /** Aliases of point1 / point2. */
  pointIndex1?: PointRef;
  pointIndex2?: PointRef;
  /** Dimension value (mm) or angle (degrees). */
  value?: number;
  targetValue?: number;
  /** Degrees. */
  angle?: number;
  /** Fixed location overrides (default: the position when solving started). */
  x?: number;
  y?: number;
  targetX?: number;
  targetY?: number;
  p1x?: number;
  p1y?: number;
  p2x?: number;
  p2y?: number;
}

export type ConstraintStatus = 'fully_constrained' | 'under_constrained' | 'over_constrained';

export interface ConstraintDiagnostic {
  type: 'conflict' | 'redundant';
  constraintIds: string[];
  message: string;
}

export interface SolveResult {
  converged: boolean;
  /** Max absolute residual. */
  error: number;
  iterations: number;
  /** Remaining degrees of freedom. */
  dof: number;
  rank: number;
  nVars?: number;
  nConstraints?: number;
  status: ConstraintStatus;
  diagnostics: ConstraintDiagnostic[];
  conflict: ConstraintDiagnostic | null;
  redundant: ConstraintDiagnostic | null;
}

type Matrix = ArrayLike<number>[];
type MutableNumbers = Record<string, number>;

interface SolverVar {
  obj: MutableNumbers;
  key: string;
  id: string;
}

interface ResidualEvaluation {
  residuals: number[];
  constraintRowMap: Map<string, number[]>;
}

type ConstraintMeta = Map<string, { side: number }>;

// =====================================================================
// Householder QR decomposition with column pivoting: A·P = Q·R
// =====================================================================

export class QRDecomposition {
  m: number;
  n: number;
  QR: Float64Array[];
  p: Int32Array;
  beta: Float64Array;
  rank: number;
  tolerance: number;

  constructor(A: Matrix | null | undefined, enablePivoting = true) {
    if (!A || A.length === 0 || !A[0] || A[0].length === 0) {
      this.m = 0;
      this.n = 0;
      this.QR = [];
      this.p = new Int32Array(0);
      this.beta = new Float64Array(0);
      this.rank = 0;
      this.tolerance = 0;
      return;
    }

    const m = A.length;
    const n = A[0].length;
    this.m = m;
    this.n = n;

    // Working copy of A with sanitized finite numbers
    const QR = Array.from({ length: m }, (_, i) => {
      const row = new Float64Array(n);
      const src = A[i];
      if (src) {
        for (let j = 0; j < n; j++) {
          const val = src[j];
          row[j] = Number.isFinite(val) ? val : 0;
        }
      }
      return row;
    });

    const p = new Int32Array(n);
    for (let j = 0; j < n; j++) p[j] = j;

    const colNormsSq = new Float64Array(n);
    const origColNormsSq = new Float64Array(n);
    if (enablePivoting) {
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < m; i++) sum += QR[i][j] * QR[i][j];
        colNormsSq[j] = sum;
        origColNormsSq[j] = sum;
      }
    }

    const minDim = Math.min(m, n);
    const beta = new Float64Array(minDim);

    for (let k = 0; k < minDim; k++) {
      // 1. Column pivoting: select column with maximum remaining norm
      if (enablePivoting) {
        let maxCol = k;
        let maxNormSq = colNormsSq[k];
        for (let j = k + 1; j < n; j++) {
          if (colNormsSq[j] > maxNormSq) {
            maxNormSq = colNormsSq[j];
            maxCol = j;
          }
        }

        if (maxCol !== k) {
          for (let i = 0; i < m; i++) {
            const tmp = QR[i][k];
            QR[i][k] = QR[i][maxCol];
            QR[i][maxCol] = tmp;
          }
          [p[k], p[maxCol]] = [p[maxCol], p[k]];
          [colNormsSq[k], colNormsSq[maxCol]] = [colNormsSq[maxCol], colNormsSq[k]];
          [origColNormsSq[k], origColNormsSq[maxCol]] = [origColNormsSq[maxCol], origColNormsSq[k]];
        }
      }

      // 2. Householder reflector for column k below the diagonal
      let normSq = 0;
      for (let i = k; i < m; i++) normSq += QR[i][k] * QR[i][k];
      const norm = Math.sqrt(normSq);

      if (norm < 1e-15 || !Number.isFinite(norm)) {
        beta[k] = 0;
        continue;
      }

      const alpha = QR[k][k];
      const sigma = alpha >= 0 ? -norm : norm;
      const v0 = alpha - sigma;

      if (Math.abs(v0) < 1e-15 || !Number.isFinite(v0)) {
        beta[k] = 0;
        continue;
      }

      // Householder vector stored below the diagonal, scaled so v[k] = 1; beta = 2 / vᵀv
      QR[k][k] = sigma;
      for (let i = k + 1; i < m; i++) QR[i][k] /= v0;
      beta[k] = -v0 / sigma;

      // 3. Apply the reflection to the remaining columns
      for (let j = k + 1; j < n; j++) {
        let dot = QR[k][j];
        for (let i = k + 1; i < m; i++) dot += QR[i][k] * QR[i][j];
        dot *= beta[k];

        QR[k][j] -= dot;
        for (let i = k + 1; i < m; i++) QR[i][j] -= dot * QR[i][k];

        if (enablePivoting) {
          // Downdate column norm; recompute when cancellation makes it unreliable
          colNormsSq[j] = Math.max(0, colNormsSq[j] - QR[k][j] * QR[k][j]);
          if (colNormsSq[j] < 1e-12 || colNormsSq[j] < 1e-4 * origColNormsSq[j]) {
            let sum = 0;
            for (let i = k + 1; i < m; i++) sum += QR[i][j] * QR[i][j];
            colNormsSq[j] = sum;
          }
        }
      }
    }

    this.QR = QR;
    this.p = p;
    this.beta = beta;

    // Numerical rank with a tolerance scaled to the problem
    const maxDiag = Math.abs(QR[0]?.[0] ?? 0) || 0;
    const tol = Math.max(
      Math.max(m, n) * Number.EPSILON * 100 * (maxDiag || 1.0),
      1e-10 * (maxDiag || 1.0),
      1e-12,
    );
    this.tolerance = tol;

    let rank = 0;
    if (maxDiag > 1e-14) {
      for (let i = 0; i < minDim; i++) {
        if (Math.abs(QR[i][i]) > tol) rank++;
      }
    }
    this.rank = rank;
  }

  /** Least-squares solution of min ‖A·x − b‖. */
  solve(b: ArrayLike<number> | null | undefined): Float64Array {
    const { m, n, QR, beta, p, tolerance } = this;
    if (n === 0) return new Float64Array(0);
    if (!b || typeof b.length !== 'number' || b.length === 0) return new Float64Array(n);

    const minDim = Math.min(m, n);

    // d = Qᵀ·b
    const d = new Float64Array(m);
    for (let i = 0; i < Math.min(b.length, m); i++) {
      const val = b[i];
      d[i] = Number.isFinite(val) ? val : 0;
    }

    for (let k = 0; k < minDim; k++) {
      if (beta[k] === 0 || !Number.isFinite(beta[k])) continue;
      let dot = d[k];
      for (let i = k + 1; i < m; i++) dot += QR[i][k] * d[i];
      dot *= beta[k];
      d[k] -= dot;
      for (let i = k + 1; i < m; i++) d[i] -= dot * QR[i][k];
    }

    // Back-substitution R·y = d
    const y = new Float64Array(n);
    const tol = tolerance || (Math.max(m, n) * 1e-12 * (Math.abs(QR[0]?.[0] ?? 0) || 1.0));

    for (let i = minDim - 1; i >= 0; i--) {
      if (Math.abs(QR[i][i]) <= tol || !Number.isFinite(QR[i][i])) {
        y[i] = 0;
        continue;
      }
      let sum = d[i];
      for (let j = i + 1; j < n; j++) sum -= QR[i][j] * y[j];
      const sol = sum / QR[i][i];
      y[i] = Number.isFinite(sol) ? sol : 0;
    }

    // x = P·y
    const x = new Float64Array(n);
    for (let j = 0; j < n; j++) x[p[j]] = y[j];
    return x;
  }
}

// =====================================================================
// Entity helpers
// =====================================================================

const isLine = (e: SolverEntity | null | undefined): e is SolverEntity & { p1: Point2; p2: Point2 } =>
  !!e && !!e.p1 && !!e.p2;

const isRound = (e: SolverEntity | null | undefined): e is SolverEntity & { center: Point2; radius: number } =>
  !!e && !!e.center && e.radius !== undefined;

/** Standalone sketch point: the entity itself is the point. */
const isPointEntity = (e: SolverEntity | null | undefined): e is SolverEntity & { x: number; y: number } =>
  !!e && e.x !== undefined && e.y !== undefined && !e.p1 && !e.p2;

/** Signed distance from `p` to the infinite line through `line`. */
function signedLineDistance(p: Point2, line: { p1: Point2; p2: Point2 }): number {
  const dx = line.p2.x - line.p1.x;
  const dy = line.p2.y - line.p1.y;
  const len = Math.hypot(dx, dy);
  const safeLen = len < 1e-6 ? Math.sqrt(dx * dx + dy * dy + 1e-6) : len;
  return ((p.x - line.p1.x) * dy - (p.y - line.p1.y) * dx) / safeLen;
}

/** Normalized cross product of two directions, regularized for degenerate segments. */
function normalizedCross(dx1: number, dy1: number, dx2: number, dy2: number): number {
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);
  if (len1 < 1e-6 || len2 < 1e-6) {
    const eps = 1e-3;
    return (dx1 * dy2 - dy1 * dx2) / Math.sqrt((dx1 * dx1 + dy1 * dy1 + eps * eps) * (dx2 * dx2 + dy2 * dy2 + eps * eps));
  }
  return (dx1 * dy2 - dy1 * dx2) / (len1 * len2);
}

/** Normalized dot product of two directions, regularized for degenerate segments. */
function normalizedDot(dx1: number, dy1: number, dx2: number, dy2: number): number {
  const len1 = Math.hypot(dx1, dy1);
  const len2 = Math.hypot(dx2, dy2);
  if (len1 < 1e-6 || len2 < 1e-6) {
    const eps = 1e-3;
    return (dx1 * dx2 + dy1 * dy2) / Math.sqrt((dx1 * dx1 + dy1 * dy1 + eps * eps) * (dx2 * dx2 + dy2 * dy2 + eps * eps));
  }
  return (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
}

// =====================================================================
// Solver
// =====================================================================

const emptyResult = (dof: number, status: ConstraintStatus): SolveResult => ({
  converged: true,
  error: 0,
  iterations: 0,
  dof,
  rank: 0,
  status,
  diagnostics: [],
  conflict: null,
  redundant: null,
});

export class ConstraintSolver {
  maxIterations: number;
  tolerance: number;

  constructor(maxIterations = 60, tolerance = 1e-5) {
    this.maxIterations = maxIterations;
    this.tolerance = tolerance;
  }

  /**
   * Solve all constraints simultaneously. Entities are updated in place.
   * Constraints without an id are given one.
   */
  solve(entities: SolverEntity[] | null | undefined, constraints: SketchConstraint[] | null | undefined): SolveResult {
    if (!constraints || constraints.length === 0 || !entities || entities.length === 0) {
      return emptyResult(entities ? entities.length * 2 : 0, 'under_constrained');
    }

    // 1. Variable registry
    const entityMap = new Map<string, SolverEntity>();
    entities.forEach(e => entityMap.set(e.id, e));

    const varMap: SolverVar[] = [];
    const varIndexMap = new Map<string, number>();

    const registerVar = (obj: object, key: string, id: string) => {
      if (!varIndexMap.has(id)) {
        varIndexMap.set(id, varMap.length);
        varMap.push({ obj: obj as MutableNumbers, key, id });
      }
    };

    for (const ent of entities) {
      if (ent.p1) {
        registerVar(ent.p1, 'x', `${ent.id}_p1_x`);
        registerVar(ent.p1, 'y', `${ent.id}_p1_y`);
      }
      if (ent.p2) {
        registerVar(ent.p2, 'x', `${ent.id}_p2_x`);
        registerVar(ent.p2, 'y', `${ent.id}_p2_y`);
      }
      if (ent.center) {
        registerVar(ent.center, 'x', `${ent.id}_center_x`);
        registerVar(ent.center, 'y', `${ent.id}_center_y`);
      }
      if (ent.radius !== undefined) registerVar(ent, 'radius', `${ent.id}_radius`);
      if (isPointEntity(ent)) {
        registerVar(ent, 'x', `${ent.id}_x`);
        registerVar(ent, 'y', `${ent.id}_y`);
      }
    }

    const nVars = varMap.length;
    if (nVars === 0) return emptyResult(0, 'fully_constrained');

    const X0 = new Float64Array(nVars);
    const X = new Float64Array(nVars);
    for (let i = 0; i < nVars; i++) {
      const val = varMap[i].obj[varMap[i].key];
      X[i] = Number.isFinite(val) ? val : 0;
      X0[i] = X[i];
    }

    const setVars = (vec: ArrayLike<number>) => {
      for (let i = 0; i < nVars; i++) {
        if (Number.isFinite(vec[i])) varMap[i].obj[varMap[i].key] = vec[i];
      }
    };

    // Record initial orientations so the solution stays on the same branch
    const constraintMeta = this._prepareConstraintMeta(constraints, entityMap);
    const evaluateResiduals = () => this._evaluateResidualVector(constraints, entityMap, X0, varIndexMap, constraintMeta);

    let { residuals: r, constraintRowMap } = evaluateResiduals();
    if (r.length === 0) return emptyResult(nVars, 'under_constrained');

    let currentError = this._normInf(r);

    const numericJacobian = (rows: number): Float64Array[] => {
      const J = Array.from({ length: rows }, () => new Float64Array(nVars));
      const h = 1e-7;
      for (let j = 0; j < nVars; j++) {
        const orig = X[j];
        X[j] = orig + h;
        setVars(X);
        const rPlus = evaluateResiduals().residuals;
        X[j] = orig - h;
        setVars(X);
        const rMinus = evaluateResiduals().residuals;
        for (let i = 0; i < rows; i++) {
          const diff = (rPlus[i] - rMinus[i]) / (2 * h);
          J[i][j] = Number.isFinite(diff) ? diff : 0;
        }
        X[j] = orig;
      }
      setVars(X);
      return J;
    };

    // 2. Levenberg-Marquardt iterations
    let lambda = 1e-3;
    const minLambda = 1e-12;
    const maxLambda = 1e10;
    const mu = 1e-9; // Tikhonov regularization towards the initial geometry
    let iter = 0;

    for (iter = 0; iter < this.maxIterations; iter++) {
      if (currentError < this.tolerance) break;

      const mConstraints = r.length;
      const J = numericJacobian(mConstraints);

      // Augmented least-squares system:
      // [ J            ]          [ -r                  ]
      // [ sqrt(λ)·I    ] · δ  ≈   [ 0                   ]
      // [ sqrt(μ)·I    ]          [ -sqrt(μ)·(X − X0)   ]
      const totalRows = mConstraints + 2 * nVars;
      const A_aug = Array.from({ length: totalRows }, () => new Float64Array(nVars));
      const b_aug = new Float64Array(totalRows);

      for (let i = 0; i < mConstraints; i++) {
        A_aug[i].set(J[i]);
        b_aug[i] = -r[i];
      }
      const sqrtLambda = Math.sqrt(Math.max(minLambda, lambda));
      const sqrtMu = Math.sqrt(Math.max(1e-15, mu));
      for (let j = 0; j < nVars; j++) {
        A_aug[mConstraints + j][j] = sqrtLambda;
        A_aug[mConstraints + nVars + j][j] = sqrtMu;
        b_aug[mConstraints + nVars + j] = -sqrtMu * (X[j] - X0[j]);
      }

      const delta = new QRDecomposition(A_aug, true).solve(b_aug);

      let deltaNormSq = 0;
      let isDeltaValid = true;
      for (let i = 0; i < nVars; i++) {
        if (!Number.isFinite(delta[i])) {
          isDeltaValid = false;
          break;
        }
        deltaNormSq += delta[i] * delta[i];
      }
      if (!isDeltaValid) {
        lambda = Math.min(maxLambda, lambda * 10.0);
        continue;
      }

      // Trust-region step limit
      const deltaNorm = Math.sqrt(deltaNormSq);
      const maxStep = 200.0;
      if (deltaNorm > maxStep) {
        const scale = maxStep / deltaNorm;
        for (let i = 0; i < nVars; i++) delta[i] *= scale;
      }

      const X_trial = new Float64Array(nVars);
      for (let i = 0; i < nVars; i++) X_trial[i] = X[i] + delta[i];
      setVars(X_trial);

      const trialEval = evaluateResiduals();
      const trialError = this._normInf(trialEval.residuals);

      if (Number.isFinite(trialError) && trialError < currentError) {
        X.set(X_trial);
        r = trialEval.residuals;
        constraintRowMap = trialEval.constraintRowMap;
        currentError = trialError;
        lambda = Math.max(minLambda, lambda * 0.4);
      } else {
        setVars(X);
        lambda = Math.min(maxLambda, lambda * 5.0);
        if (deltaNorm < 1e-14) break; // no further progress possible
      }
    }

    setVars(X);

    // 3. Rank and degrees of freedom
    const finalJ = numericJacobian(r.length);
    const rank = new QRDecomposition(finalJ, true).rank;
    const dof = Math.max(0, nVars - rank);

    // 4. Over-constrained and conflict diagnostics
    const converged = currentError < this.tolerance * 10;
    const diagnostics = this._diagnoseConstraints(constraints, constraintRowMap, r, finalJ, converged, this.tolerance);
    const conflictDiag = diagnostics.find(d => d.type === 'conflict') || null;
    const redundantDiag = diagnostics.find(d => d.type === 'redundant') || null;

    let status: ConstraintStatus;
    if (!converged || conflictDiag || redundantDiag) status = 'over_constrained';
    else if (dof === 0) status = 'fully_constrained';
    else status = 'under_constrained';

    return {
      converged,
      error: currentError,
      iterations: iter,
      dof,
      rank,
      nVars,
      nConstraints: constraints.length,
      status,
      diagnostics,
      conflict: conflictDiag,
      redundant: redundantDiag,
    };
  }

  /** Assign missing ids and record branch information (e.g. which side of a line a tangent circle is on). */
  _prepareConstraintMeta(constraints: SketchConstraint[], entityMap: Map<string, SolverEntity>): ConstraintMeta {
    const meta: ConstraintMeta = new Map();
    for (const c of constraints) {
      if (!c.id) c.id = `c_${Math.random().toString(36).substring(2, 9)}`;
      const e1 = entityMap.get(c.entity1Id ?? c.entityId ?? '');
      const e2 = c.entity2Id ? entityMap.get(c.entity2Id) : undefined;

      if (c.type === CONSTRAINT_TYPES.TANGENT && e1 && e2) {
        const line = isLine(e1) && e2.center ? e1 : (isLine(e2) && e1.center ? e2 : null);
        const circle = line === e1 ? e2 : e1;
        if (line && circle.center) {
          meta.set(c.id, { side: signedLineDistance(circle.center, line) >= 0 ? 1 : -1 });
        }
      }
    }
    return meta;
  }

  /** Evaluate all residuals and map each constraint id to its residual rows. */
  _evaluateResidualVector(
    constraints: SketchConstraint[],
    entityMap: Map<string, SolverEntity>,
    X0: Float64Array,
    varIndexMap: Map<string, number>,
    constraintMeta: ConstraintMeta,
  ): ResidualEvaluation {
    const residuals: number[] = [];
    const constraintRowMap = new Map<string, number[]>();
    const initial = (key: string): number | undefined => {
      const idx = varIndexMap.get(key);
      return idx !== undefined ? X0[idx] : undefined;
    };

    for (const c of constraints) {
      const startRow = residuals.length;
      const e1 = entityMap.get(c.entity1Id ?? c.entityId ?? '');
      const e2 = c.entity2Id ? entityMap.get(c.entity2Id) : undefined;
      const e3 = c.entity3Id ? entityMap.get(c.entity3Id) : undefined;
      const ref1 = c.pointIndex1 ?? c.point1;
      const ref2 = c.pointIndex2 ?? c.point2;

      switch (c.type) {
        case CONSTRAINT_TYPES.COINCIDENT: {
          if (!e1 || !e2) break;
          const p1 = this._explicitPoint(e1, ref1);
          const p2 = this._explicitPoint(e2, ref2);
          if (p1 && p2) {
            residuals.push(p1.x - p2.x, p1.y - p2.y);
          } else if (p1 || p2) {
            // Point on a curve: the side named without a point is the curve itself
            const point = (p1 ?? p2)!;
            const curve = p1 ? e2 : e1;
            if (isLine(curve)) residuals.push(signedLineDistance(point, curve));
            else if (isRound(curve)) residuals.push(Math.hypot(point.x - curve.center.x, point.y - curve.center.y) - curve.radius);
          }
          break;
        }

        case CONSTRAINT_TYPES.HORIZONTAL:
        case CONSTRAINT_TYPES.VERTICAL: {
          const axis = c.type === CONSTRAINT_TYPES.HORIZONTAL ? 'y' : 'x';
          if (isLine(e1)) {
            residuals.push(e1.p2[axis] - e1.p1[axis]);
          } else if (e1 && e2) {
            const p1 = this._getPoint(e1, c.point1 ?? 0);
            const p2 = this._getPoint(e2, c.point2 ?? 0);
            if (p1 && p2) residuals.push(p2[axis] - p1[axis]);
          }
          break;
        }

        case CONSTRAINT_TYPES.PARALLEL: {
          if (isLine(e1) && isLine(e2)) {
            residuals.push(normalizedCross(e1.p2.x - e1.p1.x, e1.p2.y - e1.p1.y, e2.p2.x - e2.p1.x, e2.p2.y - e2.p1.y));
          }
          break;
        }

        case CONSTRAINT_TYPES.PERPENDICULAR: {
          if (isLine(e1) && isLine(e2)) {
            residuals.push(normalizedDot(e1.p2.x - e1.p1.x, e1.p2.y - e1.p1.y, e2.p2.x - e2.p1.x, e2.p2.y - e2.p1.y));
          }
          break;
        }

        case CONSTRAINT_TYPES.EQUAL: {
          if (isLine(e1) && isLine(e2)) {
            residuals.push(distance2D(e1.p1, e1.p2) - distance2D(e2.p1, e2.p2));
          } else if (e1?.radius !== undefined && e2?.radius !== undefined) {
            residuals.push(e1.radius - e2.radius);
          }
          break;
        }

        case CONSTRAINT_TYPES.CONCENTRIC: {
          if (e1?.center && e2?.center) {
            residuals.push(e1.center.x - e2.center.x, e1.center.y - e2.center.y);
          }
          break;
        }

        case CONSTRAINT_TYPES.MIDPOINT: {
          if (e1 && isLine(e2)) {
            const pMid = this._getPoint(e1, ref1 ?? 0);
            if (pMid) {
              residuals.push(pMid.x - (e2.p1.x + e2.p2.x) * 0.5, pMid.y - (e2.p1.y + e2.p2.y) * 0.5);
            }
          }
          break;
        }

        case CONSTRAINT_TYPES.COLINEAR: {
          if (isLine(e1) && isLine(e2)) {
            const dx1 = e1.p2.x - e1.p1.x;
            const dy1 = e1.p2.y - e1.p1.y;
            // 1. Parallel directions; 2. e2.p1 lies on line e1
            residuals.push(normalizedCross(dx1, dy1, e2.p2.x - e2.p1.x, e2.p2.y - e2.p1.y));
            const len1 = Math.hypot(dx1, dy1);
            const safeLen1 = len1 < 1e-6 ? Math.sqrt(dx1 * dx1 + dy1 * dy1 + 1e-6) : len1;
            residuals.push(((e2.p1.x - e1.p1.x) * dy1 - (e2.p1.y - e1.p1.y) * dx1) / safeLen1);
          }
          break;
        }

        case CONSTRAINT_TYPES.TANGENT: {
          if (!e1 || !e2) break;
          const line = isLine(e1) && e2.center ? e1 : (isLine(e2) && e1.center ? e2 : null);
          if (line) {
            const circle = line === e1 ? e2 : e1;
            const side = constraintMeta.get(c.id!)?.side ?? 1;
            residuals.push(signedLineDistance(circle.center!, line) - side * (circle.radius ?? 10));
          } else if (e1.center && e2.center) {
            // Two circles tangent externally
            const dist = Math.hypot(e1.center.x - e2.center.x, e1.center.y - e2.center.y);
            residuals.push(dist - ((e1.radius ?? 10) + (e2.radius ?? 10)));
          }
          break;
        }

        case CONSTRAINT_TYPES.SYMMETRIC: {
          // e1 and e2 symmetric about the axis line e3 (or axisId / axisEntityId)
          const axisLine = e3 ?? entityMap.get(c.axisId ?? c.axisEntityId ?? '');
          const p1 = this._getPoint(e1, c.point1 ?? 0);
          const p2 = this._getPoint(e2, c.point2 ?? 0);
          if (p1 && p2 && isLine(axisLine)) {
            // 1. Midpoint lies on the axis; 2. p1→p2 is perpendicular to the axis
            residuals.push(signedLineDistance({ x: 0.5 * (p1.x + p2.x), y: 0.5 * (p1.y + p2.y) }, axisLine));
            const adx = axisLine.p2.x - axisLine.p1.x;
            const ady = axisLine.p2.y - axisLine.p1.y;
            const alen = Math.hypot(adx, ady);
            const safeAlen = alen < 1e-6 ? Math.sqrt(adx * adx + ady * ady + 1e-6) : alen;
            residuals.push(((p2.x - p1.x) * adx + (p2.y - p1.y) * ady) / safeAlen);
          }
          break;
        }

        case CONSTRAINT_TYPES.FIX: {
          if (!e1) break;
          if (ref1 === undefined && c.point2 === undefined && c.pointIndex2 === undefined && isLine(e1)) {
            // Fix the whole line at its starting position (or the given coordinates)
            residuals.push(
              e1.p1.x - (c.p1x ?? initial(`${e1.id}_p1_x`) ?? e1.p1.x),
              e1.p1.y - (c.p1y ?? initial(`${e1.id}_p1_y`) ?? e1.p1.y),
              e1.p2.x - (c.p2x ?? initial(`${e1.id}_p2_x`) ?? e1.p2.x),
              e1.p2.y - (c.p2y ?? initial(`${e1.id}_p2_y`) ?? e1.p2.y),
            );
          } else if (ref1 === undefined && e1.center) {
            residuals.push(
              e1.center.x - (c.x ?? initial(`${e1.id}_center_x`) ?? e1.center.x),
              e1.center.y - (c.y ?? initial(`${e1.id}_center_y`) ?? e1.center.y),
            );
          } else {
            const p = this._getPoint(e1, ref1);
            if (p) {
              const ptName = (ref1 === 1 || ref1 === 'p2' || ref1 === 'end') ? 'p2' : (ref1 === 'center' ? 'center' : 'p1');
              const x0 = initial(`${e1.id}_${ptName}_x`) ?? initial(`${e1.id}_x`);
              const y0 = initial(`${e1.id}_${ptName}_y`) ?? initial(`${e1.id}_y`);
              residuals.push(p.x - (c.x ?? c.targetX ?? x0 ?? p.x), p.y - (c.y ?? c.targetY ?? y0 ?? p.y));
            }
          }
          break;
        }

        case CONSTRAINT_TYPES.DIMENSION: {
          const target = c.value ?? c.targetValue ?? 10;
          if (e1 && e2) {
            const p1 = this._explicitPoint(e1, ref1);
            const p2 = this._explicitPoint(e2, ref2);
            if (p1 && p2) {
              residuals.push(distance2D(p1, p2) - target);
            } else if ((p1 && isLine(e2)) || (p2 && isLine(e1))) {
              // Point-to-line distance (the side named without a point is the line)
              const point = (p1 ?? p2)!;
              const line = (p1 ? e2 : e1) as SolverEntity & { p1: Point2; p2: Point2 };
              residuals.push(Math.abs(signedLineDistance(point, line)) - target);
            } else if (!p1 && !p2 && isLine(e1) && isLine(e2)) {
              // Distance between (parallel) lines, measured from e1's start point
              residuals.push(Math.abs(signedLineDistance(e1.p1, e2)) - target);
            }
          } else if (isLine(e1)) {
            residuals.push(distance2D(e1.p1, e1.p2) - target);
          } else if (e1?.radius !== undefined) {
            residuals.push(e1.radius - target);
          }
          break;
        }

        case CONSTRAINT_TYPES.ANGLE: {
          if (isLine(e1) && isLine(e2)) {
            const dx1 = e1.p2.x - e1.p1.x;
            const dy1 = e1.p2.y - e1.p1.y;
            const dx2 = e2.p2.x - e2.p1.x;
            const dy2 = e2.p2.y - e2.p1.y;
            const len1 = Math.hypot(dx1, dy1);
            const len2 = Math.hypot(dx2, dy2);
            const targetRad = ((c.angle ?? c.value ?? 90) * Math.PI) / 180;

            if (len1 < 1e-6 || len2 < 1e-6) {
              // Smooth residual for degenerate segments (avoids a singular Jacobian)
              const eps = 1e-3;
              const denom = Math.sqrt((dx1 * dx1 + dy1 * dy1 + eps * eps) * (dx2 * dx2 + dy2 * dy2 + eps * eps));
              const cross = dx1 * dy2 - dy1 * dx2;
              const dot = dx1 * dx2 + dy1 * dy2;
              residuals.push((cross * Math.cos(targetRad) - dot * Math.sin(targetRad)) / denom);
            } else {
              const cosA = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2) / (len1 * len2)));
              const sinA = Math.max(-1, Math.min(1, (dx1 * dy2 - dy1 * dx2) / (len1 * len2)));
              let diff = Math.atan2(sinA, cosA) - targetRad;
              while (diff > Math.PI) diff -= 2 * Math.PI;
              while (diff < -Math.PI) diff += 2 * Math.PI;
              residuals.push(diff);
            }
          }
          break;
        }

        default:
          break;
      }

      const rows: number[] = [];
      for (let rIdx = startRow; rIdx < residuals.length; rIdx++) rows.push(rIdx);
      constraintRowMap.set(c.id!, rows);
    }

    return { residuals, constraintRowMap };
  }

  /** Classify constraints as conflicting (unsatisfiable) or redundant (linearly dependent). */
  _diagnoseConstraints(
    constraints: SketchConstraint[],
    constraintRowMap: Map<string, number[]>,
    residuals: number[],
    J: Float64Array[],
    converged: boolean,
    tol: number,
  ): ConstraintDiagnostic[] {
    const diagnostics: ConstraintDiagnostic[] = [];
    const maxResidual = (rows: number[]) => rows.reduce((max, row) => Math.max(max, Math.abs(residuals[row] || 0)), 0);

    // 1. Conflicts: constraints with a persistent high residual
    if (!converged) {
      const conflictingIds = constraints
        .filter(c => maxResidual(constraintRowMap.get(c.id!) || []) > tol * 5)
        .map(c => c.id!);
      if (conflictingIds.length > 0) {
        diagnostics.push({
          type: 'conflict',
          constraintIds: conflictingIds,
          message: `Inconsistent/conflicting constraints detected: ${conflictingIds.join(', ')}`,
        });
      }
    }

    // 2. Redundancy: gradient rows linearly dependent on earlier constraints (Gram-Schmidt)
    const basis: Float64Array[] = [];
    for (const c of constraints) {
      const rows = constraintRowMap.get(c.id!) || [];
      if (rows.length === 0) continue;

      let isRedundant = true;
      let hasActiveRow = false;

      for (const row of rows) {
        const grad = J[row];
        let gradNormSq = 0;
        for (let k = 0; k < grad.length; k++) gradNormSq += grad[k] * grad[k];
        const gradNorm = Math.sqrt(gradNormSq);
        if (gradNorm < 1e-8) continue;
        hasActiveRow = true;

        const proj = new Float64Array(grad);
        for (const b of basis) {
          let dot = 0;
          for (let k = 0; k < grad.length; k++) dot += grad[k] * b[k];
          for (let k = 0; k < grad.length; k++) proj[k] -= dot * b[k];
        }

        let projNormSq = 0;
        for (let k = 0; k < proj.length; k++) projNormSq += proj[k] * proj[k];
        const projNorm = Math.sqrt(projNormSq);

        if (projNorm > 1e-4 * gradNorm) {
          isRedundant = false;
          basis.push(proj.map(v => v / projNorm));
        }
      }

      if (isRedundant && hasActiveRow && maxResidual(rows) <= tol * 10) {
        diagnostics.push({
          type: 'redundant',
          constraintIds: [c.id!],
          message: `Redundant constraint detected: ${c.id} (${c.type})`,
        });
      }
    }

    return diagnostics;
  }

  /**
   * The point a constraint refers to when it names one explicitly; a standalone
   * point entity is its own point. Returns null when the entity is meant as a
   * curve (a line, circle or arc named without a point).
   */
  _explicitPoint(entity: SolverEntity, ref: PointRef | undefined): Point2 | null {
    if (isPointEntity(entity)) return entity;
    if (ref === undefined) return null;
    return this._getPoint(entity, ref);
  }

  /** Resolve a point on an entity, falling back to its center or first point. */
  _getPoint(entity: SolverEntity | null | undefined, index: PointRef | undefined): Point2 | null {
    if (!entity) return null;
    if (isPointEntity(entity)) return entity;
    if ((index === 0 || index === 'p1' || index === 'start') && entity.p1) return entity.p1;
    if ((index === 1 || index === 'p2' || index === 'end') && entity.p2) return entity.p2;
    if (index === 'center' && entity.center) return entity.center;
    if (entity.center) return entity.center;
    return entity.p1 || null;
  }

  _normInf(v: ArrayLike<number>): number {
    let max = 0;
    for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
    return max;
  }
}

export const constraintSolver = new ConstraintSolver();
export default ConstraintSolver;
