// CasiWorks Pro - Assembly drawings: parts list and item balloons
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { buildDrawingSheet, drawingFile } from '../src/drawings/drawingSheet.ts';
import { layoutProblems, SHEET_SIZES } from '../src/drawings/DrawingEngine.ts';
import type { DrawingSheetSize } from '../src/store/cadStore.ts';

function assembly() {
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  r.execute('assembly.insertPart', { name: 'Base_Plate', shape: 'box', dims: { width: 50, height: 12, depth: 50 } });
  r.execute('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' });
  r.execute('assembly.mate', { type: 'concentric' });
  r.execute('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' });
  r.execute('assembly.insertPart', { name: 'Flange_Ring', shape: 'flange' });
  r.execute('assembly.solve');
  return r;
}

test('Assembly drawing: a parts list above the title block and one balloon per item, clear of everything', () => {
  assembly();
  const s = useCADStore.getState;
  for (const size of Object.keys(SHEET_SIZES) as DrawingSheetSize[]) {
    const src = { ...s(), drawingOptions: { ...s().drawingOptions, subject: 'assembly' as const, sheetSize: size } };
    const sheet = buildDrawingSheet(src)!;
    assert.ok(sheet, size);
    const t = sheet.bomTable!;
    assert.deepEqual(t.rows.map(r => [r[0], r[1], r[4]]), [['1', 'Base_Plate', '1'], ['2', 'Pin_Shaft', '2'], ['3', 'Flange_Ring', '1']], size);
    const tb = sheet.titleBlock!;
    const width = t.columns.reduce((a, c) => a + c.width, 0);
    assert.ok(Math.abs(t.x + width - (tb.x + tb.width)) < 1e-9 && t.y + 4 * t.rowHeight <= tb.y, `${size}: table sits on the title block`);
    assert.deepEqual(sheet.balloons!.map(b => b.label), ['1', '2', '3']);
    const iso = sheet.views.find(v => v.view === 'isometric')!;
    for (const b of sheet.balloons!) {
      const inView = b.target.x >= iso.bounds.minX - 1e-6 && b.target.x <= iso.bounds.maxX + 1e-6 && b.target.y >= iso.bounds.minY - 1e-6 && b.target.y <= iso.bounds.maxY + 1e-6;
      assert.ok(inView, `${size}: balloon ${b.label} points into the isometric view`);
    }
    assert.deepEqual(sheet.gdtFrames, [], 'no GD&T on an assembly drawing');
    assert.deepEqual(layoutProblems(sheet), [], `${size}: layout`);
  }
});

test('Assembly drawing: SVG and DXF carry the table and balloons; empty assembly and the part subject', () => {
  const r = assembly();
  const s = useCADStore.getState;
  r.execute('drawing.options', { subject: 'assembly' });
  const svg = drawingFile(s(), 'svg')!;
  assert.equal(svg.filename, 'Untitled_Part_assembly_drawing.svg');
  assert.match(svg.text, /<g id="bom-table">/);
  assert.match(svg.text, />PART NUMBER</);
  assert.match(svg.text, />Flange Ø50 × 8 mm</);
  assert.equal((svg.text.match(/class="balloon"/g) ?? []).length, 3);
  assert.match(svg.text, />UNTITLED PART ASSEMBLY</);
  const dxf = drawingFile(s(), 'dxf')!.text;
  assert.equal((dxf.match(/\nCIRCLE\n8\nDIMENSION\n/g) ?? []).length, 3, 'one circle per balloon');
  assert.match(dxf, /\nPin_Shaft\n/);

  assert.throws(() => r.execute('drawing.options', { subject: 'drawing' }), /subject must be/);
  r.execute('assembly.clear');
  assert.equal(drawingFile(s(), 'svg'), null, 'nothing to draw');
  r.execute('drawing.options', { subject: 'part' });
  s().newProject();
});

test('Assembly drawing: leaders end at different points even when a part sits inside another', () => {
  assembly(); // pin 1 is concentric with the plate, so its centre is inside the plate
  const s = useCADStore.getState;
  const sheet = buildDrawingSheet({ ...s(), drawingOptions: { ...s().drawingOptions, subject: 'assembly' } })!;
  const t = sheet.balloons!.map(b => b.target);
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    assert.ok(Math.hypot(t[i].x - t[j].x, t[i].y - t[j].y) >= 6, `leaders ${i + 1} and ${j + 1} end ${Math.hypot(t[i].x - t[j].x, t[i].y - t[j].y).toFixed(2)} mm apart`);
  }
  s().newProject();
});
