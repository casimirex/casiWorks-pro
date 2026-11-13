// CasiWorks Pro - FEA verification against closed-form solutions
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FEAEngine, ELEMENT_TYPES, SparseMatrix, tet10B, TET10_NODE_COORDS } from '../src/simulation/FEAEngine.ts';

const E = 200e9;
const near = (actual: number, expected: number, relTol: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) <= relTol * Math.abs(expected), `${msg}: got ${actual}, expected ${expected} ±${relTol * 100}%`);

// A skewed tetrahedron (metres) with straight-edge mid nodes in Tet10 order
function skewedTet10(): number[][] {
  const c = [[0.001, 0.002, 0], [0.011, 0.001, 0.002], [0.003, 0.013, 0.001], [0.002, 0.003, 0.015]];
  const mid = (i: number, j: number) => c[i].map((v, k) => (v + c[j][k]) / 2);
  return [...c, mid(0, 1), mid(1, 2), mid(2, 0), mid(0, 3), mid(1, 3), mid(2, 3)];
}

test('Tet10 element: exact volume, symmetric stiffness, zero rigid-body forces, passes the patch test', () => {
  const fea = new FEAEngine();
  const coords = skewedTet10();
  const { Ke, volume } = fea.computeTet10Stiffness(coords, E, 0.3)!;
  near(volume, Math.abs(fea._computeTetVolume(coords.slice(0, 4))), 1e-12, 'volume');

  const kScale = Math.max(...Ke.map((r, i) => Math.abs(r[i])));
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) assert.ok(Math.abs(Ke[i][j] - Ke[j][i]) <= 1e-12 * kScale);

  const force = (u: number[]) => Math.sqrt(Ke.reduce((s, row) => s + row.reduce((a, v, k) => a + v * u[k], 0) ** 2, 0));
  assert.ok(force(coords.flatMap(() => [1e-4, -2e-4, 3e-4])) < 1e-9 * kScale * 1e-4, 'translation produces no force');
  assert.ok(force(coords.flatMap(p => [-p[1] * 1e-3, p[0] * 1e-3, 0])) < 1e-9 * kScale * 1e-5, 'rotation produces no force');

  // A linear displacement field must give the same constant strain everywhere
  const G = [[1, 2, 0], [0, 3, 1], [2, 0, 4]].map(r => r.map(v => v * 1e-4));
  const u = coords.flatMap(p => [0, 1, 2].map(i => G[i][0] * p[0] + G[i][1] * p[1] + G[i][2] * p[2]));
  const expected = [G[0][0], G[1][1], G[2][2], G[0][1] + G[1][0], G[1][2] + G[2][1], G[2][0] + G[0][2]];
  for (const pt of [[0.1, 0.2, 0.3], ...TET10_NODE_COORDS] as Array<[number, number, number]>) {
    const { B } = tet10B(coords, pt)!;
    B.forEach((row, k) => assert.ok(Math.abs(row.reduce((s, v, c) => s + v * u[c], 0) - expected[k]) < 1e-15, `strain ${k} at ${pt}`));
  }
});

test('Cantilever (10×10×100 mm steel, 1 kN tip load): Tet10 matches beam theory', () => {
  const fea = new FEAEngine();
  fea.generateMesh(new THREE.BoxGeometry(10, 10, 100), { elementType: ELEMENT_TYPES.TET10 });
  const r = fea.solve(1000, 250e6, E, 0.3, {});
  const I = 0.01 ** 4 / 12;
  const deflection = (1000 * 0.1 ** 3) / (3 * E * I) * 1000; // 2.000 mm
  const stress = (1000 * 0.1 * 0.005) / I / 1e6; // 600 MPa
  near(r.maxDisplacementMM, deflection, 0.03, 'tip deflection (mm)');
  near(r.maxStressMPa, stress, 0.05, 'max von Mises at the root (MPa)');
  near(r.factorOfSafety, 250 / r.maxStressMPa, 1e-9, 'factor of safety');
  assert.ok(r.stresses!.every(Number.isFinite), 'all nodal stresses finite (Tet10 used to diverge to Infinity)');
});

test('Uniaxial tension (10 kN on a 10×10 mm bar): Tet10 recovers FL/EA and σ = F/A away from the clamp', () => {
  const fea = new FEAEngine();
  fea.generateMesh(new THREE.BoxGeometry(10, 10, 100), { elementType: ELEMENT_TYPES.TET10 });
  const r = fea.solveSolidFEA({
    youngsModulus: E,
    poissonRatio: 0.3,
    fixtures: [{ type: 'fixed', plane: 'zMin' }],
    loads: [{ type: 'force', plane: 'zMax', direction: [0, 0, 1], magnitude: 10000 }],
  })!;
  near(r.maxDisplacementMM, (10000 * 0.1) / (E * 1e-4) * 1000, 0.03, 'elongation (mm)');
  // Mid-length nodes are far from the clamped end: stress should be uniform 100 MPa
  const mesh = fea.solidMesh!;
  const mid = mesh.nodes.filter(n => Math.abs(n.point.z) < 1e-6).map(n => r.nodalVonMisesMPa[n.id]);
  assert.ok(mid.length > 0);
  for (const s of mid) near(s, 100, 0.02, 'mid-length von Mises (MPa)');
});

test('SparseMatrix.toCSR gives exactly the same products as the row maps', () => {
  const K = new SparseMatrix(5);
  [[0, 0, 4], [0, 3, -1], [1, 1, 2.5], [2, 4, 7], [3, 0, -1], [3, 3, 9], [4, 2, 7], [4, 4, 1e-3]].forEach(([i, j, v]) => K.add(i, j, v));
  const x = [1, -2, 3.5, 0.25, -7];
  const a = K.mult(x, new Float64Array(5));
  const b = K.toCSR().mult(x, new Float64Array(5));
  assert.deepEqual(Array.from(b), Array.from(a));
});
