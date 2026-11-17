// CasiWorks Pro - Drawing sheet as PDF
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { drawingFile } from '../src/drawings/drawingSheet.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';
import { createCasiWorksAPI, API_VERSION } from '../src/api/CasiWorksAPI.ts';

/** Semantic version at least major.minor. */
const atLeast = (v: string, major: number, minor: number) => { const [a, b] = v.split('.').map(Number); return a > major || (a === major && b >= minor); };

/** Check the file structure: header, objects at the offsets the xref table gives, trailer. */
function checkPdf(pdf: string): { pageSize: number[]; content: string } {
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
  assert.ok(pdf.slice(startxref).startsWith('xref\n0 8\n'), 'startxref points at the xref table');
  const entries = pdf.slice(startxref).split('\n').slice(3, 10);
  entries.forEach((e, i) => {
    const offset = Number(e.slice(0, 10));
    assert.ok(pdf.slice(offset).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1} at ${offset}`);
  });
  const stream = /<< \/Length (\d+) >>\nstream\n/.exec(pdf)!;
  const start = stream.index + stream[0].length;
  const content = pdf.slice(start, start + Number(stream[1]));
  assert.ok(pdf.slice(start + Number(stream[1])).startsWith('\nendstream'), 'stream length is exact');
  for (let i = 0; i < pdf.length; i++) assert.ok(pdf.charCodeAt(i) < 256, 'one byte per char');
  return { pageSize: /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)!.slice(1).map(Number), content };
}

test('PDF: the part sheet is a valid one-page vector PDF with the sheet text', () => {
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  const { sketchId } = r.execute('sketch.create', { plane: 'Front', entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 40, y: 20 } }] }) as { sketchId: string };
  r.execute('feature.create', { type: 'extrude_boss', sketchId, depth: 10 });
  s().setDocumentName('Plate (A)');
  rebuildModel(useCADStore);
  const file = drawingFile(s(), 'pdf')!;
  assert.equal(file.filename, 'Plate_(A)_drawing.pdf');
  assert.equal(file.mimeType, 'application/pdf');
  assert.equal(file.bytes!.length, file.text.length);
  const { pageSize, content } = checkPdf(file.text);
  assert.deepEqual(pageSize.map(v => Math.round(v)), [842, 595], 'A4 landscape in points');
  assert.match(content, /\(PLATE \\\(A\\\)\) Tj/, 'title, with ( ) escaped');
  assert.match(content, /\(FRONT VIEW\) Tj/);
  assert.match(content, /\(\xd80\.05\) Tj/, '⌀ written as WinAnsi Ø');
  assert.match(content, /\[[\d.]+ [\d.]+\] 0 d/, 'dashed hidden lines style');
  assert.doesNotMatch(content, /\(\?\) Tj/, 'no unknown characters');
  s().newProject();
});

test('PDF: assembly sheet carries the parts list and balloons; API 1.7 drawings.pdf', () => {
  const api = createCasiWorksAPI(useCADStore);
  assert.ok(atLeast(API_VERSION, 1, 7), `API ${API_VERSION} is at least 1.7`);
  api.document.new();
  api.assembly.insert({ name: 'Base_Plate', shape: 'box' });
  api.assembly.insert({ name: 'Pin_Shaft', shape: 'pin' });
  api.drawings.setOptions({ subject: 'assembly', sheetSize: 'A3_LANDSCAPE' });
  const { pageSize, content } = checkPdf(api.drawings.pdf());
  assert.deepEqual(pageSize.map(v => Math.round(v)), [1191, 842]);
  assert.match(content, /\(PART NUMBER\) Tj/);
  assert.match(content, /\(Pin \xd812 \xd7 40 mm\) Tj/, 'Ø and × in WinAnsi');
  assert.equal((content.match(/ c B/g) ?? []).length, 2, 'two balloons (Bézier circles, filled and stroked)');
  api.drawings.setOptions({ subject: 'part', sheetSize: 'A4_LANDSCAPE' });
  api.document.new();
});
