// CasiWorks Pro - Measure tool
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatMm, measure, snapPick } from '../src/kernel/measure.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { createCasiWorksAPI, CasiWorksAPIError, API_VERSION } from '../src/api/CasiWorksAPI.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('Measure: distance and parts; angle between faces; gap only for parallel faces', () => {
  const m = measure({ point: { x: 0, y: 0, z: 0 }, kind: 'face' }, { point: { x: 3, y: 4, z: 12 }, kind: 'face' });
  near(m.distance, 13);
  assert.deepEqual([m.dx, m.dy, m.dz], [3, 4, 12]);
  assert.equal(m.angle, null);
  assert.equal(m.gap, null);
  // Top and bottom of a 12 mm plate, picked at points far apart: gap is the thickness
  const plate = measure({ point: { x: -20, y: 5, z: 12 }, normal: { x: 0, y: 0, z: 1 }, kind: 'face' }, { point: { x: 30, y: -7, z: 0 }, normal: { x: 0, y: 0, z: -1 }, kind: 'face' });
  near(plate.angle!, 180);
  near(plate.gap!, 12);
  assert.ok(plate.distance > 50);
  const corner = measure({ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, kind: 'face' }, { point: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 2, z: 0 }, kind: 'face' });
  near(corner.angle!, 90);
  assert.equal(corner.gap, null, 'not parallel');
  assert.equal(formatMm(-0.0001), '0');
  assert.equal(formatMm(12.34567), '12.346');
});

test('Measure: a click snaps to the triangle corner within the tolerance', () => {
  const tri = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }];
  const snapped = snapPick({ x: 9.6, y: 0.2, z: 0 }, tri, { x: 0, y: 0, z: 5 }, 0.5);
  assert.equal(snapped.kind, 'vertex');
  assert.deepEqual(snapped.point, { x: 10, y: 0, z: 0 });
  assert.deepEqual(snapped.normal, { x: 0, y: 0, z: 1 }, 'normal made unit');
  const free = snapPick({ x: 3, y: 3, z: 0 }, tri, null, 0.5);
  assert.equal(free.kind, 'face');
  assert.deepEqual(free.point, { x: 3, y: 3, z: 0 });
});

test('Measure tool state: two picks, a third starts again; leaving the tool clears them', () => {
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  r.execute('evaluate.measure');
  assert.equal(s().activeTool, 'measure');
  const p = (x: number) => ({ point: { x, y: 0, z: 0 }, kind: 'face' as const });
  s().addMeasurePick(p(1));
  assert.equal(s().statusMessage, 'Measure: click the second point');
  s().addMeasurePick(p(2));
  assert.equal(s().measurePicks.length, 2);
  s().addMeasurePick(p(3));
  assert.deepEqual(s().measurePicks.map(x => x.point.x), [3], 'a third click starts a new measurement');
  r.execute('edit.cancel');
  assert.deepEqual(s().measurePicks, []);
  assert.equal(s().activeTool, 'select');
});

test('API 1.6: model.measure with and without normals; bad input refused', () => {
  const api = createCasiWorksAPI(useCADStore);
  assert.equal(API_VERSION, '1.6.0');
  const m = api.model.measure({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 12 }, { normalA: { x: 0, y: 0, z: -1 }, normalB: { x: 0, y: 0, z: 1 } });
  near(m.gap!, 12);
  near(m.distance, 12);
  assert.equal(api.model.measure({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }).angle, null);
  assert.throws(() => api.model.measure({ x: 0, y: 0 } as never, { x: 1, y: 1, z: 0 }), (e: unknown) => e instanceof CasiWorksAPIError && e.code === 'INVALID_ARGUMENT');
});
