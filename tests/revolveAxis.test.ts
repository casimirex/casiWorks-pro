// CasiWorks Pro - Revolve about a chosen axis; reference axes and points
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';
import type { ApiSketchEntity } from '../src/api/CasiWorksAPI.ts';

const api = createCasiWorksAPI(useCADStore);
/** Pappus: a full revolve sweeps area A with its centroid at distance d from the axis. */
const pappus = (d: number, area: number) => 2 * Math.PI * d * area;
const close = (v: number, expected: number, msg: string) => assert.ok(Math.abs(v - expected) / expected < 0.005, `${msg}: ${v.toFixed(1)} vs ${expected.toFixed(1)}`);
const rect = (x1: number, y1: number, x2: number, y2: number): ApiSketchEntity => ({ type: 'rectangle', corner1: { x: x1, y: y1 }, corner2: { x: x2, y: y2 } });
const volume = () => api.model.massProperties()!.volume;

test('Revolve about the sketch X axis, a centreline, and a slanted line', () => {
  api.document.new();
  let s = api.sketches.create({ entities: [rect(0, 10, 30, 20)] });
  api.features.revolve({ sketchId: s.sketchId, axis: 'x' });
  close(volume(), pappus(15, 300), 'about X');
  const b = api.model.boundingBox()!;
  assert.ok(Math.abs(b.min.x) < 1e-6 && Math.abs(b.max.x - 30) < 1e-6 && Math.abs(b.max.y - 20) < 0.1 && Math.abs(b.min.z + 20) < 0.1, 'around the X axis');

  // A construction centreline at x = 5: the profile 10..20 sweeps radius 5..15
  api.document.new();
  s = api.sketches.create({ entities: [rect(10, 0, 20, 30), { type: 'line', p1: { x: 5, y: -5 }, p2: { x: 5, y: 40 }, construction: true }] });
  const centreline = api.sketches.getEntities(s.sketchId).find(e => e.type === 'line' && e.construction)!.id;
  api.features.revolve({ sketchId: s.sketchId, axis: { line: centreline } });
  close(volume(), pappus(10, 300), 'about a centreline');
  const c = api.model.boundingBox()!;
  assert.ok(Math.abs(c.min.x + 10) < 0.1 && Math.abs(c.max.x - 20) < 1e-6, `x from 5 − 15 to 20: ${c.min.x}..${c.max.x}`);

  // A slanted axis through the origin at 45°; the square's centroid (20, 0) is 20·sin45° from it
  api.document.new();
  s = api.sketches.create({ entities: [rect(15, -5, 25, 5), { type: 'line', p1: { x: -10, y: -10 }, p2: { x: -5, y: -5 }, construction: true }] });
  const slant = api.sketches.getEntities(s.sketchId).find(e => e.type === 'line' && e.construction)!.id;
  api.features.revolve({ sketchId: s.sketchId, axis: { line: slant } });
  close(volume(), pappus(20 * Math.SQRT1_2, 100), 'about a slanted line');

  // Partial revolve about a centreline: half the volume
  api.document.new();
  s = api.sketches.create({ entities: [rect(10, 0, 20, 30), { type: 'line', p1: { x: 5, y: 0 }, p2: { x: 5, y: 30 }, construction: true }] });
  const half = api.sketches.getEntities(s.sketchId).find(e => e.type === 'line' && e.construction)!.id;
  api.features.revolve({ sketchId: s.sketchId, axis: { line: half }, angle: 180 });
  close(volume(), pappus(10, 300) / 2, 'half revolve');
  api.document.new();
});

test('Revolve about a reference axis in the sketch plane; it follows a reference point', () => {
  api.document.new();
  const p = api.features.referencePoint({ x: 40, y: 0, z: 0 });
  const axis = api.features.referenceAxis({ direction: 'Y', through: p });
  assert.equal(api.features.get(axis).name, 'Axis1');
  const s = api.sketches.create({ entities: [rect(50, 0, 60, 10)] });
  api.features.revolve({ sketchId: s.sketchId, axis: { axis } });
  close(volume(), pappus(15, 100), 'about Axis1 at x = 40');
  let b = api.model.boundingBox()!;
  assert.ok(Math.abs(b.min.x - 20) < 0.1 && Math.abs(b.max.x - 60) < 1e-6, `around x = 40: ${b.min.x}..${b.max.x}`);

  // Move the point: the axis and the revolve follow
  api.equations.set([{ name: 'ax', expression: '45' }]);
  api.equations.link(p, 'point.x', 'ax');
  close(volume(), pappus(10, 100), 'axis moved to x = 45');
  b = api.model.boundingBox()!;
  assert.ok(Math.abs(b.min.x - 30) < 0.1, `around x = 45: ${b.min.x}`);

  // An axis not in the sketch plane is a rebuild error, named
  const off = api.features.referenceAxis({ direction: 'Z', point: { x: 40, y: 0, z: 0 } });
  const s2 = api.sketches.create({ entities: [rect(50, 20, 60, 30)] });
  api.features.revolve({ sketchId: s2.sketchId, axis: { axis: off } });
  assert.match(api.model.errors().map(e => e.error).join(), /does not lie in the sketch plane/);
  api.document.new();
});

test('Revolve errors: profile across the axis; bad axis arguments', () => {
  api.document.new();
  const s = api.sketches.create({ entities: [rect(-5, 0, 5, 10)] });
  api.features.revolve({ sketchId: s.sketchId });
  assert.match(api.model.errors().map(e => e.error).join(), /crosses the axis/);
  assert.throws(() => api.features.revolve({ sketchId: s.sketchId, axis: { line: 'nope' } }), /No line/);
  assert.throws(() => api.features.revolve({ sketchId: s.sketchId, axis: { axis: 'nope' } }), /No reference axis/);
  assert.throws(() => api.features.revolve({ sketchId: s.sketchId, axis: 'z' as never }), /axis must be/);
  assert.throws(() => api.features.referenceAxis({ direction: 'W' as never }), /direction/);
  api.document.new();
});
