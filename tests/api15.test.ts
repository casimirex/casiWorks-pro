// CasiWorks Pro - Public API 1.5: equations, configurations, assembly, drawings, sketch editing
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI, CasiWorksAPIError, API_VERSION } from '../src/api/CasiWorksAPI.ts';
import type { CasiWorksAPIErrorCode } from '../src/api/CasiWorksAPI.ts';
import type { LineEntity } from '../src/types/cad.ts';

/** Semantic version at least major.minor. */
const atLeast = (v: string, major: number, minor: number) => { const [a, b] = v.split('.').map(Number); return a > major || (a === major && b >= minor); };

const api = createCasiWorksAPI(useCADStore);
const throwsCode = (fn: () => unknown, code: CasiWorksAPIErrorCode, msg?: RegExp) =>
  assert.throws(fn, (err: unknown) => err instanceof CasiWorksAPIError && err.code === code && (!msg || msg.test(err.message)), `expected ${code}`);

test('API 1.5: version and the new namespaces are frozen', () => {
  assert.ok(atLeast(API_VERSION, 1, 5), `API ${API_VERSION} is at least 1.5`);
  for (const ns of [api.equations, api.configurations, api.assembly, api.drawings]) assert.ok(Object.isFrozen(ns));
  assert.equal(typeof api.sketches.trim, 'function');
});

test('API equations and configurations: variables drive a linked extrude; versions switch it', () => {
  api.document.new();
  assert.deepEqual(api.equations.set([{ name: 'wall', expression: '3' }, { name: 'depth', expression: 'wall * 8' }]), { wall: 3, depth: 24 });
  throwsCode(() => api.equations.set([{ name: 'a', expression: 'a' }]), 'INVALID_ARGUMENT', /Circular/);
  assert.equal(api.equations.evaluate('depth / 2 + wall'), 15);
  throwsCode(() => api.equations.evaluate('nope + 1'), 'INVALID_ARGUMENT', /Unknown variable/);

  const s = api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 40, y: 20 } }] });
  const boss = api.features.extrude({ sketchId: s.sketchId, depth: 10 });
  api.equations.link(boss, 'depth', 'depth + 1');
  assert.equal(api.features.get(boss).parameters.depth, 25);
  assert.ok(Math.abs(api.model.massProperties()!.volume - 40 * 20 * 25) < 1e-6);
  throwsCode(() => api.equations.link(boss, 'nope', '1'), 'INVALID_ARGUMENT', /no parameter "nope"/);
  throwsCode(() => api.equations.link(boss, 'depth', 'missing'), 'INVALID_ARGUMENT', /Unknown variable "missing"/);
  assert.deepEqual(api.equations.list().links.map(l => [l.parameter, l.value]), [['depth', 25]]);

  api.configurations.set([{ name: 'Thin', values: { wall: '1' } }, { name: 'Tall', values: { depth: '60' } }]);
  throwsCode(() => api.configurations.set([{ name: 'Default', values: {} }]), 'INVALID_ARGUMENT', /reserved/);
  api.configurations.activate('Tall');
  assert.equal(api.configurations.active(), 'Tall');
  assert.equal(api.features.get(boss).parameters.depth, 61);
  assert.equal(api.equations.list().variables[1].override, '60');
  assert.deepEqual(api.configurations.list().map(c => [c.name, c.variables.depth, c.active]), [['Default', 24, false], ['Thin', 8, false], ['Tall', 60, true]]);
  throwsCode(() => api.configurations.activate('Huge'), 'NOT_FOUND');
  api.configurations.activate('Default');
  assert.equal(api.features.get(boss).parameters.depth, 25);

  api.equations.link(boss, 'depth', null);
  api.equations.set([{ name: 'wall', expression: '10' }, { name: 'depth', expression: 'wall * 8' }]);
  assert.equal(api.features.get(boss).parameters.depth, 25, 'unlinked: the number stays');
});

test('API assembly: insert, mate, solve, materials and the BOM', () => {
  api.document.new();
  const plate = api.assembly.insert({ name: 'Base_Plate', shape: 'box', dimensions: { width: 50, height: 12, depth: 50 } });
  const pin = api.assembly.insert({ name: 'Pin_Shaft', shape: 'pin' });
  const pin2 = api.assembly.insert({ name: 'Pin_Shaft', shape: 'pin' });
  throwsCode(() => api.assembly.insert({ name: 'X', shape: 'cone' as never }), 'INVALID_ARGUMENT');
  api.assembly.mate({ type: 'concentric', component1: plate, component2: pin });
  throwsCode(() => api.assembly.mate({ type: 'glue' as never, component1: plate, component2: pin }), 'INVALID_ARGUMENT');
  throwsCode(() => api.assembly.mate({ type: 'coincident', component1: plate, component2: 'nope' }), 'NOT_FOUND');
  const solved = api.assembly.solve();
  assert.equal(solved.converged, true, solved.message);
  const list = api.assembly.list();
  assert.deepEqual(list.map(c => [c.name, c.shape, c.fixed]), [['Base_Plate', 'box', true], ['Pin_Shaft', 'pin', false], ['Pin_Shaft', 'pin', false]]);
  assert.ok(Math.abs(list[1].position.x - list[0].position.x) < 1e-3, 'concentric: pin on the plate axis');

  api.assembly.setMaterial([pin, pin2], 'Brass_C36000');
  throwsCode(() => api.assembly.setMaterial([pin], 'Unobtainium'), 'NOT_FOUND');
  const bom = api.assembly.bom();
  assert.deepEqual(bom.rows.map(r => [r.partNumber, r.material, r.quantity]), [['Base_Plate', 'AISI 1020 Steel', 1], ['Pin_Shaft', 'Brass C36000', 2]]);
  assert.equal(api.assembly.list()[1].material, 'Brass_C36000');

  api.assembly.explode({ distance: 30 });
  assert.deepEqual(useCADStore.getState().explodedView, { distance: 30, leaderLines: true });
  api.assembly.collapse();
  assert.equal(useCADStore.getState().explodedView, null);
});

test('API drawings: options, SVG and DXF for the part and the assembly, headless', () => {
  api.document.new();
  throwsCode(() => api.drawings.svg(), 'NOT_FOUND', /no solid body/);
  const s = api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 40, y: 20 } }] });
  api.features.extrude({ sketchId: s.sketchId, depth: 10 });
  const part = api.drawings.svg();
  assert.match(part, /^<svg[^>]+viewBox="0 0 297.00 210.00"/);
  assert.match(api.drawings.dxf(), /^0\nSECTION/);
  assert.deepEqual(api.drawings.setOptions({ sheetSize: 'A3_LANDSCAPE', gdt: false }), { subject: 'part', sheetSize: 'A3_LANDSCAPE', hiddenLines: true, dimensions: true, gdt: false });
  throwsCode(() => api.drawings.setOptions({ sheetSize: 'A0' as never }), 'INVALID_ARGUMENT');
  assert.doesNotMatch(api.drawings.svg(), /id="gdt"/);

  api.drawings.setOptions({ subject: 'assembly' });
  throwsCode(() => api.drawings.svg(), 'NOT_FOUND', /assembly is empty/);
  api.assembly.insert({ name: 'Base_Plate', shape: 'box' });
  api.assembly.insert({ name: 'Pin_Shaft', shape: 'pin' });
  const asm = api.drawings.svg();
  assert.match(asm, /<g id="bom-table">/);
  assert.equal((asm.match(/class="balloon"/g) ?? []).length, 2);
  api.drawings.setOptions({ subject: 'part', sheetSize: 'A4_LANDSCAPE', gdt: true });
});

test('API sketch editing: trim, extend, offset and mirror on a stored sketch (undoable)', () => {
  api.document.new();
  const s = api.sketches.create({ entities: [
    { type: 'line', p1: { x: -10, y: 0 }, p2: { x: 10, y: 0 } },
    { type: 'line', p1: { x: 0, y: -10 }, p2: { x: 0, y: 10 } },
    { type: 'line', p1: { x: 20, y: -10 }, p2: { x: 20, y: 10 } },
  ] });
  const ents = () => api.sketches.getEntities(s.sketchId) as LineEntity[];
  const [h, v] = ents();
  let out = api.sketches.trim(s.sketchId, h.id, { x: 5, y: 0 }) as LineEntity[];
  assert.deepEqual(out.find(e => e.id === h.id)!.p2, { x: 0, y: 0 });
  out = api.sketches.extend(s.sketchId, h.id, { x: 0, y: 0 }) as LineEntity[];
  assert.ok(Math.abs(out.find(e => e.id === h.id)!.p2.x - 20) < 1e-9, 'extended to the line at x = 20');
  out = api.sketches.offset(s.sketchId, v.id, 2, { x: -5, y: 0 }) as LineEntity[];
  assert.equal(out.length, 4);
  out = api.sketches.mirror(s.sketchId, v.id, [out[3].id]) as LineEntity[];
  assert.equal(out.length, 5);
  assert.ok(Math.abs(out[4].p1.x - 2) < 1e-9, 'mirrored the offset line to x = +2');
  throwsCode(() => api.sketches.trim(s.sketchId, 'nope', { x: 0, y: 0 }), 'NOT_FOUND');
  const lone = api.sketches.create({ entities: [{ type: 'line', p1: { x: 0, y: 0 }, p2: { x: 5, y: 0 } }] });
  throwsCode(() => api.sketches.extend(lone.sketchId, api.sketches.getEntities(lone.sketchId)[0].id, { x: 5, y: 0 }), 'INVALID_ARGUMENT', /Nothing to extend/);
  api.history.undo(); // the lone sketch
  api.history.undo();
  assert.equal(api.sketches.getEntities(s.sketchId).length, 4, 'undo removes the mirror');
});
