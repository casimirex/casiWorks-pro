// CasiWorks Pro - Global variables and equations
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExpression, evaluateVariables, isPlainNumber, parseExpression } from '../src/features/equations.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import type { ExtrudeFeature, LinearPatternFeature } from '../src/types/cad.ts';

test('Expressions: arithmetic, precedence, functions in degrees, variables; errors are readable', () => {
  assert.equal(evaluateExpression('2 + 3 * 4'), 14);
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateExpression('-2 ^ 2'), -4, 'power binds tighter than unary minus');
  assert.equal(evaluateExpression('2 ^ 3 ^ 2'), 512, 'right-associative');
  assert.equal(evaluateExpression('= 10 / 4'), 2.5, 'a leading = is allowed');
  assert.ok(Math.abs(evaluateExpression('sin(30)') - 0.5) < 1e-12, 'degrees');
  assert.equal(evaluateExpression('max(3, wall * 2, 1)', { wall: 4 }), 8);
  assert.ok(Math.abs(evaluateExpression('pi * r^2', { r: 2 }) - 4 * Math.PI) < 1e-12);
  assert.equal(evaluateExpression('1.5e2'), 150);
  assert.deepEqual([...parseExpression('a + b * sqrt(c)').names], ['a', 'b', 'c']);
  for (const [src, msg] of [['2 +', /end of expression/], ['wall', /Unknown variable "wall"/], ['foo(2)', /Unknown function/], ['1 / 0', /Division by zero/],
    ['sqrt(1, 2)', /takes 1 argument/], ['2 $ 3', /Unexpected "\$"/], ['(1 + 2', /Expected "\)"/], ['', /Empty/]] as const) {
    assert.throws(() => evaluateExpression(src), msg, src);
  }
  assert.ok(isPlainNumber(' -12.5 ') && !isPlainNumber('wall') && !isPlainNumber('2*3'));
});

test('Variables: evaluated in dependency order; cycles, unknown names, bad and duplicate names reported per variable', () => {
  const ok = evaluateVariables([{ name: 'depth', expression: 'wall * 8' }, { name: 'wall', expression: '3' }, { name: 'hole', expression: 'depth / 2 + 1' }]);
  assert.deepEqual(ok.values, { wall: 3, depth: 24, hole: 13 });
  assert.deepEqual(ok.errors, {});
  const bad = evaluateVariables([
    { name: 'a', expression: 'b + 1' }, { name: 'b', expression: 'a * 2' },
    { name: 'c', expression: 'nope' }, { name: '2x', expression: '1' }, { name: 'pi', expression: '3' },
    { name: 'd', expression: '1' }, { name: 'd', expression: '2' }, { name: 'e', expression: '5' },
  ]);
  assert.match(bad.errors.a, /Circular: a → b → a/);
  assert.match(bad.errors.b, /Circular/);
  assert.match(bad.errors.c, /Unknown variable "nope"/);
  assert.match(bad.errors['2x'], /not a valid name/);
  assert.match(bad.errors.pi, /built-in/);
  assert.match(bad.errors.d, /defined twice/);
  assert.deepEqual(bad.values, { e: 5 }, 'the good one still evaluates');
});

test('Equations drive feature parameters: create, change a variable, undo, save and load', () => {
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  r.execute('equations.set', { variables: [{ name: 'wall', expression: '3' }, { name: 'depth', expression: 'wall * 8' }] });
  const { sketchId } = r.execute('sketch.create', { plane: 'Front', entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 40, y: 20 } }] }) as { sketchId: string };
  const { featureId } = r.execute('feature.create', { type: 'extrude_boss', sketchId, depth: 1, expressions: { depth: 'depth + 1' } }) as { featureId: string };
  const ext = () => s().features.find(f => f.id === featureId) as ExtrudeFeature;
  assert.equal(ext().depth, 25, 'the expression wins over the number given');
  const { featureId: pat } = r.execute('feature.create', { type: 'linear_pattern', count: 2, spacing: 50, directionX: 1, directionY: 0, directionZ: 0, expressions: { count: 'depth / 7' } }) as { featureId: string };
  assert.equal((s().features.find(f => f.id === pat) as LinearPatternFeature).count, 3, 'counts are rounded (24/7 = 3.43)');

  r.execute('equations.set', { variables: [{ name: 'wall', expression: '5' }, { name: 'depth', expression: 'wall * 8' }] });
  assert.equal(ext().depth, 41, 'a variable change flows to the feature');
  assert.equal(s().needsRebuild, true);
  s().undo();
  assert.equal(ext().depth, 25, 'undo restores variables and values together');
  assert.equal(s().variables[0].expression, '3');
  s().redo();
  assert.equal(ext().depth, 41);

  const list = r.execute('equations.list') as { variables: Array<{ name: string; value: number }>; links: Array<{ parameter: string; value: number }> };
  assert.deepEqual(list.variables.map(v => [v.name, v.value]), [['wall', 5], ['depth', 40]]);
  assert.deepEqual(list.links.map(l => [l.parameter, l.value]), [['depth', 41], ['count', 6]]);

  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string; message: string }).code + ': ' + (e as Error).message; } return null; };
  assert.match(code(() => r.execute('equations.set', { variables: [{ name: 'a', expression: 'a + 1' }] }))!, /INVALID_ARGUMENT: a: Circular/);
  assert.match(code(() => r.execute('feature.update', { id: featureId, changes: { expressions: { depth: 'missing * 2' } } }))!, /INVALID_ARGUMENT: depth = missing \* 2: Unknown variable "missing"/);
  assert.equal(s().variables.length, 2, 'a refused set changes nothing');

  const saved = s().saveProject();
  assert.deepEqual(JSON.parse(saved).variables, [{ name: 'wall', expression: '5' }, { name: 'depth', expression: 'wall * 8' }]);
  s().newProject();
  assert.deepEqual(s().variables, []);
  s().loadProject(saved);
  assert.equal((s().features.find(f => f.id === featureId) as ExtrudeFeature).depth, 41);
  assert.equal(s().variables.length, 2);

  // Unlinking: an empty expressions object leaves the number alone
  r.execute('feature.update', { id: featureId, changes: { depth: 12, expressions: {} } });
  r.execute('equations.set', { variables: [{ name: 'wall', expression: '1' }, { name: 'depth', expression: 'wall * 8' }] });
  assert.equal((s().features.find(f => f.id === featureId) as ExtrudeFeature).depth, 12);
  s().newProject();
});

test('Equations reach grouped parameters: a hole position linked with position.x / position.y', () => {
  const r = createCommandRegistry(useCADStore);
  const s = useCADStore.getState;
  s().newProject();
  r.execute('equations.set', { variables: [{ name: 'pitch', expression: '20' }] });
  const { featureId } = r.execute('feature.create', {
    type: 'hole', diameter: 6, depth: 10, holeType: 'simple', position: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
    expressions: { 'position.x': 'pitch / 2', 'position.y': '-pitch', diameter: 'pitch / 4' },
  }) as { featureId: string };
  const hole = () => s().features.find(f => f.id === featureId) as unknown as { position: { x: number; y: number; z: number }; diameter: number };
  assert.deepEqual(hole().position, { x: 10, y: -20, z: 0 });
  assert.equal(hole().diameter, 5);
  r.execute('equations.set', { variables: [{ name: 'pitch', expression: '30' }] });
  assert.deepEqual(hole().position, { x: 15, y: -30, z: 0 }, 'z untouched');
  const links = (r.execute('equations.list') as { links: Array<{ parameter: string; value: number }> }).links;
  assert.deepEqual(links.map(l => [l.parameter, l.value]), [['position.x', 15], ['position.y', -30], ['diameter', 7.5]]);
  s().newProject();
});
