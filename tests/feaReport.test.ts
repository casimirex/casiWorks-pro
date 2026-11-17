// CasiWorks Pro - FEA result probes and the study report
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { buildResultPlot, plotPositionOf, probeAt } from '../src/simulation/resultPlot.ts';
import { feaReportHtml } from '../src/simulation/report.ts';
import type { FeaReportData } from '../src/simulation/report.ts';
import { useCADStore } from '../src/store/cadStore.ts';

/** One tetrahedron: 4 nodes, its 4 faces on the surface. */
function tet() {
  const nodes = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]].map(([x, y, z]) => ({ point: new THREE.Vector3(x, y, z) }));
  const boundaryFaces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]].map(n => ({ nodes: n }));
  const result = {
    nodalVonMisesMPa: new Float32Array([10, 20, 30, 40]),
    displacementVectors: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1e-5, 0), new THREE.Vector3(0, -2e-5, 0), new THREE.Vector3(3e-5, 0, 4e-5)],
  };
  return { mesh: { nodes, boundaryFaces, size: new THREE.Vector3(10, 10, 10) }, result };
}

test('Probes: every plot vertex maps to its node, with stress and displacement whatever is plotted', () => {
  const { mesh, result } = tet();
  for (const quantity of ['vonMises', 'displacement'] as const) {
    const plot = buildResultPlot(mesh, result, { quantity });
    assert.equal(plot.vertexNodes.length, 12, '4 triangles × 3 corners');
    const v = Array.from(plot.vertexNodes).indexOf(3);
    const p = probeAt(plot, v)!;
    assert.equal(p.node, 3);
    assert.deepEqual(p.point, { x: 0, y: 0, z: 10 });
    assert.ok(Math.abs(p.vonMisesMPa - 40) < 1e-6);
    assert.ok(Math.abs(p.displacementMM - 0.05) < 1e-6, '|(3, 0, 4)·1e-5 m| = 0.05 mm');
  }
  const deformed = buildResultPlot(mesh, result, { deformed: true });
  const at = plotPositionOf(deformed, 3)!;
  assert.ok(at[2] > 10, 'the probe follows the deformed shape');
  assert.equal(probeAt(deformed, 999), null);
});

test('Probes in the store: no duplicates, at most 12, cleared by New', () => {
  const s = useCADStore.getState;
  s().newProject();
  const probe = (node: number) => ({ node, point: { x: node, y: 0, z: 0 }, vonMisesMPa: node, displacementMM: 0.01 });
  s().addFeaProbe(probe(1));
  s().addFeaProbe(probe(1));
  assert.equal(s().feaProbes.length, 1);
  assert.match(s().statusMessage, /^Probe 1: 1\.0 MPa, 0\.0100 mm$/);
  for (let i = 2; i <= 14; i++) s().addFeaProbe(probe(i));
  assert.equal(s().feaProbes.length, 12);
  assert.equal(s().feaProbes[0].node, 3, 'oldest dropped');
  s().newProject();
  assert.deepEqual(s().feaProbes, []);
});

const DATA: FeaReportData = {
  documentName: 'Bracket <A>',
  date: '2026-11-17 12:40',
  material: { name: 'Aluminum 6061-T6', youngsModulus: 68.9e9, poissonsRatio: 0.33, yieldStrength: 276e6, density: 2700 },
  setup: { fixedFace: 'zMin', loadFace: 'zMax', loadDirection: '-Y' },
  load: 5000,
  elementType: 'tet10',
  mesh: { elements: 5040, nodes: 7800, coverage: 0.98, quality: 'medium' },
  results: { maxStressMPa: 99.1, minStressMPa: 0.2, maxDisplacementMM: 0.093692, factorOfSafety: 2.79 },
  requiredSafetyFactor: 1.5,
  probes: [{ node: 7, point: { x: 1, y: 2, z: 3 }, vonMisesMPa: 45.5, displacementMM: 0.012 }],
  image: 'data:image/png;base64,iVBORw0KGgo=',
};

test('Report: verdict, results, setup, material, mesh, probes and the image; text is escaped', () => {
  const html = feaReportHtml(DATA);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Bracket &lt;A&gt; – FEA report<\/title>/, 'escaped');
  assert.doesNotMatch(html, /<A>/);
  assert.match(html, /FEA report · 2026-11-17 12:40/);
  assert.match(html, /PASS: safety factor 2\.79 ≥ 1\.5/);
  assert.match(html, /99\.1 MPa/);
  assert.match(html, /0\.09369 mm/);
  assert.match(html, /Back \(−Z\)/);
  assert.match(html, /Front \(\+Z\)/);
  assert.match(html, /5,000 N towards -Y/);
  assert.match(html, /68\.9 GPa/);
  assert.match(html, /276 MPa/);
  assert.match(html, /5,040 · 7,800/);
  assert.match(html, /98%/);
  assert.match(html, /<td>45\.5<\/td><td>0\.012<\/td>/);
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(html, /class="warn"/);

  const fail = feaReportHtml({ ...DATA, results: { ...DATA.results, factorOfSafety: 1.2 }, image: 'javascript:alert(1)', probes: [], stale: true });
  assert.match(fail, /FAIL: safety factor 1\.2 &lt; 1\.5|FAIL: safety factor 1\.2 < 1\.5/);
  assert.doesNotMatch(fail, /<img/, 'only PNG data URLs are embedded');
  assert.doesNotMatch(fail, /<h2>Probes<\/h2>/);
  assert.match(fail, /class="warn"/);
});
