// CasiWorks Pro - Assembly manager: every mate type, quaternion edge cases, missing components, exploded view
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AssemblyManager, safeQuaternionFromVectors } from '../src/assembly/AssemblyManager.ts';
import { MATE_TYPES } from '../src/utils/constants.ts';

test('AssemblyManager: coincident mate aligns contact surfaces', () => {
  const mgr = new AssemblyManager();
  const c1 = mgr.insertComponent('Base', new THREE.BoxGeometry(40, 20, 40), true);
  const c2 = mgr.insertComponent('Plate', new THREE.BoxGeometry(40, 10, 40), false);

  c2.position.set(0, 50, 0);
  c2.updateMatrix();

  mgr.addMate(MATE_TYPES.COINCIDENT, c1.id, 'top', c2.id, 'bottom', 0);
  const result = mgr.solve();

  assert.ok(result.error < 1e-3, `Mate solve residual ${result.error} must be < 1e-3`);

  const topFaceC1 = c1.getFaceReference('top');
  const botFaceC2 = c2.getFaceReference('bottom');

  assert.ok(Math.abs(topFaceC1.point.y - botFaceC2.point.y) < 1e-3, 'Faces must be in exact contact');
  assert.ok(topFaceC1.normal.dot(botFaceC2.normal) < -0.99, 'Face normals must oppose');
});

test('AssemblyManager: distance mate maintains exact offset', () => {
  const mgr = new AssemblyManager();
  const c1 = mgr.insertComponent('FixedBase', new THREE.BoxGeometry(30, 10, 30), true);
  const c2 = mgr.insertComponent('HoverBlock', new THREE.BoxGeometry(30, 10, 30), false);

  mgr.addMate(MATE_TYPES.DISTANCE, c1.id, 'top', c2.id, 'bottom', 15.0);
  const result = mgr.solve();
  assert.ok(result.error < 1e-3, `Mate solve residual ${result.error} must be < 1e-3`);

  const topFaceC1 = c1.getFaceReference('top');
  const botFaceC2 = c2.getFaceReference('bottom');
  const gap = Math.abs(botFaceC2.point.y - topFaceC1.point.y);

  assert.ok(Math.abs(gap - 15.0) < 1e-3, `Gap ${gap} must be 15.0mm`);
});

test('AssemblyManager: concentric, parallel, perpendicular, and advanced mates (tangent, width, path)', () => {
  // 1. Concentric mate
  const mgr1 = new AssemblyManager();
  const baseCyl = mgr1.insertComponent('BaseCyl', new THREE.CylinderGeometry(15, 15, 60), true);
  const pinCyl = mgr1.insertComponent('PinCyl', new THREE.CylinderGeometry(10, 10, 40), false);
  pinCyl.position.set(50, 30, 20);
  pinCyl.updateMatrix();

  mgr1.addMate(MATE_TYPES.CONCENTRIC, baseCyl.id, 'cylinder', pinCyl.id, 'cylinder', 0);
  const concRes = mgr1.solve();
  assert.ok(concRes.error < 1e-3, `Concentric mate residual ${concRes.error} must be < 1e-3`);
  assert.ok(Math.abs(pinCyl.position.x) < 1e-3 && Math.abs(pinCyl.position.y) < 1e-3, 'Pin must align with base cylinder axis');

  // 2. Parallel and Perpendicular mates
  const mgr2 = new AssemblyManager();
  const fixedBlock = mgr2.insertComponent('FixedBlock', new THREE.BoxGeometry(40, 40, 40), true);
  const rotBlock1 = mgr2.insertComponent('RotBlock1', new THREE.BoxGeometry(20, 20, 20), false);
  const rotBlock2 = mgr2.insertComponent('RotBlock2', new THREE.BoxGeometry(20, 20, 20), false);

  mgr2.addMate(MATE_TYPES.PARALLEL, fixedBlock.id, 'top', rotBlock1.id, 'bottom', 0);
  mgr2.addMate(MATE_TYPES.PERPENDICULAR, fixedBlock.id, 'top', rotBlock2.id, 'front', 0);
  const rotRes = mgr2.solve();
  assert.ok(rotRes.error < 1e-3, `Parallel/Perpendicular mate residual ${rotRes.error} < 1e-3`);

  const topFix = fixedBlock.getFaceReference('top');
  const botRot1 = rotBlock1.getFaceReference('bottom');
  const frontRot2 = rotBlock2.getFaceReference('front');

  assert.ok(Math.abs(Math.abs(topFix.normal.dot(botRot1.normal)) - 1.0) < 1e-3, 'RotBlock1 bottom normal must be parallel to fixed top');
  assert.ok(Math.abs(topFix.normal.dot(frontRot2.normal)) < 1e-3, 'RotBlock2 front normal must be perpendicular to fixed top');

  // 3. Advanced Mates: Tangent Mate
  const mgrTan = new AssemblyManager();
  const planeBox = mgrTan.insertComponent('PlaneBox', new THREE.BoxGeometry(100, 20, 100), true);
  const rollerCyl = mgrTan.insertComponent('RollerCyl', new THREE.CylinderGeometry(15, 15, 50), false);
  rollerCyl.position.set(0, 50, 0);
  rollerCyl.updateMatrix();

  mgrTan.addMate(MATE_TYPES.TANGENT, rollerCyl.id, 'z', planeBox.id, 'top', 0);
  const tanRes = mgrTan.solve();
  assert.ok(tanRes.error < 1e-3, `Tangent mate residual ${tanRes.error} < 1e-3`);

  // 4. Advanced Mates: Width Mate
  const mgr3 = new AssemblyManager();
  const bracket = mgr3.insertComponent('Bracket', new THREE.BoxGeometry(60, 30, 40), true);
  const tab = mgr3.insertComponent('Tab', new THREE.BoxGeometry(20, 30, 30), false);
  tab.position.set(40, 0, 0);
  tab.updateMatrix();

  mgr3.addMate(MATE_TYPES.WIDTH, bracket.id, 'left', tab.id, 'left', 0, {
    ref1Secondary: 'right',
    ref2Secondary: 'right',
  });
  const widthRes = mgr3.solve();
  assert.ok(widthRes.error < 1e-3, `Width mate residual ${widthRes.error} < 1e-3`);
  assert.ok(Math.abs(tab.position.x) < 1e-3, `Tab must be centered symmetrically at X=0, got ${tab.position.x}`);

  // 5. Advanced Mates: Path Mate
  const mgr4 = new AssemblyManager();
  const guide = mgr4.insertComponent('Guide', new THREE.BoxGeometry(100, 10, 10), true);
  const runner = mgr4.insertComponent('Runner', new THREE.BoxGeometry(10, 10, 10), false);
  runner.position.set(25, 45, 10);
  runner.updateMatrix();

  const pathPoints = [
    new THREE.Vector3(-50, 20, 0),
    new THREE.Vector3(50, 20, 0),
  ];
  mgr4.addMate(MATE_TYPES.PATH, guide.id, 'top', runner.id, 'bottom', 0, { pathPoints });
  const pathRes = mgr4.solve();
  assert.ok(pathRes.error < 1e-3, `Path mate residual ${pathRes.error} < 1e-3`);
  assert.ok(Math.abs(runner.position.y - 20) < 1e-3, `Runner Y must project onto path Y=20, got ${runner.position.y}`);

  // 6. Exploded View Generator
  const exploded = mgr1.generateExplodedView(40);
  assert.ok(exploded.components.length >= 2, 'Exploded view must position components');
  assert.ok(exploded.leaderLines.length > 0, 'Exploded view must generate leader lines');
});

test('AssemblyManager Audit: Quaternion degeneracy for 180° anti-parallel and colinear vectors', () => {
  // 1. safeQuaternionFromVectors unit tests
  const qIdent = safeQuaternionFromVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0));
  assert.ok(Math.abs(qIdent.w - 1) < 1e-6, 'Identical vectors must return identity quaternion');

  const qOppositeY = safeQuaternionFromVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0));
  assert.ok(!isNaN(qOppositeY.x) && !isNaN(qOppositeY.w), 'Opposite Y vectors must not produce NaN');
  const testVecY = new THREE.Vector3(0, 1, 0).applyQuaternion(qOppositeY);
  assert.ok(testVecY.dot(new THREE.Vector3(0, -1, 0)) > 0.999, 'Opposite Y vectors must rotate by 180°');

  const qOppositeX = safeQuaternionFromVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0));
  const testVecX = new THREE.Vector3(1, 0, 0).applyQuaternion(qOppositeX);
  assert.ok(testVecX.dot(new THREE.Vector3(-1, 0, 0)) > 0.999, 'Opposite X vectors must rotate by 180°');

  const qZero = safeQuaternionFromVectors(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  assert.ok(Math.abs(qZero.w - 1) < 1e-6, 'Degenerate zero-length vector must return identity quaternion');

  // 2. Coincident mate starting 180° opposite
  const mgr = new AssemblyManager();
  const base = mgr.insertComponent('Base', new THREE.BoxGeometry(30, 30, 30), true);
  const comp = mgr.insertComponent('Comp', new THREE.BoxGeometry(30, 30, 30), false);

  // Invert comp upside-down (180 deg) so bottom faces in opposite direction
  comp.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  comp.updateMatrix();

  mgr.addMate(MATE_TYPES.COINCIDENT, base.id, 'top', comp.id, 'bottom', 0);
  const coinRes = mgr.solve();
  assert.equal(coinRes.converged, true, 'Coincident mate must resolve 180° opposite face orientation');
  assert.ok(!isNaN(comp.quaternion.x) && !isNaN(comp.quaternion.w), 'Comp quaternion must not be NaN');

  // 3. Concentric mate with 180° anti-parallel cylinder axes
  const mgrConc = new AssemblyManager();
  const c1 = mgrConc.insertComponent('C1', new THREE.CylinderGeometry(10, 10, 50), true);
  const c2 = mgrConc.insertComponent('C2', new THREE.CylinderGeometry(10, 10, 50), false);
  c2.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI); // anti-parallel axis
  c2.position.set(25, 25, 0);
  c2.updateMatrix();

  mgrConc.addMate(MATE_TYPES.CONCENTRIC, c1.id, 'cylinder', c2.id, 'cylinder', 0);
  const concRes = mgrConc.solve();
  assert.equal(concRes.converged, true, 'Concentric mate must resolve anti-parallel cylinder axes');
  assert.ok(Math.abs(c2.position.x) < 1e-3 && Math.abs(c2.position.y) < 1e-3, 'Concentric axes must align');

  // 4. Perpendicular mate starting from colinear face normals
  const mgrPerp = new AssemblyManager();
  const b1 = mgrPerp.insertComponent('B1', new THREE.BoxGeometry(20, 20, 20), true);
  const b2 = mgrPerp.insertComponent('B2', new THREE.BoxGeometry(20, 20, 20), false);
  mgrPerp.addMate(MATE_TYPES.PERPENDICULAR, b1.id, 'top', b2.id, 'top', 0);
  const perpRes = mgrPerp.solve();
  assert.equal(perpRes.converged, true, 'Perpendicular mate must resolve colinear starting normals');
  const dotNormals = b1.getFaceReference('top').normal.dot(b2.getFaceReference('top').normal);
  assert.ok(Math.abs(dotNormals) < 1e-3, `Normals must be perpendicular, dot=${dotNormals}`);
});

test('AssemblyManager Audit: Null checks for deleted/missing components, faces & removeComponent', () => {
  const mgr = new AssemblyManager();
  const c1 = mgr.insertComponent('Comp1', new THREE.BoxGeometry(20, 20, 20), true);
  const c2 = mgr.insertComponent('Comp2', new THREE.BoxGeometry(20, 20, 20), false);

  // Adding a mate to a component that does not exist is rejected
  assert.throws(() => mgr.addMate(MATE_TYPES.COINCIDENT, c1.id, 'top', 'deleted_comp_id_999', 'bottom', 0), /unknown component/);
  // A stale mate already stored (e.g. loaded from an old file) is skipped by the solver
  mgr.mates.push({ ...mgr.mates[0], id: 'stale', type: MATE_TYPES.COINCIDENT, comp1Id: c1.id, comp2Id: 'deleted_comp_id_999', ref1: 'top', ref2: 'bottom', offset: 0 });
  const resMissing = mgr.solve();
  assert.ok(resMissing.converged, 'Solve must gracefully handle mate referencing non-existent component');
  mgr.mates = [];

  // Add valid mate between c1 and c2
  mgr.addMate(MATE_TYPES.COINCIDENT, c1.id, 'top', c2.id, 'bottom', 5.0);
  assert.equal(mgr.mates.length, 1, 'Must have 1 mate (the stale one was cleared)');

  // removeComponent should remove component and cleanup dangling mates
  mgr.removeComponent(c2.id);
  assert.equal(mgr.components.length, 1, 'Component count must be 1 after removal');
  assert.equal(mgr.mates.length, 0, 'Dangling mate referencing removed component must be pruned');

  // Custom face reference with degenerate/missing normal
  const degenFace = c1.getFaceReference({ point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 0, 0) });
  assert.ok(Math.abs(degenFace.normal.length() - 1.0) < 1e-6, 'Degenerate normal must fallback to normalized unit vector');
});

test('AssemblyManager Audit: Exploded view handling for 0 and 1 components without division by zero', () => {
  const mgr = new AssemblyManager();

  // 1. 0 components in assembly
  const exp0 = mgr.createExplodedView(50);
  assert.equal(exp0.components.length, 0, 'Exploded view on 0 components must return empty array');
  assert.equal(exp0.leaderLines.length, 0, 'Exploded view on 0 components must have 0 leader lines');
  assert.equal(exp0.distance, 50, 'Configured distance must be preserved');

  // 2. 1 component in assembly
  const c1 = mgr.insertComponent('SoloBody', new THREE.BoxGeometry(20, 20, 20), false);
  c1.position.set(10, 20, 30);
  c1.updateMatrix();

  const exp1 = mgr.createExplodedView(50);
  assert.equal(exp1.components.length, 1, 'Exploded view on 1 component must return 1 component');
  assert.equal(exp1.components[0].distance, 0, 'Single component must not explode (distance = 0)');
  assert.ok(
    exp1.components[0].position.distanceTo(new THREE.Vector3(10, 20, 30)) < 1e-6,
    'Single component must remain at its original position'
  );
  assert.equal(exp1.leaderLines.length, 0, 'Single component must have 0 leader lines');

  // 3. Multi-component assembly explodes properly
  const c2 = mgr.insertComponent('MateBody', new THREE.BoxGeometry(20, 20, 20), false);
  c2.position.set(10, 50, 30);
  c2.updateMatrix();

  const exp2 = mgr.createExplodedView(40);
  assert.equal(exp2.components.length, 2, 'Multi-component exploded view must include both components');
  assert.ok(exp2.leaderLines.length > 0, 'Multi-component exploded view must generate leader lines');
});
