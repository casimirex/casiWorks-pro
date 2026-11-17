// CasiWorks Pro - Data exchange round trips: STL, DXF, STEP, IGES (Hollerith lengths) and sketch points
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { exportEngine } from '../src/kernel/ExportEngine.ts';
import { importEngine } from '../src/kernel/ImportEngine.ts';
import { SKETCH_ENTITY_TYPES } from '../src/utils/constants.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { sketchEngine } from '../src/kernel/SketchEngine.ts';

test('ExportEngine & ImportEngine: STL binary round-trip preserves geometry bounds', async () => {
  const geom = new THREE.BoxGeometry(30, 20, 10);
  const binBuffer = exportEngine.exportSTL(geom, true);
  const arrayBuf = await binBuffer.arrayBuffer();

  const imported = importEngine.importSTL(arrayBuf);
  imported.computeBoundingBox();

  const origBox = geom.boundingBox ?? (geom.computeBoundingBox(), geom.boundingBox!);
  const impBox = imported.boundingBox!;

  assert.ok(Math.abs(impBox.min.x - origBox.min.x) < 1e-2);
  assert.ok(Math.abs(impBox.max.x - origBox.max.x) < 1e-2);
  assert.ok(Math.abs(impBox.min.y - origBox.min.y) < 1e-2);
  assert.ok(Math.abs(impBox.max.y - origBox.max.y) < 1e-2);
  assert.ok(Math.abs(impBox.min.z - origBox.min.z) < 1e-2);
  assert.ok(Math.abs(impBox.max.z - origBox.max.z) < 1e-2);
  const expectedCount = geom.index ? geom.toNonIndexed().attributes.position.count : geom.attributes.position.count;
  assert.equal(imported.attributes.position.count, expectedCount);
});

test('ExportEngine & ImportEngine: DXF sketch round-trip preserves entity data', async () => {
  const entities = [
    { id: 'l1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 0, y: 0 }, p2: { x: 100, y: 50 } },
    { id: 'c1', type: SKETCH_ENTITY_TYPES.CIRCLE, center: { x: 25, y: 25 }, radius: 15 },
  ];

  const dxfBlob = exportEngine.exportDXF(entities);
  const dxfStr = await dxfBlob.text();
  const importedEntities = importEngine.importDXF(dxfStr);

  assert.equal(importedEntities.length, 2, 'Must import 2 entities');
  const line = importedEntities.find(e => e.type === SKETCH_ENTITY_TYPES.LINE);
  const circle = importedEntities.find(e => e.type === SKETCH_ENTITY_TYPES.CIRCLE);

  assert.ok(line && Math.abs(line.p2.x - 100) < 1e-3 && Math.abs(line.p2.y - 50) < 1e-3);
  assert.ok(circle && Math.abs(circle.center.x - 25) < 1e-3 && Math.abs(circle.radius - 15) < 1e-3);
});

test('ExportEngine & ImportEngine: STEP (faceted B-rep) and IGES 5.3 round-trip data exchange', async () => {
  const geom = new THREE.BoxGeometry(40, 25, 15);

  // 1. STEP AP214 faceted B-rep export & import (detailed structure checks: exchange.test.ts)
  const stepBlob = exportEngine.exportSTEP(geom, 'TEST_BRACKET', { schema: 'AP214' });
  const stepText = await stepBlob.text();
  assert.ok(stepText.includes('ISO-10303-21;'), 'STEP must contain ISO-10303-21 header');
  assert.ok(stepText.includes('FACETED_BREP('), 'STEP must define a FACETED_BREP solid');
  assert.ok(stepText.includes('FACETED_BREP_SHAPE_REPRESENTATION'), 'STEP must define the faceted shape representation');
  assert.ok(stepText.includes('POLY_LOOP'), 'STEP faces must be POLY_LOOPs');
  assert.ok(stepText.includes('MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION'), 'STEP must include styling');

  const importedStep = importEngine.importSTEP(stepText);
  assert.ok(importedStep instanceof THREE.BufferGeometry, 'Imported STEP must be BufferGeometry');
  importedStep.computeBoundingBox();
  const stepBox = importedStep.boundingBox!;
  assert.ok(Math.abs(stepBox.max.x - stepBox.min.x - 40) < 1e-1, 'STEP round-trip X dimension ~40');
  assert.ok(Math.abs(stepBox.max.y - stepBox.min.y - 25) < 1e-1, 'STEP round-trip Y dimension ~25');
  assert.ok(Math.abs(stepBox.max.z - stepBox.min.z - 15) < 1e-1, 'STEP round-trip Z dimension ~15');

  // 2. IGES 5.3 MSBO export & import
  const igesBlob = exportEngine.exportIGES(geom, 'TEST_IGES');
  const igesText = await igesBlob.text();
  const igesLines = igesText.split('\n');
  assert.ok(igesLines.some(l => l.length >= 73 && l.charAt(72) === 'S'), 'IGES must have Start (S) records');
  assert.ok(igesLines.some(l => l.length >= 73 && l.charAt(72) === 'G'), 'IGES must have Global (G) records');
  assert.ok(igesLines.some(l => l.length >= 73 && l.charAt(72) === 'D'), 'IGES must have Directory (D) records');
  assert.ok(igesLines.some(l => l.length >= 73 && l.charAt(72) === 'P'), 'IGES must have Parameter (P) records');

  const importedIges = importEngine.importIGES(igesText);
  assert.ok(importedIges instanceof THREE.BufferGeometry, 'Imported IGES must be BufferGeometry');
  importedIges.computeBoundingBox();
  const igesBox = importedIges.boundingBox!;
  assert.ok(Math.abs(igesBox.max.x - igesBox.min.x - 40) < 1e-1, 'IGES round-trip X dimension ~40');
  assert.ok(Math.abs(igesBox.max.y - igesBox.min.y - 25) < 1e-1, 'IGES round-trip Y dimension ~25');
  assert.ok(Math.abs(igesBox.max.z - igesBox.min.z - 15) < 1e-1, 'IGES round-trip Z dimension ~15');
});

test('IGES regression: every Hollerith string in the Global section declares its true length', async () => {
  const geom = new THREE.BoxGeometry(10, 10, 10);
  const iges = await exportEngine.exportIGES(geom, 'Part').text();
  const gSection = iges.split(/\r?\n/).filter(l => l.length >= 73 && l[72] === 'G').map(l => l.slice(0, 72)).join('');
  const re = /(\d+)H/g;
  let m;
  let checked = 0;
  while ((m = re.exec(gSection))) {
    const prev = gSection[m.index - 1];
    if (m.index > 0 && prev !== ',' ) continue; // only parameters starting a field
    const n = Number(m[1]);
    const text = gSection.slice(m.index + m[0].length, m.index + m[0].length + n);
    const after = gSection[m.index + m[0].length + n];
    assert.ok(after === ',' || after === ';', `Hollerith ${m[0]}${text} must be followed by a delimiter, got "${after}"`);
    checked++;
    re.lastIndex = m.index + m[0].length + n;
  }
  assert.ok(checked >= 8, `expected to verify the Global section strings, verified ${checked}`);
  assert.match(gSection, /CasiWorks/);
});

test('Sketch points: UI-created points use the canonical format and survive DXF export; old files are converted', async () => {
  const pt = sketchEngine.createPoint({ x: 12.5, y: -4 });
  assert.equal(pt.type, 'point');
  assert.equal(pt.x, 12.5);
  assert.equal(pt.y, -4);
  assert.equal((pt as { p1?: unknown }).p1, undefined);

  const dxf = await exportEngine.exportDXF([pt]).text();
  assert.match(dxf, /POINT/, 'point must be written to DXF');
  assert.match(dxf, /10\n12\.5/, 'x coordinate must be written');

  // A project saved by an older build stored points as { p1: {x, y} }
  const store = useCADStore;
  store.getState().loadProject({
    documentName: 'Legacy',
    features: [],
    sketchEntities: { s1: [{ id: 'old', type: 'point', p1: { x: 3, y: 7 } }] },
  });
  const loaded = store.getState().sketchEntities.s1[0] as unknown as Record<string, unknown>;
  assert.deepEqual([loaded.x, loaded.y, loaded.p1], [3, 7, undefined]);
});
