// CasiWorks Pro - Macro recording, replay and script export
import test from 'node:test';
import assert from 'node:assert/strict';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { attachMacros, MacroError, macroToScript, parseMacro } from '../src/commands/macros.ts';
import type { Macro } from '../src/commands/macros.ts';
import { createCasiWorksAPI, CasiWorksAPIError } from '../src/api/CasiWorksAPI.ts';
import type { CasiWorksAPI } from '../src/api/CasiWorksAPI.ts';

const L = (x1: number, y1: number, x2: number, y2: number) => ({ id: `l${x1}${y1}${x2}${y2}`, type: 'line', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
const square = [L(-10, -10, 10, -10), L(10, -10, 10, 10), L(10, 10, -10, 10), L(-10, 10, -10, -10)];

function setup() {
  const registry = createCommandRegistry(useCADStore);
  const recorder = attachMacros(registry);
  const api: CasiWorksAPI = createCasiWorksAPI(useCADStore, { commands: registry, macros: recorder });
  const s = () => useCADStore.getState();
  return { registry, recorder, api, s };
}

/** New part + 20 mm square extruded 5 mm, then made 8 mm deep. */
function recordBlock({ registry, recorder }: ReturnType<typeof setup>): Macro {
  recorder.start('Block');
  registry.execute('document.new');
  const sk = registry.execute('sketch.create', { plane: 'Front', entities: square }) as { sketchId: string };
  const { featureId } = registry.execute('feature.create', { type: 'extrude_boss', sketchId: sk.sketchId, depth: 5 }) as { featureId: string };
  registry.execute('view.top'); // views are not recorded
  registry.execute('feature.hole'); // opening a tool panel is not recorded
  registry.execute('edit.cancel');
  registry.execute('feature.update', { id: featureId, changes: { depth: 8 } });
  return recorder.stop();
}

test('Recording keeps only model-changing steps, with the ids they created', () => {
  const ctx = setup();
  const macro = recordBlock(ctx);
  assert.deepEqual(macro.steps.map(s => s.command), ['document.new', 'sketch.create', 'feature.create', 'feature.update']);
  assert.deepEqual(Object.keys(macro.steps[1].returns!), ['sketchId', 'featureId']);
  assert.deepEqual(Object.keys(macro.steps[2].returns!), ['featureId']);
  assert.equal(parseMacro(JSON.parse(JSON.stringify(macro))).name, 'Block', 'a macro is plain JSON');
});

test('Replay rebuilds the same model, and maps ids so it can run twice in one document', () => {
  const ctx = setup();
  const { recorder, api, s } = ctx;
  const macro = recordBlock(ctx);
  const volume = api.model.massProperties()!.volume;
  assert.ok(Math.abs(volume - 20 * 20 * 8) < 1e-6);

  api.document.new();
  const replay = recorder.run(macro);
  assert.equal(replay.steps, 4);
  assert.ok(Math.abs(api.model.massProperties()!.volume - volume) < 1e-6, 'same solid');

  // Without document.new: run the steps after it twice into one document
  const body = { ...macro, steps: macro.steps.slice(1) };
  api.document.new();
  recorder.run(body);
  recorder.run(body);
  const feats = s().features;
  assert.equal(feats.length, 4);
  const [sk1, ex1, sk2, ex2] = feats as Array<{ sketchId?: string; depth?: number }>;
  assert.notEqual(sk1.sketchId, sk2.sketchId);
  assert.equal(ex1.sketchId, sk1.sketchId);
  assert.equal(ex2.sketchId, sk2.sketchId, 'second replay refers to its own sketch');
  assert.equal(ex2.depth, 8, 'feature.update applied to the replayed feature');
});

test('Interactive sketches are recorded as their finished geometry; edits as replacements', () => {
  const { registry, recorder, s } = setup();
  s().newProject();
  recorder.start('UI sketch');
  registry.execute('sketch.new', { plane: 'Right' });
  square.forEach(e => s().addSketchEntity(e as never)); // the clicks
  registry.execute('sketch.exit');
  const sketchFeature = s().features[0];
  s().editSketch(sketchFeature.id);
  s().addSketchEntity({ id: 'p', type: 'point', x: 1, y: 2 } as never);
  registry.execute('sketch.exit');
  const macro = recorder.stop();

  assert.deepEqual(macro.steps.map(st => st.command), ['sketch.create', 'sketch.setEntities']);
  const created = macro.steps[0].args as { plane: string; entities: unknown[] };
  assert.equal(created.plane, 'Right');
  assert.equal(created.entities.length, 4);
  assert.equal((macro.steps[1].args as { entities: unknown[] }).entities.length, 5);

  s().newProject();
  recorder.run(macro);
  const replayed = s().features[0];
  assert.equal(replayed.type === 'sketch' && replayed.plane, 'Right');
  assert.equal(s().sketchEntities[replayed.type === 'sketch' ? replayed.sketchId : ''].length, 5, 'edit replayed on the new sketch');
});

test('Exported script replays through the public API', async () => {
  const ctx = setup();
  const macro = recordBlock(ctx);
  const script = macroToScript(macro);
  assert.match(script, /const r1 = run\("sketch\.create"/);
  assert.match(script, /sketchId: r1\.sketchId/);
  assert.match(script, /id: r2\.featureId/);

  ctx.api.document.new();
  (globalThis as { casiworks?: CasiWorksAPI }).casiworks = ctx.api;
  try {
    const realLog = console.log;
    console.log = () => {};
    try {
      await import('data:text/javascript,' + encodeURIComponent(script));
    } finally {
      console.log = realLog;
    }
  } finally {
    delete (globalThis as { casiworks?: CasiWorksAPI }).casiworks;
  }
  assert.equal(ctx.s().features.length, 2);
  assert.ok(Math.abs(ctx.api.model.massProperties()!.volume - 20 * 20 * 8) < 1e-6);
});

test('Bad macros fail before or at the failing step, with its index', () => {
  const { recorder, s, api } = setup();
  assert.throws(() => recorder.run({ format: 'something-else' }), /Not a CasiWorks macro/);
  const base = { format: 'casiworks-macro', version: 1, name: 'x', recordedAt: '' };

  s().newProject();
  assert.throws(() => recorder.run({ ...base, steps: [{ command: 'document.new' }, { command: 'no.such' }] }), MacroError);
  assert.equal(s().documentRevision >= 0 && s().features.length, 0, 'unknown commands are caught before anything runs');

  const err = (() => {
    try {
      recorder.run({ ...base, steps: [{ command: 'sketch.create', args: { entities: square } }, { command: 'feature.create', args: { type: 'nonsense' } }] });
    } catch (e) {
      return e;
    }
  })() as MacroError;
  assert.ok(err instanceof MacroError);
  assert.equal(err.step, 1);
  assert.match(err.message, /Step 2 \(feature\.create\) failed/);

  // Through the API: errors are API errors
  assert.throws(() => api.macros.run('not json'), (e: unknown) => e instanceof CasiWorksAPIError);
  assert.throws(() => api.macros.stopRecording(), (e: unknown) => e instanceof CasiWorksAPIError && e.code === 'OPERATION_FAILED');
});

test('API macros: record script-driven changes; replay is not recorded twice', () => {
  const { api, recorder } = setup();
  api.document.new();
  api.macros.startRecording('From API');
  assert.equal(api.macros.isRecording(), true);
  api.commands.execute('sketch.create', { entities: square });
  const inner = { format: 'casiworks-macro', version: 1, name: 'inner', recordedAt: '', steps: [{ command: 'sketch.create', args: { entities: square } }] };
  recorder.run(inner); // replays while recording: not recorded
  const macro = api.macros.stopRecording();
  assert.deepEqual(macro.steps.map(st => st.command), ['sketch.create']);
  assert.match(api.macros.toScript(macro), /run\("sketch\.create"/);

  const bare = createCasiWorksAPI(useCADStore);
  assert.equal(bare.macros.isRecording(), false);
  assert.throws(() => bare.macros.startRecording(), (e: unknown) => e instanceof CasiWorksAPIError && e.code === 'OPERATION_FAILED');
});
