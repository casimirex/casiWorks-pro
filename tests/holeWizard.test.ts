// CasiWorks Pro - Hole Wizard: ISO metric sizes and the holes they cut
import test from 'node:test';
import assert from 'node:assert/strict';

import { METRIC, METRIC_SIZES, standardHole } from '../src/features/holeStandards.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI, CasiWorksAPIError, API_VERSION } from '../src/api/CasiWorksAPI.ts';

/** Semantic version at least major.minor. */
const atLeast = (v: string, major: number, minor: number) => { const [a, b] = v.split('.').map(Number); return a > major || (a === major && b >= minor); };

/** Cross-section area of the kernel's 32-sided hole of radius r. */
const area = (r: number) => 16 * r * r * Math.sin(Math.PI / 16);
const near = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('Hole table: consistent with the standards it comes from', () => {
  for (const size of METRIC_SIZES) {
    const row = METRIC[size];
    assert.equal(size, `M${row.d}`);
    assert.ok(row.clearance.close > row.d && row.clearance.close < row.clearance.normal && row.clearance.normal < row.clearance.loose, `${size} clearance series`);
    assert.ok(row.counterbore.diameter > row.clearance.loose, `${size} counterbore clears the hole`);
    assert.ok(row.counterbore.depth > row.d && row.counterbore.depth < row.d + 1, `${size} counterbore depth: head height + a little`);
    assert.ok(row.countersink.diameter > row.clearance.loose && row.countersink.angle === 90, `${size} countersink`);
    const tapped = standardHole('tapped', size);
    near(tapped.diameter, row.d - row.pitch, 1e-9, `${size} tap drill`);
  }
  const m8 = standardHole('counterbore', 'M8');
  assert.deepEqual([m8.diameter, m8.cbDiameter, m8.cbDepth, m8.label], [9, 15, 8.6, 'M8 Counterbore']);
  assert.equal(standardHole('simple', 'M8', 'close').diameter, 8.4);
  assert.equal(standardHole('tapped', 'M8').thread, 'M8×1.25');
  assert.equal(standardHole('tapped', 'M8').diameter, 6.75);
  assert.match(standardHole('countersink', 'M6').description, /countersink Ø13\.44 × 90°/);
  assert.throws(() => standardHole('simple', 'M7' as never), /Unknown size/);
});

test('API 1.8 features.hole: standard holes remove the right volume', () => {
  const api = createCasiWorksAPI(useCADStore);
  assert.ok(atLeast(API_VERSION, 1, 8), `API ${API_VERSION} is at least 1.8`);
  const block = () => {
    api.document.new();
    const s = api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
    api.features.extrude({ sketchId: s.sketchId, depth: 20 });
    return api.model.massProperties()!.volume;
  };
  const top = { position: { x: 0, y: 0, z: 20 }, axis: { x: 0, y: 0, z: -1 }, depth: 12 };

  let v0 = block();
  const id = api.features.hole({ ...top, type: 'counterbore', standard: { size: 'M8' } });
  const f = api.features.get(id);
  assert.equal(f.name, 'M8 Counterbore');
  assert.deepEqual([f.parameters.diameter, f.parameters.cbDiameter, f.parameters.cbDepth], [9, 15, 8.6]);
  near(v0 - api.model.massProperties()!.volume, area(4.5) * (12 - 8.6) + area(7.5) * 8.6, 0.5, 'M8 counterbore volume');

  v0 = block();
  const tapped = api.features.hole({ ...top, type: 'tapped', standard: { size: 'M8' } });
  assert.equal(api.features.get(tapped).parameters.thread, 'M8×1.25');
  near(v0 - api.model.massProperties()!.volume, area(6.75 / 2) * 12, 0.5, 'M8 tapped: tap drill Ø6.75');

  v0 = block();
  api.features.hole({ ...top, type: 'countersink', standard: { size: 'M8' } });
  const sink = v0 - api.model.massProperties()!.volume;
  near(sink, area(4.5) * 12, 400, 'countersink: about the hole');
  assert.ok(sink > area(4.5) * 12 + 50, 'plus the cone');

  v0 = block();
  api.features.hole({ ...top, type: 'counterbore', diameter: 6, cbDiameter: 12, cbDepth: 4 });
  near(v0 - api.model.massProperties()!.volume, area(3) * 8 + area(6) * 4, 0.5, 'custom counterbore');

  const bad = (spec: object) => assert.throws(() => api.features.hole(spec as never), (e: unknown) => e instanceof CasiWorksAPIError && e.code === 'INVALID_ARGUMENT');
  bad({ ...top, standard: { size: 'M7' } });
  bad({ ...top, standard: { size: 'M8', fit: 'snug' } });
  bad({ ...top, type: 'drilled', diameter: 5 });
  bad({ ...top });
  bad({ ...top, diameter: 5, axis: { x: 0, y: 0, z: 0 } });
  api.document.new();
});

test('A standard hole is saved with its sizes and rebuilds without the table', () => {
  const api = createCasiWorksAPI(useCADStore);
  api.document.new();
  const s = api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
  api.features.extrude({ sketchId: s.sketchId, depth: 20 });
  api.features.hole({ position: { x: 0, y: 0, z: 20 }, axis: { x: 0, y: 0, z: -1 }, depth: 12, type: 'counterbore', standard: { size: 'M6', fit: 'close' } });
  const v = api.model.massProperties()!.volume;
  const json = api.document.toJSON();
  const hole = JSON.parse(json).features.find((f: { type: string }) => f.type === 'hole');
  assert.deepEqual(hole.standard, { size: 'M6', fit: 'close' });
  assert.deepEqual([hole.diameter, hole.cbDiameter, hole.cbDepth], [6.4, 11, 6.4]);
  api.document.new();
  api.document.load(json);
  near(api.model.massProperties()!.volume, v, 1e-6, 'same volume after load');
  api.document.new();
});
