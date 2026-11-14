// CasiWorks Pro - Scripting console evaluator
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSnippet, formatValue } from '../src/console/evaluate.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  Object.assign(console, { log() {}, info() {}, warn() {}, error() {} });
  try { return await fn(); } finally { Object.assign(console, saved); }
};

test('Console: expressions, statements, await, logs and errors', async () => {
  const run = (code: string, scope = {}) => quietly(() => evaluateSnippet(code, scope));
  assert.equal((await run('1 + 2')).value, '3');
  assert.equal((await run('{ a: 1 }')).value, '{\n  "a": 1\n}', 'a lone object literal is a value, not a block');
  assert.equal((await run('const x = 4;\nx * 2')).value, '8', 'value of the last line, like the browser console');
  assert.equal((await run('const x = 4; x * 3')).value, '12');
  assert.equal((await run('let t = 0;\nfor (let i = 0; i < 3; i++) { t += i; }')).value, 'undefined');
  assert.equal((await run('return 7;')).value, '7');
  assert.equal((await run('await new Promise(r => setTimeout(() => r(5), 1))')).value, '5');

  const logged = await run('console.log("hi", { n: 1 }); console.warn("careful"); 0');
  assert.deepEqual(logged.logs, [{ level: 'log', text: 'hi {\n  "n": 1\n}' }, { level: 'warn', text: 'careful' }]);

  const err = await run('nope()');
  assert.equal(err.ok, false);
  assert.match(err.error!, /ReferenceError: nope is not defined/);
  const syntax = await run('const = 1');
  assert.match(syntax.error!, /SyntaxError/);
});

test('Console: snippets drive the API; API error codes are shown', async () => {
  const registry = createCommandRegistry(useCADStore);
  const api = createCasiWorksAPI(useCADStore, { commands: registry });
  const scope = { api, run: (id: string, args?: unknown) => api.commands.execute(id, args) };
  const result = await quietly(() => evaluateSnippet(`
    api.document.new();
    const s = api.sketches.create({ entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 10 }] });
    api.features.extrude({ sketchId: s.sketchId, depth: 10 });
    Math.round(api.model.massProperties().volume)`, scope));
  assert.equal(result.ok, true, result.error);
  assert.ok(Math.abs(Number(result.value) - Math.PI * 100 * 10) < 0.01 * Math.PI * 1000);

  const bad = await quietly(() => evaluateSnippet(`run('nope.nope')`, scope));
  assert.match(bad.error!, /CasiWorksAPIError \[NOT_FOUND\]: Unknown command/);
});

test('Console: values are formatted readably and safely', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.match(formatValue(cyclic), /\[circular\]/);
  assert.equal(formatValue(new Float32Array(9000)), '"[Float32Array × 9000]"');
  assert.equal(formatValue(function named() {}), 'ƒ named()');
  assert.equal(formatValue('text'), '"text"');
  assert.match(formatValue('x'.repeat(50000), 100), /more characters/);
});
