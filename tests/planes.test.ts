// CasiWorks Pro - Reference planes and sketching on faces
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { faceFrame, getSketchPlaneMatrix, planeFrameOf, referencePlaneFrame, sketchToWorld, worldToSketch } from '../src/utils/math.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';
import type { PlaneFrame, SketchFeature } from '../src/types/cad.ts';

const near = (a: number, b: number, msg = '') => assert.ok(Math.abs(a - b) < 1e-6, `${msg} ${a} ≠ ${b}`);
const nearV = (a: { x: number; y: number; z: number }, b: [number, number, number], msg = '') => { near(a.x, b[0], msg); near(a.y, b[1], msg); near(a.z, b[2], msg); };
const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4, msg: string) => a.elements.forEach((v, i) => near(v, b.elements[i], msg));

test('Plane frames: standard planes, faces lining up with them, reference planes', () => {
  for (const p of ['Front', 'Top', 'Right'] as const) {
    sameMatrix(getSketchPlaneMatrix(planeFrameOf(p)), getSketchPlaneMatrix(p), `${p} as a frame`);
  }
  // Front, top and right faces of a part line up with the standard planes, moved out
  sameMatrix(getSketchPlaneMatrix(faceFrame({ x: 5, y: 3, z: 20 }, { x: 0, y: 0, z: 1 })), new THREE.Matrix4().makeTranslation(0, 0, 20).multiply(getSketchPlaneMatrix('Front')), 'front face');
  sameMatrix(getSketchPlaneMatrix(faceFrame({ x: 1, y: 12, z: 2 }, { x: 0, y: 1, z: 0 })), new THREE.Matrix4().makeTranslation(0, 12, 0).multiply(getSketchPlaneMatrix('Top')), 'top face');
  sameMatrix(getSketchPlaneMatrix(faceFrame({ x: 30, y: 1, z: 2 }, { x: 1, y: 0, z: 0 })), new THREE.Matrix4().makeTranslation(30, 0, 0).multiply(getSketchPlaneMatrix('Right')), 'right face');
  // Walls are upright from any side: sketch Y is model up
  for (const n of [{ x: 0, y: 0, z: -1 }, { x: -1, y: 0, z: 0 }, { x: 0.6, y: 0, z: 0.8 }]) {
    const up = new THREE.Vector3(0, 1, 0).transformDirection(getSketchPlaneMatrix(faceFrame({ x: 0, y: 0, z: 0 }, n)));
    nearV(up, [0, 1, 0], `wall ${JSON.stringify(n)}`);
  }
  // Round trip on an arbitrary frame
  const f: PlaneFrame = { origin: { x: 10, y: -5, z: 3 }, xAxis: { x: 1, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 2 } };
  const w = sketchToWorld({ x: 4, y: 7 }, f);
  const back = worldToSketch(w, f);
  near(back.x, 4); near(back.y, 7);
  // Reference plane: Top moved up 25, then tilted 30° about its X axis
  const r = referencePlaneFrame('Top', 25, 30);
  nearV(r.origin, [0, 25, 0], 'offset along the Top normal (+Y)');
  nearV(r.xAxis, [1, 0, 0]);
  nearV(r.normal, [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], 'tilted normal');
});

test('Reference plane: a sketch on it extrudes from it and follows it when the offset changes', () => {
  const api = createCasiWorksAPI(useCADStore);
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  api.document.new();
  const { featureId: plane } = r.execute('feature.create', { type: 'reference_plane', name: 'Plane1', base: 'Front', offset: 30, angle: 0 }) as { featureId: string };
  const { sketchId, featureId: sketchFeature } = r.execute('sketch.create', { plane, entities: [{ type: 'line', p1: { x: 0, y: 0 }, p2: { x: 20, y: 0 } }, { type: 'line', p1: { x: 20, y: 0 }, p2: { x: 20, y: 10 } }, { type: 'line', p1: { x: 20, y: 10 }, p2: { x: 0, y: 10 } }, { type: 'line', p1: { x: 0, y: 10 }, p2: { x: 0, y: 0 } }] }) as { sketchId: string; featureId: string };
  const sk = s().features.find(f => f.id === sketchFeature) as SketchFeature;
  assert.equal(sk.planeRef, plane);
  assert.deepEqual(sk.parentIds, [plane], 'depends on the plane');
  const boss = api.features.extrude({ sketchId, depth: 5 });
  let box = api.model.boundingBox()!;
  nearV(box.min, [0, 0, 30], 'starts on the plane'); nearV(box.max, [20, 10, 35]);

  api.features.update(plane, { offset: 50 });
  box = api.model.boundingBox()!;
  nearV(box.min, [0, 0, 50], 'moved with the plane'); nearV(box.max, [20, 10, 55]);

  // Equations can drive the plane
  api.equations.set([{ name: 'h', expression: '12' }]);
  api.equations.link(plane, 'offset', 'h * 2');
  near(api.model.boundingBox()!.min.z, 24);

  // Suppressing the plane suppresses the sketch and the extrude (no solid left)
  api.features.setSuppressed(plane, true);
  assert.equal(api.model.hasBody(), false);
  api.features.setSuppressed(boss, false); // unsuppressing a child brings its parents back
  assert.equal(api.features.get(plane).suppressed, false);
  assert.equal(api.model.hasBody(), true);

  // Saved and loaded
  const json = api.document.toJSON();
  api.document.new();
  api.document.load(json);
  near(api.model.boundingBox()!.min.z, 24, 'after load');
  api.document.new();
});

test('Tilted plane: an extrude leaves along the tilted normal', () => {
  const api = createCasiWorksAPI(useCADStore);
  const r = createCommandRegistry(useCADStore);
  api.document.new();
  const { featureId: plane } = r.execute('feature.create', { type: 'reference_plane', base: 'Top', offset: 0, angle: 90 }) as { featureId: string };
  // Top tilted 90° about X is the Front plane flipped: normal −Z... check against the frame itself
  const f = referencePlaneFrame('Top', 0, 90);
  const { sketchId } = r.execute('sketch.create', { plane, entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 5 }] }) as { sketchId: string };
  api.features.extrude({ sketchId, depth: 10 });
  const box = api.model.boundingBox()!;
  const c = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  nearV(c, [f.normal.x * 5, f.normal.y * 5, f.normal.z * 5], 'centre 5 mm along the plane normal');
  api.document.new();
});

test('Sketch on a face: from a click, a frame; confirmed sketches keep it; macros record it', () => {
  const api = createCasiWorksAPI(useCADStore);
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  api.document.new();
  const base = api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -20, y: -10 }, corner2: { x: 20, y: 10 } }] });
  api.features.extrude({ sketchId: base.sketchId, depth: 15 });

  r.execute('sketch.onFace');
  assert.equal(s().activeTool, 'sketch_on_face');
  r.execute('sketch.onFace', { point: { x: 3, y: 2, z: 15 }, normal: { x: 0, y: 0, z: 1 } });
  assert.equal(s().isSketchActive, true);
  const frame = s().activeSketchPlane as PlaneFrame;
  nearV(frame.origin, [0, 0, 15], 'plane of the front face');
  assert.ok(s().viewFrame, 'the view looks straight at the face');
  s().addSketchEntity({ id: 'c1', type: 'circle', center: { x: 0, y: 0 }, radius: 4 });
  const exit = r.execute('sketch.exit') as { sketchId: string; featureId: string };
  const sk = s().features.find(f => f.id === exit.featureId) as SketchFeature;
  nearV(sk.frame!.origin, [0, 0, 15]);
  assert.equal((r.macroStepFor({ id: 'sketch.exit', args: undefined, ok: true, result: { ...exit, created: true } } as never)!.args as { plane: PlaneFrame }).plane.origin.z, 15, 'macro keeps the face plane');

  // A boss on the face: the part grows from z = 15
  api.features.extrude({ sketchId: exit.sketchId, depth: 5 });
  near(api.model.boundingBox()!.max.z, 20);

  assert.throws(() => r.execute('sketch.onFace', { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 } }), /normal non-zero/);
  assert.throws(() => r.execute('sketch.new', { plane: 'Diagonal' }), /reference plane id/);
  api.document.new();
});

test('API 1.9: reference planes and sketches on them or on a frame', () => {
  const api = createCasiWorksAPI(useCADStore);
  api.document.new();
  const plane = api.features.referencePlane({ base: 'Right', offset: 15 });
  assert.equal(api.features.get(plane).name, 'Plane1');
  const s = api.sketches.create({ plane, entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 3 }] });
  api.features.extrude({ sketchId: s.sketchId, depth: 4 });
  const box = api.model.boundingBox()!;
  near(box.min.x, 15, 'from the plane at x = 15'); near(box.max.x, 19);
  const onFrame = api.sketches.create({ plane: { origin: { x: 0, y: 40, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }, entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 3 }] });
  api.features.extrude({ sketchId: onFrame.sketchId, depth: 2 });
  near(api.model.boundingBox()!.max.y, 42, 'on the frame at y = 40');
  for (const bad of [{ plane: 'Diagonal' }, { plane: { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: 0, z: 1 } } }]) {
    assert.throws(() => api.sketches.create({ ...bad, entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 1 }] } as never), /plane/);
  }
  assert.throws(() => api.features.referencePlane({ angle: 90 }), /angle/);
  api.document.new();
});
