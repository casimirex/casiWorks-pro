// CasiWorks Pro - Fitted, graded FEA grids and the static solver on thin parts (roadmap 6.2)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FEAEngine, ELEMENT_TYPES } from '../src/simulation/FEAEngine.ts';
import { autoMesh, axisFeatures, gridLines, meshVolume, modelVolume, COVERAGE_TOLERANCE } from '../src/simulation/autoMesh.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';

const E = 200e9;
const near = (actual: number, expected: number, relTol: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) <= relTol * Math.abs(expected), `${msg}: got ${actual}, expected ${expected} ±${relTol * 100}%`);
const steps = (lines: number[]) => lines.slice(1).map((v, i) => v - lines[i]);
const quiet = <T>(f: () => T): T => {
  const realWarn = console.warn;
  console.warn = () => {};
  try { return f(); } finally { console.warn = realWarn; }
};

test('Grid lines: through every face level, graded at most 2.5× between neighbours, h/2 across curved spans', () => {
  // A 1.5 mm wall at 10–11.5 in a 0–60 span, cells of about 6
  const lines = gridLines(0, 60, { planes: [10, 11.5], zones: [] }, 6);
  assert.ok(lines.includes(10) && lines.includes(11.5), `wall faces are grid lines: ${lines}`);
  assert.equal(lines[0], 0);
  assert.equal(lines[lines.length - 1], 60);
  const s = steps(lines);
  assert.ok(s.every(v => v > 0 && v <= 6 + 1e-9), `cells ${s}`);
  for (let i = 1; i < s.length; i++) assert.ok(Math.max(s[i], s[i - 1]) / Math.min(s[i], s[i - 1]) <= 2.5 + 1e-9, `grading ${s[i - 1]} → ${s[i]}`);

  // A curved span (a hole from 20 to 30) gets cells of h/2; elsewhere h
  const holed = steps(gridLines(0, 60, { planes: [], zones: [[20, 30]] }, 6));
  assert.ok(Math.max(...holed) <= 6 + 1e-9 && Math.min(...holed) <= 3 + 1e-9, `refined across the hole: ${holed}`);
  // Curved faces nearly everywhere (a round part): no point refining, plain h
  assert.ok(steps(gridLines(0, 60, { planes: [], zones: [[0, 60]] }, 6)).every(v => v > 4), 'no refinement when everything is curved');

  // A face a rounding error inside the end is the end (no zero-width cell); one just inside makes a thin end slice
  assert.ok(steps(gridLines(-35, 35, { planes: [-35 + 1e-14, 0], zones: [] }, 6)).every(v => v > 1), 'no sliver at a rounding error');
  const slice = gridLines(-31.25, 31.25, { planes: [-31.064, -29.12], areas: [5000, 5000], zones: [] }, 6);
  assert.equal(slice[1], -31.064, 'the wall face just inside the end is kept');
  // Faces closer than a tenth of h: the larger one stays
  const merged = gridLines(0, 60, { planes: [20, 20.3], areas: [10, 900], zones: [] }, 6);
  assert.ok(merged.includes(20.3) && !merged.includes(20), `larger face kept: ${merged}`);
});

test('Thin walls are meshed at their thickness: the sheet-metal enclosure within the coverage tolerance at every size', () => {
  quiet(() => {
    useCADStore.getState().loadExampleModel(CAD_EXAMPLES.find(e => e.id === 'sheet_enclosure')!.create());
    rebuildModel(useCADStore);
  });
  const g = useCADStore.getState().bodies[0].geometry;
  const f = axisFeatures(g);
  assert.ok(f.x.planes.length >= 4, `the side walls' faces are found: ${f.x.planes}`);
  for (const q of ['coarse', 'medium', 'fine'] as const) {
    const fea = new FEAEngine();
    const info = autoMesh(fea, g, ELEMENT_TYPES.TET4, q);
    // Was 58% (coarse) and 155% (medium) with an equal grid
    assert.ok(Math.abs(info.coverage - 1) <= COVERAGE_TOLERANCE, `${q}: coverage ${info.coverage}`);
    near(meshVolume(fea.solidMesh!) / modelVolume(g), info.coverage, 1e-9, `${q}: reported coverage`);
    assert.ok(info.cellRange![0] > 0 && info.cellRange![0] <= info.cellRange![1], `${q}: cells ${info.cellRange}`);
  }
});

test('A 2 mm plate in bending matches beam theory, and the solver reports how it converged', () => {
  // 100 long (z), 20 wide (x), 2 thick (y): thinner than the cells of an equal grid
  const g = new THREE.BoxGeometry(20, 2, 100);
  const fea = new FEAEngine();
  autoMesh(fea, g, ELEMENT_TYPES.TET10, 'medium');
  const r = fea.solve(10, 250e6, E, 0.3, { fixtures: [{ type: 'fixed', plane: 'zMin' }], loads: [{ type: 'force', plane: 'zMax', direction: [0, -1, 0], magnitude: 10 }] });
  const I = 0.02 * 0.002 ** 3 / 12;
  near(r.maxDisplacementMM, (10 * 0.1 ** 3) / (3 * E * I) * 1000, 0.04, 'tip deflection (1.25 mm)');
  assert.equal(r.solverConverged, true);
  assert.ok(fea.lastSolve && ['direct', 'ic-cg'].includes(fea.lastSolve.method) && fea.lastSolve.residual < 1e-6, JSON.stringify(fea.lastSolve));
});

test('Pieces of a mesh joined to the rest only at an edge, or not at all, are dropped', () => {
  // Two boxes apart: the larger one is kept, with no unused nodes
  const big = new THREE.BoxGeometry(20, 10, 10).toNonIndexed();
  const small = new THREE.BoxGeometry(4, 4, 4).toNonIndexed().translate(20, 0, 0);
  const pos = new Float32Array([...big.getAttribute('position').array, ...small.getAttribute('position').array]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const fea = new FEAEngine();
  fea.generateMesh(g, { elementType: ELEMENT_TYPES.TET4, divisions: 16 });
  const mesh = fea.solidMesh!;
  assert.ok(mesh.nodes.every(n => n.point.x <= 10 + 1e-9), 'only the big box is left');
  const used = new Set(mesh.elements.flatMap(e => e.nodes));
  assert.equal(used.size, mesh.nodes.length, 'no unused nodes');
  mesh.nodes.forEach((n, i) => assert.equal(n.id, i));
  const r = fea.solve(100, 250e6, E, 0.3, { fixtures: [{ type: 'fixed', plane: 'xMin' }], loads: [{ type: 'force', plane: 'zMax', direction: [0, -1, 0], magnitude: 100 }] });
  assert.ok(Number.isFinite(r.maxDisplacementMM) && r.solverConverged, `solves: ${r.maxDisplacementMM}`);
});
