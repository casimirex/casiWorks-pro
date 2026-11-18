// CasiWorks Pro - Unit systems (roadmap 8.3)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatArea, formatDensity, formatInertia, formatLength, formatMass, formatVolume, fromLength,
  niceStep, parseLength, toLength, unitSystemOf, UNIT_SYSTEMS,
} from '../src/utils/units.ts';
import { unitsFor } from '../src/components/common/useUnits.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { commands } from '../src/commands/index.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { drawingFile } from '../src/drawings/drawingSheet.ts';
import { bomCSV } from '../src/assembly/bom.ts';
import type { Bom } from '../src/assembly/bom.ts';

const s = useCADStore.getState;

test('Lengths convert both ways in every system; the model unit is always mm', () => {
  assert.deepEqual([...UNIT_SYSTEMS], ['MMGS', 'CGS', 'MKS', 'IPS']);
  assert.equal(toLength(25.4, 'IPS'), 1);
  assert.equal(toLength(25, 'CGS'), 2.5);
  assert.equal(toLength(1500, 'MKS'), 1.5);
  assert.equal(toLength(12.5, 'MMGS'), 12.5);
  for (const sys of UNIT_SYSTEMS) assert.ok(Math.abs(fromLength(toLength(123.456, sys), sys) - 123.456) < 1e-12, sys);
  assert.equal(formatLength(70, 'IPS'), '2.756 in');
  assert.equal(formatLength(70, 'MMGS'), '70 mm');
  assert.equal(formatLength(70, 'MMGS', { fixed: true }), '70.00 mm');
  assert.equal(formatLength(-0.0001, 'MMGS'), '0 mm', 'no -0');
  assert.equal(formatLength(1234, 'MKS'), '1.234 m');
});

test('Typed lengths: a plain number is in the system unit, a number with a unit is in that unit', () => {
  assert.equal(parseLength('2', 'IPS'), 50.8);
  assert.equal(parseLength('2', 'MMGS'), 2);
  assert.equal(parseLength('25.4 mm', 'IPS'), 25.4);
  assert.equal(parseLength('1in', 'MMGS'), 25.4);
  assert.ok(Math.abs(parseLength('1.5"', 'CGS')! - 38.1) < 1e-9);
  assert.equal(parseLength("1'", 'MMGS'), 304.8);
  assert.equal(parseLength('3 cm', 'IPS'), 30);
  assert.equal(parseLength(' 0.5 M ', 'MMGS'), 500);
  assert.equal(parseLength('-.25in', 'MMGS'), -6.35);
  assert.equal(parseLength('1e1 mm', 'IPS'), 10);
  for (const bad of ['', 'abc', '2 furlongs', 'wall*2', '1 2']) assert.equal(parseLength(bad, 'MMGS'), null, bad);
});

test('Areas, volumes, masses, densities and inertia in each system', () => {
  assert.equal(formatVolume(60000, 'MMGS'), '60000 mm³');
  assert.equal(formatVolume(60000, 'CGS'), '60 cm³');
  assert.equal(formatVolume(16387.064, 'IPS'), '1 in³');
  assert.equal(formatArea(645.16, 'IPS'), '1 in²');
  assert.equal(formatMass(0.237, 'MMGS'), '237 g');
  assert.equal(formatMass(0.45359237, 'IPS'), '1 lb');
  assert.equal(formatMass(2.5, 'MKS'), '2.5 kg');
  assert.equal(formatDensity(7850, 'MKS'), '7850 kg/m³');
  assert.equal(formatDensity(7850, 'CGS'), '7.85 g/cm³');
  assert.equal(formatDensity(27679.9, 'IPS'), '1 lb/in³');
  assert.equal(formatInertia(1000, 'MKS'), '0.001 kg·m²');
  assert.equal(niceStep(1, 'IPS'), 0.05);
  assert.equal(niceStep(5, 'IPS'), 0.2);
  assert.equal(niceStep(5, 'CGS'), 0.5);
  assert.equal(niceStep(10, 'MKS'), 0.01);
  const u = unitsFor('IPS');
  assert.equal(u.len(12.7), '0.5 in');
  assert.equal(u.len(12.7, { fixed: true }), '0.500 in');
  assert.equal(u.num(25.4, 1), '1');
});

test('The unit system is a document setting: command, saved and read back, older files are MMGS, New keeps it', () => {
  s().newProject();
  assert.equal(s().settings.units, 'MMGS');
  assert.deepEqual(commands.execute('settings.units') , { system: 'MMGS', name: 'MMGS (millimetre, gram, second)', length: 'mm', mass: 'g', decimals: 2 });
  commands.execute('settings.units', { system: 'IPS' });
  assert.equal(s().settings.units, 'IPS');
  assert.equal(s().isModified, true);
  assert.throws(() => commands.execute('settings.units', { system: 'inch' }), /system must be one of/);
  const json = s().saveProject();
  assert.equal(JSON.parse(json).settings.units, 'IPS');
  s().newProject();
  assert.equal(s().settings.units, 'IPS', 'New keeps the unit system');
  commands.execute('settings.units', { system: 'MKS' });
  s().loadProject(json);
  assert.equal(s().settings.units, 'IPS');
  const old = JSON.parse(json);
  old.settings.units = 'mm';
  s().loadProject(JSON.stringify(old));
  assert.equal(s().settings.units, 'MMGS', 'an older file (units: mm) opens as MMGS');
  assert.equal(unitSystemOf(undefined), 'MMGS');
});

test('Drawing sheets dimension in the document units; the model and API stay in mm', () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    s().loadExampleModel(CAD_EXAMPLES[0].create());
    rebuildModel(useCADStore);
  } finally {
    console.warn = realWarn;
  }
  commands.execute('settings.units', { system: 'IPS' });
  const svg = drawingFile(s(), 'svg')!.text;
  assert.match(svg, />2\.756 in</, 'bracket width 70 mm');
  assert.match(svg, />2× Ø0\.394 in</, 'hole callout Ø10 mm');
  // Commands and API inputs are mm whatever the display
  const d = commands.execute('drawing.addDimension', { view: 'front', points: [{ x: -35, y: 20 }, { x: 35, y: 20 }] }) as { value: number };
  assert.equal(Math.round(d.value * 1000) / 1000, 70);
  commands.execute('settings.units', { system: 'MMGS' });
  assert.match(drawingFile(s(), 'svg')!.text, />70\.0 mm</);
});

test('BOM CSV masses in the document mass unit', () => {
  const bom: Bom = { rows: [{ item: 1, partNumber: 'P1', description: 'Plate', quantity: 2, material: 'Steel', unitMass: 0.45359237, totalMass: 0.90718474 }], totalQuantity: 2, totalMass: 0.90718474, material: 'Steel' } as unknown as Bom;
  const lb = bomCSV(bom, 'lb').split('\r\n');
  assert.equal(lb[0], 'Item,Part number,Description,Qty,Material,Unit mass (lb),Total mass (lb)');
  assert.equal(lb[1], '1,P1,Plate,2,Steel,1.0000,2.0000');
  assert.equal(bomCSV(bom).split('\r\n')[1], '1,P1,Plate,2,Steel,453.59,907.18');
});
