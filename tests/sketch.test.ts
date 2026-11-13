// CasiWorks Pro - Sketch engine and constraint solver tests
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConstraintSolver } from '../src/kernel/ConstraintSolver.ts';
import type { SolverEntity } from '../src/kernel/ConstraintSolver.ts';
import { sketchEngine } from '../src/kernel/SketchEngine.ts';

const close = (actual: number, expected: number, tol = 1e-4, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} got ${actual}, expected ${expected}`);

const fixedLine = (): SolverEntity => ({ id: 'ln', type: 'line', p1: { x: -10, y: 0 }, p2: { x: 10, y: 0 } });

test('Solver: coincident point + line places the point ON the line (not on its endpoint)', () => {
  const solver = new ConstraintSolver();
  const pt: SolverEntity = { id: 'pt', type: 'point', x: 3, y: 4 };
  const res = solver.solve([pt, fixedLine()], [
    { id: 'fix', type: 'fix', entity1Id: 'ln' },
    { id: 'on', type: 'coincident', entity1Id: 'pt', entity2Id: 'ln' },
  ]);
  assert.ok(res.converged);
  close(pt.y!, 0, 1e-4, 'y');
  close(pt.x!, 3, 1e-3, 'x stays (minimal movement)');
});

test('Solver: coincident point + circle places the point ON the circle (not at its center)', () => {
  const solver = new ConstraintSolver();
  const pt: SolverEntity = { id: 'pt', type: 'point', x: 3, y: 9 };
  const circle: SolverEntity = { id: 'c', type: 'circle', center: { x: 0, y: 0 }, radius: 5 };
  const res = solver.solve([pt, circle], [
    { id: 'fix', type: 'fix', entity1Id: 'c' },
    { id: 'r', type: 'dimension', entity1Id: 'c', value: 5 },
    { id: 'on', type: 'coincident', entity1Id: 'pt', entity2Id: 'c' },
  ]);
  assert.ok(res.converged);
  close(Math.hypot(pt.x!, pt.y!), 5, 1e-4, 'distance from center');
});

test('Solver: dimension between a point and a line is the perpendicular distance', () => {
  const solver = new ConstraintSolver();
  const pt: SolverEntity = { id: 'pt', type: 'point', x: 2, y: 7 };
  const res = solver.solve([pt, fixedLine()], [
    { id: 'fix', type: 'fix', entity1Id: 'ln' },
    { id: 'd', type: 'dimension', entity1Id: 'pt', entity2Id: 'ln', value: 3 },
  ]);
  assert.ok(res.converged);
  close(Math.abs(pt.y!), 3, 1e-4, '|y|');
});

test('Solver: explicit endpoints still mean point-to-point coincidence', () => {
  const solver = new ConstraintSolver();
  const a: SolverEntity = { id: 'a', type: 'line', p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } };
  const b: SolverEntity = { id: 'b', type: 'line', p1: { x: 12, y: 3 }, p2: { x: 20, y: 8 } };
  const res = solver.solve([a, b], [
    { id: 'fix', type: 'fix', entity1Id: 'a' },
    { id: 'join', type: 'coincident', entity1Id: 'a', entity2Id: 'b', point1: 'p2', point2: 'p1' },
  ]);
  assert.ok(res.converged);
  close(b.p1!.x, 10);
  close(b.p1!.y, 0);
});

test('SketchEngine: isProfileClosed handles rectangles, half-discs, slots and open chains', () => {
  assert.equal(sketchEngine.isProfileClosed(sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 })), true);
  assert.equal(sketchEngine.isProfileClosed([sketchEngine.createCircle({ x: 0, y: 0 }, 3)]), true);

  // Half-disc: one arc closed by one line (2 segments) — previously reported open
  const halfDisc = [
    sketchEngine.createArc({ x: 0, y: 0 }, 5, -Math.PI / 2, Math.PI / 2),
    sketchEngine.createLine({ x: 0, y: 5 }, { x: 0, y: -5 }),
  ];
  assert.equal(sketchEngine.isProfileClosed(halfDisc), true);

  assert.equal(sketchEngine.isProfileClosed(sketchEngine.createSlot({ x: 0, y: 0 }, { x: 20, y: 0 }, 4)), true);
  assert.equal(sketchEngine.isProfileClosed(sketchEngine.createPolygon({ x: 0, y: 0 }, 10, 6)), true);

  const open = sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 }).slice(0, 3);
  assert.equal(sketchEngine.isProfileClosed(open), false);
  // Two straight lines cannot enclose an area, even if they overlap
  const twoLines = [sketchEngine.createLine({ x: 0, y: 0 }, { x: 5, y: 0 }), sketchEngine.createLine({ x: 5, y: 0 }, { x: 0, y: 0 })];
  assert.equal(sketchEngine.isProfileClosed(twoLines), false);
  // Construction geometry is ignored
  const withConstruction = [...open, sketchEngine.createLine({ x: 0, y: 5 }, { x: 0, y: 0 }, true)];
  assert.equal(sketchEngine.isProfileClosed(withConstruction), false);
});

test('SketchEngine: snapToEntity picks the nearest endpoint, midpoint or center', () => {
  const line = sketchEngine.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const circle = sketchEngine.createCircle({ x: 30, y: 0 }, 4);
  assert.deepEqual(sketchEngine.snapToEntity({ x: 9.5, y: 0.3 }, [line, circle])?.type, 'endpoint');
  assert.deepEqual(sketchEngine.snapToEntity({ x: 5.2, y: 0.1 }, [line, circle])?.point, { x: 5, y: 0 });
  assert.equal(sketchEngine.snapToEntity({ x: 29, y: 1 }, [line, circle])?.type, 'center');
  assert.equal(sketchEngine.snapToEntity({ x: 100, y: 100 }, [line, circle]), null);
});

test('Sketch planes: the viewport picks, draws and the kernel extrudes the same sketch point', async () => {
  const THREE = await import('three');
  const { viewportPicker } = await import('../src/viewport/ViewportPicker.ts');
  const { sketchToWorld, sketchPlaneNormal } = await import('../src/utils/math.ts');
  const { geometryEngine: G } = await import('../src/kernel/GeometryEngine.ts');
  const p = { x: 12, y: 5 };
  for (const plane of ['Front', 'Top', 'Right'] as const) {
    // The extruded solid has a vertex at the sketch point on the sketch plane
    const tri = [[0, 0, 12, 0], [12, 0, 12, 5], [12, 5, 0, 0]].map(([x1, y1, x2, y2]) => ({ type: 'line', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } }));
    const solid = G.extrudeProfile(G.shapesFromSketchEntities(tri), 3, plane, {});
    const w = sketchToWorld(p, plane);
    const pos = solid.attributes.position;
    let best = Infinity;
    for (let i = 0; i < pos.count; i++) best = Math.min(best, w.distanceTo(new THREE.Vector3().fromBufferAttribute(pos, i)));
    assert.ok(best < 1e-6, `${plane}: extruded solid has a vertex at the drawn point (closest ${best})`);

    // Clicking where that point appears on screen gives back the same sketch point
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.copy(sketchPlaneNormal(plane).multiplyScalar(100));
    camera.up.set(0, plane === 'Top' ? 0 : 1, plane === 'Top' ? -1 : 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const ndc = w.clone().project(camera);
    const picked = viewportPicker.screenToSketchPlane(ndc.x, ndc.y, camera, plane)!;
    assert.ok(Math.abs(picked.x - p.x) < 1e-6 && Math.abs(picked.y - p.y) < 1e-6, `${plane}: picked (${picked.x}, ${picked.y})`);
  }
});
