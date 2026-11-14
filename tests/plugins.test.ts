// CasiWorks Pro - Plugins (add-ins)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { PluginManager, apiVersionSatisfies } from '../src/plugins/PluginManager.ts';
import type { CasiWorksPlugin } from '../src/plugins/PluginManager.ts';
import { createCasiWorksAPI, CasiWorksAPIError } from '../src/api/CasiWorksAPI.ts';
import type { CasiWorksAPI } from '../src/api/CasiWorksAPI.ts';

const WASHER = pathToFileURL('public/plugins/washer.js').href;

function setup() {
  const registry = createCommandRegistry(useCADStore);
  const self: { api?: CasiWorksAPI } = {};
  const manager = new PluginManager(registry, () => self.api!);
  self.api = createCasiWorksAPI(useCADStore, { commands: registry, plugins: manager });
  return { registry, manager, api: self.api };
}

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { assert.ok(e instanceof CasiWorksAPIError, String(e)); return e.code; }
  return null;
};

test('Plugin API versions: same major, at least the required minor', () => {
  assert.ok(apiVersionSatisfies('1.4', '1.4.0'));
  assert.ok(apiVersionSatisfies('1.2', '1.4.0'));
  assert.ok(apiVersionSatisfies('1.4.1', '1.4.3'));
  assert.ok(!apiVersionSatisfies('1.5', '1.4.0'));
  assert.ok(!apiVersionSatisfies('2.0', '1.4.0'));
  assert.ok(!apiVersionSatisfies('0.9', '1.4.0'));
  assert.ok(!apiVersionSatisfies('one', '1.4.0'));
});

test('The example washer add-in loads from its URL, adds a command and buttons, and builds a washer', async () => {
  const { api, manager, registry } = setup();
  const info = await api.plugins.load(WASHER);
  assert.deepEqual([info.id, info.name, info.commands], ['washer', 'Washer generator', ['washer.create']]);
  assert.deepEqual(manager.buttons().map(b => [b.commandId, b.label]), [['washer.create', 'M8'], ['washer.create', 'M12']]);
  assert.equal(registry.list().find(c => c.id === 'washer.create')!.category, 'Washer generator');

  api.document.new();
  const created = api.commands.execute('washer.create', { size: 'M8' }) as { featureId: string };
  assert.equal(api.features.get(created.featureId).name, 'Washer M8');
  const v = api.model.massProperties()!.volume;
  const exact = Math.PI * (8 ** 2 - 4.2 ** 2) * 1.6;
  assert.ok(Math.abs(v - exact) / exact < 0.01, `washer volume ${v} vs ${exact}`);

  assert.equal(await code(Promise.resolve().then(() => api.commands.execute('washer.create', { size: 'M99' }))), 'OPERATION_FAILED');

  api.plugins.unload('washer');
  assert.equal(registry.has('washer.create'), false, 'commands removed on unload');
  assert.deepEqual(manager.buttons(), []);
  assert.deepEqual(api.plugins.list(), []);
  assert.equal(await code(Promise.resolve().then(() => api.plugins.unload('washer'))), 'NOT_FOUND');
});

const plugin = (extra: Partial<CasiWorksPlugin> = {}): CasiWorksPlugin => ({
  id: 'demo', name: 'Demo', version: '0.1.0', apiVersion: '1.4',
  commands: [{ name: 'hello', label: 'Hello', run: () => 'hi' }],
  buttons: [{ command: 'hello', label: 'Hello' }],
  ...extra,
});

test('Plugins are refused when invalid, incompatible or conflicting', async () => {
  const { api, registry } = setup();
  assert.equal(await code(api.plugins.load({ id: 'Bad Id' })), 'INVALID_ARGUMENT');
  assert.equal(await code(api.plugins.load(plugin({ apiVersion: '2.0' }))), 'OPERATION_FAILED');
  assert.equal(await code(api.plugins.load(plugin({ id: 'file' }))), 'OPERATION_FAILED', 'built-in namespaces are reserved');
  assert.equal(await code(api.plugins.load(plugin({ commands: [{ name: 'save', label: 'S', shortcuts: ['Ctrl+S'], run: () => 0 }], buttons: [] }))), 'OPERATION_FAILED', 'Ctrl+S is taken');
  assert.equal(registry.has('demo.save'), false, 'nothing left behind by a refused plugin');
  assert.equal(await code(api.plugins.load(plugin({ buttons: [{ command: 'missing', label: 'X' }] }))), 'INVALID_ARGUMENT');
  assert.equal(registry.has('demo.hello'), false);

  await api.plugins.load(plugin());
  assert.equal(await code(api.plugins.load(plugin())), 'OPERATION_FAILED', 'already loaded');
  assert.equal(api.commands.execute('demo.hello'), 'hi');
});

test('A plugin that fails to start is rolled back; its event listeners go when it is unloaded', async () => {
  const { api, manager, registry } = setup();
  const failing = plugin({ activate() { throw new Error('boom'); } });
  assert.equal(await code(api.plugins.load(failing)), 'OPERATION_FAILED');
  assert.equal(registry.has('demo.hello'), false);
  assert.deepEqual(manager.buttons(), []);

  const seen: string[] = [];
  let deactivated = false;
  await api.plugins.load(plugin({
    activate(host) {
      host.on('selectionChanged', (e) => seen.push(e.ids.join()));
      host.registerCommand({ name: 'later', label: 'Added at run time', run: () => 'later' });
      host.addButton({ command: 'later', label: 'Later' });
    },
    deactivate() { deactivated = true; },
  }));
  assert.equal(api.commands.execute('demo.later'), 'later');
  assert.equal(manager.buttons().length, 2);
  useCADStore.getState().setSelection([{ id: 'x' }]);
  api.plugins.unload('demo');
  useCADStore.getState().setSelection([{ id: 'y' }]);
  useCADStore.getState().clearSelection();
  assert.deepEqual(seen, ['x'], 'listener removed on unload');
  assert.ok(deactivated);
  assert.equal(registry.has('demo.later'), false);
});
