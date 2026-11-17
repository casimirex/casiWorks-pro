// CasiWorks Pro - API events (api.on / api.off)
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI, CasiWorksAPIError } from '../src/api/CasiWorksAPI.ts';
import type { ApiStore, CasiWorksEventMap, CasiWorksEventName } from '../src/api/CasiWorksAPI.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';

const rect = { type: 'rectangle' as const, corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } };

/** Record every event of the given kinds. */
function recorder(api: ReturnType<typeof createCasiWorksAPI>, names: CasiWorksEventName[]) {
  const log: Array<{ event: CasiWorksEventName; payload: CasiWorksEventMap[CasiWorksEventName] }> = [];
  const stops = names.map(n => api.on(n, (payload) => log.push({ event: n, payload })));
  return { log, of: <K extends CasiWorksEventName>(n: K) => log.filter(e => e.event === n).map(e => e.payload as CasiWorksEventMap[K]), stop: () => stops.forEach(s => s()) };
}

test('Events: features added, changed and removed, with rebuild results', () => {
  const api = createCasiWorksAPI(useCADStore);
  api.document.new();
  const rec = recorder(api, ['featureAdded', 'featureChanged', 'featureRemoved', 'rebuild']);

  const sketch = api.sketches.create({ entities: [rect] });
  const boss = api.features.extrude({ sketchId: sketch.sketchId, depth: 25, name: 'Base' });
  assert.deepEqual(rec.of('featureAdded').map(e => [e.feature.type, e.feature.name]), [['sketch', 'Sketch1'], ['extrude_boss', 'Base']]);
  assert.equal(rec.of('featureAdded')[1].feature.parameters.depth, 25);

  api.model.massProperties(); // queries rebuild first
  const rebuilt = rec.of('rebuild').at(-1)!;
  assert.deepEqual([rebuilt.ok, rebuilt.bodyCount, rebuilt.errors], [true, 1, []]);

  rec.log.length = 0;
  api.features.update(boss, { depth: 40 });
  const changed = rec.of('featureChanged');
  assert.deepEqual(changed.map(e => [e.feature.id, e.feature.parameters.depth]), [[boss, 40]]);

  api.features.remove(boss);
  assert.deepEqual(rec.of('featureRemoved'), [{ id: boss, name: 'Base' }]);
  rec.stop();
});

test('Events: undo reports what it undid, not every feature; new document is one documentChanged', () => {
  const api = createCasiWorksAPI(useCADStore);
  api.document.new();
  const s1 = api.sketches.create({ entities: [rect] });
  const boss = api.features.extrude({ sketchId: s1.sketchId, depth: 25 });
  const s2 = api.sketches.create({ entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 5 }] });
  const cut = api.features.extrude({ sketchId: s2.sketchId, depth: 50, endCondition: 'throughall', cut: true });

  const rec = recorder(api, ['featureAdded', 'featureChanged', 'featureRemoved', 'documentChanged']);
  api.history.undo();
  assert.deepEqual(rec.of('featureRemoved').map(e => e.id), [cut]);
  assert.ok(!rec.of('featureChanged').some(e => e.feature.id === boss), 'untouched features are not reported (undo restores copies)');
  assert.equal(rec.of('featureAdded').length, 0);

  rec.log.length = 0;
  api.document.new();
  assert.deepEqual(rec.log.map(e => e.event), ['documentChanged']);
  assert.deepEqual(rec.of('documentChanged')[0], { name: 'Untitled Part', featureCount: 0 });
  rec.stop();
});

test('Events: selection and commands', () => {
  const registry = createCommandRegistry(useCADStore);
  const api = createCasiWorksAPI(useCADStore, { commands: registry });
  const rec = recorder(api, ['selectionChanged', 'commandExecuted']);

  useCADStore.getState().setSelection([{ id: 'body_0' }]);
  useCADStore.getState().setSelection([{ id: 'body_0' }]); // same selection: no event
  useCADStore.getState().clearSelection();
  assert.deepEqual(rec.of('selectionChanged').map(e => e.ids), [['body_0'], []]);

  api.commands.execute('view.top');
  assert.throws(() => api.commands.execute('sketch.new', { plane: 'X' }));
  assert.deepEqual(rec.of('commandExecuted').map(e => [e.id, e.ok]), [['view.top', true], ['sketch.new', false]]);
  assert.match(rec.of('commandExecuted')[1].error!, /plane must be Front, Top, Right/);
  rec.stop();
});

test('Events: unsubscribe, bad input, failing listeners, and no store subscription without listeners', () => {
  let subscriptions = 0;
  const store: ApiStore = {
    getState: () => useCADStore.getState(),
    subscribe: (l) => { subscriptions++; const stop = useCADStore.subscribe(l); return () => { subscriptions--; stop(); }; },
  };
  const api = createCasiWorksAPI(store);
  assert.equal(subscriptions, 0, 'nothing watched until someone listens');

  const seen: string[] = [];
  const stopBad = api.on('selectionChanged', () => { throw new Error('listener bug'); });
  const stop = api.on('selectionChanged', (e) => seen.push(e.ids.join()));
  assert.equal(subscriptions, 1, 'one store subscription for any number of listeners');

  const realError = console.error;
  console.error = () => {};
  try {
    useCADStore.getState().setSelection([{ id: 'a' }]);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(seen, ['a'], 'a failing listener does not stop the others');

  stop();
  stopBad();
  assert.equal(subscriptions, 0, 'released when the last listener leaves');
  useCADStore.getState().setSelection([{ id: 'b' }]);
  assert.deepEqual(seen, ['a']);

  assert.throws(() => api.on('explode' as CasiWorksEventName, () => {}), (e: unknown) => e instanceof CasiWorksAPIError && e.code === 'INVALID_ARGUMENT');
  useCADStore.getState().clearSelection();
});
