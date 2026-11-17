// CasiWorks Pro - Reference coordinate systems
import test from 'node:test';
import assert from 'node:assert/strict';

import { coordinateFrame, fromFrame, massPropertiesIn, toFrame } from '../src/features/coordinateSystems.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCasiWorksAPI } from '../src/api/CasiWorksAPI.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import type { MassProperties } from '../src/types/cad.ts';

const near = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const nearPoint = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tol: number, msg: string) => {
  near(a.x, b.x, tol, `${msg} x`); near(a.y, b.y, tol, `${msg} y`); near(a.z, b.z, tol, `${msg} z`);
};

test('Frames: rotations about model X, then Y, then Z; to and from frame coordinates', () => {
  const f = coordinateFrame({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 90 });
  nearPoint(f.x, { x: 0, y: 1, z: 0 }, 1e-12, 'X axis turned to model Y');
  nearPoint(f.y, { x: -1, y: 0, z: 0 }, 1e-12, 'Y axis turned to model −X');
  nearPoint(f.z, { x: 0, y: 0, z: 1 }, 1e-12, 'Z stays');
  nearPoint(toFrame(f, { x: 10, y: 5, z: 0 }), { x: 5, y: 0, z: 0 }, 1e-12, 'a point along the new X');
  // Order: X first, then Y. Turning X by 90 sends Y to Z; then Y by 90 sends that Z to X
  const g = coordinateFrame({ x: 0, y: 0, z: 0 }, { x: 90, y: 90, z: 0 });
  nearPoint(g.y, { x: 1, y: 0, z: 0 }, 1e-12, 'X then Y');
  // Orthonormal and right-handed, and the round trip is exact
  const h = coordinateFrame({ x: 3, y: -7, z: 11 }, { x: 17, y: -40, z: 123 });
  const dot = (a: typeof h.x, b: typeof h.x) => a.x * b.x + a.y * b.y + a.z * b.z;
  near(dot(h.x, h.y), 0, 1e-12, 'x·y'); near(dot(h.y, h.z), 0, 1e-12, 'y·z'); near(dot(h.x, h.x), 1, 1e-12, '|x|');
  const cross = { x: h.x.y * h.y.z - h.x.z * h.y.y, y: h.x.z * h.y.x - h.x.x * h.y.z, z: h.x.x * h.y.y - h.x.y * h.y.x };
  nearPoint(cross, h.z, 1e-12, 'x × y = z');
  const p = { x: 4, y: 5, z: -6 };
  nearPoint(fromFrame(h, toFrame(h, p)), p, 1e-12, 'round trip');
});

test('Mass properties in a coordinate system: centre of mass moved, inertia turned and shifted', () => {
  // A 100 × 20 × 10 mm block centred at (50, 10, 5), 1 kg; box inertia about its centre
  const m = 1, a = 100, b = 20, c = 10;
  const atCom = { Ixx: m * (b * b + c * c) / 12, Iyy: m * (a * a + c * c) / 12, Izz: m * (a * a + b * b) / 12, Ixy: 0, Ixz: 0, Iyz: 0 };
  const mp = { volume: 20000, surfaceArea: 0, mass: m, density: 0, centerOfMass: { x: 50, y: 10, z: 5 }, momentOfInertia: atCom, momentOfInertiaAtOrigin: atCom } as unknown as MassProperties;
  // A frame at the block's centre, turned 90° about Z: its X runs along the block's 20 mm side
  const at = massPropertiesIn(mp, coordinateFrame({ x: 50, y: 10, z: 5 }, { x: 0, y: 0, z: 90 }));
  nearPoint(at.centerOfMass, { x: 0, y: 0, z: 0 }, 1e-12, 'centre at the origin');
  near(at.momentOfInertia.Ixx, atCom.Iyy, 1e-9, 'Ixx is the old Iyy');
  near(at.momentOfInertia.Iyy, atCom.Ixx, 1e-9, 'Iyy is the old Ixx');
  near(at.momentOfInertia.Izz, atCom.Izz, 1e-9, 'Izz unchanged');
  near(at.momentOfInertiaAtOrigin.Izz, atCom.Izz, 1e-9, 'origin at the centre: same');
  // A frame 30 mm along model X from the centre: parallel axes add m·d²
  const shifted = massPropertiesIn(mp, coordinateFrame({ x: 20, y: 10, z: 5 }));
  nearPoint(shifted.centerOfMass, { x: 30, y: 0, z: 0 }, 1e-12, 'centre 30 mm along X');
  near(shifted.momentOfInertiaAtOrigin.Izz, atCom.Izz + m * 900, 1e-9, 'Izz + m·30²');
  near(shifted.momentOfInertiaAtOrigin.Iyy, atCom.Iyy + m * 900, 1e-9, 'Iyy + m·30²');
  near(shifted.momentOfInertiaAtOrigin.Ixx, atCom.Ixx, 1e-9, 'Ixx: the offset is along X');
  near(shifted.mass, m, 0, 'mass unchanged');
});

test('Coordinate system feature: API, mass properties in it, follows a reference point and equations', () => {
  const s = useCADStore.getState;
  s().newProject();
  const api = createCasiWorksAPI(useCADStore);
  const [major, minor] = api.version.split('.').map(Number);
  assert.ok(major > 1 || minor >= 15);
  const sk = api.sketches.create({ plane: 'Front', entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 100, y: 20 } }] });
  api.features.extrude({ sketchId: sk.sketchId, depth: 10 });
  const plain = api.model.massProperties()!;

  const cs = api.features.coordinateSystem({ origin: { x: 50, y: 10, z: 5 }, rotation: { z: 90 } });
  const info = api.features.list().find(f => f.id === cs)!;
  assert.equal(info.type, 'coordinate_system');
  assert.equal(info.name, 'CS1');
  const inCs = api.model.massProperties({ coordinateSystem: cs })!;
  nearPoint(inCs.centerOfMass, { x: 0, y: 0, z: 0 }, 1e-6, 'block centre at the CS origin');
  near(inCs.momentOfInertia.Ixx, plain.momentOfInertia.Iyy, 1e-6 * plain.momentOfInertia.Iyy, 'turned 90° about Z');
  near(inCs.mass, plain.mass, 0, 'mass');
  assert.throws(() => api.model.massProperties({ coordinateSystem: 'nope' }), /No coordinate system/);

  // At a reference point: moves with it
  const pt = api.features.referencePoint({ x: 0, y: 0, z: 0 });
  const cs2 = api.features.coordinateSystem({ through: pt });
  nearPoint(api.model.massProperties({ coordinateSystem: cs2 })!.centerOfMass, { x: 50, y: 10, z: 5 }, 1e-6, 'at the model origin');
  api.equations.link(pt, 'point.x', '50'); // grouped values change through equations
  nearPoint(api.model.massProperties({ coordinateSystem: cs2 })!.centerOfMass, { x: 0, y: 10, z: 5 }, 1e-6, 'after the point moved');
  assert.throws(() => api.features.coordinateSystem({ through: cs }), /No reference point/);

  // A rotation driven by an equation
  api.equations.set([{ name: 'turn', expression: '45' }]);
  api.equations.link(cs, 'rotation.z', 'turn * 2');
  const turned = api.features.list().find(f => f.id === cs)!.parameters as { rotation: { z: number } };
  assert.equal(turned.rotation.z, 90);

  // The ribbon command opens its panel
  const r = createCommandRegistry(useCADStore);
  r.execute('feature.coordinateSystem');
  assert.equal(s().propertyPanelContent?.type, 'coordinate_system');
  s().closePropertyPanel();
  assert.equal(api.model.errors().length, 0);
  s().newProject();
});
