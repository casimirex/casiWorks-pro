// CasiWorks Pro - Bill of materials
import test from 'node:test';
import assert from 'node:assert/strict';

import { bomCSV, buildBom } from '../src/assembly/bom.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import type { Bom } from '../src/assembly/bom.ts';

const steel = 'Steel_1020';
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

test('Component materials: own material per component, grouped apart, saved with the project', () => {
  const r = createCommandRegistry(useCADStore);
  const s = () => useCADStore.getState();
  s().newProject();
  r.execute('assembly.insertPart', { name: 'Base_Plate', shape: 'box', dims: { width: 50, height: 12, depth: 50 } });
  const pins = [r.execute('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' }), r.execute('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' })]
    .map(x => (x as { componentId: string }).componentId);
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return null; };
  assert.equal(code(() => r.execute('assembly.setMaterial', { components: pins, material: 'Unobtainium' })), 'INVALID_ARGUMENT');
  assert.equal(code(() => r.execute('assembly.setMaterial', { components: ['nope'], material: 'Brass_C36000' })), 'INVALID_ARGUMENT');
  assert.equal(code(() => r.execute('assembly.setMaterial', { components: [], material: 'Brass_C36000' })), 'INVALID_ARGUMENT');

  // One brass pin: the two pins split into two rows
  r.execute('assembly.setMaterial', { components: [pins[0]], material: 'Brass_C36000' });
  let bom = r.execute('assembly.bom') as Bom;
  assert.deepEqual(bom.rows.map(x => [x.partNumber, x.material, x.quantity, x.inherited]),
    [['Base_Plate', 'AISI 1020 Steel', 1, true], ['Pin_Shaft', 'Brass C36000', 1, false], ['Pin_Shaft', 'AISI 1020 Steel', 1, true]]);
  near(bom.rows[1].unitMass, Math.PI * 36 * 40 * 1e-9 * 8500);
  assert.match(s().statusMessage, /"Pin_Shaft": Brass C36000/);

  // Both brass: one row again. The document material change leaves them brass.
  r.execute('assembly.setMaterial', { components: pins, material: 'Brass_C36000' });
  r.execute('model.setMaterial', { key: 'Aluminum_6061' });
  bom = r.execute('assembly.bom') as Bom;
  assert.deepEqual(bom.rows.map(x => [x.material, x.quantity]), [['Aluminum 6061-T6', 1], ['Brass C36000', 2]]);

  // Saved and loaded with the project
  const saved = s().saveProject();
  s().newProject();
  s().loadProject(saved);
  bom = r.execute('assembly.bom') as Bom;
  assert.deepEqual(bom.rows.map(x => [x.material, x.quantity]), [['Aluminum 6061-T6', 1], ['Brass C36000', 2]], 'after reload');

  // null goes back to the part material
  r.execute('assembly.setMaterial', { components: s().assemblyComponents.map(c => c.id), material: null });
  bom = r.execute('assembly.bom') as Bom;
  assert.ok(bom.rows.every(x => x.inherited && x.material === 'Aluminum 6061-T6'));
  s().newProject();
});
