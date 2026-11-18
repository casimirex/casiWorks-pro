// CasiWorks Pro - FEA fixtures and loads on picked faces (roadmap 6.3)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { FEAEngine, ELEMENT_TYPES } from '../src/simulation/FEAEngine.ts';
import { autoMesh } from '../src/simulation/autoMesh.ts';
import { studyBoundary, setupProblems, modalSetupProblems, fixturesFor, loadsFor, faceChoiceLabel } from '../src/simulation/studySetup.ts';
import type { StudySetup } from '../src/simulation/studySetup.ts';
import { studyFaceAt, resolveStudyFace, nodesOnFace, studyFaceLabel, sameStudyFace, faceAnchors } from '../src/simulation/studyFaces.ts';
import type { StudyFace } from '../src/simulation/studyFaces.ts';
import { runSolve } from '../src/simulation/feaTransfer.ts';
import { naturalFrequencies } from '../src/simulation/modal.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';
import type { SketchEntity } from '../src/types/cad.ts';

const E = 200e9;
const near = (actual: number, expected: number, relTol: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) <= relTol * Math.abs(expected), `${msg}: got ${actual}, expected ${expected} ±${relTol * 100}%`);
const s = useCADStore.getState;
const quiet = <T>(f: () => T): T => {
  const realWarn = console.warn;
  console.warn = () => {};
  try { return f(); } finally { console.warn = realWarn; }
};

/** The first triangle of a geometry whose normal points along `n` and whose centre passes `where`. */
function triangleWhere(geometry: THREE.BufferGeometry, n: [number, number, number], where: (c: THREE.Vector3) => boolean = () => true): number {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const want = new THREE.Vector3(...n);
  for (let t = 0; t < pos.count / 3; t++) {
    const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3(pos.getX(t * 3 + k), pos.getY(t * 3 + k), pos.getZ(t * 3 + k)));
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    if (normal.dot(want) > 0.999 && where(a.clone().add(b).add(c).divideScalar(3))) return t;
  }
  return -1;
}

/** A face of the L-bracket's current body from a triangle test. */
function bracket(): THREE.BufferGeometry {
  return s().bodies[0].geometry as THREE.BufferGeometry;
}
function loadBracket() {
  quiet(() => {
    s().loadExampleModel(CAD_EXAMPLES.find(e => e.id === 'l_bracket')!.create());
    rebuildModel(useCADStore);
  });
}
/** The cylinder faces of the bracket's holes, found by clicking the triangles of each bore. */
function holes(geometry: THREE.BufferGeometry): StudyFace[] {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const out: StudyFace[] = [];
  for (let t = 0; t < pos.count / 3 && out.length < 2; t++) {
    const f = studyFaceAt(geometry, t);
    if (f?.kind === 'cylinder' && f.hole && !out.some(o => sameStudyFace(o, f))) out.push(f);
  }
  return out;
}

test('Picked end faces of a cantilever give the same answer as the bounding-box sides', () => {
  const geometry = new THREE.BoxGeometry(10, 10, 100);
  const back = studyFaceAt(geometry, triangleWhere(geometry, [0, 0, -1]))!;
  const front = studyFaceAt(geometry, triangleWhere(geometry, [0, 0, 1]))!;
  assert.equal(back.kind, 'plane');
  near(back.area, 100, 1e-6, 'back face area (mm²)');
  assert.equal(studyFaceLabel(back), 'Flat face, 100 mm²');

  const solve = (setup: StudySetup) => {
    const fea = new FEAEngine();
    fea.generateMesh(geometry, { elementType: ELEMENT_TYPES.TET10 });
    return fea.solve(1000, 250e6, E, 0.3, studyBoundary(setup, geometry, fea.solidMesh!, 1000));
  };
  const box = solve({ fixedFace: 'zMin', loadFace: 'zMax', loadDirection: '-Y' });
  const picked = solve({ fixedFace: 'faces', fixedFaces: [back], loadFace: 'faces', loadFaces: [front], loadDirection: '-Y' });
  near(picked.maxDisplacementMM, box.maxDisplacementMM, 1e-9, 'tip deflection');
  near(picked.maxStressMPa, box.maxStressMPa, 1e-9, 'max stress');
  const I = 0.01 ** 4 / 12;
  near(picked.maxDisplacementMM, (1000 * 0.1 ** 3) / (3 * E * I) * 1000, 0.04, 'beam theory');

  // The mesh nodes on the picked back face are exactly the nodes at z = −50 (Tet10 mid-edge nodes included)
  const fea = new FEAEngine();
  fea.generateMesh(geometry, { elementType: ELEMENT_TYPES.TET10 });
  const mesh = fea.solidMesh!;
  const onPlane = mesh.nodes.map((n, i) => (Math.abs(n.point.z + 50) < 1e-6 ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(nodesOnFace(mesh, resolveStudyFace(geometry, back)!), onPlane);
});

test('A part fixed by its two bolt holes and loaded on a face: the holes hold, the load face moves', () => {
  loadBracket();
  const geometry = bracket();
  const bores = holes(geometry);
  assert.equal(bores.length, 2, 'two holes found');
  for (const h of bores) {
    assert.equal(h.kind, 'cylinder');
    if (h.kind === 'cylinder') near(h.radius, 5, 0.02, 'hole radius');
    assert.match(studyFaceLabel(h), /^Hole Ø10(\.\d+)? mm$/);
  }
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  // The upright's top face: the face at the part's top, normal +Y
  const topTri = triangleWhere(geometry, [0, 1, 0], c => Math.abs(c.y - bb.max.y) < 1e-6);
  const top = studyFaceAt(geometry, topTri)!;
  assert.equal(top.kind, 'plane');

  const setup: StudySetup = { fixedFace: 'faces', fixedFaces: bores, loadFace: 'faces', loadFaces: [top], loadDirection: '-Y' };
  assert.deepEqual(setupProblems(setup), []);
  assert.match(faceChoiceLabel(setup, 'fixed'), /^2 faces: Hole Ø10/);

  const fea = new FEAEngine();
  autoMesh(fea, geometry, ELEMENT_TYPES.TET10, 'medium');
  const mesh = fea.solidMesh!;
  const boundary = studyBoundary(setup, geometry, mesh, 500);
  const held = boundary.fixtures[0].nodeIndices!;
  assert.ok(held.length > 8, `nodes held in the holes: ${held.length}`);
  // Every held node is near one of the bore surfaces
  const cell = Math.max(mesh.cellSize!.x, mesh.cellSize!.y, mesh.cellSize!.z);
  for (const i of held) {
    const p = mesh.nodes[i].point;
    const d = Math.min(...bores.map(b => {
      if (b.kind !== 'cylinder') return Infinity;
      const a = new THREE.Vector3(b.axis.x, b.axis.y, b.axis.z);
      const r = p.clone().sub(new THREE.Vector3(b.point.x, b.point.y, b.point.z));
      return Math.abs(r.addScaledVector(a, -r.dot(a)).length() - b.radius);
    }));
    assert.ok(d < cell, `held node ${i} is ${d} mm from a bore (cell ${cell})`);
  }
  const r = fea.solve(500, 276e6, 69e9, 0.33, boundary);
  assert.ok(r.maxDisplacementMM > 0 && Number.isFinite(r.maxStressMPa), `solved: ${r.maxDisplacementMM} mm, ${r.maxStressMPa} MPa`);
  const disp = r.solidResult!.displacementVectors;
  const heldMax = Math.max(...held.map(i => disp[i].length()));
  const loaded = boundary.loads[0].nodeIndices!;
  const loadedMean = loaded.reduce((a, i) => a + disp[i].length(), 0) / loaded.length;
  assert.ok(heldMax < 1e-12, `held nodes stay put: ${heldMax}`);
  assert.ok(loadedMean > 0, 'the loaded face moves');

  // The worker path does the same
  const packed = runSolve({
    positions: new Float32Array((geometry.index ? geometry.toNonIndexed() : geometry).getAttribute('position').array),
    index: null, elementType: ELEMENT_TYPES.TET10, load: 500, yieldStrength: 276e6, youngsModulus: 69e9, poissonRatio: 0.33, quality: 'medium', setup,
  });
  near(packed.results!.maxDisplacementMM, r.maxDisplacementMM, 1e-6, 'worker solve');

  // Modal with the holes held: fewer rigid modes means a finite first frequency
  const m = naturalFrequencies(geometry, { youngsModulus: 69e9, poissonsRatio: 0.33, density: 2700 }, { fixedFaces: bores, modes: 2 });
  assert.ok(m.frequencies[0] > 10, `first frequency ${m.frequencies[0]} Hz`);
});

test('Picked faces are found again after the part changes; problems are reported', () => {
  loadBracket();
  const before = holes(bracket());
  // Move both holes 3 mm along x and make them Ø12
  const map = structuredClone(s().sketchEntities);
  for (const list of Object.values(map)) for (const e of list as SketchEntity[]) {
    if (e.type === 'circle' && (e.id === 'h1' || e.id === 'h2')) { e.center = { x: e.center.x + 3, y: e.center.y }; e.radius = 6; }
  }
  useCADStore.setState({ sketchEntities: map, needsRebuild: true });
  quiet(() => rebuildModel(useCADStore));
  const after = bracket();
  for (const h of before) {
    const tris = resolveStudyFace(after, h);
    assert.ok(tris && tris.length > 0, 'hole found again');
    // Every point of it lies on the moved (3 mm along x), larger (Ø12) hole
    if (h.kind !== 'cylinder') continue;
    const a = new THREE.Vector3(h.axis.x, h.axis.y, h.axis.z);
    const c = new THREE.Vector3(h.point.x + 3, h.point.y, h.point.z);
    for (let i = 0; i < tris!.length / 3; i++) {
      const radial = new THREE.Vector3().fromArray(tris!, i * 3).sub(c);
      radial.addScaledVector(a, -radial.dot(a));
      assert.ok(Math.abs(radial.length() - 6) < 0.05, `point on the moved Ø12 hole: r = ${radial.length()}`);
    }
  }

  const back = { kind: 'plane', point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: -1 }, area: 100 } as StudyFace;
  assert.deepEqual(setupProblems({ fixedFace: 'faces', fixedFaces: [], loadFace: 'zMax', loadDirection: '-Y' }), ['Pick a face to fix: click Pick, then a face on the model']);
  assert.deepEqual(setupProblems({ fixedFace: 'faces', fixedFaces: [back], loadFace: 'faces', loadFaces: [back], loadDirection: '-Y' }), ['The load must act on a different face from the fixed one']);
  assert.deepEqual(setupProblems({ fixedFace: 'faces', fixedFaces: [back], loadFace: 'zMin', loadDirection: '-Y' }), []);
  assert.deepEqual(modalSetupProblems({ fixedFace: 'faces', loadFace: 'zMax', loadDirection: '-Y' }).length, 1);
  // Box sides still work through the old helpers
  assert.deepEqual(fixturesFor({ fixedFace: 'xMin', loadFace: 'xMax', loadDirection: '-Y' }), [{ type: 'fixed', plane: 'xMin' }]);
  assert.equal(loadsFor({ fixedFace: 'xMin', loadFace: 'xMax', loadDirection: '+Z' }, -20)[0].magnitude, 20);

  // A face that has gone: a flat face far from everything facing a way nothing faces
  const gone = { kind: 'plane', point: { x: 0, y: 0, z: 0 }, normal: { x: 0.6, y: 0.8, z: 0 }, area: 10 } as StudyFace;
  assert.equal(resolveStudyFace(after, gone), null);
  const fea = new FEAEngine();
  autoMesh(fea, after, ELEMENT_TYPES.TET4, 'coarse');
  assert.throws(() => studyBoundary({ fixedFace: 'faces', fixedFaces: [gone], loadFace: 'zMax', loadDirection: '-Y' }, after, fea.solidMesh!, 1), /not on the part any more/);

  // Load arrows spread over a face
  const plate = new THREE.BoxGeometry(40, 10, 20);
  const tri = triangleWhere(plate, [0, 1, 0]);
  const anchors = faceAnchors(resolveStudyFace(plate, studyFaceAt(plate, tri)!)!, 5);
  assert.ok(anchors.length >= 2 && anchors.every(p => Math.abs(p.y - 5) < 1e-6), 'anchors on the top face');
});

test('Commands and API 1.19: study faces picked by points; picking clicks toggle faces', async () => {
  const { commands } = await import('../src/commands/index.ts');
  const { createCasiWorksAPI } = await import('../src/api/CasiWorksAPI.ts');
  const api = createCasiWorksAPI(useCADStore, { commands });
  assert.equal(api.version, '1.19.0');
  loadBracket();
  // Points on the two bore walls (holes Ø10 at x = 15 and x = −10) and on the face at y = 20
  const r = commands.execute('simulation.study', { fixed: [{ x: 20, y: 0, z: 6 }, { x: -5, y: 0, z: 6 }], load: [{ x: 0, y: 20, z: 6 }], direction: '-Y' }) as { fixed: string; load: string; problems: string[] };
  assert.match(r.fixed, /^2 faces: Hole Ø10(\.\d+)? mm, Hole Ø10(\.\d+)? mm$/);
  assert.match(r.load, /^Flat face, /);
  assert.deepEqual(r.problems, []);
  assert.equal(s().feaSetup.fixedFace, 'faces');
  assert.throws(() => commands.execute('simulation.study', { fixed: [{ x: 'a' }] }), /array of points/);
  assert.throws(() => commands.execute('simulation.study', { direction: 'up' }), /direction must be/);
  commands.execute('simulation.study', { fixed: 'zMin' });
  assert.equal(s().feaSetup.fixedFace, 'zMin');
  assert.equal(s().feaSetup.fixedFaces?.length, 2, 'picked faces are kept for when they are chosen again');

  // Picking: a click toggles a face; Esc (edit.cancel) stops picking
  commands.execute('simulation.pickFaces', { target: 'load' });
  assert.equal(s().feaFacePick, 'load');
  const face = s().feaSetup.loadFaces![0];
  s().toggleFeaFace('load', face);
  assert.equal(s().feaSetup.loadFaces!.length, 0, 'clicked again: removed');
  s().toggleFeaFace('load', face);
  assert.equal(s().feaSetup.loadFaces!.length, 1);
  commands.execute('edit.cancel');
  assert.equal(s().feaFacePick, null);
  assert.throws(() => commands.execute('simulation.pickFaces', { target: 'both' }), /target must be/);

  // Another part: the picked faces are dropped
  quiet(() => s().newProject());
  assert.equal(s().feaSetup.fixedFaces, undefined);
  assert.notEqual(s().feaSetup.loadFace, 'faces');

  // Modal with the holes held, through the API
  loadBracket();
  const m = api.model.naturalFrequencies({ fixedFaces: [{ x: 20, y: 0, z: 6 }, { x: -5, y: 0, z: 6 }], modes: 1 });
  const free = api.model.naturalFrequencies({ fixedFace: 'zMin', modes: 1 });
  assert.ok(m.frequencies[0] > 10 && Math.abs(m.frequencies[0] - free.frequencies[0]) > 1, `held by the holes ${m.frequencies[0]} Hz vs by the back ${free.frequencies[0]} Hz`);
});
