// CasiWorks Pro - Drawing dimensions that follow the model (roadmap 5.2)
import test from 'node:test';
import assert from 'node:assert/strict';

import { DrawingEngine, layoutProblems, SHEET_SIZES } from '../src/drawings/DrawingEngine.ts';
import { buildDrawingSheet, dimensionInfo, drawingFile, newDimension, pickOnSheet } from '../src/drawings/drawingSheet.ts';
import { sanitizeDimensions } from '../src/drawings/associative.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';
import { commands } from '../src/commands/index.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';
import type { SketchEntity } from '../src/types/cad.ts';

const D = new DrawingEngine();
const s = useCADStore.getState;
const quiet = <T>(f: () => T): T => {
  const realWarn = console.warn;
  console.warn = () => {};
  try { return f(); } finally { console.warn = realWarn; }
};

function loadExample(id: string) {
  quiet(() => {
    s().loadExampleModel(CAD_EXAMPLES.find(e => e.id === id)!.create());
    rebuildModel(useCADStore);
  });
}

/** Change sketch entities of the current model and rebuild. */
function edit(patch: Record<string, (e: SketchEntity) => void>) {
  const map = structuredClone(s().sketchEntities);
  for (const list of Object.values(map)) for (const e of list) patch[e.id]?.(e);
  useCADStore.setState({ sketchEntities: map, needsRebuild: true });
  quiet(() => rebuildModel(useCADStore));
}

const values = () => Object.fromEntries(dimensionInfo(s()).map(d => [d.id, d.value]));

test('A distance between hole centres follows the holes; a diameter follows the hole size', () => {
  loadExample('l_bracket');
  const pitch = commands.execute('drawing.addDimension', { view: 'front', points: [{ x: -10.4, y: 0.3 }, { x: 15.2, y: -0.2 }] }) as { id: string; kind: string; value: number };
  assert.equal(pitch.kind, 'horizontal', 'auto: along the larger offset');
  assert.ok(Math.abs(pitch.value - 25) < 1e-3, `pitch ${pitch.value}`);
  const dia = commands.execute('drawing.addDimension', { view: 'front', points: [{ x: 20, y: 0.5 }] }) as { id: string; kind: string; value: number };
  assert.equal(dia.kind, 'diameter');
  assert.ok(Math.abs(dia.value - 10) < 1e-3);

  edit({ h1: e => { (e as { center: { x: number } }).center.x = 20; (e as { radius: number }).radius = 6; } });
  const v = values();
  assert.ok(Math.abs(v[pitch.id]! - 30) < 1e-3, `pitch now ${v[pitch.id]}`);
  assert.ok(Math.abs(v[dia.id]! - 12) < 1e-3, `diameter now ${v[dia.id]}`);

  // The sheet shows the new values
  const svg = drawingFile(s(), 'svg')!.text;
  assert.match(svg, />30\.0 mm</);
  assert.match(svg, />Ø12\.0 mm</);
});

test('An overall dimension follows the part when it is made wider (corners found again relative to the view)', () => {
  loadExample('l_bracket');
  const width = commands.execute('drawing.addDimension', { view: 'front', points: [{ x: -35, y: 20 }, { x: 35, y: 20 }] }) as { id: string; value: number };
  assert.ok(Math.abs(width.value - 70) < 1e-3);
  const height = commands.execute('drawing.addDimension', { view: 'front', kind: 'vertical', points: [{ x: 35, y: -20 }, { x: 35, y: 20 }] }) as { id: string; value: number };
  assert.ok(Math.abs(height.value - 40) < 1e-3);
  edit({
    b1: e => { (e as { p2: { x: number } }).p2.x = 55; },
    b2: e => { (e as { p1: { x: number } }).p1.x = 55; (e as { p2: { x: number } }).p2.x = 55; },
    b3: e => { (e as { p1: { x: number } }).p1.x = 55; },
  });
  const v = values();
  assert.ok(Math.abs(v[width.id]! - 90) < 1e-3, `width now ${v[width.id]}`);
  assert.ok(Math.abs(v[height.id]! - 40) < 1e-3, `height now ${v[height.id]}`);
});

test('A dimension whose hole is gone dangles: listed with no value, not drawn, the sheet stays clean', () => {
  loadExample('l_bracket');
  const dia = commands.execute('drawing.addDimension', { view: 'front', kind: 'diameter', points: [{ x: -15, y: 0 }] }) as { id: string };
  const sk = Object.entries(s().sketchEntities).find(([, list]) => list.some(e => e.id === 'h2'))![0];
  const map = structuredClone(s().sketchEntities);
  map[sk] = map[sk].filter(e => e.id !== 'h2');
  useCADStore.setState({ sketchEntities: map, needsRebuild: true });
  quiet(() => rebuildModel(useCADStore));
  // The other hole (r 5 at x 15) is too far away to be taken for it
  const info = dimensionInfo(s()).find(d => d.id === dia.id)!;
  assert.equal(info.dangling, true);
  assert.equal(info.value, null);
  assert.ok(Math.abs(info.placedValue - 10) < 1e-3);
  const sheet = buildDrawingSheet(s())!;
  assert.ok(!sheet.dimensions.some(d => d.text === 'Ø10.0 mm' && d.extLine1.p1.x < sheet.views[1].centerX), 'not drawn');
  assert.deepEqual(layoutProblems(sheet), []);
  const listed = commands.execute('drawing.dimensions') as Array<{ id: string; dangling: boolean }>;
  assert.ok(listed.find(d => d.id === dia.id)!.dangling);
});

test('Dimensions in every view: placed in their bands, nothing overlaps on any sheet size', () => {
  loadExample('bearing_block');
  commands.execute('drawing.addDimension', { view: 'front', points: [{ x: -32, y: 0 }, { x: 32, y: 0 }] });
  commands.execute('drawing.addDimension', { view: 'front', kind: 'vertical', points: [{ x: -45, y: -15 }, { x: 0, y: 0 }] });
  commands.execute('drawing.addDimension', { view: 'top', points: [{ x: -45, y: 0 }, { x: -24, y: 0 }] });
  commands.execute('drawing.addDimension', { view: 'top', kind: 'vertical', points: [{ x: 45, y: -14 }, { x: 45, y: 0 }] });
  commands.execute('drawing.addDimension', { view: 'right', kind: 'vertical', points: [{ x: 16, y: -24 }, { x: 16, y: 24 }] });
  const placed = dimensionInfo(s());
  assert.equal(placed.length, 5);
  assert.ok(placed.every(d => !d.dangling), JSON.stringify(placed));
  for (const [name, size] of Object.entries(SHEET_SIZES)) {
    const sizeKey = name as keyof typeof SHEET_SIZES;
    const sheet = buildDrawingSheet({ ...s(), drawingOptions: { ...s().drawingOptions, sheetSize: sizeKey } })!;
    assert.equal(sheet.sheetSize, size);
    assert.deepEqual(layoutProblems(sheet), [], name);
    for (const d of placed) assert.ok(sheet.dimensions.some(x => x.text === `${d.value!.toFixed(1)} mm`), `${name}: ${d.value} drawn`);
  }
});

test('Hole callouts: one per hole size with the count, and never at the cost of scale', () => {
  loadExample('bearing_block');
  const sheet = D.createStandardSheet(s().bodies[0].geometry!, {});
  const texts = sheet.dimensions.map(d => d.text);
  assert.ok(texts.includes('2× Ø8.0 mm'), texts.join(' | '));
  for (const ex of CAD_EXAMPLES) {
    loadExample(ex.id);
    const g = s().bodies[0].geometry!;
    for (const sheetSize of Object.values(SHEET_SIZES)) {
      const withCallouts = D.createStandardSheet(g, { sheetSize });
      const without = D.createStandardSheet(g, { sheetSize, holeCallouts: false });
      assert.equal(withCallouts.scale, without.scale, `${ex.id} on ${sheetSize.name}`);
    }
  }
});

test('Undo removes a placed dimension; it is saved with the project and read back', () => {
  loadExample('l_bracket');
  commands.execute('drawing.addDimension', { view: 'front', points: [{ x: -10, y: 0 }, { x: 15, y: 0 }] });
  assert.equal(s().drawingDimensions.length, 1);
  s().undo();
  assert.equal(s().drawingDimensions.length, 0);
  s().redo();
  assert.equal(s().drawingDimensions.length, 1);
  const json = s().saveProject();
  s().newProject();
  assert.equal(s().drawingDimensions.length, 0);
  s().loadProject(json);
  assert.equal(s().drawingDimensions.length, 1);
  assert.deepEqual(sanitizeDimensions([{ id: 'x', view: 'iso', kind: 'horizontal', refs: [] }, null, 3]), []);
  const id = s().drawingDimensions[0].id;
  commands.execute('drawing.removeDimension', { id });
  assert.equal(s().drawingDimensions.length, 0);
  assert.throws(() => commands.execute('drawing.removeDimension', { id }), /No drawing dimension/);
});

test('Picks snap to corners, centres and circles; bad picks are refused with a reason', () => {
  loadExample('l_bracket');
  const sheet = buildDrawingSheet(s())!;
  const front = sheet.views.find(v => v.view === 'front')!;
  const corner = D.sheetPoint(front, { x: 35, y: 20, z: 0 });
  const p = pickOnSheet(sheet, { x: corner.x + 1, y: corner.y - 0.5 })!;
  assert.equal(p.view, 'front');
  assert.equal(p.snap, 'end');
  assert.ok(Math.hypot(p.at.x - 35, p.at.y - 20) < 1e-6);
  const centre = D.sheetPoint(front, { x: 15, y: 0, z: 0 });
  assert.equal(pickOnSheet(sheet, centre)!.snap, 'center');
  const rim = D.sheetPoint(front, { x: 20, y: 0, z: 0 });
  assert.equal(pickOnSheet(sheet, { x: rim.x, y: rim.y - 0.2 })!.snap, 'circle');
  assert.equal(pickOnSheet(sheet, { x: 2, y: 2 }), null);

  assert.match(newDimension(sheet, 'front', 'auto', [{ x: 35, y: 20 }, { x: 35, y: 20 }]) as string, /same/);
  assert.match(newDimension(sheet, 'front', 'vertical', [{ x: -35, y: 20 }, { x: 35, y: 20 }]) as string, /level/);
  assert.match(newDimension(sheet, 'front', 'diameter', [{ x: 0, y: 10 }]) as string, /No circle/);
  assert.throws(() => commands.execute('drawing.addDimension', { view: 'isometric', points: [{ x: 0, y: 0 }] }), /view must be/);
});

test('API 1.17: api.drawings.addDimension / dimensions / removeDimension', () => {
  loadExample('l_bracket');
  const api = createCasiWorksAPI(useCADStore as never);
  assert.ok(api.version >= '1.17.0');
  const d = api.drawings.addDimension({ view: 'front', points: [{ x: 15, y: 5 }] });
  assert.equal(d.kind, 'diameter');
  assert.ok(Math.abs(d.value! - 10) < 1e-3);
  assert.equal(api.drawings.dimensions().length, 1);
  assert.throws(() => api.drawings.addDimension({ view: 'front', points: [] }), /two points|one point/);
  api.drawings.removeDimension(d.id);
  assert.equal(api.drawings.dimensions().length, 0);
  assert.throws(() => api.drawings.removeDimension(d.id), /No drawing dimension/);
});
