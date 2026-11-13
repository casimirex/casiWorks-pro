// CasiWorks Pro - Assembly mate regression tests (measured geometry after solving)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { AssemblyManager } from '../src/assembly/AssemblyManager.ts';
import type { AssemblyComponent } from '../src/assembly/AssemblyManager.ts';

const box = () => new THREE.BoxGeometry(30, 10, 20);
const cylinder = () => new THREE.CylinderGeometry(5, 5, 40, 32); // three.js cylinders run along Y

/** Move a component to an arbitrary tilted pose so the solver has work to do. */
function displace(c: AssemblyComponent): void {
  c.position.set(13, 27, -9);
  c.quaternion.setFromEuler(new THREE.Euler(0.4, -0.7, 0.25));
  c.updateMatrix();
}

for (const cylinderFixed of [false, true]) {
  test(`Tangent mate: cylinder axis ends perpendicular to the plane at radius distance (${cylinderFixed ? 'fixed' : 'free'} cylinder)`, () => {
    const m = new AssemblyManager();
    const cyl = m.insertComponent('Cylinder', cylinder(), cylinderFixed);
    const plate = m.insertComponent('Plate', box(), !cylinderFixed);
    displace(cylinderFixed ? plate : cyl);
    m.addMate('tangent', cyl.id, 'y', plate.id, 'top', 0);
    const result = m.solve();

    const axis = cyl.getAxisReference('y');
    const face = plate.getFaceReference('top');
    assert.ok(Math.abs(axis.axis.dot(face.normal)) < 1e-4, `axis·normal = ${axis.axis.dot(face.normal)}`);
    assert.ok(Math.abs(Math.abs(axis.point.clone().sub(face.point).dot(face.normal)) - 5) < 1e-3, 'centre line at radius from the plane');
    assert.ok(result.converged, 'solver reports convergence only when orientation is also satisfied');
  });
}

test('Concentric mate on cylinder axes (Y) makes the true axes colinear', () => {
  const m = new AssemblyManager();
  const a = m.insertComponent('A', cylinder(), true);
  const b = m.insertComponent('B', cylinder(), false);
  displace(b);
  m.addMate('concentric', a.id, 'y', b.id, 'y', 0);
  const ax1 = a.getAxisReference('y');
  const ax2 = b.getAxisReference('y');
  const offset = ax2.point.clone().sub(ax1.point);
  offset.sub(ax1.axis.clone().multiplyScalar(offset.dot(ax1.axis)));
  assert.ok(Math.min(ax1.axis.angleTo(ax2.axis), ax1.axis.angleTo(ax2.axis.clone().negate())) < 1e-4);
  assert.ok(offset.length() < 1e-3, `axis offset ${offset.length()}`);
});

test('Exploded view moves mated parts away from their partner and returns a plain result', () => {
  const m = new AssemblyManager();
  const base = m.insertComponent('Base', box(), true);
  const pin = m.insertComponent('Pin', cylinder(), false);
  m.addMate('coincident', base.id, 'top', pin.id, 'bottom', 0);

  const view = m.createExplodedView(40);
  assert.ok(!Array.isArray(view), 'result is a plain object, not an array with properties');
  assert.deepEqual(Object.keys(view).sort(), ['components', 'distance', 'leaderLines']);
  const exploded = view.components.find(c => c.id === pin.id)!;
  const moved = exploded.position.clone().sub(pin.position).dot(base.getFaceReference('top').normal);
  assert.ok(moved > 39.9, `pin moved ${moved} mm along the base's top normal (away from the base)`);
  assert.equal(view.components.find(c => c.id === base.id)!.distance, 0, 'fixed base stays');
  assert.equal(view.leaderLines.length, 1);
});

test('Mates to components that do not exist are rejected', () => {
  const m = new AssemblyManager();
  const a = m.insertComponent('A', box());
  assert.throws(() => m.addMate('path', a.id, 'top', 'path_curve', 'top', 0), /unknown component "path_curve"/);
  assert.equal(m.mates.length, 0);
});
