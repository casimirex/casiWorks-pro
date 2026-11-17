// CasiWorks Pro - FEA engine: beam deflection against Euler-Bernoulli, Tet4 stiffness and stress, Poisson fallback
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { feaEngine, ELEMENT_TYPES } from '../src/simulation/FEAEngine.ts';

test('FEAEngine: cantilever beam deflection matches Euler-Bernoulli analytical formula', () => {
  const geom = new THREE.BoxGeometry(20, 30, 500);
  feaEngine.generateMesh(geom, 10);
  const res = feaEngine.solve(1000, 350e6, 200e9);

  assert.ok(res.maxDisplacementMM > 0, 'Deflection must be positive');
  const errorPercent = Math.abs(res.maxDisplacementMM - res.theoreticalDispMM) / res.theoreticalDispMM * 100;

  assert.ok(errorPercent < 1.0, `FEA deflection error ${errorPercent.toFixed(3)}% must be < 1%`);
});

test('FEAEngine: 3D solid tetrahedral meshing, 12x12 stiffness matrix, and Cauchy stress tensor', () => {
  const geom = new THREE.BoxGeometry(20, 30, 100);
  const solidMesh = feaEngine.tetrahedralize(geom, { divisions: [2, 2, 4], elementType: ELEMENT_TYPES.TET4 });
  assert.ok(solidMesh, 'mesh generated');

  assert.ok(solidMesh.numElements > 0, 'Solid mesh must have tetrahedral elements');
  assert.ok(solidMesh.numNodes > 0, 'Solid mesh must have nodes');
  assert.ok(solidMesh.boundaryFaces.length > 0, 'Solid mesh must identify boundary faces');

  // Verify 12x12 stiffness matrix formulation
  const elem = solidMesh.elements[0];
  const nodeCoords = elem.nodes.map(nIdx => solidMesh.nodes[nIdx].posMeters);
  const tetStiffness = feaEngine.computeTet4Stiffness(nodeCoords, 200e9, 0.3);

  assert.ok(tetStiffness, 'Must compute Tet4 stiffness matrix');
  assert.equal(tetStiffness.Ke.length, 12, 'Ke must be 12x12');
  assert.equal(tetStiffness.Ke[0].length, 12, 'Ke must be 12x12');

  // Verify stiffness matrix symmetry: K_ij == K_ji
  let maxAsym = 0;
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 12; c++) {
      maxAsym = Math.max(maxAsym, Math.abs(tetStiffness.Ke[r][c] - tetStiffness.Ke[c][r]));
    }
  }
  assert.ok(maxAsym < 1e-6, `Ke must be strictly symmetric, maxAsym: ${maxAsym}`);

  // Solve 3D Solid Linear Static FEA
  const res3D = feaEngine.solveSolidFEA({
    loadMagnitude: 2000,
    yieldStrength: 350e6,
    youngsModulus: 200e9,
    poissonRatio: 0.3,
  });
  assert.ok(res3D, 'solved');

  assert.ok(res3D.maxDisplacementMM > 0, '3D solid deflection must be positive');
  assert.ok(res3D.maxStressMPa > 0, '3D solid von Mises stress must be positive');
  assert.ok(res3D.factorOfSafety > 0, 'Factor of safety must be positive');
  assert.ok(res3D.deformedGeometry instanceof THREE.BufferGeometry, 'Must generate deformed Three.js geometry');

  // Verify principal stresses & Cauchy tensor invariants
  const firstElemStress = res3D.elementStresses[0];
  assert.equal(firstElemStress.stress.length, 6, 'Must compute 6 Cauchy stress components');
  assert.equal(firstElemStress.principalStresses.length, 3, 'Must compute 3 principal stresses');
  assert.ok(firstElemStress.principalStresses[0] >= firstElemStress.principalStresses[1], 'sigma1 >= sigma2');
  assert.ok(firstElemStress.principalStresses[1] >= firstElemStress.principalStresses[2], 'sigma2 >= sigma3');
  assert.ok(firstElemStress.vonMises >= 0, 'von Mises stress >= 0');
});

test('FEA regression: missing or invalid Poisson ratio falls back to 0.3 instead of producing NaN', () => {
  const pts = [[0, 0, 0], [0.01, 0, 0], [0, 0.01, 0], [0, 0, 0.01]];
  const refRes = feaEngine.computeTet4Stiffness(pts, 200e9, 0.3);
  assert.ok(refRes, 'reference tetrahedron must produce a stiffness result');
  const ref = JSON.stringify(refRes);
  for (const bad of [undefined, null, 'abc', NaN]) {
    const json = JSON.stringify(feaEngine.computeTet4Stiffness(pts, 200e9, bad));
    assert.ok(!json.includes('null'), `nu=${String(bad)} must not yield NaN entries`);
    assert.equal(json, ref, `nu=${String(bad)} must use the 0.3 default`);
  }
});
