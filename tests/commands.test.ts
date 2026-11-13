// CasiWorks Pro - Command registry and built-in commands
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CommandError, CommandRegistry, normalizeShortcut, shortcutFromEvent } from '../src/commands/CommandRegistry.ts';
import type { CommandExecution, UIHost } from '../src/commands/CommandRegistry.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI, CasiWorksAPIError } from '../src/api/CasiWorksAPI.ts';

const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, `expected ${code}`);

test('Shortcuts normalise: modifier order, case, Cmd = Ctrl, plain letters ignore Shift', () => {
  assert.equal(normalizeShortcut('shift+ctrl+z'), 'Ctrl+Shift+Z');
  assert.equal(normalizeShortcut('Cmd+S'), 'Ctrl+S');
  assert.equal(normalizeShortcut('escape'), 'Escape');
  const ev = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    shortcutFromEvent({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(ev('z', { metaKey: true }), 'Ctrl+Z');
  assert.equal(ev('Z', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Z');
  assert.equal(ev('L', { shiftKey: true }), 'L');
  assert.equal(ev(' '), 'Space');
  assert.equal(ev('F5'), 'F5');
});

test('Registry: ids, duplicates, unknown commands, UI-only commands, listeners see top-level runs', () => {
  const r = new CommandRegistry(() => ({ n: 0 }));
  throwsCode(() => r.register({ id: 'bad id', label: 'x', category: 'x', run: () => 0 }), 'INVALID_ARGUMENT');
  r.register({ id: 'demo.inner', label: 'Inner', category: 'Demo', run: () => 'inner' });
  r.register({ id: 'demo.outer', label: 'Outer', category: 'Demo', shortcuts: ['ctrl+k'], run: (ctx, args: { x: number }) => `${ctx.execute('demo.inner')}:${args.x}` });
  r.register({ id: 'demo.dialog', label: 'Dialog', category: 'Demo', requiresUI: true, run: (ctx) => ctx.ui().openDialog('export') });
  throwsCode(() => r.register({ id: 'demo.inner', label: 'x', category: 'x', run: () => 0 }), 'DUPLICATE_COMMAND');

  const seen: CommandExecution[] = [];
  r.onExecute(e => seen.push(e));
  assert.equal(r.execute('demo.outer', { x: 7 }), 'inner:7');
  assert.deepEqual(seen, [{ id: 'demo.outer', args: { x: 7 }, ok: true }], 'nested run is part of its caller');

  throwsCode(() => r.execute('demo.missing'), 'UNKNOWN_COMMAND');
  throwsCode(() => r.execute('demo.dialog'), 'NOT_AVAILABLE');
  const opened: string[] = [];
  r.setUIHost({ openDialog: (n) => opened.push(n), toggleFeatureTree: () => {} } satisfies UIHost);
  r.execute('demo.dialog');
  assert.deepEqual(opened, ['export']);

  assert.equal(r.commandForShortcut('Ctrl+K'), 'demo.outer');
  r.unregister('demo.outer');
  assert.equal(r.commandForShortcut('Ctrl+K'), undefined, 'unregister frees the shortcut');
  assert.ok(seen.at(-1)!.ok, 'listeners keep working');
});

test('Built-in keymap: every former shortcut runs the same action, and no key is bound twice', () => {
  const r = createCommandRegistry(useCADStore);
  const expected: Record<string, string> = {
    'Ctrl+Z': 'edit.undo', 'Ctrl+Y': 'edit.redo', 'Ctrl+Shift+Z': 'edit.redo', 'Ctrl+S': 'file.save', 'Ctrl+O': 'file.open',
    'Ctrl+Alt+N': 'file.new', F5: 'model.rebuild', Escape: 'edit.cancel',
    'Ctrl+1': 'view.front', 'Ctrl+2': 'view.back', 'Ctrl+3': 'view.left', 'Ctrl+4': 'view.right',
    'Ctrl+5': 'view.top', 'Ctrl+6': 'view.bottom', 'Ctrl+7': 'view.isometric', Space: 'view.isometric',
    L: 'sketch.line', R: 'sketch.rectangle', C: 'sketch.circle', D: 'sketch.dimension', E: 'feature.extrude',
  };
  for (const [key, id] of Object.entries(expected)) assert.equal(r.commandForShortcut(key), id, key);

  const bound = r.list().flatMap(c => c.shortcuts);
  assert.equal(new Set(bound).size, bound.length, `duplicate bindings: ${bound}`);
});

test('Every command the UI runs is registered', () => {
  const r = createCommandRegistry(useCADStore);
  const files: string[] = [];
  const walk = (dir: string) => readdirSync(dir).forEach(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.tsx')) files.push(p);
  });
  walk('src');
  const used = new Set(files.flatMap(f => [...readFileSync(f, 'utf8').matchAll(/runCommand\('([\w.]+)'/g)].map(m => m[1])));
  assert.ok(used.size > 40, `UI runs ${used.size} commands`);
  for (const id of used) assert.ok(r.has(id), `UI runs unregistered command ${id}`);
});

test('Built-in commands drive the store: sketch planes, views, feature tools, examples, mates', () => {
  const r = createCommandRegistry(useCADStore);
  const s = () => useCADStore.getState();
  s().newProject();

  r.execute('sketch.new', { plane: 'Top' });
  assert.equal(s().activeSketchPlane, 'Top');
  assert.equal(s().viewOrientation, 'top', 'camera faces the sketch plane');
  throwsCode(() => r.execute('sketch.new', { plane: 'Right' }), 'NOT_AVAILABLE');
  r.execute('sketch.discard');
  throwsCode(() => r.execute('sketch.new', { plane: 'Diagonal' }), 'INVALID_ARGUMENT');

  r.execute('view.left');
  assert.equal(s().viewOrientation, 'left');

  r.execute('feature.hole');
  assert.equal(s().propertyPanelContent?.type, 'hole');
  r.execute('edit.cancel');
  assert.equal(s().propertyPanelOpen, false);

  throwsCode(() => r.execute('file.loadExample', { id: 'nope' }), 'INVALID_ARGUMENT');
  r.execute('file.loadExample', { id: 'hex_bolt' });
  assert.ok(s().features.length > 0);

  s().clearAssembly();
  throwsCode(() => r.execute('assembly.mate', { type: 'coincident' }), 'NOT_AVAILABLE');
  r.execute('assembly.insertPart', { name: 'Plate', shape: 'box', dims: { width: 50, height: 12, depth: 50 } });
  // One component: the path mate used to crash here (it checked for one but used two)
  throwsCode(() => r.execute('assembly.mate', { type: 'path' }), 'NOT_AVAILABLE');
  r.execute('assembly.insertPart', { name: 'Pin', shape: 'pin' });
  const [plate, pin] = s().assemblyComponents;
  r.execute('assembly.mate', { type: 'tangent' });
  const mate = s().mates.at(-1)!;
  assert.deepEqual([mate.comp1Id, mate.ref1, mate.comp2Id, mate.ref2], [pin.id, 'y', plate.id, 'top'], 'pin axis tangent to the plate top');
  throwsCode(() => r.execute('assembly.mate', { type: 'glue' }), 'INVALID_ARGUMENT');
});

test('API: commands namespace lists and runs commands with API error codes', () => {
  const r = createCommandRegistry(useCADStore);
  const api = createCasiWorksAPI(useCADStore, { commands: r });
  assert.ok(api.commands.list().some(c => c.id === 'feature.extrudeCut' && c.category === 'Features'));
  assert.ok(api.commands.has('file.save'));
  api.commands.execute('view.bottom');
  assert.equal(useCADStore.getState().viewOrientation, 'bottom');

  const code = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof CasiWorksAPIError); return e.code; } return null; };
  assert.equal(code(() => api.commands.execute('nope.nope')), 'NOT_FOUND');
  assert.equal(code(() => api.commands.execute('sketch.new', { plane: 'X' })), 'INVALID_ARGUMENT');
  assert.equal(code(() => api.commands.execute('model.material')), 'OPERATION_FAILED', 'needs the UI');
  assert.ok(!(new CommandError('FAILED', 'x') instanceof CasiWorksAPIError));

  const bare = createCasiWorksAPI(useCADStore);
  assert.deepEqual(bare.commands.list(), []);
  assert.equal(code(() => bare.commands.execute('view.top')), 'NOT_FOUND');
});
