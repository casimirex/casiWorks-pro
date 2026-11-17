// CasiWorks Pro - Drawing engine: projections with hidden-line removal, sheets, dimensions, GD&T, SVG and DXF
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { drawingEngine, PROJECTION_VIEWS, SHEET_SIZES } from '../src/drawings/DrawingEngine.ts';

test('DrawingEngine: orthographic projections with Hidden Line Removal (HLR)', () => {
  const geom = new THREE.BoxGeometry(60, 40, 25);

  const frontView = drawingEngine.projectGeometry(geom, PROJECTION_VIEWS.FRONT, { enableHLR: true });
  const topView = drawingEngine.projectGeometry(geom, PROJECTION_VIEWS.TOP, { enableHLR: true });
  const rightView = drawingEngine.projectGeometry(geom, PROJECTION_VIEWS.RIGHT, { enableHLR: true });
  const isoView = drawingEngine.projectGeometry(geom, PROJECTION_VIEWS.ISOMETRIC, { enableHLR: true });

  assert.ok(frontView.visible.length > 0, 'Front view must contain visible edges');
  assert.ok(topView.visible.length > 0, 'Top view must contain visible edges');
  assert.ok(rightView.visible.length > 0, 'Right view must contain visible edges');
  assert.ok(isoView.visible.length > 0, 'Isometric view must contain visible edges');

  assert.ok(frontView.bounds.width > 0, 'Front view width > 0');
  assert.ok(frontView.bounds.height > 0, 'Front view height > 0');
});

test('DrawingEngine: standard sheet generation with dimensions, GD&T, and SVG/DXF exports', () => {
  const geom = new THREE.BoxGeometry(60, 40, 25);
  const sheetData = drawingEngine.createStandardSheet(geom, {
    sheetSize: SHEET_SIZES.A4_LANDSCAPE,
    title: 'BRACKET HOUSING',
    partNumber: 'DWG-BRK-01',
    material: 'Steel 1020',
  });

  assert.equal(sheetData.views.length, 4, 'Must generate 4 orthographic views (Top, Front, Right, Iso)');
  assert.ok(sheetData.dimensions.length > 0, 'Must generate automatic linear dimensions');
  assert.ok(sheetData.gdtFrames.length > 0, 'Must generate GD&T feature control frames');
  assert.ok(sheetData.titleBlock?.title === 'BRACKET HOUSING', 'Title block must contain part title');

  // Verify SVG vector export
  const svg = drawingEngine.exportSVG(sheetData);
  assert.ok(svg.includes('<svg') && svg.includes('</svg>'), 'Must export valid SVG document');
  assert.ok(svg.includes('visible-line'), 'SVG must include visible contour lines');
  assert.ok(svg.includes('title-block'), 'SVG must include engineering title block');
  assert.ok(svg.includes('BRACKET HOUSING'), 'SVG must include part name text');

  // Verify AutoCAD DXF export
  const dxf = drawingEngine.exportDXF(sheetData);
  assert.ok(dxf.includes('SECTION') && dxf.includes('ENTITIES') && dxf.includes('EOF'), 'Must export valid DXF structure');
  assert.ok(dxf.includes('VISIBLE'), 'DXF must contain VISIBLE layer lines');
  assert.ok(dxf.includes('DIMENSION'), 'DXF must contain DIMENSION entities');
});
