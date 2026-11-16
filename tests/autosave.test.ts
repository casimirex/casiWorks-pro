// CasiWorks Pro - Autosave: the document is kept after changes and restored on start-up
import test from 'node:test';
import assert from 'node:assert/strict';

import { memoryStorage, restoreAutosave, startAutosave } from '../src/utils/autosave.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const s = () => useCADStore.getState();

function plate(r = createCommandRegistry(useCADStore)) {
  r.execute('sketch.create', { plane: 'Front', entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 40, y: 20 } }] });
}

test('Autosave: a change is written after the delay, once, with the unsaved flag', async () => {
  s().newProject();
  const storage = memoryStorage();
  const autosave = startAutosave(useCADStore, storage, { delayMs: 20, now: () => 1000 });
  try {
    s().setStatus('just a status message'); // not a document change
    await sleep(40);
    assert.equal(storage.text, null, 'status changes are not saved');

    s().setDocumentName('Bracket A');
    plate();
    assert.equal(storage.text, null, 'waits for the delay');
    await sleep(60);
    const snap = JSON.parse(storage.text!);
    assert.equal(snap.format, 'casiworks-autosave');
    assert.equal(snap.savedAt, 1000);
    assert.equal(snap.modified, true);
    const project = JSON.parse(snap.project);
    assert.equal(project.documentName, 'Bracket A');
    assert.equal(project.features.length, 1);

    // flush writes a waiting change at once; with nothing waiting it does nothing
    s().setDocumentName('Bracket B');
    await autosave.flush();
    assert.equal(JSON.parse(JSON.parse(storage.text!).project).documentName, 'Bracket B');
    storage.text = 'untouched';
    await autosave.flush();
    assert.equal(storage.text, 'untouched');
  } finally {
    autosave.stop();
  }
  s().setDocumentName('after stop');
  await sleep(40);
  assert.equal(storage.text, 'untouched', 'stop() ends saving');
});

test('Autosave: restore brings back the document and its unsaved flag; bad snapshots are dropped', async () => {
  s().newProject();
  s().setDocumentName('Gear Housing');
  plate();
  const storage = memoryStorage();
  const autosave = startAutosave(useCADStore, storage, { delayMs: 0 });
  s().setDocumentName('Gear Housing'); // no-op name, but the plate above happened before start
  plate();
  await autosave.flush();
  autosave.stop();
  const saved = JSON.parse(JSON.parse(storage.text!).project);

  s().newProject();
  assert.equal(s().features.length, 0);
  assert.match((await restoreAutosave(useCADStore, storage))!, /^Restored Gear Housing from autosave \(/);
  assert.equal(s().documentName, 'Gear Housing');
  assert.equal(s().features.length, saved.features.length);
  assert.equal(s().isModified, true, 'still marked unsaved');
  assert.match(s().statusMessage, /^Restored Gear Housing from autosave/);

  assert.equal(await restoreAutosave(useCADStore, memoryStorage()), null, 'nothing saved');
  for (const bad of ['not json', '{"format":"other"}', JSON.stringify({ format: 'casiworks-autosave', version: 1, savedAt: 0, modified: false, project: '[1,2]' })]) {
    const store = memoryStorage(bad);
    s().newProject();
    assert.equal(await restoreAutosave(useCADStore, store), null, bad);
    assert.equal(store.text, null, `removed: ${bad}`);
    assert.equal(s().features.length, 0, 'document untouched');
  }

  const broken = { read: async () => { throw new Error('blocked'); }, write: async () => {}, clear: async () => {} };
  assert.equal(await restoreAutosave(useCADStore, broken), null, 'storage errors do not stop start-up');
});

test('Autosave: a failing write is reported once in the status bar', async () => {
  s().newProject();
  let writes = 0;
  const failing = { read: async () => null, write: async () => { writes++; throw new Error('QuotaExceededError'); }, clear: async () => {} };
  const autosave = startAutosave(useCADStore, failing, { delayMs: 0 });
  s().setDocumentName('One');
  await autosave.flush();
  assert.equal(s().statusMessage, 'Autosave failed: QuotaExceededError');
  s().setStatus('Ready');
  s().setDocumentName('Two');
  await autosave.flush();
  assert.equal(writes, 2, 'keeps trying');
  assert.equal(s().statusMessage, 'Ready', 'reported once');
  autosave.stop();
});
