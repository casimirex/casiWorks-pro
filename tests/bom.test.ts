// CasiWorks Pro - Bill of materials
import test from 'node:test';
import assert from 'node:assert/strict';

import { bomCSV, buildBom } from '../src/assembly/bom.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import type { Bom } from '../src/assembly/bom.ts';

const steel = { name: 'AISI 1020 Steel', density: 7900 };
const near = (a: number, b: number, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

test('BOM: identical parts share a row with their quantity; masses from exact volumes', () => {
  const bom = buildBom([
    { id: 'c1', name: 'Base_Plate', geometryType: 'box', dimensions: { width: 50, height: 12, depth: 50 } },
    { id: 'c2', name: 'Pin_Shaft', geometryType: 'pin' },
    { id: 'c3', name: 'Pin_Shaft', geometryType: 'pin' },
    { id: 'c4', name: 'Rod', geometryType: 'cylinder', dimensions: { radius: 12, height: 35 } },
    { id: 'c5', name: 'Rod', geometryType: 'cylinder', dimensions: { radius: 10, height: 35 } },
  ], steel);
  assert.deepEqual(bom.rows.map(r => [r.item, r.partNumber, r.quantity]), [[1, 'Base_Plate', 1], [2, 'Pin_Shaft', 2], [3, 'Rod', 1], [4, 'Rod', 1]], 'same name, other size: own row');
  assert.equal(bom.rows[0].description, 'Block 50 × 12 × 50 mm');
  assert.equal(bom.rows[1].description, 'Pin Ø12 × 40 mm');
  assert.equal(bom.rows[2].description, 'Cylinder Ø24 × 35 mm');
  near(bom.rows[0].unitMass, 50 * 12 * 50 * 1e-9 * 7900); // 0.237 kg
  near(bom.rows[1].totalMass, 2 * Math.PI * 36 * 40 * 1e-9 * 7900);
  assert.deepEqual(bom.rows[1].componentIds, ['c2', 'c3']);
  assert.equal(bom.totalQuantity, 5);
  near(bom.totalMass, bom.rows.reduce((m, r) => m + r.totalMass, 0));
  assert.deepEqual(buildBom([], steel).rows, []);
});

test('BOM CSV: header, a row per part, a total; cells with commas or quotes are quoted', () => {
  const bom: Bom = buildBom([{ id: 'a', name: 'Plate, "big"', geometryType: 'box', dimensions: { width: 10, height: 10, depth: 10 } }], steel);
  const lines = bomCSV(bom).trimEnd().split('\r\n');
  assert.equal(lines[0], 'Item,Part number,Description,Qty,Material,Unit mass (g),Total mass (g)');
  assert.equal(lines[1], '1,"Plate, ""big""",Block 10 × 10 × 10 mm,1,AISI 1020 Steel,7.90,7.90');
  assert.equal(lines[2], ',Total,,1,,,7.90');
});

test('BOM command: uses the document material and the components in the store', () => {
  const r = createCommandRegistry(useCADStore);
  const s = () => useCADStore.getState();
  s().newProject();
  assert.deepEqual((r.execute('assembly.bom') as Bom).rows, []);
  r.execute('assembly.insertPart', { name: 'Base_Plate', shape: 'box', dims: { width: 50, height: 12, depth: 50 } });
  r.execute('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' });
  r.execute('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' });
  r.execute('model.setMaterial', { key: 'Aluminum_6061' });
  const bom = r.execute('assembly.bom') as Bom;
  assert.equal(bom.material, 'Aluminum 6061-T6');
  assert.deepEqual(bom.rows.map(x => x.quantity), [1, 2]);
  near(bom.rows[0].unitMass, 30000 * 1e-9 * 2700);
  assert.throws(() => r.execute('assembly.exportBom'), (e: unknown) => (e as { code?: string }).code === 'NOT_AVAILABLE', 'needs the UI');
  s().newProject();
});
