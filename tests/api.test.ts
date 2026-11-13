// CasiWorks Pro - Public API v1 tests (headless: no browser, no React)
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI, CasiWorksAPIError, API_VERSION } from '../src/api/CasiWorksAPI.ts';
import type { CasiWorksAPI, CasiWorksAPIErrorCode, SketchRef } from '../src/api/CasiWorksAPI.ts';

const api: CasiWorksAPI = createCasiWorksAPI(useCADStore);
const STEEL = 7900e-9; // kg/mm³

const near = (actual: number, expected: number, relTol: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) <= relTol * Math.abs(expected), `${msg}: got ${actual}, expected ${expected} ±${relTol * 100}%`);

const throwsCode = (fn: () => unknown, code: CasiWorksAPIErrorCode) =>
  assert.throws(fn, (err: unknown) => err instanceof CasiWorksAPIError && err.code === code, `expected CasiWorksAPIError ${code}`);

/** New part with a 60 × 40 rectangle extruded 25 mm. */
function makeBlock(): { sketch: SketchRef; boss: string } {
  api.document.new();
  const sketch = api.sketches.create({
    plane: 'Front',
    entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }],
  });
  const boss = api.features.extrude({ sketchId: sketch.sketchId, depth: 25 });
  return { sketch, boss };
}

test('API: version, units and immutability', () => {
  assert.equal(api.version, API_VERSION);
  assert.match(api.version, /^\d+\.\d+\.\d+$/);
  assert.equal(api.units.length, 'mm');
  assert.ok(Object.isFrozen(api) && Object.isFrozen(api.features), 'API surface must be frozen');
});

test('API: sketch + extrude builds the expected solid headlessly', () => {
  const { sketch, boss } = makeBlock();
  const list = api.features.list();
  assert.deepEqual(list.map(f => f.type), ['sketch', 'extrude_boss']);
  assert.equal(list[1].id, boss);
  assert.deepEqual(list[1].parentIds, [sketch.featureId], 'extrude depends on its sketch');
  assert.equal(list[1].parameters.depth, 25);

  const box = api.model.boundingBox()!;
  assert.deepEqual([box.size.x, box.size.y, box.size.z].map(v => Math.round(v * 1e6) / 1e6), [60, 40, 25]);

  const mp = api.model.massProperties()!;
  near(mp.volume, 60 * 40 * 25, 1e-9, 'volume mm³');
  near(mp.mass, 60 * 40 * 25 * STEEL, 1e-9, 'mass kg');
  assert.equal(api.model.errors().length, 0);
});

test('API: through-all cut removes a cylinder', () => {
  makeBlock();
  const hole = api.sketches.create({ entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 10 }] });
  api.features.extrude({ sketchId: hole.sketchId, depth: 100, endCondition: 'throughall', cut: true });
  const vol = api.model.massProperties()!.volume;
  // Polygonal circle: allow 1% for tessellation of the hole
  near(vol, 60 * 40 * 25 - Math.PI * 10 * 10 * 25, 0.01, 'volume after cut');
});

test('API: update, undo and redo', () => {
  const { boss } = makeBlock();
  api.features.update(boss, { depth: 40 });
  assert.equal(api.features.get(boss).parameters.depth, 40);
  near(api.model.boundingBox()!.size.z, 40, 1e-9, 'depth after update');

  assert.equal(api.history.undo(), true);
  near(api.model.boundingBox()!.size.z, 25, 1e-9, 'depth after undo');
  assert.equal(api.history.redo(), true);
  near(api.model.boundingBox()!.size.z, 40, 1e-9, 'depth after redo');

  api.document.new();
  assert.equal(api.history.undo(), false, 'nothing to undo in a new document');
});

test('API: suppression cascades and rollback limits evaluation', () => {
  const { sketch, boss } = makeBlock();
  api.features.setSuppressed(sketch.featureId, true);
  assert.equal(api.features.get(boss).suppressed, true, 'suppressing a sketch suppresses its extrude');
  assert.equal(api.model.hasBody(), false);

  api.features.setSuppressed(sketch.featureId, false);
  api.features.setSuppressed(boss, false);
  assert.equal(api.model.hasBody(), true);

  api.features.rollbackTo(0); // only the sketch is evaluated
  assert.equal(api.model.hasBody(), false);
  api.features.rollbackTo(null);
  assert.equal(api.model.hasBody(), true);
});

test('API: remove deletes the feature', () => {
  const { boss } = makeBlock();
  api.features.remove(boss);
  assert.equal(api.features.list().length, 1);
  assert.equal(api.model.massProperties(), null);
  throwsCode(() => api.features.get(boss), 'NOT_FOUND');
});

test('API: materials change mass; unknown material is rejected', () => {
  makeBlock();
  const alu = api.materials.list().find(m => /alumin/i.test(m.name));
  assert.ok(alu, 'an aluminium material must exist');
  api.materials.setActive(alu.key);
  assert.equal(api.materials.getActive(), alu.key);
  near(api.model.massProperties()!.mass, 60 * 40 * 25 * alu.density * 1e-9, 1e-9, 'aluminium mass');
  throwsCode(() => api.materials.setActive('Unobtainium'), 'NOT_FOUND');
});

test('API: document save/load round-trip; invalid input leaves the document untouched', () => {
  makeBlock();
  api.document.setName('Bracket');
  const json = api.document.toJSON();
  const before = api.features.list();

  api.document.new();
  assert.equal(api.features.list().length, 0);
  api.document.load(json);
  assert.equal(api.document.getName(), 'Bracket');
  assert.deepEqual(api.features.list(), before);
  near(api.model.massProperties()!.volume, 60000, 1e-9, 'volume after load');

  throwsCode(() => api.document.load('{not json'), 'INVALID_DOCUMENT');
  throwsCode(() => api.document.load({ features: 'nope' }), 'INVALID_DOCUMENT');
  assert.equal(api.document.getName(), 'Bracket', 'failed loads must not change the document');
});

test('API: input validation uses stable error codes', () => {
  const { sketch, boss } = makeBlock();
  // @ts-expect-error the types reject this; the runtime must too
  throwsCode(() => api.sketches.create({ plane: 'Diagonal', entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 1 }] }), 'INVALID_ARGUMENT');
  throwsCode(() => api.sketches.create({ entities: [] }), 'INVALID_ARGUMENT');
  throwsCode(() => api.sketches.create({ entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: -1 }] }), 'INVALID_ARGUMENT');
  // @ts-expect-error the types reject this; the runtime must too
  throwsCode(() => api.sketches.create({ entities: [{ type: 'spline' }] }), 'INVALID_ARGUMENT');
  throwsCode(() => api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 0, y: 5 } }] }), 'INVALID_ARGUMENT');
  throwsCode(() => api.features.extrude({ sketchId: sketch.sketchId, depth: 0 }), 'INVALID_ARGUMENT');
  throwsCode(() => api.features.extrude({ sketchId: sketch.sketchId, depth: NaN }), 'INVALID_ARGUMENT');
  // @ts-expect-error the types reject this; the runtime must too
  throwsCode(() => api.features.extrude({ sketchId: sketch.sketchId, depth: 5, endCondition: 'upto' }), 'INVALID_ARGUMENT');
  throwsCode(() => api.features.extrude({ sketchId: 'missing', depth: 5 }), 'NOT_FOUND');
  throwsCode(() => api.features.revolve({ sketchId: sketch.sketchId, angle: 400 }), 'INVALID_ARGUMENT');
  throwsCode(() => api.features.update(boss, { type: 'fillet' }), 'INVALID_ARGUMENT');
  throwsCode(() => api.features.update(boss, { depth: -3 }), 'INVALID_ARGUMENT');
  throwsCode(() => api.features.update('nope', { depth: 3 }), 'NOT_FOUND');
  // @ts-expect-error the types reject this; the runtime must too
  throwsCode(() => api.features.setSuppressed(boss, 'yes'), 'INVALID_ARGUMENT');
  throwsCode(() => api.features.rollbackTo(99), 'INVALID_ARGUMENT');
  // Nothing above may have changed the model
  assert.equal(api.features.list().length, 2);
  assert.equal(api.features.get(boss).parameters.depth, 25);
});

test('API: returned data are copies and cannot corrupt the model', () => {
  const { boss } = makeBlock();
  const info = api.features.get(boss);
  info.parameters.depth = 999;
  info.parentIds.push('x');
  api.features.list()[1].name = 'Hacked';
  const again = api.features.get(boss);
  assert.equal(again.parameters.depth, 25);
  assert.equal(again.parentIds.length, 1);
  assert.notEqual(again.name, 'Hacked');
});

test('API: arc + lines profile and revolve produce a body', () => {
  api.document.new();
  // Closed D-shaped profile: semicircle arc closed by a line
  const s = api.sketches.create({
    entities: [
      { type: 'arc', center: { x: 20, y: 0 }, radius: 5, startAngle: -90, endAngle: 90 },
      { type: 'line', p1: { x: 20, y: 5 }, p2: { x: 20, y: -5 } },
    ],
  });
  api.features.revolve({ sketchId: s.sketchId, angle: 360 });
  assert.equal(api.model.errors().length, 0, JSON.stringify(api.model.errors()));
  assert.equal(api.model.hasBody(), true);
});

test('API: exposeGlobalAPI installs a read-only casiworks and announces it', async () => {
  const { exposeGlobalAPI, READY_EVENT } = await import('../src/api/index.ts');
  const target = new EventTarget() as EventTarget & { casiworks?: CasiWorksAPI };
  const seen: { detail?: { api: CasiWorksAPI; version: string } } = {};
  target.addEventListener(READY_EVENT, (e) => { seen.detail = (e as CustomEvent).detail; });

  const installed = exposeGlobalAPI(useCADStore, target);
  assert.equal(target.casiworks, installed);
  assert.equal(target.casiworks!.version, API_VERSION);
  assert.ok(seen.detail, 'ready event dispatched');
  assert.equal(seen.detail.api, installed);
  assert.equal(seen.detail.version, API_VERSION);
  assert.throws(() => { (target as { casiworks?: unknown }).casiworks = 1; }, TypeError, 'read-only');

  // Installing again (hot reload) replaces it
  assert.notEqual(exposeGlobalAPI(useCADStore, target), installed);
});

test('API: importable as the casiworks-pro/api module and usable headlessly', async () => {
  const mod = await import('casiworks-pro/api');
  const headless = mod.createHeadlessAPI();
  assert.equal(headless.version, mod.API_VERSION);
  headless.document.new();
  const s = headless.sketches.create({ entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 10 }] });
  headless.features.extrude({ sketchId: s.sketchId, depth: 5 });
  assert.ok(Math.abs(headless.model.massProperties()!.volume - Math.PI * 100 * 5) < 0.01 * Math.PI * 100 * 5);
});
