// CasiWorks Pro - Constraint solver: coupled systems, degrees of freedom, conflicts, QR numerics, degenerate geometry
import test from 'node:test';
import assert from 'node:assert/strict';
import { constraintSolver, ConstraintSolver, QRDecomposition } from '../src/kernel/ConstraintSolver.ts';
import { SKETCH_ENTITY_TYPES, CONSTRAINT_TYPES } from '../src/utils/constants.ts';
import type { SketchConstraint } from '../src/kernel/ConstraintSolver.ts';

test('ConstraintSolver: coupled geometric system (horizontal, perpendicular, coincident, dimensions)', () => {
  const entities = [
    { id: 'l1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 0, y: 0 }, p2: { x: 45, y: 12 } },
    { id: 'l2', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 48, y: 10 }, p2: { x: 50, y: 45 } },
  ];

  const constraints: SketchConstraint[] = [
    { id: 'c1', type: CONSTRAINT_TYPES.FIX, entity1Id: 'l1', point1: 'p1' },
    { id: 'c2', type: CONSTRAINT_TYPES.HORIZONTAL, entity1Id: 'l1' },
    { id: 'c3', type: CONSTRAINT_TYPES.DIMENSION, entity1Id: 'l1', value: 60 },
    { id: 'c4', type: CONSTRAINT_TYPES.COINCIDENT, entity1Id: 'l1', entity2Id: 'l2', point1: 'p2', point2: 'p1' },
    { id: 'c5', type: CONSTRAINT_TYPES.PERPENDICULAR, entity1Id: 'l1', entity2Id: 'l2' },
    { id: 'c6', type: CONSTRAINT_TYPES.DIMENSION, entity1Id: 'l2', value: 40 },
  ];

  const result = constraintSolver.solve(entities, constraints);

  assert.equal(result.converged, true, 'Solver must converge');
  assert.ok(result.error < 1e-3, `Residual ${result.error} must be < 1e-3`);

  const solvedL1 = entities.find(e => e.id === 'l1')!;
  const solvedL2 = entities.find(e => e.id === 'l2')!;

  // L1 start at (0,0) and horizontal with length 60
  assert.ok(Math.abs(solvedL1.p1.x) < 1e-3);
  assert.ok(Math.abs(solvedL1.p1.y) < 1e-3);
  assert.ok(Math.abs(solvedL1.p2.y) < 1e-3, 'L1 must be horizontal (y = 0)');
  assert.ok(Math.abs(solvedL1.p2.x - 60) < 1e-3, 'L1 must have length 60');

  // L2 coincident with L1 at (60, 0)
  assert.ok(Math.abs(solvedL2.p1.x - 60) < 1e-3, 'L2 p1.x must be 60');
  assert.ok(Math.abs(solvedL2.p1.y) < 1e-3, 'L2 p1.y must be 0');

  // L2 perpendicular to L1 with length 40
  const l2dx = solvedL2.p2.x - solvedL2.p1.x;
  const l2dy = solvedL2.p2.y - solvedL2.p1.y;
  assert.ok(Math.abs(l2dx) < 1e-3, 'L2 must be vertical (dx ~ 0)');
  assert.ok(Math.abs(Math.abs(l2dy) - 40) < 1e-3, 'L2 must have length 40');
});

test('ConstraintSolver: equal length & parallel constraints', () => {
  const entities = [
    { id: 'l1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 } },
    { id: 'l2', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 0, y: 25 }, p2: { x: 30, y: 35 } },
  ];

  const constraints: SketchConstraint[] = [
    { id: 'c1', type: CONSTRAINT_TYPES.FIX, entity1Id: 'l1' },
    { id: 'c2', type: CONSTRAINT_TYPES.PARALLEL, entity1Id: 'l1', entity2Id: 'l2' },
    { id: 'c3', type: CONSTRAINT_TYPES.EQUAL, entity1Id: 'l1', entity2Id: 'l2' },
  ];

  const result = constraintSolver.solve(entities, constraints);
  assert.equal(result.converged, true);
  assert.ok(result.error < 1e-3, `Error ${result.error} must be < 1e-3`);

  const l2 = entities.find(e => e.id === 'l2')!;
  const l2dy = l2.p2.y - l2.p1.y;
  const l2dx = l2.p2.x - l2.p1.x;
  assert.ok(Math.abs(l2dy) < 1e-3, 'L2 must be parallel to horizontal L1');
  assert.ok(Math.abs(l2dx - 50) < 1e-3, 'L2 must be equal length to L1 (50)');
});

test('ConstraintSolver: under-constrained degrees of freedom (DOF) count and over-constrained conflict detection', () => {
  // Case A: Under-constrained single line (4 variables: x1, y1, x2, y2)
  const lineEnt = [
    { id: 'l1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 0, y: 0 }, p2: { x: 30, y: 0 } },
  ];
  // 1 fix constraint on p1 (removes 2 DOF -> 2 DOF left), 1 horizontal constraint (removes 1 DOF -> 1 DOF left)
  const underConstraints: SketchConstraint[] = [
    { id: 'c1', type: CONSTRAINT_TYPES.FIX, entity1Id: 'l1', point1: 'p1' },
    { id: 'c2', type: CONSTRAINT_TYPES.HORIZONTAL, entity1Id: 'l1' },
  ];
  const underRes = constraintSolver.solve(lineEnt, underConstraints);
  assert.equal(underRes.status, 'under_constrained');
  assert.equal(underRes.dof, 1, `Line with fixed point and horizontal should have 1 DOF, got ${underRes.dof}`);

  // Case B: Over-constrained conflicting dimensions on same entity
  const conflictConstraints: SketchConstraint[] = [
    { id: 'c1', type: CONSTRAINT_TYPES.FIX, entity1Id: 'l1', point1: 'p1' },
    { id: 'c2', type: CONSTRAINT_TYPES.DIMENSION, entity1Id: 'l1', value: 30 },
    { id: 'c3', type: CONSTRAINT_TYPES.DIMENSION, entity1Id: 'l1', value: 60 },
  ];
  const conflictRes = constraintSolver.solve(lineEnt, conflictConstraints);
  assert.equal(conflictRes.status, 'over_constrained');
  assert.ok(
    conflictRes.conflict || conflictRes.diagnostics.some(d => d.type === 'conflict'),
    'Must identify conflicting constraint diagnostic'
  );
});

test('ConstraintSolver Audit: QR decomposition numerical instability, machine epsilon handling & empty matrix robustness', () => {
  // 1. Empty matrix handling
  const qrEmpty = new QRDecomposition([]);
  assert.equal(qrEmpty.rank, 0, 'Empty matrix QR must report rank 0');
  const solEmpty = qrEmpty.solve([]);
  assert.equal(solEmpty.length, 0, 'Solve on empty matrix must return empty array');

  // 2. All-zero matrix handling
  const qrZero = new QRDecomposition([[0, 0, 0], [0, 0, 0]]);
  assert.equal(qrZero.rank, 0, 'Zero matrix QR must report rank 0');
  const solZero = qrZero.solve([1, 2]);
  assert.deepEqual(Array.from(solZero), [0, 0, 0], 'Solve on zero matrix must return all zeros');

  // 3. Rank-1 matrix with machine epsilon perturbations (~2e-16)
  const A = [
    [1.0, 2.0, 3.0],
    [2.0, 4.0, 6.0],
    [3.0, 6.0, 9.0 + Number.EPSILON * 2],
  ];
  const qrPerturbed = new QRDecomposition(A);
  assert.equal(qrPerturbed.rank, 1, `Rank of rank-1 matrix with eps perturbation must be 1, got ${qrPerturbed.rank}`);

  // 4. Over-determined system with column pivoting and back-substitution
  const A_rect = [
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  const qrRect = new QRDecomposition(A_rect);
  assert.equal(qrRect.rank, 2, 'Full column rank rectangular matrix must have rank 2');
  const solRect = qrRect.solve([1, 2, 3]);
  assert.ok(Math.abs(solRect[0] - 1) < 1e-6 && Math.abs(solRect[1] - 2) < 1e-6, 'Rectangular least-squares solve must be exact');
});

test('ConstraintSolver Audit: Degenerate geometries (zero-length lines, coincident points dx=0 dy=0) & LM damping', () => {
  const solver = new ConstraintSolver();

  // 1. Zero-length line in parallel constraint (dx=0, dy=0)
  const degenEntities = [
    { id: 'dl1', p1: { x: 5, y: 5 }, p2: { x: 5, y: 5 } }, // zero length!
    { id: 'dl2', p1: { x: 10, y: 0 }, p2: { x: 20, y: 0 } },
  ];
  const parallelConstraints: SketchConstraint[] = [
    { id: 'dc1', type: CONSTRAINT_TYPES.PARALLEL, entity1Id: 'dl1', entity2Id: 'dl2' },
  ];
  const parRes = solver.solve(degenEntities, parallelConstraints);
  assert.equal(parRes.converged, true, 'Zero-length parallel constraint must not explode');
  assert.ok(!isNaN(parRes.error), 'Residual must not be NaN');
  assert.ok(parRes.error < 1e-3, 'Residual must be near 0');

  // 2. Zero-length line in angle constraint (dx=0, dy=0)
  const angleConstraints: SketchConstraint[] = [
    { id: 'dc2', type: CONSTRAINT_TYPES.ANGLE, entity1Id: 'dl1', entity2Id: 'dl2', angle: 45 },
  ];
  const angRes = solver.solve(degenEntities, angleConstraints);
  assert.ok(!isNaN(angRes.error), 'Angle residual on degenerate line must not produce NaN');
  assert.ok(Number.isFinite(angRes.error), 'Angle residual must be finite');

  // 3. System starting from fully collapsed line (p1 == p2 == (0,0)) coupling with dimension and fix
  const expandingEntities = [
    { id: 'el1', p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 } }, // collapsed point
    { id: 'el2', p1: { x: 0, y: 0 }, p2: { x: 20, y: 0 } },
  ];
  const expandConstraints: SketchConstraint[] = [
    { id: 'ec1', type: CONSTRAINT_TYPES.FIX, entity1Id: 'el1', point1: 'p1', x: 0, y: 0 },
    { id: 'ec2', type: CONSTRAINT_TYPES.DIMENSION, entity1Id: 'el1', value: 15 },
    { id: 'ec3', type: CONSTRAINT_TYPES.HORIZONTAL, entity1Id: 'el1' },
    { id: 'ec4', type: CONSTRAINT_TYPES.COINCIDENT, entity1Id: 'el1', entity2Id: 'el2', point1: 'p2', point2: 'p1' },
  ];
  const expandRes = solver.solve(expandingEntities, expandConstraints);
  assert.equal(expandRes.converged, true, 'Solver must expand collapsed line segment and converge');
  assert.ok(expandRes.error < 1e-3, `Error ${expandRes.error} must be < 1e-3`);
  const solvedL1 = expandingEntities.find(e => e.id === 'el1')!;
  assert.ok(Math.abs(solvedL1.p2.x - 15) < 1e-3, 'Collapsed line must expand to length 15');
});
