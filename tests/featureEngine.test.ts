// CasiWorks Pro - Feature engine: midplane and through cuts, rollback, thin features, suppressed and missing sketches
import test from 'node:test';
import assert from 'node:assert/strict';
import { featureEngine } from '../src/features/FeatureEngine.ts';
import { FEATURE_TYPES, SKETCH_ENTITY_TYPES } from '../src/utils/constants.ts';
import type { FeatureData } from '../src/types/cad.ts';

const squareSketch = (half = 10) => [
  { id: 'q1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -half, y: -half }, p2: { x: half, y: -half } },
  { id: 'q2', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: half, y: -half }, p2: { x: half, y: half } },
  { id: 'q3', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: half, y: half }, p2: { x: -half, y: half } },
  { id: 'q4', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -half, y: half }, p2: { x: -half, y: -half } },
];

test('FeatureEngine: extrude boss midplane and through cut', () => {
  const sketchId = 'sk_box_cut';
  const sketchEntities = {
    [sketchId]: [
      { id: 's1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -20, y: -20 }, p2: { x: 20, y: -20 } },
      { id: 's2', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 20, y: -20 }, p2: { x: 20, y: 20 } },
      { id: 's3', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 20, y: 20 }, p2: { x: -20, y: 20 } },
      { id: 's4', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -20, y: 20 }, p2: { x: -20, y: -20 } },
    ],
    'sk_hole': [
      { id: 'c1', type: SKETCH_ENTITY_TYPES.CIRCLE, center: { x: 0, y: 0 }, radius: 8 },
    ],
  };

  const features: FeatureData[] = [
    {
      id: 'f_sk1',
      name: 'Sketch1',
      type: FEATURE_TYPES.SKETCH,
      sketchId: sketchId,
      plane: 'Front',
    },
    {
      id: 'f_ext1',
      name: 'Base-Extrude',
      type: FEATURE_TYPES.EXTRUDE_BOSS,
      sketchId: sketchId,
      depth: 30,
      direction: 'midplane',
      parentIds: ['f_sk1'],
    },
    {
      id: 'f_sk2',
      name: 'Sketch2',
      type: FEATURE_TYPES.SKETCH,
      sketchId: 'sk_hole',
      plane: 'Front',
    },
    {
      id: 'f_cut1',
      name: 'Through-Cut',
      type: FEATURE_TYPES.EXTRUDE_CUT,
      sketchId: 'sk_hole',
      depth: 50,
      direction: 'throughall',
      parentIds: ['f_sk2'],
    },
  ];

  const result = featureEngine.rebuild(features, sketchEntities);
  assert.equal(result.bodies.length, 1, 'Should produce 1 solid body');

  const solid = result.bodies[0];
  solid.computeBoundingBox();
  const box = solid.boundingBox!;

  // Midplane extrude bounds: Z should span roughly -15 to +15
  assert.ok(Math.abs(box.min.z - (-15)) < 1e-2, `Box min.z is ${box.min.z}`);
  assert.ok(Math.abs(box.max.z - 15) < 1e-2, `Box max.z is ${box.max.z}`);

  // Extrude cut creates cylindrical hole: vertex count should exceed standard box (36 vertices)
  const posCount = solid.attributes.position.count;
  assert.ok(posCount > 36, `Position count ${posCount} indicates hole was cut`);
});

test('FeatureEngine: rollback bar stops rebuild at rollbackIndex', () => {
  const sketchId = 'sk_base';
  const sketchEntities = {
    [sketchId]: [
      { id: 's1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -10, y: -10 }, p2: { x: 10, y: -10 } },
      { id: 's2', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 10, y: -10 }, p2: { x: 10, y: 10 } },
      { id: 's3', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 10, y: 10 }, p2: { x: -10, y: 10 } },
      { id: 's4', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -10, y: 10 }, p2: { x: -10, y: -10 } },
    ],
  };

  const features: FeatureData[] = [
    { id: 'f_sk1', name: 'f_sk1', type: FEATURE_TYPES.SKETCH, sketchId, plane: 'Front' },
    { id: 'f_ext1', name: 'f_ext1', type: FEATURE_TYPES.EXTRUDE_BOSS, sketchId, depth: 10 },
    { id: 'f_fillet', name: 'f_fillet', type: FEATURE_TYPES.FILLET, radius: 2 },
  ];

  // Rollback to index 1 (skips fillet at index 2)
  const result = featureEngine.rebuild(features, sketchEntities, 1);
  assert.equal(result.bodies.length, 1);
  assert.equal(result.errors.length, 0);
});

test('FeatureEngine: thin feature creates solid walls from open sketch', () => {
  const sketchId = 'sk_thin_line';
  const sketchEntities = {
    [sketchId]: [
      { id: 'tl1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 } },
    ],
  };

  const features: FeatureData[] = [
    { id: 'f_sk1', name: 'f_sk1', type: FEATURE_TYPES.SKETCH, sketchId, plane: 'Front' },
    {
      id: 'f_thin_ext',
      name: 'Thin-Extrude',
      type: FEATURE_TYPES.EXTRUDE_BOSS,
      sketchId,
      depth: 20,
      thin: true,
      wallThickness: 4,
    },
  ];

  const result = featureEngine.rebuild(features, sketchEntities);
  assert.equal(result.bodies.length, 1);
  const solid = result.bodies[0];
  solid.computeBoundingBox();
  assert.ok(Math.abs(solid.boundingBox!.max.x - solid.boundingBox!.min.x - 50) < 1e-2);
});

test('FeatureEngine regression: suppressed sketch disables consumers; missing sketch is an error, not a substitute', () => {
  const sketchEntities = { a: squareSketch(10), b: squareSketch(30) };
  const suppressed = featureEngine.rebuild([
    { id: 's', name: 'S', type: FEATURE_TYPES.SKETCH, sketchId: 'a', plane: 'Front', suppressed: true },
    { id: 'e', name: 'E', type: FEATURE_TYPES.EXTRUDE_BOSS, sketchId: 'a', depth: 5 },
  ], sketchEntities);
  assert.equal(suppressed.bodies.length, 0);

  const missing = featureEngine.rebuild([
    { id: 'e', name: 'Boss', type: FEATURE_TYPES.EXTRUDE_BOSS, sketchId: 'deleted', depth: 5 },
  ], sketchEntities);
  assert.equal(missing.bodies.length, 0, 'must not fall back to an unrelated sketch');
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0].error, /no longer exists/);
});
