// CasiWorks Pro - Mass properties: SI units, exact inertia, winding-independent centre of mass
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { geometryEngine } from '../src/kernel/GeometryEngine.ts';

test('Mass properties regression: SI units, exact inertia, winding-independent center of mass', () => {
  const m = 10 * 20 * 30 * 1e-9 * 7900; // 0.0474 kg
  const close = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

  const box = new THREE.BoxGeometry(10, 20, 30);
  let r = geometryEngine.computeMassProperties(box, { density: 7900 });
  assert.ok(r);
  close(r.volume, 6000, 'volume mm³');
  close(r.mass, m, 'mass kg (mm³ × 1e-9 × kg/m³)');
  close(r.momentOfInertia.Ixx, m * (20 ** 2 + 30 ** 2) / 12, 'Ixx');
  close(r.momentOfInertia.Iyy, m * (10 ** 2 + 30 ** 2) / 12, 'Iyy');
  close(r.momentOfInertia.Izz, m * (10 ** 2 + 20 ** 2) / 12, 'Izz');
  assert.equal(r.units.mass, 'kg');

  // Translated box: parallel-axis theorem at origin, unchanged central inertia
  const moved = new THREE.BoxGeometry(10, 20, 30);
  moved.translate(5, 0, 0);
  r = geometryEngine.computeMassProperties(moved, { density: 7900 });
  assert.ok(r);
  close(r.centerOfMass.x, 5, 'COM x');
  close(r.momentOfInertiaAtOrigin.Iyy, m * (10 ** 2 + 30 ** 2) / 12 + m * 25, 'Iyy at origin');
  close(r.momentOfInertia.Iyy, m * (10 ** 2 + 30 ** 2) / 12, 'Iyy at COM');

  // Inverted winding must not mirror the center of mass
  const idx = moved.index!.array;
  for (let i = 0; i < idx.length; i += 3) [idx[i], idx[i + 1]] = [idx[i + 1], idx[i]];
  r = geometryEngine.computeMassProperties(moved, { density: 7900 });
  assert.ok(r);
  close(r.centerOfMass.x, 5, 'COM x with inverted winding');
  close(r.mass, m, 'mass with inverted winding');
});
