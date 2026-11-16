// CasiWorks Pro - Sketch editing: trim, extend, offset, mirror
import test from 'node:test';
import assert from 'node:assert/strict';

import { arcSweep, distanceToEntity, extendLine, mirrorEntities, offsetEntity, pickEntity, trimEntity } from '../src/kernel/sketchEdit.ts';
import type { EditResult } from '../src/kernel/sketchEdit.ts';
import { sketchEngine } from '../src/kernel/SketchEngine.ts';
import type { ArcEntity, LineEntity, Point2, SketchEntity } from '../src/types/cad.ts';

const line = (id: string, x1: number, y1: number, x2: number, y2: number): LineEntity => ({ id, type: 'line', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
const ok = (r: EditResult) => { if ('error' in r) assert.fail(r.error); return r.entities; };
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≠ ${b}`);
const nearPt = (p: Point2, q: Point2, msg?: string) => { near(p.x, q.x, msg); near(p.y, q.y, msg); };
const arcEnds = (a: ArcEntity) => [0, arcSweep(a)].map(t => ({ x: a.center.x + a.radius * Math.cos(a.startAngle + t), y: a.center.y + a.radius * Math.sin(a.startAngle + t) }));

test('Trim: a line loses the part between the crossings around the click; alone it is deleted', () => {
  const ents = [line('a', -10, 0, 10, 0), line('b', 0, -10, 0, 10), line('c', 6, -10, 6, 10)];
  const end = ok(trimEntity(ents, 'a', { x: 9, y: 0.2 }));
  const a = end.find(e => e.id === 'a') as LineEntity;
  nearPt(a.p1, { x: -10, y: 0 }); nearPt(a.p2, { x: 6, y: 0 }, 'trimmed back to c');
  const mid = ok(trimEntity(ents, 'a', { x: 3, y: 0 }));
  const pieces = mid.filter(e => e.type === 'line' && Math.abs(e.p1.y) < 1e-9 && Math.abs(e.p2.y) < 1e-9) as LineEntity[];
  assert.equal(pieces.length, 2, 'middle removed: two pieces left');
  nearPt(pieces[0].p2, { x: 0, y: 0 }); nearPt(pieces[1].p1, { x: 6, y: 0 });
  assert.notEqual(pieces[0].id, pieces[1].id);
  // Corners where lines only touch at their ends are not crossings
  const rect = sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 40, y: 20 });
  const gone = ok(trimEntity(rect, rect[0].id, { x: 20, y: 0 }));
  assert.equal(gone.length, 3, 'a rectangle side has no crossings: deleted');
});

test('Trim: a circle cut by a line keeps the far side as an arc; arcs trim like lines', () => {
  const circle = sketchEngine.createCircle({ x: 0, y: 0 }, 10);
  const ents: SketchEntity[] = [circle, line('l', -20, 0, 20, 0)];
  const out = ok(trimEntity(ents, circle.id, { x: 0, y: 10 }));
  const arc = out.find(e => e.id === circle.id) as ArcEntity;
  assert.equal(arc.type, 'arc');
  near(arcSweep(arc), Math.PI, 'half left');
  const [s, e] = arcEnds(arc);
  nearPt(s, { x: -10, y: 0 }); nearPt(e, { x: 10, y: 0 });
  assert.match(String((trimEntity([circle, line('t', -20, 10, 20, 10)], circle.id, { x: 0, y: -10 }) as { error: string }).error), /two crossings/, 'tangent line: one crossing');

  // Trim that arc again where the vertical line x = 0 crosses it, clicking its right half
  const half = ok(trimEntity([...out, line('v', 0, -20, 0, 20)], circle.id, { x: 7, y: -7 }));
  const quarter = half.find(x => x.id === circle.id) as ArcEntity;
  near(arcSweep(quarter), Math.PI / 2);
  nearPt(arcEnds(quarter)[0], { x: -10, y: 0 }); nearPt(arcEnds(quarter)[1], { x: 0, y: -10 });
});

test('Extend: a line end reaches the first line, arc or circle in its direction', () => {
  const ents = [line('a', 0, 0, 5, 0), line('wall', 10, -5, 10, 5), line('far', 20, -5, 20, 5)];
  const out = ok(extendLine(ents, 'a', { x: 4.5, y: 0.1 }));
  nearPt((out.find(e => e.id === 'a') as LineEntity).p2, { x: 10, y: 0 }, 'stops at the first wall');
  const back = ok(extendLine([...ents, sketchEngine.createCircle({ x: -10, y: 0 }, 3)], 'a', { x: 0.5, y: 0 }));
  nearPt((back.find(e => e.id === 'a') as LineEntity).p1, { x: -7, y: 0 }, 'start end reaches the circle');
  assert.ok('error' in extendLine([line('a', 0, 0, 5, 0), line('w', 10, 1, 10, 5)], 'a', { x: 5, y: 0 }), 'misses the wall');
});

test('Offset: a rectangle offsets as a closed rectangle, out or in; a slot keeps its arcs', () => {
  const rect = sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 40, y: 20 });
  const out = ok(offsetEntity(rect, rect[0].id, 2, { x: 20, y: -5 })).slice(4) as LineEntity[];
  assert.equal(out.length, 4);
  assert.ok(sketchEngine.isProfileClosed(out), 'closed');
  const xs = out.flatMap(l => [l.p1.x, l.p2.x]), ys = out.flatMap(l => [l.p1.y, l.p2.y]);
  near(Math.min(...xs), -2); near(Math.max(...xs), 42); near(Math.min(...ys), -2); near(Math.max(...ys), 22);
  const inner = ok(offsetEntity(rect, rect[2].id, 3, { x: 20, y: 10 })).slice(4) as LineEntity[];
  const ix = inner.flatMap(l => [l.p1.x, l.p2.x]), iy = inner.flatMap(l => [l.p1.y, l.p2.y]);
  near(Math.min(...ix), 3); near(Math.max(...ix), 37); near(Math.min(...iy), 3); near(Math.max(...iy), 17);
  assert.match((offsetEntity(rect, rect[0].id, 12, { x: 20, y: 10 }) as { error: string }).error, /too large/);

  const slot = sketchEngine.createSlot({ x: 0, y: 0 }, { x: 30, y: 0 }, 5);
  const wide = ok(offsetEntity(slot, slot[0].id, 1, { x: 15, y: 50 })).slice(slot.length);
  assert.equal(wide.length, 4);
  assert.ok(sketchEngine.isProfileClosed(wide), 'offset slot is closed');
  for (const a of wide.filter(e => e.type === 'arc') as ArcEntity[]) near(a.radius, 6);

  const circle = sketchEngine.createCircle({ x: 0, y: 0 }, 10);
  near((ok(offsetEntity([circle], circle.id, 4, { x: 1, y: 1 }))[1] as typeof circle).radius, 6, 'inside: smaller');
  assert.ok('error' in offsetEntity([circle], circle.id, 10, { x: 1, y: 1 }));
  const single = ok(offsetEntity([line('a', 0, 0, 10, 0)], 'a', 2.5, { x: 5, y: -1 }))[1] as LineEntity;
  nearPt(single.p1, { x: 0, y: -2.5 }); nearPt(single.p2, { x: 10, y: -2.5 });
});

test('Mirror: copies reflect about the line; arcs keep their shape (direction reversed)', () => {
  const axis = line('axis', 0, -50, 0, 50);
  const arc: ArcEntity = { id: 'arc', type: 'arc', center: { x: 10, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2 };
  const out = ok(mirrorEntities([axis, arc, line('l', 5, 5, 20, 10)], 'axis', ['arc', 'l', 'axis']));
  assert.equal(out.length, 5, 'axis itself is not mirrored');
  const m = out[3] as ArcEntity;
  nearPt(m.center, { x: -10, y: 0 });
  const ends = arcEnds(m);
  nearPt(ends[0], { x: -10, y: 5 }); nearPt(ends[1], { x: -15, y: 0 });
  const mid = { x: m.center.x + 5 * Math.cos(m.startAngle + arcSweep(m) / 2), y: m.center.y + 5 * Math.sin(m.startAngle + arcSweep(m) / 2) };
  nearPt(mid, { x: -10 - 5 * Math.SQRT1_2, y: 5 * Math.SQRT1_2 }, 'same bulge, mirrored');
  nearPt((out[4] as LineEntity).p2, { x: -20, y: 10 });
  // A slanted mirror line
  const diag = ok(mirrorEntities([line('d', 0, 0, 10, 10), { id: 'p', type: 'point', x: 4, y: 0 }], 'd', ['p']))[2];
  nearPt(diag as Point2, { x: 0, y: 4 });
  assert.ok('error' in mirrorEntities([arc], 'arc', ['arc']), 'axis must be a line');
});

test('Picking: nearest entity within the tolerance', () => {
  const ents = [line('a', 0, 0, 10, 0), sketchEngine.createCircle({ x: 30, y: 0 }, 5)];
  assert.equal(pickEntity(ents, { x: 5, y: 0.4 }, 0.5)?.id, 'a');
  assert.equal(pickEntity(ents, { x: 5, y: 2 }, 0.5), null);
  near(distanceToEntity(ents[1], { x: 30, y: 0 }), 5);
  assert.equal(pickEntity(ents, { x: 35.2, y: 0 }, 0.5)?.type, 'circle');
});

test('Editing tools click by click: spline finish and close, offset pick then side, mirror line then entities', async () => {
  const { editClick, editPreview, editStage, NEW_EDIT_SESSION } = await import('../src/viewport/sketchTools.ts');
  const { TOOLS } = await import('../src/utils/constants.ts');
  const opts = { offsetDistance: 2 };
  const at = (x: number, y: number, tol = 0.5) => ({ pt: { x, y }, raw: { x, y }, tol });

  // Spline: points, then the last point again finishes
  let s = NEW_EDIT_SESSION;
  for (const [x, y] of [[0, 0], [10, 5], [20, 0]]) s = editClick(TOOLS.SKETCH_SPLINE, s, at(x, y), [], opts).session;
  assert.equal(editStage(TOOLS.SKETCH_SPLINE, s), 3);
  assert.equal(editPreview(TOOLS.SKETCH_SPLINE, s, at(30, 5), [], opts).entities[0].type, 'spline');
  const done = editClick(TOOLS.SKETCH_SPLINE, s, at(20.2, 0), [], { ...opts, construction: true });
  const spline = done.entities![0] as { type: string; controlPoints: Point2[]; construction?: boolean };
  assert.equal(spline.controlPoints.length, 3);
  assert.equal(spline.construction, true, 'follows construction mode');
  assert.deepEqual(done.session, NEW_EDIT_SESSION);
  const closed = editClick(TOOLS.SKETCH_SPLINE, s, at(0.1, 0.1), [], opts).entities![0] as { controlPoints: Point2[] };
  assert.deepEqual(closed.controlPoints.at(-1), closed.controlPoints[0], 'clicking the first point closes it');

  // Offset: first click picks, second sets the side
  const rect = sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 40, y: 20 });
  assert.match(editClick(TOOLS.SKETCH_OFFSET, NEW_EDIT_SESSION, at(20, 5), rect, opts).status!, /no line/);
  const picked = editClick(TOOLS.SKETCH_OFFSET, NEW_EDIT_SESSION, at(20, 0.2), rect, opts).session;
  assert.equal(picked.pickedId, rect[0].id);
  assert.equal(editPreview(TOOLS.SKETCH_OFFSET, picked, at(20, -3), rect, opts).entities.length, 4, 'preview shows the offset chain');
  const off = editClick(TOOLS.SKETCH_OFFSET, picked, at(20, -3), rect, opts);
  assert.equal(off.entities!.length, 8);
  assert.match(off.status!, /Closed chain of 4 offset 2 mm/);

  // Mirror: the line first, then each click mirrors one entity
  const axis = line('axis', 0, -10, 0, 10);
  const c = sketchEngine.createCircle({ x: 5, y: 0 }, 2);
  assert.match(editClick(TOOLS.SKETCH_MIRROR, NEW_EDIT_SESSION, at(7, 0), [axis, c], opts).status!, /click a line/);
  const m1 = editClick(TOOLS.SKETCH_MIRROR, NEW_EDIT_SESSION, at(0, 3), [axis, c], opts).session;
  const m2 = editClick(TOOLS.SKETCH_MIRROR, m1, at(7, 0), [axis, c], opts);
  nearPt((m2.entities![2] as typeof c).center, { x: -5, y: 0 });
  assert.equal(m2.session.pickedId, 'axis', 'stays on the same mirror line');

  // Trim and extend pick within the tolerance only
  assert.match(editClick(TOOLS.SKETCH_TRIM, NEW_EDIT_SESSION, at(20, 10), rect, opts).status!, /no line, arc or circle there/);
  assert.equal(editClick(TOOLS.SKETCH_TRIM, NEW_EDIT_SESSION, at(20, 0.3), rect, opts).entities!.length, 3);
});
