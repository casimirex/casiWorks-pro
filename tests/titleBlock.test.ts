// CasiWorks Pro - Sheet formats and the title block editor (roadmap 5.4)
import test from 'node:test';
import assert from 'node:assert/strict';

import { DrawingEngine, layoutProblems, SHEET_SIZES, SHEET_SIZE_KEYS } from '../src/drawings/DrawingEngine.ts';
import { buildDrawingSheet, drawingFile, titleBlockFields } from '../src/drawings/drawingSheet.ts';
import { fitText, sanitizeTitleBlock, titleBlockDrawing } from '../src/drawings/titleBlock.ts';
import { sheetToPdf } from '../src/drawings/pdf.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';
import { commands } from '../src/commands/index.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';

const D = new DrawingEngine();
const s = useCADStore.getState;
function bracket() {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    s().loadExampleModel(CAD_EXAMPLES[0].create());
    rebuildModel(useCADStore);
  } finally {
    console.warn = realWarn;
  }
}

test('Sheet formats: ISO A4–A0 and ANSI A–D, every one laid out cleanly with the title block in the corner', () => {
  assert.deepEqual(SHEET_SIZE_KEYS, ['A4_LANDSCAPE', 'A4_PORTRAIT', 'A3_LANDSCAPE', 'A2_LANDSCAPE', 'A1_LANDSCAPE', 'A0_LANDSCAPE', 'ANSI_A', 'ANSI_B', 'ANSI_C', 'ANSI_D']);
  assert.deepEqual([SHEET_SIZES.A0_LANDSCAPE.width, SHEET_SIZES.A0_LANDSCAPE.height], [1189, 841]);
  assert.deepEqual([SHEET_SIZES.ANSI_D.width, SHEET_SIZES.ANSI_D.height], [863.6, 558.8]);
  bracket();
  for (const key of SHEET_SIZE_KEYS) {
    commands.execute('drawing.options', { sheetSize: key });
    const sheet = buildDrawingSheet(s())!;
    assert.equal(sheet.sheetSize, SHEET_SIZES[key]);
    const tb = sheet.titleBlock!, b = sheet.border!;
    // In the corner of the inner frame, so no frame line runs through it
    assert.ok(Math.abs(tb.x + tb.width - (b.x + b.width - b.innerMargin)) < 1e-9 && Math.abs(tb.y + tb.height - (b.y + b.height - b.innerMargin)) < 1e-9, `${key}: bottom-right corner`);
    assert.deepEqual(layoutProblems(sheet), [], key);
  }
  // Bigger sheets draw the part bigger
  const scale = (key: string) => { commands.execute('drawing.options', { sheetSize: key }); return buildDrawingSheet(s())!.scale; };
  assert.ok(scale('A0_LANDSCAPE') > scale('A4_LANDSCAPE'));
  commands.execute('drawing.options', { sheetSize: 'A4_LANDSCAPE' });
  assert.throws(() => commands.execute('drawing.options', { sheetSize: 'B5' }), /sheetSize must be one of .*ANSI_D/);
});

test('Title block fields: set, shown on SVG, PDF and DXF, cleared back to the generated value', () => {
  bracket();
  const before = commands.execute('drawing.titleBlock') as { shown: { title: string; revision: string; material: string } };
  assert.equal(before.shown.title, 'MOUNTING_L_BRACKET');
  assert.equal(before.shown.revision, 'A');
  const r = commands.execute('drawing.titleBlock', { company: 'Acme Engineering', drawnBy: 'J. Doe', checkedBy: 'R. Roe', approvedBy: 'K. Lee', revision: 'C', title: 'Mounting bracket, left', date: '2026-11-18' }) as { set: Record<string, string>; shown: Record<string, string> };
  assert.equal(r.shown.company, 'Acme Engineering');
  assert.equal(r.shown.partNumber, 'DWG-MOUN', 'unset fields keep their generated values');
  const svg = drawingFile(s(), 'svg')!.text;
  for (const text of ['Acme Engineering', 'J. Doe', 'R. Roe', 'K. Lee', '>C<', 'Mounting bracket, left', '2026-11-18', '>DRAWN<', '>APPROVED<', '>1:2<']) assert.ok(svg.includes(text), `SVG has ${text}`);
  const dxf = drawingFile(s(), 'dxf')!.text;
  assert.match(dxf, /\n1\nAcme Engineering\n/);
  assert.match(dxf, /\n1\nJ\. Doe\n/);
  assert.ok((dxf.match(/\nLINE\n8\nBORDER\n/g) ?? []).length >= 8 + 4 + 6, 'border frames and title block lines in the DXF');
  const pdf = sheetToPdf(buildDrawingSheet(s())!, 'x');
  assert.ok(pdf.includes('(Acme Engineering)') && pdf.includes('(K. Lee)'));
  commands.execute('drawing.titleBlock', { company: '', revision: '' });
  const after = titleBlockFields(s());
  assert.equal(after.company, '');
  assert.equal(after.revision, 'A', 'cleared: generated again');
  assert.equal(s().drawingTitleBlock.drawnBy, 'J. Doe');
});

test('Title block edits: validated, undoable, saved with the document, reset by a new document', () => {
  bracket();
  assert.throws(() => commands.execute('drawing.titleBlock', { owner: 'x' }), /Unknown title block field/);
  assert.throws(() => commands.execute('drawing.titleBlock', { revision: 'TOO-LONG-REV' }), /longer than 6/);
  assert.throws(() => commands.execute('drawing.titleBlock', { title: 5 }), /must be a string/);
  commands.execute('drawing.titleBlock', { drawnBy: 'A. Smith' });
  assert.equal(s().drawingTitleBlock.drawnBy, 'A. Smith');
  s().undo();
  assert.equal(s().drawingTitleBlock.drawnBy, undefined);
  s().redo();
  assert.equal(s().drawingTitleBlock.drawnBy, 'A. Smith');
  const json = s().saveProject();
  assert.equal(JSON.parse(json).drawingTitleBlock.drawnBy, 'A. Smith');
  s().newProject();
  assert.deepEqual(s().drawingTitleBlock, {});
  s().loadProject(json);
  assert.equal(s().drawingTitleBlock.drawnBy, 'A. Smith');
  assert.deepEqual(sanitizeTitleBlock({ title: '  Plate\n  ', bogus: 'x', company: 3, revision: '' }), { title: 'Plate' });
});

test('Long values are cut to their cell, so the title block never overflows', () => {
  assert.equal(fitText('short', 40, 2.5), 'short');
  const cut = fitText('A very long material name that does not fit', 20, 2.5);
  assert.ok(cut.endsWith('…') && cut.length <= Math.floor(20 / (2.5 * 0.58)));
  const tb = { x: 0, y: 0, width: 100, height: 40, title: 'X'.repeat(60), partNumber: 'P'.repeat(30), revision: 'A', material: 'M'.repeat(40), scaleText: 'Scale: 1:1', date: '2026-11-18', drawnBy: 'D'.repeat(24) };
  for (const t of titleBlockDrawing(tb).texts) {
    const right = t.x + t.text.length * t.size * 0.58;
    assert.ok(right <= 100 + 1e-9, `${t.text.slice(0, 10)}… ends at ${right.toFixed(1)}`);
  }
});

test('The assembly sheet uses the title block fields too; API 1.18 getTitleBlock / setTitleBlock', () => {
  bracket();
  const api = createCasiWorksAPI(useCADStore as never);
  assert.ok(api.version >= '1.18.0', api.version);
  const shown = api.drawings.setTitleBlock({ company: 'Acme', approvedBy: 'Q. A.' });
  assert.equal(shown.company, 'Acme');
  assert.equal(api.drawings.getTitleBlock().approvedBy, 'Q. A.');
  assert.throws(() => api.drawings.setTitleBlock({ nope: 'x' } as never), /Unknown title block field/);
  const asm = titleBlockFields({ ...s(), drawingOptions: { ...s().drawingOptions, subject: 'assembly' } });
  assert.equal(asm.material, 'SEE PARTS LIST');
  assert.equal(asm.company, 'Acme');
  // A standalone sheet without fields still has a complete title block
  const sheet = D.createStandardSheet(s().bodies[0].geometry!, {});
  assert.equal(sheet.titleBlock!.revision, 'A');
  api.drawings.setTitleBlock({ company: '', approvedBy: '' });
});
