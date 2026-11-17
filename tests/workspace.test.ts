// CasiWorks Pro - Workspace and assemblies of real parts: documents, references, face mates, DOF, motion, explode steps
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';
import { apiWorkspace, workspace } from '../src/workspace/index.ts';
import { stepOffsets } from '../src/assembly/explodeSteps.ts';

const api = createCasiWorksAPI(useCADStore, { workspace: apiWorkspace });
const tick = () => new Promise(r => setTimeout(r, 0));

/** A 60 × 40 × 10 plate (Front plane, extruded along +Z) with a Ø10 hole at x = 10. */
function plate(depth = 10) {
  const s = api.sketches.create({ plane: 'Front', entities: [
    { type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } },
    { type: 'circle', center: { x: 10, y: 0 }, radius: 5 },
  ] });
  return api.features.extrude({ sketchId: s.sketchId, depth, name: 'Plate' });
}
/** A Ø10 × 30 pin standing on the Front plane. */
function pin() {
  const s = api.sketches.create({ plane: 'Front', entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 5 }] });
  api.features.extrude({ sketchId: s.sketchId, depth: 30, name: 'Pin' });
}
const sizeZ = (id: string) => {
  const c = useCADStore.getState().assemblyComponents.find(x => x.id === id)!;
  const b = c.geometry.boundingBox!;
  return b.max.z - b.min.z;
};

test('Workspace: parts and assemblies are separate documents; switching keeps each one as it was', () => {
  const partId = api.workspace.newPart('Plate');
  plate();
  assert.equal(api.document.getType(), 'part');
  assert.ok(api.document.isModified());
  const asmId = api.workspace.newAssembly('Bench');
  assert.equal(api.document.getType(), 'assembly');
  assert.equal(api.features.list().length, 0, 'an assembly has no features');
  assert.equal(useCADStore.getState().activeCommandTab, 'Assembly');

  api.workspace.activate(partId);
  assert.equal(api.document.getName(), 'Plate');
  assert.equal(api.features.list().length, 2, 'the sketch and the extrude came back');
  assert.ok(api.document.isModified(), 'unsaved changes are remembered');
  assert.ok(useCADStore.getState().undoStack.length > 0, 'and the undo history');
  assert.deepEqual(api.workspace.list().map(d => [d.name, d.type, d.active]).slice(-2), [['Plate', 'part', true], ['Bench', 'assembly', false]]);

  // Closing with unsaved changes needs discard
  assert.throws(() => api.workspace.close(partId), /unsaved changes/);
  // The same file opened twice is two documents
  const json = api.document.toJSON();
  const copy = api.workspace.open(json);
  assert.equal(copy, partId, 'identical content just activates the open one');
  const changed = api.workspace.open(json.replace('"documentName": "Plate"', '"documentName": "Plate copy"'));
  assert.notEqual(changed, partId);
  api.workspace.close(changed, { discard: true });
  api.workspace.activate(asmId);
  api.workspace.close(asmId);
});

test('Assembly of real parts: references follow the part, mates stay, a closed part falls back to the cached copy', async () => {
  const plateId = api.workspace.newPart('Plate');
  plate(10);
  const pinId = api.workspace.newPart('Pin');
  pin();
  api.materials.setActive('Brass_C36000');
  const asmId = api.workspace.newAssembly('Fixture');

  assert.throws(() => api.assembly.insert({ part: asmId }), /assembly; insert parts/);
  const p = api.assembly.insert({ part: plateId });
  const q = api.assembly.insert({ part: pinId });
  const list = api.assembly.list();
  assert.deepEqual(list.map(c => [c.name, c.part?.documentId, c.part?.linked, c.fixed]), [['Plate', plateId, 'workspace', true], ['Pin', pinId, 'workspace', false]]);
  assert.equal(list[1].material, 'Brass_C36000', 'the part material comes along');
  assert.ok(Math.abs(sizeZ(p) - 10) < 1e-6);

  // Face mates: the pin's end face on the plate's front face, its side concentric with the hole
  const pinAt = list[1].position;
  api.assembly.mate({ type: 'coincident', component1: p, ref1: api.assembly.faceAt(p, { x: 0, y: 15, z: 10 }), component2: q, ref2: api.assembly.faceAt(q, { x: pinAt.x, y: pinAt.y, z: 0 }) });
  const hole = api.assembly.faceAt(p, { x: 15, y: 0, z: 5 });
  assert.equal(hole.kind, 'cylinder');
  assert.ok(Math.abs(hole.radius! - 5) < 0.05, `hole radius ${hole.radius}`);
  api.assembly.mate({ type: 'concentric', component1: p, ref1: hole, component2: q, ref2: api.assembly.faceAt(q, { x: pinAt.x + 5, y: pinAt.y, z: 15 }) });
  let pinNow = api.assembly.list()[1].position;
  assert.ok(Math.abs(pinNow.x - 10) < 1e-3 && Math.abs(pinNow.y) < 1e-3 && Math.abs(pinNow.z - 10) < 1e-3, `pin at ${JSON.stringify(pinNow)}`);
  const dof = api.assembly.dof()!;
  assert.equal(dof.status, 'under-defined');
  assert.deepEqual(dof.components.map(c => [c.name, c.status, c.dof]), [['Plate', 'fixed', 0], ['Pin', 'under-defined', 1]]);
  assert.deepEqual(dof.components[1].motions, ['turn about Z']);

  // Edit the plate: the assembly picks it up when it becomes active again, and re-solves
  api.workspace.activate(plateId);
  const extrude = api.features.list().find(f => f.type === 'extrude_boss')!;
  api.features.update(extrude.id, { depth: 20 });
  api.workspace.activate(asmId);
  await tick();
  assert.ok(Math.abs(sizeZ(p) - 20) < 1e-6, 'the plate is 20 mm now');
  pinNow = api.assembly.list()[1].position;
  assert.ok(Math.abs(pinNow.z - 20) < 1e-3, `the pin moved up with the face: z = ${pinNow.z}`);
  assert.equal(api.assembly.dof()!.components[1].dof, 1, 'mates kept');

  // Saved and reopened with the plate closed: the cached copy is used and said so
  const saved = api.document.toJSON();
  api.workspace.close(asmId, { discard: true });
  api.workspace.close(plateId, { discard: true });
  api.workspace.open(saved);
  await tick();
  const back = api.assembly.list();
  assert.deepEqual(back.map(c => c.part?.linked), ['cached', 'workspace']);
  assert.ok(Math.abs(sizeZ(back[0].id) - 20) < 1e-6, 'the cached plate is the 20 mm one');
  assert.equal(api.assembly.mates().length, 2);
  // The BOM groups by part and uses the parts' materials
  assert.deepEqual(api.assembly.bom().rows.map(r => [r.partNumber, r.quantity]), [['Plate', 1], ['Pin', 1]]);
});

test('Motion along mates: an angle mate about an axis drives the part round; a conflicting mate is over defined', () => {
  api.workspace.newAssembly('Spinner');
  const base = api.assembly.insert({ name: 'Base', shape: 'box', dimensions: { width: 60, height: 10, depth: 60 } });
  const arm = api.assembly.insert({ name: 'Arm', shape: 'box', dimensions: { width: 80, height: 10, depth: 12 } });
  api.assembly.mate({ type: 'coincident', component1: base, ref1: 'top', component2: arm, ref2: 'bottom' });
  api.assembly.mate({ type: 'concentric', component1: base, ref1: 'y', component2: arm, ref2: 'y' });
  assert.deepEqual(api.assembly.dof()!.components[1].motions, ['turn about Y']);
  api.assembly.mate({ type: 'angle', component1: base, ref1: 'right', component2: arm, ref2: 'right', angle: 0, axis: { x: 0, y: 1, z: 0 } });
  assert.equal(api.assembly.dof()!.status, 'fully-defined');
  const angle = api.assembly.mates().find(m => m.type === 'angle')!;

  for (const deg of [45, 90, 135, 180, -90]) {
    const r = api.assembly.drive(angle.id, deg);
    assert.ok(r.converged, `${deg}°: ${r.error}`);
    const arms = useCADStore.getState().assemblyComponents.find(c => c.id === arm)!;
    // The arm's +X now points at deg about +Y (x = cos, z = -sin)
    const dir = { x: 1 - 2 * (arms.quaternion.y ** 2 + arms.quaternion.z ** 2), z: 2 * (arms.quaternion.x * arms.quaternion.z - arms.quaternion.w * arms.quaternion.y) };
    const rad = deg * Math.PI / 180;
    assert.ok(Math.abs(dir.x - Math.cos(rad)) < 1e-3 && Math.abs(dir.z + Math.sin(rad)) < 1e-3, `${deg}°: arm x axis (${dir.x.toFixed(3)}, ${dir.z.toFixed(3)})`);
    assert.ok(Math.abs(arms.position.y - 10) < 1e-3, 'still on the base');
  }
  assert.throws(() => api.assembly.drive(api.assembly.mates()[0].id, 3), /no value to drive/);

  // A distance that contradicts the coincident mate
  api.assembly.mate({ type: 'distance', component1: base, ref1: 'top', component2: arm, ref2: 'bottom', offset: 5 });
  const dof = api.assembly.dof()!;
  assert.equal(dof.status, 'over-defined');
  assert.equal(dof.components[1].status, 'over-defined');
  assert.ok(dof.conflicts.length >= 1);
});

test('Explode steps: in order, played by progress, saved with the assembly', () => {
  api.workspace.newAssembly('Stack');
  const a = api.assembly.insert({ name: 'A', shape: 'box' });
  const b = api.assembly.insert({ name: 'B', shape: 'box' });
  const c = api.assembly.insert({ name: 'C', shape: 'box' });
  assert.throws(() => api.assembly.setExplodeSteps([{ components: ['nope'], direction: '+Y', distance: 10 }]), /no component/);
  assert.throws(() => api.assembly.setExplodeSteps([{ components: [b], direction: 'up' as never, distance: 10 }]), /direction/);
  api.assembly.setExplodeSteps([
    { components: [b, c], direction: '+Y', distance: 40 },
    { components: [c], direction: { x: 3, y: 0, z: 4 }, distance: 50 },
  ]);
  const steps = api.assembly.explodeSteps();
  assert.deepEqual(steps[1].direction, { x: 0.6, y: 0, z: 0.8 });
  const at = (p: number) => Object.fromEntries([...stepOffsets(useCADStore.getState().explodeSteps, p)].map(([id, v]) => [id === b ? 'B' : 'C', [v.x, v.y, v.z].map(n => Math.round(n))]));
  assert.deepEqual(at(0), {});
  assert.deepEqual(at(0.25), { B: [0, 20, 0], C: [0, 20, 0] });
  assert.deepEqual(at(0.75), { B: [0, 40, 0], C: [15, 40, 20] });
  assert.deepEqual(at(1), { B: [0, 40, 0], C: [30, 40, 40] });
  api.assembly.explode({ progress: 0.5 });
  assert.equal(useCADStore.getState().explodedView?.progress, 0.5);

  const saved = JSON.parse(api.document.toJSON()) as { explodeSteps: unknown[]; documentType: string };
  assert.equal(saved.documentType, 'assembly');
  assert.equal(saved.explodeSteps.length, 2);
  // Removing a component takes it out of the steps
  api.assembly.remove(c);
  assert.deepEqual(api.assembly.explodeSteps().map(s => s.components), [[b]]);
  void a;
});

test('Older files: a file with components and no features opens as an assembly; with features, as a part', () => {
  const old = (features: unknown[]) => JSON.stringify({ version: '2.0.0', documentName: 'Old', features, sketchEntities: {}, assemblyComponents: [
    { id: 'c1', name: 'Box', isFixed: true, position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, geometryType: 'box', dimensions: {} },
  ], mates: [] });
  api.workspace.open(old([]));
  assert.equal(api.document.getType(), 'assembly');
  api.workspace.open(old([{ id: 'f1', type: 'sketch', name: 'S', sketchId: 's1', plane: 'Front' }]));
  assert.equal(api.document.getType(), 'part');
  assert.equal(workspace.list().filter(d => d.name === 'Old').length, 2);
});
