// CasiWorks Pro - True arcs and circles in drawing views (roadmap 5.1)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { DrawingEngine, layoutProblems, SHEET_SIZES } from '../src/drawings/DrawingEngine.ts';
import type { DrawingArc } from '../src/drawings/DrawingEngine.ts';
import { arcBeziers, arcPoint, arcThrough, fitCircle, intervalsToArcs, subtractIntervals, unionIntervals, wrapInterval } from '../src/drawings/curves.ts';
import { sheetToPdf } from '../src/drawings/pdf.ts';
import { geometryEngine as G } from '../src/kernel/GeometryEngine.ts';
import type { ProfileEntity } from '../src/kernel/GeometryEngine.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';

const D = new DrawingEngine();
const L = (x1: number, y1: number, x2: number, y2: number): ProfileEntity => ({ type: 'line', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
const rect = (x0: number, y0: number, x1: number, y1: number) => [L(x0, y0, x1, y0), L(x1, y0, x1, y1), L(x1, y1, x0, y1), L(x0, y1, x0, y0)];
const circles = (arcs: DrawingArc[], type = 'visible') => arcs.filter(a => a.full && a.type === type);

function example(id: string): THREE.BufferGeometry {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    useCADStore.getState().loadExampleModel(CAD_EXAMPLES.find(e => e.id === id)!.create());
    rebuildModel(useCADStore);
    return useCADStore.getState().bodies[0].geometry;
  } finally {
    console.warn = realWarn;
  }
}

test('Holes are drawn as true circles with their exact centre and radius, not as polygons', () => {
  const v = D.projectGeometry(example('l_bracket'), 'front');
  const c = circles(v.arcs).sort((a, b) => a.center.x - b.center.x);
  assert.equal(c.length, 2);
  for (const [arc, x] of [[c[0], -10], [c[1], 15]] as const) {
    assert.ok(Math.abs(arc.radius - 5) < 1e-3, `r = ${arc.radius}`);
    assert.ok(Math.hypot(arc.center.x - x, arc.center.y) < 1e-3, `centre ${JSON.stringify(arc.center)}`);
  }
  // No polygon pieces left on the rims, and the outline is whole lines
  const onRim = v.visible.filter(l => c.some(a => Math.abs(Math.hypot(l.p1.x - a.center.x, l.p1.y - a.center.y) - 5) < 0.1));
  assert.equal(onRim.length, 0);
  assert.ok(v.visible.length <= 8, `${v.visible.length} lines`);
});

test('Circles seen at several depths (bores through layers, bolt holes) come out once each', () => {
  const flange = D.projectGeometry(example('pipe_flange'), 'front');
  const radii = circles(flange.arcs).map(a => +a.radius.toFixed(3)).sort((a, b) => a - b);
  assert.deepEqual(radii, [4.5, 4.5, 4.5, 4.5, 18, 26, 45]);
  assert.equal(flange.arcs.filter(a => !a.full).length, 0);
  const block = D.projectGeometry(example('bearing_block'), 'front');
  assert.deepEqual(circles(block.arcs).map(a => +a.radius.toFixed(3)).sort((a, b) => a - b), [4, 4, 12, 24]);
  const rod = D.projectGeometry(example('connecting_rod'), 'front');
  assert.deepEqual(circles(rod.arcs).map(a => +a.radius.toFixed(3)).sort((a, b) => a - b), [8, 15, 15, 24]);
});

test('A slot has two true half circles joined by straight lines', () => {
  const slot: ProfileEntity[] = [
    L(-20, -5, 20, -5),
    { type: 'arc', center: { x: 20, y: 0 }, radius: 5, startAngle: -Math.PI / 2, endAngle: Math.PI / 2 },
    L(20, 5, -20, 5),
    { type: 'arc', center: { x: -20, y: 0 }, radius: 5, startAngle: Math.PI / 2, endAngle: (3 * Math.PI) / 2 },
  ];
  const v = D.projectGeometry(G.extrudeProfile(G.shapesFromSketchEntities(slot), 10, 'Front', {}), 'front');
  assert.equal(v.visible.length, 2, 'two straight sides');
  assert.equal(v.arcs.length, 2);
  for (const a of v.arcs) {
    assert.ok(!a.full);
    assert.ok(Math.abs(a.radius - 5) < 1e-3 && Math.abs(Math.abs(a.center.x) - 20) < 1e-3 && Math.abs(a.center.y) < 1e-3, JSON.stringify(a));
    assert.ok(Math.abs(a.endAngle - a.startAngle - Math.PI) < 1e-3, 'half circle');
    // The arc's ends meet the straight sides
    const ends = [arcPoint(a, a.startAngle), arcPoint(a, a.endAngle)];
    for (const p of ends) assert.ok(v.visible.some(l => Math.hypot(l.p1.x - p.x, l.p1.y - p.y) < 0.01 || Math.hypot(l.p2.x - p.x, l.p2.y - p.y) < 0.01), 'joined');
  }
});

test('A blind hole from the back is one hidden circle in the front view', () => {
  const block = G.extrudeProfile(G.shapesFromSketchEntities(rect(-20, -20, 20, 20)), 10, 'Front', {});
  block.computeBoundingBox();
  const zBack = block.boundingBox!.min.z;
  const tool = new THREE.CylinderGeometry(6, 6, 6, 64).rotateX(Math.PI / 2).translate(0, 0, zBack + 2);
  const v = D.projectGeometry(G.booleanSubtract(block, tool)!, 'front');
  assert.equal(circles(v.arcs, 'visible').length, 0);
  const hidden = circles(v.arcs, 'hidden');
  assert.equal(hidden.length, 1, 'the rim and the bottom of the hole are the same circle');
  assert.ok(Math.abs(hidden[0].radius - 6) < 1e-3);
});

test('The isometric view keeps circles as polylines (they are ellipses there)', () => {
  const v = D.projectGeometry(example('l_bracket'), 'isometric');
  assert.equal(v.arcs.length, 0);
});

test('Sheet: arcs placed with the view, centre marks inside the view; SVG, DXF and PDF carry real arcs', () => {
  const sheet = D.createStandardSheet(example('l_bracket'), {});
  const front = sheet.views.find(v => v.label === 'FRONT VIEW')!;
  const c = circles(front.arcs);
  assert.equal(c.length, 2);
  for (const a of c) {
    assert.ok(Math.abs(a.radius - 5 * sheet.scale) < 1e-3, 'radius scaled');
    const p = D.sheetPoint(front, { x: Math.abs(a.center.x - D.sheetPoint(front, { x: 15, y: 0, z: 0 }).x) < 1e-3 ? 15 : -10, y: 0, z: 0 });
    assert.ok(Math.hypot(p.x - a.center.x, p.y - a.center.y) < 1e-3, 'centre where the model point lands');
  }
  assert.equal(front.centerlines.length, 4, 'a cross per hole');
  for (const l of front.centerlines) {
    for (const p of [l.p1, l.p2]) assert.ok(p.x >= front.bounds.minX - 1e-9 && p.x <= front.bounds.maxX + 1e-9 && p.y >= front.bounds.minY - 1e-9 && p.y <= front.bounds.maxY + 1e-9);
  }
  const svg = D.exportSVG(sheet);
  assert.equal((svg.match(/<circle class="visible-line"/g) ?? []).length, 2);
  assert.match(svg, /class="center-line"/);
  const dxf = D.exportDXF(sheet);
  const dxfCircles = [...dxf.matchAll(/\nCIRCLE\n8\nVISIBLE\n10\n([-\d.]+)\n20\n([-\d.]+)\n30\n0.0\n40\n([-\d.]+)\n/g)];
  assert.equal(dxfCircles.length, 2);
  for (const m of dxfCircles) assert.ok(Math.abs(Number(m[3]) - 5 * sheet.scale) < 1e-3);
  assert.match(dxf, /LTYPE\n2\nCENTER/);
  const pdf = sheetToPdf(sheet, 'bracket');
  assert.ok((pdf.match(/ c /g) ?? []).length >= 8, 'circles as Bézier curves');
  assert.deepEqual(layoutProblems(sheet), []);
});

test('DXF arcs run counter-clockwise from the right start angle (y flipped)', () => {
  const slot: ProfileEntity[] = [
    L(-20, -5, 20, -5),
    { type: 'arc', center: { x: 20, y: 0 }, radius: 5, startAngle: -Math.PI / 2, endAngle: Math.PI / 2 },
    L(20, 5, -20, 5),
    { type: 'arc', center: { x: -20, y: 0 }, radius: 5, startAngle: Math.PI / 2, endAngle: (3 * Math.PI) / 2 },
  ];
  const sheet = D.createStandardSheet(G.extrudeProfile(G.shapesFromSketchEntities(slot), 10, 'Front', {}), { sheetSize: SHEET_SIZES.A4_LANDSCAPE });
  const dxf = D.exportDXF(sheet);
  const H = sheet.sheetSize.height;
  const front = sheet.views.find(v => v.label === 'FRONT VIEW')!;
  const right = D.sheetPoint(front, { x: 20, y: 0, z: 0 });
  // The right end of the slot: in model (and DXF, y up) terms the arc runs from −90° to +90°
  const re = new RegExp(`\\nARC\\n8\\nVISIBLE\\n10\\n${right.x.toFixed(3)}\\n20\\n${(H - right.y).toFixed(3)}\\n30\\n0.0\\n40\\n[-\\d.]+\\n50\\n([-\\d.]+)\\n51\\n([-\\d.]+)\\n`);
  const m = dxf.match(re);
  assert.ok(m, 'arc at the right end');
  assert.ok(Math.abs(Number(m![1]) - 270) < 0.1 && Math.abs(Number(m![2]) - 90) < 0.1, `from ${m![1]}° to ${m![2]}°`);
});

test('Arc helpers: circle fit, arc runs, angle intervals, Bézier pieces', () => {
  const pts = Array.from({ length: 9 }, (_, i) => ({ x: 3 + 7 * Math.cos(i * 0.2), y: -2 + 7 * Math.sin(i * 0.2) }));
  const f = fitCircle(pts)!;
  assert.ok(Math.hypot(f.center.x - 3, f.center.y + 2) < 1e-9 && Math.abs(f.radius - 7) < 1e-9);
  assert.equal(fitCircle([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), null);
  const arc = arcThrough(pts, 1e-6)!;
  assert.ok(Math.abs(arc.startAngle) < 1e-9 && Math.abs(arc.endAngle - 1.6) < 1e-9);
  // Clockwise points give the same counter-clockwise arc
  const back = arcThrough([...pts].reverse(), 1e-6)!;
  assert.ok(Math.abs(back.startAngle - arc.startAngle) < 1e-9 && Math.abs(back.endAngle - arc.endAngle) < 1e-9);
  // A corner is not an arc
  assert.equal(arcThrough([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }], 1e-6), null);

  assert.deepEqual(wrapInterval(-0.5, 0.5).map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]), [[+(2 * Math.PI - 0.5).toFixed(6), +(2 * Math.PI).toFixed(6)], [0, 0.5]]);
  assert.deepEqual(unionIntervals([[0, 1], [0.5, 2], [3, 4]]), [[0, 2], [3, 4]]);
  assert.deepEqual(subtractIntervals([[0, 4]], [[1, 2]]), [[0, 1], [2, 4]]);
  const joined = intervalsToArcs([[0, 0.5], [6, 2 * Math.PI]], { x: 0, y: 0 }, 1, 'visible', 1e-3);
  assert.equal(joined.length, 1, 'an interval through angle 0 is one arc');
  assert.ok(Math.abs(joined[0].startAngle - (6 - 2 * Math.PI)) < 1e-9 && joined[0].endAngle === 0.5);
  assert.ok(intervalsToArcs([[0, 2 * Math.PI]], { x: 0, y: 0 }, 1, 'visible', 1e-3)[0].full);

  // Béziers stay within 0.03% of the radius of the true arc
  const a: DrawingArc = { center: { x: 1, y: 2 }, radius: 10, startAngle: 0.3, endAngle: 4 };
  const pieces = arcBeziers(a);
  assert.equal(pieces.length, 3);
  for (const [p0, c1, c2, p3] of pieces) {
    for (let t = 0; t <= 1; t += 0.125) {
      const u = 1 - t;
      const x = u ** 3 * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * p3.x;
      const y = u ** 3 * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * p3.y;
      assert.ok(Math.abs(Math.hypot(x - 1, y - 2) - 10) < 3e-3);
    }
  }
});
