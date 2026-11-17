// CasiWorks Pro - Store: feature graph, examples, atomic load, new document, undo/redo, save/load round trip
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_TYPES, SKETCH_ENTITY_TYPES } from '../src/utils/constants.ts';
import type { Feature } from '../src/types/cad.ts';
import { useCADStore, ensureFeatureGraph } from '../src/store/cadStore.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';

const squareSketch = (half = 10) => [
  { id: 'q1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -half, y: -half }, p2: { x: half, y: -half } },
  { id: 'q2', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: half, y: -half }, p2: { x: half, y: half } },
  { id: 'q3', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: half, y: half }, p2: { x: -half, y: half } },
  { id: 'q4', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -half, y: half }, p2: { x: -half, y: -half } },
];

test('Store regression: addFeature works on features lacking dependency arrays (starter part / examples)', () => {
  const store = useCADStore;
  store.getState().newProject();
  store.setState(s => {
    s.sketchEntities.sk0 = squareSketch();
    s.features.push(
      // Deliberately without parentIds / childIds (as the starter part and examples once were)
      { id: 'fs', name: 'Sketch1', type: FEATURE_TYPES.SKETCH, sketchId: 'sk0', plane: 'Front', suppressed: false } as Feature,
      { id: 'fe', name: 'Boss', type: FEATURE_TYPES.EXTRUDE_BOSS, sketchId: 'sk0', depth: 5, suppressed: false } as Feature,
    );
  });
  assert.doesNotThrow(() => store.getState().addFeature({ id: 'cut', name: 'Cut', type: FEATURE_TYPES.EXTRUDE_CUT, sketchId: 'sk0', depth: 5 }));
  const feats = store.getState().features;
  assert.equal(feats.length, 3);
  const cut = feats[2];
  assert.deepEqual(cut.parentIds, ['fs'], 'parent must be the sketch feature, not another consumer');
  assert.ok(feats[0].childIds.includes(cut.id));

  // Suppressing the sketch must cascade to every consumer
  store.getState().toggleFeatureSuppressed('fs');
  assert.ok(store.getState().features.every(f => f.suppressed));
});

test('Store regression: every built-in example supports add, remove and suppress', () => {
  for (const ex of CAD_EXAMPLES) {
    const store = useCADStore;
    store.getState().loadExampleModel(ex.create());
    const sketch = store.getState().features.find(f => f.type === FEATURE_TYPES.SKETCH);
    assert.ok(sketch?.type === FEATURE_TYPES.SKETCH, ex.id);
    assert.doesNotThrow(() => store.getState().addFeature({ id: `x_${ex.id}`, name: 'X', type: FEATURE_TYPES.EXTRUDE_CUT, sketchId: sketch.sketchId, depth: 5 }), ex.id);
    const last = store.getState().features.at(-1);
    assert.ok(last, ex.id);
    assert.doesNotThrow(() => store.getState().toggleFeatureSuppressed(last.id), ex.id);
    assert.doesNotThrow(() => store.getState().removeFeature(last.id), ex.id);
  }
});

test('Store regression: loadProject rejects invalid files atomically', () => {
  const store = useCADStore;
  store.getState().newProject();
  store.getState().setDocumentName('KeepMe');
  store.getState().loadProject('{"features": "not-an-array", "documentName": "Bad"}');
  assert.equal(store.getState().documentName, 'KeepMe', 'invalid file must not partially load');
  assert.match(store.getState().statusMessage, /Error loading project/);
  for (const bad of ['[1,2]', 'null', '"text"', '{not json']) {
    store.getState().loadProject(bad);
    assert.equal(store.getState().documentName, 'KeepMe', `input ${bad} must not change the document`);
  }
});

test('Store: newProject resets to a fresh, independent initial state', () => {
  const store = useCADStore;
  store.getState().newProject();
  store.getState().addFeature({ id: 'f1', name: 'S', type: FEATURE_TYPES.SKETCH, sketchId: 'k', plane: 'Front' });
  store.getState().newProject();
  assert.equal(store.getState().features.length, 0);
  assert.equal(store.getState().undoStack.length, 0);
  // A second reset must not share arrays with the first (initial state is created fresh each time)
  store.getState().addFeature({ id: 'f2', name: 'S', type: FEATURE_TYPES.SKETCH, sketchId: 'k2', plane: 'Front' });
  store.getState().newProject();
  assert.equal(store.getState().features.length, 0);
});

test('Store: undo/redo carry action names and restore the document', () => {
  const store = useCADStore;
  store.getState().newProject();
  store.getState().addFeature({ id: 'f1', name: 'Sk', type: FEATURE_TYPES.SKETCH, sketchId: 'k', plane: 'Front' });
  store.getState().undo();
  assert.equal(store.getState().features.length, 0);
  assert.match(store.getState().statusMessage, /^Undo: Add Sk/);
  store.getState().redo();
  assert.equal(store.getState().features.length, 1);
  assert.match(store.getState().statusMessage, /^Redo: Add Sk/);
});

test('Store regression: project save/load round-trip preserves feature graph', () => {
  const store = useCADStore;
  store.getState().loadExampleModel(CAD_EXAMPLES[0].create());
  const json = store.getState().saveProject();
  const before = store.getState().features.map(f => [f.id, f.parentIds, f.childIds]);
  store.getState().newProject();
  assert.equal(store.getState().features.length, 0, 'New must leave an empty document');
  store.getState().loadProject(json);
  assert.deepEqual(store.getState().features.map(f => [f.id, f.parentIds, f.childIds]), before);
});

test('ensureFeatureGraph: derives parents and rebuilds child links', () => {
  const f = ensureFeatureGraph([
    { id: 's', name: 'S', type: FEATURE_TYPES.SKETCH, sketchId: 'k', plane: 'Front' },
    { id: 'e1', name: 'E1', type: FEATURE_TYPES.EXTRUDE_BOSS, sketchId: 'k', depth: 5 },
    { id: 'e2', name: 'E2', type: FEATURE_TYPES.EXTRUDE_CUT, sketchId: 'k', depth: 5, childIds: ['stale'] },
  ]);
  assert.deepEqual(f[0].childIds, ['e1', 'e2']);
  assert.deepEqual(f[2].parentIds, ['s']);
  assert.deepEqual(f[2].childIds, []);
});
