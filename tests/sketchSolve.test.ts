// CasiWorks Pro - Sketch relations and driving dimensions
import test from 'node:test';
import assert from 'node:assert/strict';

import { measureForDimension, relationConstraint, solveSketch } from '../src/kernel/sketchSolve.ts';
import { sketchEngine } from '../src/kernel/SketchEngine.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import type { ArcEntity, LineEntity, SketchEntity } from '../src/types/cad.ts';
import type { SketchConstraint } from '../src/kernel/ConstraintSolver.ts';

const near = (a: number, b: number, msg = '', tol = 1e-4) => assert.ok(Math.abs(a - b) < tol, `${msg} ${a} ≠ ${b}`);
const len = (l: LineEntity) => Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y);

test('Rectangle: relations and a width dimension; the corners stay joined when the width changes', () => {
  const rect = sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 40, y: 20 });
  const [bottom, right, top, left] = rect as LineEntity[];
  const cs: SketchConstraint[] = [
    { id: 'h1', type: 'horizontal', entity1Id: bottom.id }, { id: 'h2', type: 'horizontal', entity1Id: top.id },
    { id: 'v1', type: 'vertical', entity1Id: left.id }, { id: 'v2', type: 'vertical', entity1Id: right.id },
    { id: 'w', type: 'dimension', entity1Id: bottom.id, value: 60 },
  ];
  const r = solveSketch(rect, cs);
  assert.ok(r.ok, r.message);
  const out = r.entities as LineEntity[];
  near(len(out[0]), 60, 'bottom');
  near(len(out[2]), 60, 'top follows (it is joined and horizontal)');
  assert.ok(sketchEngine.isProfileClosed(out), 'still closed');
  near(len(out[1]), 20, 'the free height stays close to 20', 0.2);
  assert.equal(r.state, 'under', 'height and position are still free');
  assert.match(r.message, /Under defined \(\d+ degrees of freedom\)/);

  // Height, and the bottom-left corner fixed: fully defined
  const full = solveSketch(rect, [...cs, { id: 'hgt', type: 'dimension', entity1Id: left.id, value: 25 }, { id: 'f', type: 'fix', entity1Id: bottom.id, point1: 'p1' } as SketchConstraint]);
  assert.ok(full.ok, full.message);
  near(len(full.entities[1] as LineEntity), 25);
  assert.equal(full.state, 'fully', full.message);

  // Conflict: a line both horizontal and vertical with a length
  const bad = solveSketch(rect, [...cs, { id: 'x', type: 'vertical', entity1Id: bottom.id }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.state, 'failed');
});

test('Slot: dimensioning a straight side keeps the end arcs on the lines; circles by diameter', () => {
  const slot = sketchEngine.createSlot({ x: 0, y: 0 }, { x: 30, y: 0 }, 5);
  const line = slot.find(e => e.type === 'line')! as LineEntity;
  const other = slot.find(e => e.type === 'line' && e.id !== line.id)! as LineEntity;
  const r = solveSketch(slot, [
    { id: 'h', type: 'horizontal', entity1Id: line.id }, { id: 'h2', type: 'horizontal', entity1Id: other.id },
    { id: 'L', type: 'dimension', entity1Id: line.id, value: 50 },
  ]);
  assert.ok(r.ok, r.message);
  near(len(r.entities.find(e => e.id === line.id) as LineEntity), 50);
  assert.ok(sketchEngine.isProfileClosed(r.entities), 'arcs still meet the lines');
  // Free sizes stay close to where they were (least change); a radius dimension would fix them exactly
  for (const a of r.entities.filter(e => e.type === 'arc') as ArcEntity[]) near(a.radius, 5, 'arc radius stays close', 0.1);

  const c = sketchEngine.createCircle({ x: 0, y: 0 }, 10);
  const m = measureForDimension([{ id: c.id }], [c]);
  assert.deepEqual(typeof m === 'object' && [m.label, m.value], ['Diameter', 20]);
});

test('Relation picks: what each relation accepts', () => {
  const rect = sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 40, y: 20 }) as LineEntity[];
  const circle = sketchEngine.createCircle({ x: 10, y: 10 }, 3);
  const ents: SketchEntity[] = [...rect, circle];
  assert.equal((relationConstraint('horizontal', [{ id: rect[0].id }], ents) as SketchConstraint).type, 'horizontal');
  assert.match(relationConstraint('horizontal', [{ id: circle.id }], ents) as string, /needs a line/);
  assert.match(relationConstraint('equal', [{ id: rect[0].id }, { id: circle.id }], ents) as string, /two lines, or two circles/);
  const coin = relationConstraint('coincident', [{ id: rect[0].id, ref: 'p1' }, { id: circle.id, ref: 'center' }], ents) as SketchConstraint;
  assert.deepEqual([coin.point1, coin.point2], ['p1', 'center']);
});

test('Commands: relations and dimensions on the open sketch, change, remove, refuse conflicts; Discard undoes them', () => {
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  r.execute('sketch.new', { plane: 'Front' });
  for (const e of sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 40, y: 20 })) s().addSketchEntity(e);
  const id = s().activeSketchId!;
  const lines = () => s().sketchEntities[id] as LineEntity[];
  const [bottom, , , left] = lines();
  r.execute('sketch.constrain', { constraint: { type: 'horizontal', entity1Id: bottom.id } });
  r.execute('sketch.constrain', { constraint: { type: 'vertical', entity1Id: left.id } });
  const { id: dim } = r.execute('sketch.dimensionPicks', { picks: [{ id: bottom.id }], value: 55 }) as { id: string };
  near(len(lines()[0]), 55);
  assert.equal(s().sketchSolveState?.state, 'under');
  r.execute('sketch.setDimension', { id: dim, value: 70 });
  near(len(lines()[0]), 70);
  assert.ok(sketchEngine.isProfileClosed(lines()));
  assert.throws(() => r.execute('sketch.constrain', { constraint: { type: 'vertical', entity1Id: bottom.id } }), /FAILED|cannot|conflict/i);
  near(len(lines()[0]), 70, 'a refused relation changes nothing');
  assert.equal((s().sketchConstraints[id] as unknown[]).length, 3);
  r.execute('sketch.removeConstraint', { id: dim });
  assert.equal((s().sketchConstraints[id] as unknown[]).length, 2);
  assert.throws(() => r.execute('sketch.setDimension', { id: 'nope', value: 3 }), /No dimension/);
  assert.throws(() => r.execute('sketch.relation', { type: 'glued' }), /type must be/);

  // Trimming away a related line drops its relations on the next refresh
  s().replaceActiveSketchEntities(lines().filter(l => l.id !== left.id));
  s().refreshSketchSolve();
  assert.equal((s().sketchConstraints[id] as SketchConstraint[]).some(c => c.entity1Id === left.id), false);

  r.execute('sketch.discard');
  assert.equal(s().sketchEntities[id], undefined, 'a new sketch discarded is gone with its relations');
  s().newProject();
});

test('Built-in relations: rectangles stay rectangles, slots parallel, polygons equal; redundant relations are refused', async () => {
  const { builtInRelations } = await import('../src/viewport/sketchTools.ts');
  const { TOOLS } = await import('../src/utils/constants.ts');
  const rect = sketchEngine.createRectangle({ x: 0, y: 0 }, { x: 40, y: 20 }) as LineEntity[];
  const rels = builtInRelations(TOOLS.SKETCH_RECT, rect);
  assert.deepEqual(rels.map(r => r.type), ['horizontal', 'vertical', 'horizontal', 'vertical']);
  const wider = solveSketch(rect, [...rels, { id: 'w', type: 'dimension', entity1Id: rect[0].id, value: 70 }]);
  const out = wider.entities as LineEntity[];
  near(len(out[0]), 70); near(len(out[2]), 70, 'top too');
  near(out[1].p1.x, out[1].p2.x, 'right side still vertical');
  assert.equal(builtInRelations(TOOLS.SKETCH_SLOT, sketchEngine.createSlot({ x: 0, y: 0 }, { x: 30, y: 0 }, 5))[0].type, 'parallel');
  assert.equal(builtInRelations(TOOLS.SKETCH_POLYGON, sketchEngine.createPolygon({ x: 0, y: 0 }, 10, 6)).length, 5);

  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  r.execute('sketch.new', { plane: 'Front' });
  for (const e of rect) s().addSketchEntity(e);
  const id = s().activeSketchId!;
  assert.equal(s().applySketchConstraints(id, rels), null);
  assert.throws(() => r.execute('sketch.constrain', { constraint: { type: 'horizontal', entity1Id: rect[0].id } }), /already fixed/);
  r.execute('sketch.discard');
  s().newProject();
});

test('API 1.11: relations and dimensions on a stored sketch; the part follows', async () => {
  const { createCasiWorksAPI } = await import('../src/api/CasiWorksAPI.ts');
  const api = createCasiWorksAPI(useCADStore);
  api.document.new();
  const s = api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 40, y: 20 } }] });
  const [bottom, right, top, left] = api.sketches.getEntities(s.sketchId) as LineEntity[];
  for (const [t, l] of [['horizontal', bottom], ['horizontal', top], ['vertical', left], ['vertical', right]] as const) api.sketches.constrain(s.sketchId, { type: t, entity1Id: l.id });
  const width = api.sketches.constrain(s.sketchId, { type: 'dimension', entity1Id: bottom.id, value: 50 });
  api.features.extrude({ sketchId: s.sketchId, depth: 10 });
  assert.ok(Math.abs(api.model.boundingBox()!.size.x - 50) < 1e-4, 'the solid is 50 wide');
  api.sketches.setDimension(s.sketchId, width, 80);
  assert.ok(Math.abs(api.model.boundingBox()!.size.x - 80) < 1e-4, 'and follows the dimension');
  assert.equal(api.sketches.status(s.sketchId).state, 'under');
  assert.equal(api.sketches.constraints(s.sketchId).length, 5);
  assert.throws(() => api.sketches.constrain(s.sketchId, { type: 'horizontal', entity1Id: bottom.id }), /already fixed/);
  assert.throws(() => api.sketches.constrain(s.sketchId, { type: 'glue', entity1Id: bottom.id }), /type must be/);
  api.history.undo();
  assert.ok(Math.abs(api.model.boundingBox()!.size.x - 50) < 1e-4, 'undo restores the old width');
  api.sketches.removeConstraint(s.sketchId, width);
  assert.equal(api.sketches.constraints(s.sketchId).length, 4);
  api.document.new();
});
