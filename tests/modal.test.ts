// CasiWorks Pro - Modal analysis
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FEAEngine, ELEMENT_TYPES, SparseMatrix } from '../src/simulation/FEAEngine.ts';
import { autoMesh } from '../src/simulation/autoMesh.ts';
import { EnvelopeCholesky, SpdSolver, solveModal, symmetricEigen } from '../src/simulation/modal.ts';
import { fixturesFor } from '../src/simulation/studySetup.ts';
import { runSolve, unpack } from '../src/simulation/feaTransfer.ts';

const E = 200e9, rho = 7850;
/** A steel cantilever 10 × 10 × 100 mm along Z, fixed at z = 0. */
const beam = () => { const g = new THREE.BoxGeometry(10, 10, 100); g.translate(0, 0, 50); return g; };
const fixedBack = fixturesFor({ fixedFace: 'zMin', loadFace: 'zMax', loadDirection: '-Y' });
/** Euler–Bernoulli cantilever: f = (βL)² / 2π · √(EI / ρAL⁴). */
const cantilever = (betaL: number) => { const b = 0.01, L = 0.1; return (betaL ** 2 / (2 * Math.PI)) * Math.sqrt(E * (b ** 4 / 12) / (rho * b * b * L ** 4)); };

test('Small symmetric eigenproblems (Jacobi)', () => {
  const { values, vectors } = symmetricEigen([[2, 1, 0], [1, 2, 1], [0, 1, 2]]);
  const sorted = [...values].sort((a, b) => a - b);
  [2 - Math.SQRT2, 2, 2 + Math.SQRT2].forEach((v, i) => assert.ok(Math.abs(sorted[i] - v) < 1e-10));
  // A·v = λ·v for each column
  values.forEach((l, k) => {
    const v = vectors.map(r => r[k]);
    const Av = [2 * v[0] + v[1], v[0] + 2 * v[1] + v[2], v[1] + 2 * v[2]];
    Av.forEach((x, i) => assert.ok(Math.abs(x - l * v[i]) < 1e-10));
  });
});

test('Direct (envelope Cholesky) and iterative (IC-CG) solves agree on a stiffness matrix', () => {
  const fea = new FEAEngine();
  autoMesh(fea, beam(), ELEMENT_TYPES.TET4, 'coarse');
  const mesh = fea.solidMesh!;
  const n = mesh.nodes.length * 3;
  const K = new SparseMatrix(n);
  const engine = fea as unknown as { computeTet4Stiffness(c: ArrayLike<number>[], E: number, nu: number): { Ke: Float64Array[] } };
  for (const el of mesh.elements) {
    const en = el.nodes.slice(0, 4);
    const { Ke } = engine.computeTet4Stiffness(en.map(i => mesh.nodes[i].posMeters), E, 0.3);
    const d = en.flatMap(i => [i * 3, i * 3 + 1, i * 3 + 2]);
    d.forEach((r, a) => d.forEach((c, b) => K.add(r, c, Ke[a][b])));
  }
  const fixed = new Map<number, number>();
  mesh.nodes.forEach((nd, i) => { if (nd.point.z < 1e-6) [0, 1, 2].forEach(k => fixed.set(i * 3 + k, 0)); });
  const b = new Float64Array(n);
  for (let i = 1; i < n; i += 3) if (!fixed.has(i)) b[i] = -1;
  K.applyDirichlet(fixed, b);
  const x1 = EnvelopeCholesky.create(K)!.solve(b);
  const x2 = new SpdSolver(K).solve(b, 1e-12);
  let maxDiff = 0, maxX = 0;
  for (let i = 0; i < n; i++) { maxDiff = Math.max(maxDiff, Math.abs(x1[i] - x2[i])); maxX = Math.max(maxX, Math.abs(x1[i])); }
  assert.ok(maxDiff / maxX < 1e-6, `relative difference ${maxDiff / maxX}`);
  assert.equal(EnvelopeCholesky.create(K, 10), null, 'too big for the limit: fall back');
});

test('Cantilever beam: Tet10 matches the beam formula for the first modes; mass is exact', () => {
  const fea = new FEAEngine();
  autoMesh(fea, beam(), ELEMENT_TYPES.TET10, 'coarse');
  const r = solveModal(fea, { youngsModulus: E, poissonRatio: 0.3, density: rho, fixtures: fixedBack, modes: 4 });
  assert.equal(r.frequencies.length, 4);
  const f1 = cantilever(1.875104);
  // The square section bends equally both ways: two equal first modes
  for (const f of r.frequencies.slice(0, 2)) assert.ok(Math.abs(f - f1) / f1 < 0.01, `first bending ${f.toFixed(1)} vs ${f1.toFixed(1)} Hz`);
  // Second bending: Euler–Bernoulli ignores shear and rotary inertia, so a stubby beam (L/h = 10) is a few % lower
  const f2 = cantilever(4.694091);
  for (const f of r.frequencies.slice(2, 4)) assert.ok(f < f2 && f > 0.9 * f2, `second bending ${f.toFixed(0)} vs ${f2.toFixed(0)} Hz`);
  assert.ok(Math.abs(r.mass - 0.0785) < 1e-9, `mass ${r.mass}`);
  // Shapes: the fixed end does not move; the free end moves most
  const shape = r.shapes[0];
  fea.solidMesh!.nodes.forEach((nd, i) => { if (nd.point.z < 1e-6) assert.equal(Math.hypot(shape[i * 3], shape[i * 3 + 1], shape[i * 3 + 2]), 0); });
  let maxTip = 0;
  fea.solidMesh!.nodes.forEach((nd, i) => { if (nd.point.z > 99.99) maxTip = Math.max(maxTip, Math.hypot(shape[i * 3], shape[i * 3 + 1], shape[i * 3 + 2])); });
  assert.ok(Math.abs(maxTip - 1) < 1e-9, 'normalised: the tip moves 1');
});

test('Modal analysis through the worker path: packed and unpacked', () => {
  const g = beam();
  const req = {
    positions: Float32Array.from(g.getAttribute('position').array as ArrayLike<number>),
    index: g.getIndex() ? Uint32Array.from(g.getIndex()!.array as ArrayLike<number>) : null,
    elementType: ELEMENT_TYPES.TET4, load: 0, yieldStrength: 250e6, youngsModulus: E, poissonRatio: 0.3,
    quality: 'coarse' as const, setup: { fixedFace: 'zMin' as const, loadFace: 'zMax' as const, loadDirection: '-Y' as const },
    analysis: 'modal' as const, density: rho, modes: 3,
  };
  const out = unpack(runSolve(req));
  assert.equal(out.results, null);
  assert.equal(out.modal!.frequencies.length, 3);
  assert.equal(out.modal!.shapes.length, 3);
  assert.equal(out.modal!.shapes[0].length, out.mesh!.nodes.length * 3);
  assert.ok(out.modal!.frequencies[0] > 0 && out.modal!.frequencies[0] < out.modal!.frequencies[2]);
});

test('simulation.modal command and api.model.naturalFrequencies (since 1.14)', async () => {
  const { useCADStore } = await import('../src/store/cadStore.ts');
  const { createCommandRegistry } = await import('../src/commands/builtinCommands.ts');
  const { createCasiWorksAPI } = await import('../src/api/CasiWorksAPI.ts');
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  assert.throws(() => r.execute('simulation.modal'), /solid body/);
  r.execute('file.loadExample', { id: 'l_bracket' });
  const out = r.execute('simulation.modal', { modes: 3, elementType: 'tet4' }) as { frequencies: number[]; mass: number; elements: number };
  assert.equal(out.frequencies.length, 3);
  assert.ok(out.frequencies[0] > 100 && out.frequencies[0] <= out.frequencies[1] && out.frequencies[1] <= out.frequencies[2]);
  assert.ok(out.mass > 0 && out.elements > 100);
  assert.match(s().statusMessage, /Natural frequencies: [\d.]+ Hz/);
  assert.throws(() => r.execute('simulation.modal', { fixedFace: 'top' }), /fixedFace must be one of/);
  assert.throws(() => r.execute('simulation.modal', { modes: 0 }), /modes must be/);

  const api = createCasiWorksAPI(useCADStore);
  const [major, minor] = api.version.split('.').map(Number);
  assert.ok(major > 1 || minor >= 14);
  const viaApi = api.model.naturalFrequencies({ modes: 3, elementType: 'tet4' });
  viaApi.frequencies.forEach((f, i) => assert.ok(Math.abs(f - out.frequencies[i]) < 1e-6 * f, 'same study, same answer'));
  assert.throws(() => api.model.naturalFrequencies({ quality: 'huge' as never }), /quality must be/);
  s().newProject();
});
