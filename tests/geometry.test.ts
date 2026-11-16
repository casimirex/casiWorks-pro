// CasiWorks Pro - Geometry engine regression tests (volumes, orientation, closedness)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { geometryEngine as G } from '../src/kernel/GeometryEngine.ts';
import type { ProfileEntity } from '../src/kernel/GeometryEngine.ts';
import { featureEngine } from '../src/features/FeatureEngine.ts';
import type { FeatureData } from '../src/types/cad.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';

// ------------------------------------------------------------------ helpers
const L = (x1: number, y1: number, x2: number, y2: number, construction = false): ProfileEntity =>
  ({ type: 'line', p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, construction });
const rect = (w: number, h: number, cx = 0, cy = 0): ProfileEntity[] => [
  L(cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2),
  L(cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2),
  L(cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2),
  L(cx - w / 2, cy + h / 2, cx - w / 2, cy - h / 2),
];
const circle = (x: number, y: number, r: number, construction = false): ProfileEntity =>
  ({ type: 'circle', center: { x, y }, radius: r, construction });

function signedVolume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    a.fromBufferAttribute(p, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(p, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(p, idx ? idx.getX(i + 2) : i + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return v;
}

/** Closed 2-manifold check: after welding, every undirected edge belongs to exactly two triangles. */
function isClosedMesh(g: THREE.BufferGeometry): boolean {
  const p = g.getAttribute('position');
  const idx = g.index;
  // Round to 1e-4 mm; "+ 0" turns -0 into 0 so seam vertices (e.g. sin 2π ≈ -2e-16) weld
  const q = (v: number) => (Math.round(v * 1e4) / 1e4 + 0).toFixed(4);
  const key = (i: number) => `${q(p.getX(i))},${q(p.getY(i))},${q(p.getZ(i))}`;
  const vertex = (t: number) => (idx ? idx.getX(t) : t);
  const n = idx ? idx.count : p.count;
  const edges = new Map<string, number>();
  for (let i = 0; i + 2 < n; i += 3) {
    const v = [key(vertex(i)), key(vertex(i + 1)), key(vertex(i + 2))];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue; // degenerate sliver
    for (let k = 0; k < 3; k++) {
      const e = [v[k], v[(k + 1) % 3]].sort().join('|');
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  return [...edges.values()].every(n => n === 2);
}

const bounds = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!;
};
const near = (actual: number, expected: number, relTol: number, msg: string) =>
  assert.ok(Math.abs(actual - expected) <= relTol * Math.abs(expected), `${msg}: got ${actual}, expected ${expected} ±${relTol * 100}%`);
const extrude = (entities: ProfileEntity[], depth: number, options = {}) =>
  G.extrudeProfile(G.shapesFromSketchEntities(entities), depth, 'Front', options);

// ------------------------------------------------------------------ profiles
test('Profiles: every closed region is used (two separate circles = two cylinders)', () => {
  near(signedVolume(extrude([circle(-10, 0, 3), circle(10, 0, 3)], 10)), 2 * Math.PI * 9 * 10, 0.005, 'two cylinders');
});

test('Profiles: line direction does not matter; arcs run counter-clockwise across 0°', () => {
  const mixed = [L(-10, -5, 10, -5), L(10, 5, 10, -5) /* drawn backwards */, L(10, 5, -10, 5), L(-10, 5, -10, -5)];
  near(signedVolume(extrude(mixed, 10)), 2000, 1e-9, 'rectangle with a reversed edge');

  // CCW from 270° to 90° is the RIGHT half-disc (x ≥ 0)
  const halfDisc: ProfileEntity[] = [
    { type: 'arc', center: { x: 0, y: 0 }, radius: 5, startAngle: 1.5 * Math.PI, endAngle: 0.5 * Math.PI },
    L(0, 5, 0, -5),
  ];
  const g = extrude(halfDisc, 10);
  near(signedVolume(g), (Math.PI * 25) / 2 * 10, 0.005, 'half-disc volume');
  assert.ok(bounds(g).min.x > -1e-6 && bounds(g).max.x > 4.9, 'half-disc lies on the +X side');
});

test('Profiles: nesting by containment, regardless of drawing order; overlapping regions are unioned', () => {
  const innerFirst = [...rect(4, 4), ...rect(20, 10)];
  near(signedVolume(extrude(innerFirst, 10)), (200 - 16) * 10, 1e-9, 'rectangle with a square hole');

  // Island inside a hole inside a solid
  const island = [...rect(30, 30), ...rect(20, 20), ...rect(10, 10)];
  near(signedVolume(extrude(island, 1)), 900 - 400 + 100, 1e-9, 'solid/hole/island');

  // Keyed bore: a circle plus a keyway whose ends sit on the circle (overlapping loops)
  const keyed = [circle(0, 0, 12), L(-2.5, 11.7, -2.5, 15), L(-2.5, 15, 2.5, 15), L(2.5, 15, 2.5, 11.7)];
  const keywayOutside = 5 * 15 - 2 * (2.5 * Math.sqrt(144 - 6.25) / 2 + 72 * Math.asin(2.5 / 12)); // rect area above the circle
  const g = extrude(keyed, 10);
  near(signedVolume(g), (Math.PI * 144 + keywayOutside) * 10, 0.01, 'circle ∪ keyway');
});

test('Profiles: construction geometry never becomes part of a solid', () => {
  const sketch = [...rect(20, 10), circle(0, 0, 3, true), L(-10, -5, 10, 5, true)];
  near(signedVolume(extrude(sketch, 10)), 2000, 1e-9, 'construction circle is not a hole');
});

// ------------------------------------------------------------------ operations
test('Extrude: flip puts the solid on the other side of the sketch plane, outward-facing', () => {
  const g = extrude(rect(20, 10), 10, { flip: true });
  near(signedVolume(g), 2000, 1e-9, 'positive volume (not inside-out)');
  assert.ok(Math.abs(bounds(g).min.z + 10) < 1e-6 && Math.abs(bounds(g).max.z) < 1e-6, 'z in [-10, 0]');
});

test('Revolve: either profile direction gives an outward solid; partial revolves are capped and closed', () => {
  const ccw = [L(10, 0, 20, 0), L(20, 0, 20, 10), L(20, 10, 10, 10), L(10, 10, 10, 0)];
  const cw = [L(10, 0, 10, 10), L(10, 10, 20, 10), L(20, 10, 20, 0), L(20, 0, 10, 0)];
  const ring = Math.PI * (400 - 100) * 10;
  for (const [name, profile] of [['ccw', ccw], ['cw', cw]] as const) {
    const full = G.revolveProfile(G.shapeFromSketchEntities(profile));
    near(signedVolume(full), ring, 0.005, `${name} full revolve`);
    assert.ok(isClosedMesh(full), `${name} full revolve is closed`);
    const half = G.revolveProfile(G.shapeFromSketchEntities(profile), null, Math.PI);
    near(signedVolume(half), ring / 2, 0.005, `${name} 180° revolve`);
    assert.ok(isClosedMesh(half), `${name} 180° revolve is capped (closed)`);
  }
});

test('Loft: honours height, closes the seam and caps both ends', () => {
  const square = G.shapeFromSketchEntities(rect(20, 20));
  const prism = G.loftProfiles([square, square], { height: 40 });
  near(signedVolume(prism), 16000, 1e-6, 'prism volume');
  assert.ok(Math.abs(bounds(prism).max.z - 40) < 1e-6, 'height 40');
  assert.ok(isClosedMesh(prism), 'closed solid');

  // Square 20 → circle r 10 over 30: positive volume between the two cross-sections
  const frustum = G.loftProfiles([square, G.shapeFromSketchEntities([circle(0, 0, 10)])], { height: 30 });
  const v = signedVolume(frustum);
  assert.ok(v > Math.PI * 100 * 30 && v < 400 * 30, `square→circle loft volume ${v} lies between the two prisms`);
});

test('Mirror: plane names map to the right planes and the halves are unioned', () => {
  const body = extrude([L(0, 5, 10, 5), L(10, 5, 10, 15), L(10, 15, 0, 15), L(0, 15, 0, 5)], 5);
  const top = G.mirrorGeometry(body, 'Top');
  assert.ok(Math.abs(bounds(top).min.y + 15) < 1e-6, 'Top mirrors across XZ (y → −y)');
  const front = G.mirrorGeometry(body, 'Front');
  assert.ok(Math.abs(bounds(front).min.z + 5) < 1e-6, 'Front mirrors across XY (z → −z)');
  // A body crossing the mirror plane is not doubled
  const crossing = extrude(rect(10, 10), 4);
  near(signedVolume(G.mirrorGeometry(crossing, 'Right')), 400, 1e-6, 'symmetric body mirrored onto itself');
});

test('Patterns: overlapping instances are unioned; partial circular patterns end at the given angle', () => {
  const box = extrude(rect(20, 20), 20);
  near(signedVolume(G.linearPattern(box, new THREE.Vector3(1, 0, 0), 3, 10)), 16000, 1e-6, 'overlapping linear pattern');

  const tab = extrude(rect(2, 2, 11, 0), 2);
  const pattern = G.circularPattern(tab, new THREE.Vector3(0, 0, 1), 3, Math.PI);
  assert.ok(Math.abs(bounds(pattern).min.x + 12) < 1e-4, '3 instances over 180° reach the far side (0°, 90°, 180°)');
});

// ------------------------------------------------------------------ feature engine
test('Features: loft and sweep report missing input instead of inventing geometry', () => {
  const loft = featureEngine.rebuild([{ id: 'l', name: 'Loft', type: 'loft_boss', profiles: [] }], {});
  assert.equal(loft.bodies.length, 0);
  assert.match(loft.errors[0].error, /Loft needs at least 2 profile sketches/);

  const sweep = featureEngine.rebuild([
    { id: 's', name: 'S', type: 'sketch', sketchId: 'k', plane: 'Front' },
    { id: 'w', name: 'Sweep', type: 'sweep_boss', sketchId: 'k' },
  ], { k: [circle(0, 0, 2) as never] });
  assert.equal(sweep.bodies.length, 0);
  assert.match(sweep.errors[0].error, /Sweep needs a path/);
});

const NOT_APPLIED = /not applied: the mesh kernel cannot .*; .* instead/;

test('Fillet, chamfer and shell report a warning and leave the model unchanged', () => {
  const base: FeatureData[] = [
    { id: 's', name: 'S', type: 'sketch', sketchId: 'k', plane: 'Front' },
    { id: 'e', name: 'Boss', type: 'extrude_boss', sketchId: 'k', depth: 20 },
  ];
  const sketch = { k: rect(20, 20) as never[] };
  const finishes: FeatureData[] = [
    { id: 'f', name: 'Fillet1', type: 'fillet', radius: 2 },
    { id: 'c', name: 'Chamfer1', type: 'chamfer', distance: 2 },
    { id: 'h', name: 'Shell1', type: 'shell', thickness: 2 },
  ];
  for (const finish of finishes) {
    const result = featureEngine.rebuild([...base, finish], sketch);
    assert.equal(result.errors.length, 1, finish.type);
    assert.equal(result.errors[0].featureId, finish.id);
    assert.match(result.errors[0].error, NOT_APPLIED);
    near(signedVolume(result.bodies[0]), 8000, 1e-9, `${finish.type} leaves the body unchanged`);
  }
});

test('Examples: all built-in models rebuild (only "not applied" warnings); hex bolt matches its exact volume', () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const ex of CAD_EXAMPLES) {
      useCADStore.getState().loadExampleModel(ex.create());
      const result = rebuildModel(useCADStore);
      const unexpected = result.errors.filter(e => !NOT_APPLIED.test(e.error));
      assert.equal(unexpected.length, 0, `${ex.id}: ${JSON.stringify(unexpected)}`);
      assert.equal(result.bodyCount, 1, `${ex.id} has a body`);
      if (ex.id === 'hex_bolt') {
        // Hexagonal head (circumradius 13, 8 thick) ∪ shank (r 6, 50 long), both from z = 0
        const exact = (3 * Math.sqrt(3) / 2) * 169 * 8 + Math.PI * 36 * 42;
        near(signedVolume(useCADStore.getState().bodies[0].geometry), exact, 0.005, 'hex bolt volume');
      }
    }
  } finally {
    console.warn = realWarn;
  }
});

// ------------------------------------------------------------------ feature placement
const featureSketches = { a: rect(40, 40) as never[], b: rect(10, 20, 10, 10) as never[] };
const sketchF = (id: string, plane: 'Front' | 'Top' | 'Right' = 'Front'): FeatureData => ({ id: `s${id}`, name: 'S', type: 'sketch', sketchId: id, plane });
const build = (features: FeatureData[]) => {
  const r = featureEngine.rebuild(features, featureSketches);
  assert.deepEqual(r.errors, []);
  return r.bodies[0];
};
const expectBox = (g: THREE.BufferGeometry, min: number[], max: number[], msg: string) => {
  const b = bounds(g);
  [...b.min.toArray(), ...b.max.toArray()].forEach((v, i) => assert.ok(Math.abs(v - [...min, ...max][i]) < 1e-3, `${msg}: ${b.min.toArray()} .. ${b.max.toArray()}`));
};

test('Hole feature drills its full depth from the entry point, counterbore at the entry', () => {
  const block: FeatureData[] = [sketchF('a'), { id: 'e', name: 'E', type: 'extrude_boss', sketchId: 'a', depth: 30 }];
  const faceted = (r: number, h: number) => 16 * Math.sin(Math.PI / 16) * r * r * h; // 32-sided prism
  const plain = build([...block, { id: 'h', name: 'H', type: 'hole', diameter: 10, depth: 20 }]);
  near(48000 - signedVolume(plain), faceted(5, 20), 1e-3, 'removed volume of a Ø10 × 20 hole (was half of it)');

  // Drilled down from the top face: counterbore Ø18 × 5 must be at z = 25..30
  const cb = build([...block, { id: 'h', name: 'H', type: 'hole', diameter: 10, depth: 20, holeType: 'counterbore', position: { x: 0, y: 0, z: 30 }, axis: { x: 0, y: 0, z: -1 } }]);
  near(48000 - signedVolume(cb), faceted(5, 15) + faceted(9, 5), 1e-3, 'removed volume of the counterbored hole');
  const p = cb.attributes.position;
  // Vertices inside the block (the boolean also splits the outer faces at z = 0 and 30)
  const inner = Array.from({ length: p.count }, (_, i) => i).filter(i => p.getZ(i) > 1e-3 && p.getZ(i) < 30 - 1e-3);
  const z = (r: number) => inner.filter(i => Math.abs(Math.hypot(p.getX(i), p.getY(i)) - r) < 0.05).map(i => p.getZ(i));
  assert.ok(z(9).length > 0 && Math.min(...z(9)) > 24.999, `counterbore at the entry (z 25..30), found z ${Math.min(...z(9))}`);
  assert.ok(Math.abs(Math.min(...z(5)) - 10) < 1e-3, 'hole bottom at z = 10');
});

test('Patterns keep zero vector components: along Y means along Y, about Z means about Z', () => {
  const part: FeatureData[] = [sketchF('b'), { id: 'e', name: 'E', type: 'extrude_boss', sketchId: 'b', depth: 5 }];
  expectBox(build([...part, { id: 'p', name: 'P', type: 'linear_pattern', count: 2, spacing: 50, directionY: 1 }]), [5, 0, 0], [15, 70, 5], 'linear pattern along +Y');
  expectBox(build([...part, { id: 'p', name: 'P', type: 'circular_pattern', count: 2, angle: 180, axisZ: 1 }]), [-15, -20, 0], [15, 20, 5], 'circular pattern about Z');
  const zero = featureEngine.rebuild([...part, { id: 'p', name: 'P', type: 'linear_pattern', count: 2, spacing: 50, directionX: 0, directionY: 0, directionZ: 0 }], featureSketches);
  assert.match(zero.errors[0].error, /zero vector/);
});

test('Revolve follows its sketch plane and starts at the sketch', () => {
  // Top plane: sketch y runs along world −Z, so the revolve axis is Z
  const top = build([sketchF('b', 'Top'), { id: 'r', name: 'R', type: 'revolve_boss', sketchId: 'b', angle: 360 }]);
  expectBox(top, [-15, -15, -20], [15, 15, 0], 'revolve of a Top sketch');
  // A quarter revolve sweeps right-handed about +Y from the sketch (+X) towards −Z
  const quarter = build([sketchF('b'), { id: 'r', name: 'R', type: 'revolve_boss', sketchId: 'b', angle: 90 }]);
  expectBox(quarter, [0, 0, -15], [15, 20, 0], 'quarter revolve of a Front sketch');
  assert.ok(isClosedMesh(quarter) && signedVolume(quarter) > 0);
});
