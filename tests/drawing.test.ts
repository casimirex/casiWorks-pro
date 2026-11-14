// CasiWorks Pro - Drawing engine tests (projection, hidden lines, sheet layout, exports)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { DrawingEngine, buildViewMesh, extractDrawingEdges, layoutProblems, SHEET_SIZES } from '../src/drawings/DrawingEngine.ts';
import type { DrawingLine } from '../src/drawings/DrawingEngine.ts';
import { geometryEngine as G } from '../src/kernel/GeometryEngine.ts';
import type { ProfileEntity } from '../src/kernel/GeometryEngine.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';

const D = new DrawingEngine();
const L = (x1: number, y1: number, x2: number, y2: number): ProfileEntity => ({ type: 'line', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
const rect = (x0: number, y0: number, x1: number, y1: number) => [L(x0, y0, x1, y0), L(x1, y0, x1, y1), L(x1, y1, x0, y1), L(x0, y1, x0, y0)];
const total = (lines: DrawingLine[]) => lines.reduce((s, l) => s + Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y), 0);

/** Union of y-intervals covered by lines lying on x = x0 (sorted, merged). */
function coverageAtX(lines: DrawingLine[], x0: number): Array<[number, number]> {
  const spans = lines
    .filter(l => Math.abs(l.p1.x - x0) < 1e-3 && Math.abs(l.p2.x - x0) < 1e-3)
    .map(l => [Math.min(l.p1.y, l.p2.y), Math.max(l.p1.y, l.p2.y)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 0.2) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged;
}

test('Front view of a block shows exactly its outline: no triangulation lines, no hidden lines', () => {
  const block = G.extrudeProfile(G.shapesFromSketchEntities(rect(-20, 0, 20, 20)), 10, 'Front', {});
  const v = D.projectGeometry(block, 'front');
  assert.ok(Math.abs(total(v.visible) - 120) < 1e-6, `visible length ${total(v.visible)}`);
  assert.equal(v.hidden.length, 0);
});

test('Partly hidden edges are split into visible and hidden parts; hidden lines behind visible ones are omitted', () => {
  // Low wide block in front of a tall narrow block: the tall block's edge at x = 5
  // is hidden for 0 ≤ y ≤ 10 and visible for 10 ≤ y ≤ 30
  const front = G.extrudeProfile(G.shapesFromSketchEntities(rect(-20, 0, 20, 10)), 10, 'Front', {});
  const back = G.extrudeProfile(G.shapesFromSketchEntities(rect(-5, 0, 5, 30)), 10, 'Front', { flip: true });
  const v = D.projectGeometry(G.booleanUnion(front, back)!, 'front');
  const vis = coverageAtX(v.visible, 5);
  const hid = coverageAtX(v.hidden, 5);
  assert.equal(vis.length, 1);
  assert.ok(Math.abs(vis[0][0] - 10) < 0.2 && Math.abs(vis[0][1] - 30) < 0.2, `visible ${JSON.stringify(vis)}`);
  assert.equal(hid.length, 1);
  assert.ok(Math.abs(hid[0][0] - 0) < 0.2 && Math.abs(hid[0][1] - 10) < 0.2, `hidden ${JSON.stringify(hid)}`);
});

test('Isometric view looks from (+1, +1, +1), like the 3D viewport', () => {
  const { projMat } = D._getProjectionMatrix('isometric');
  const towardsViewer = new THREE.Vector3(1, 1, 1).normalize().applyMatrix4(projMat);
  assert.ok(towardsViewer.z > 0.999, `(1,1,1) maps to ${towardsViewer.toArray()}`);
});

function bracketSheet() {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    useCADStore.getState().loadExampleModel(CAD_EXAMPLES[0].create());
    rebuildModel(useCADStore);
    return D.createStandardSheet(useCADStore.getState().bodies[0].geometry, {});
  } finally {
    console.warn = realWarn;
  }
}

test('Flat faces cut by holes (T-junctions from booleans) show no triangulation fan lines', () => {
  bracketSheet();
  const { projMat } = D._getProjectionMatrix('front');
  const edges = extractDrawingEdges(buildViewMesh(useCADStore.getState().bodies[0].geometry, projMat), 25);
  const onHole = (p: THREE.Vector3) => [[15, 0], [-10, 0]].some(([cx, cy]) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - 5) < 0.2);
  const onOutline = (p: THREE.Vector3) => Math.abs(Math.abs(p.y) - 20) < 1e-3 || Math.abs(p.x - 35) < 1e-3 || Math.abs(p.x + 23) < 1e-3;
  const fan = edges.filter(e => Math.abs(e.a.z - 12) < 1e-3 && Math.abs(e.b.z - 12) < 1e-3)
    .filter(e => !(onHole(e.a) && onHole(e.b)) && !(onOutline(e.a) && onOutline(e.b)));
  assert.equal(fan.length, 0, `interior lines on the bracket face: ${fan.length} (was ~116)`);
});

test('Sheet: views are upright (model up = sheet up) and in third-angle arrangement', () => {
  // An L profile whose upright rises on the left: the highest model points are on the left
  const L_shape = G.extrudeProfile(G.shapesFromSketchEntities([
    L(0, 0, 40, 0), L(40, 0, 40, 8), L(40, 8, 8, 8), L(8, 8, 8, 30), L(8, 30, 0, 30), L(0, 30, 0, 0),
  ]), 10, 'Front', {});
  const sheet = D.createStandardSheet(L_shape, {});
  const front = sheet.views.find(v => v.label === 'FRONT VIEW')!;
  const top = sheet.views.find(v => v.label === 'TOP VIEW')!;
  const right = sheet.views.find(v => v.label === 'RIGHT VIEW')!;
  // Sheet y grows downwards: the line at the top of the upright (left side) must be near minY
  const topmost = front.visible.reduce((m, l) => Math.min(m, l.p1.y, l.p2.y), Infinity);
  const leftHigh = front.visible.filter(l => Math.abs(Math.min(l.p1.y, l.p2.y) - topmost) < 1e-6);
  assert.ok(leftHigh.every(l => Math.max(l.p1.x, l.p2.x) < (front.bounds.minX + front.bounds.maxX) / 2), 'upright appears at the top-left');
  assert.ok(top.bounds.maxY < front.bounds.minY, 'top view above the front view');
  assert.ok(right.bounds.minX > front.bounds.maxX, 'right view to the right of the front view');
  for (const v of sheet.views) for (const l of [...v.visible, ...v.hidden]) {
    for (const p of [l.p1, l.p2]) assert.ok(p.x >= 0 && p.y >= 0 && p.x <= sheet.sheetSize.width && p.y <= sheet.sheetSize.height, `${v.label} point on sheet`);
  }
});

test('DXF: R12 with defined linetypes, y-up (sheet y flipped)', () => {
  const sheet = bracketSheet();
  const dxf = D.exportDXF(sheet);
  assert.ok(dxf.indexOf('LTYPE\n2\nDASHED') > 0 && dxf.indexOf('LTYPE\n2\nDASHED') < dxf.indexOf('LAYER\n2\nHIDDEN'), 'DASHED defined before use');
  const first = sheet.views[0].visible[0];
  const m = dxf.match(/LINE\n8\nVISIBLE\n10\n([-\d.]+)\n20\n([-\d.]+)/)!;
  assert.ok(Math.abs(Number(m[1]) - first.p1.x) < 1e-3);
  assert.ok(Math.abs(Number(m[2]) - (sheet.sheetSize.height - first.p1.y)) < 1e-3, 'y flipped about the sheet height');
});

test('Drawing sheets of large examples are fast and uncluttered', () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    useCADStore.getState().loadExampleModel(CAD_EXAMPLES.find(e => e.id === 'pipe_flange')!.create());
    rebuildModel(useCADStore);
    const t = Date.now();
    const sheet = D.createStandardSheet(useCADStore.getState().bodies[0].geometry, {});
    const ms = Date.now() - t;
    assert.ok(ms < 3000, `sheet took ${ms} ms (was ~7.7 s)`);
    const front = sheet.views.find(v => v.label === 'FRONT VIEW')!;
    assert.ok(front.hidden.length < 400, `front view hidden lines ${front.hidden.length}`);
  } finally {
    console.warn = realWarn;
  }
});

test('Sheet layout: nothing overlaps or leaves the border, for every example on every sheet size', () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const ex of CAD_EXAMPLES) {
      useCADStore.getState().loadExampleModel(ex.create());
      rebuildModel(useCADStore);
      const geometry = useCADStore.getState().bodies[0].geometry;
      for (const [name, sheetSize] of Object.entries(SHEET_SIZES)) {
        const sheet = D.createStandardSheet(geometry, { sheetSize });
        assert.deepEqual(layoutProblems(sheet), [], `${ex.id} on ${name}`);
        assert.match(sheet.titleBlock!.scaleText, /^Scale: (1:(1|2|5|10|20|50|100)|(2|5|10):1)$/, `${ex.id} on ${name}: standard scale`);
      }
    }
  } finally {
    console.warn = realWarn;
  }
});

test('Sheet layout checker reports overlaps and elements outside the border', () => {
  const sheet = bracketSheet();
  const front = sheet.views.find(v => v.label === 'FRONT VIEW')!;
  const moved = { ...sheet, titleBlock: { ...sheet.titleBlock!, x: front.bounds.minX, y: front.bounds.minY } };
  assert.ok(layoutProblems(moved).some(p => p === 'FRONT VIEW overlaps title block'));
  const outside = { ...sheet, gdtFrames: sheet.gdtFrames.map(f => (f.type === 'gdt_fcf' ? { ...f, x: -50 } : f)) };
  assert.ok(layoutProblems(outside).includes('feature control frame is outside the border'));
});
