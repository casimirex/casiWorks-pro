// CasiWorks Pro - Interference detection
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { findInterferences } from '../src/assembly/interference.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';

const near = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const boxAt = (id: string, x: number) => {
  const g = new THREE.BoxGeometry(30, 20, 30);
  g.translate(x, 0, 0);
  return { id, name: id, geometry: g };
};

test('Interference: overlapping boxes report the shared volume; touching or apart do not', () => {
  const found = findInterferences([boxAt('A', 0), boxAt('B', 20), boxAt('C', 50), boxAt('D', 80)]);
  // A (−15..15) and B (5..35) share 10 × 20 × 30; B and C touch at x = 35; C and D are apart
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].a, found[0].b], ['A', 'B']);
  near(found[0].volume, 10 * 20 * 30, 1e-6, 'shared volume');
  const box = new THREE.Box3().setFromBufferAttribute(found[0].geometry.getAttribute('position') as THREE.BufferAttribute);
  near(box.min.x, 5, 1e-6, 'overlap from x = 5'); near(box.max.x, 15, 1e-6, 'to x = 15');
  // Largest first
  const two = findInterferences([boxAt('A', 0), boxAt('B', 25), boxAt('C', 10)]);
  assert.ok(two[0].volume >= two[1].volume && two.length === 3);
});

test('Interference in an assembly: a pin through a solid plate; the command shows it and goes stale on change', () => {
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  r.execute('assembly.insertPart', { name: 'Base_Plate', shape: 'box', dims: { width: 50, height: 12, depth: 50 } });
  r.execute('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' });
  type Pairs = { pairs: Array<{ aName: string; bName: string; volume: number }> };
  let res = r.execute('assembly.interference') as Pairs;
  assert.equal(res.pairs.length, 0, 'side by side: no interference');
  assert.match(s().statusMessage, /No interference between 2 components/);

  r.execute('assembly.mate', { type: 'concentric' });
  r.execute('assembly.solve');
  res = r.execute('assembly.interference') as Pairs;
  // The pin (Ø12, 32-gon) passes through the 12 mm plate
  const pinArea = 16 * 36 * Math.sin(Math.PI / 16);
  assert.equal(res.pairs.length, 1);
  assert.deepEqual([res.pairs[0].aName, res.pairs[0].bName], ['Base_Plate', 'Pin_Shaft']);
  near(res.pairs[0].volume, pinArea * 12, 1, 'pin through the plate');
  assert.equal(s().interference!.components, s().assemblyComponents, 'current');
  assert.match(s().statusMessage, /1 interference, [\d.]+ mm³ in all/);

  r.execute('assembly.insertPart', { name: 'Flange_Ring', shape: 'flange' });
  assert.notEqual(s().interference!.components, s().assemblyComponents, 'out of date after a change');
  r.execute('assembly.clearInterference');
  assert.equal(s().interference, null);

  const api = createCasiWorksAPI(useCADStore);
  const pairs = api.assembly.interference();
  assert.ok(pairs.some(p => p.aName === 'Base_Plate' && p.bName === 'Pin_Shaft'));
  r.execute('assembly.clear');
  assert.throws(() => r.execute('assembly.interference'), /at least two/);
  s().newProject();
});
