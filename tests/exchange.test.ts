// CasiWorks Pro - Data exchange tests.
// STEP and IGES files are checked against the structure their standards require
// using small parsers written here (independent of ImportEngine), then round-tripped.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { exportEngine as E, weldMesh } from '../src/kernel/ExportEngine.ts';
import { importEngine as I } from '../src/kernel/ImportEngine.ts';
import { geometryEngine as G } from '../src/kernel/GeometryEngine.ts';
import { MaterialLibrary } from '../src/kernel/MaterialLibrary.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';

const volume = (g: THREE.BufferGeometry) => G.computeMassProperties(g, { density: 1000 })!.volume;

function exampleGeometry(id: string): THREE.BufferGeometry {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    useCADStore.getState().loadExampleModel(CAD_EXAMPLES.find(e => e.id === id)!.create());
    rebuildModel(useCADStore);
    return useCADStore.getState().bodies[0].geometry.clone();
  } finally {
    console.warn = realWarn;
  }
}

// ------------------------------------------------------------------ STEP (ISO 10303-21)
interface StepEntity { type: string; args: string }

function parseStep(text: string): Map<number, StepEntity> {
  const data = text.slice(text.indexOf('DATA;') + 5, text.lastIndexOf('ENDSEC;'));
  const entities = new Map<number, StepEntity>();
  for (const stmt of data.split(/;\s*\n/)) {
    const m = stmt.trim().match(/^#(\d+)=(\(?)([A-Z_0-9]*)\(?([\s\S]*)$/);
    if (m) entities.set(Number(m[1]), { type: m[2] ? 'COMPLEX' : m[3], args: m[4] });
  }
  return entities;
}
const refs = (args: string) => [...args.matchAll(/#(\d+)/g)].map(m => Number(m[1]));

test('STEP: every face is exported (no truncation), as a faceted B-rep over shared points', async () => {
  const g = exampleGeometry('piston_head'); // > 11,000 triangles; the old writer kept 1,200
  const { points, triangles } = weldMesh(g);
  const text = await E.exportSTEP(g, 'Piston').text();
  const ents = parseStep(text);
  const count = (type: string) => [...ents.values()].filter(e => e.type === type).length;

  assert.equal(count('FACE'), triangles.length, 'one FACE per triangle');
  assert.equal(count('POLY_LOOP'), triangles.length);
  assert.equal(count('CARTESIAN_POINT'), points.length + 1, 'shared points (+ the origin)');
  assert.equal(count('FACETED_BREP'), 1);
  assert.equal(count('FACETED_BREP_SHAPE_REPRESENTATION'), 1);
  assert.match(text, /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN/);
});

test('STEP: every reference resolves to the entity type the schema requires', async () => {
  const text = await E.exportSTEP(exampleGeometry('l_bracket'), 'Bracket').text();
  const ents = parseStep(text);
  const typeOf = (id: number) => ents.get(id)?.type;
  for (const [id, e] of ents) {
    for (const r of refs(e.args)) assert.ok(ents.has(r), `#${id} ${e.type} references missing #${r}`);
    if (e.type === 'FACE') assert.equal(typeOf(refs(e.args)[0]), 'FACE_OUTER_BOUND');
    if (e.type === 'FACE_OUTER_BOUND') assert.equal(typeOf(refs(e.args)[0]), 'POLY_LOOP');
    if (e.type === 'POLY_LOOP') {
      assert.equal(refs(e.args).length, 3);
      for (const r of refs(e.args)) assert.equal(typeOf(r), 'CARTESIAN_POINT');
    }
    if (e.type === 'CLOSED_SHELL') for (const r of refs(e.args)) assert.equal(typeOf(r), 'FACE');
    if (e.type === 'FACETED_BREP') assert.equal(typeOf(refs(e.args)[0]), 'CLOSED_SHELL');
    // PRODUCT_DEFINITION's frame of reference must be a PRODUCT_DEFINITION_CONTEXT
    if (e.type === 'PRODUCT_DEFINITION') assert.equal(typeOf(refs(e.args)[1]), 'PRODUCT_DEFINITION_CONTEXT');
    // REAL values must contain a decimal point
    if (e.type === 'CARTESIAN_POINT') for (const v of e.args.match(/-?\d[\d.E+-]*/g) ?? []) assert.ok(/[.E]/.test(v), `real ${v} in #${id}`);
  }
});

test('STEP: a closed solid exports a closed, consistently oriented shell', async () => {
  const ents = parseStep(await E.exportSTEP(new THREE.BoxGeometry(20, 10, 5), 'Box').text());
  const directed = new Map<string, number>();
  for (const e of ents.values()) {
    if (e.type !== 'POLY_LOOP') continue;
    const p = refs(e.args);
    for (let k = 0; k < p.length; k++) {
      const key = `${p[k]}>${p[(k + 1) % p.length]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  assert.equal(directed.size, 36, 'box: 12 triangles x 3 directed edges (guards against an empty file passing)');
  for (const [key, n] of directed) {
    const [a, b] = key.split('>');
    assert.equal(n, 1, `edge ${key} used once in this direction`);
    assert.equal(directed.get(`${b}>${a}`), 1, `edge ${key} has an opposite partner`);
  }
});

// ------------------------------------------------------------------ IGES 5.3
interface IgesEntity { de: number; type: number; form: number; params: string[] }

function parseIges(text: string) {
  const lines = text.split('\n').filter(Boolean);
  const bySection = (c: string) => lines.filter(l => l[72] === c);
  const d = bySection('D');
  const p = bySection('P');
  const entities = new Map<number, IgesEntity>();
  for (let i = 0; i < d.length; i += 2) {
    const type = Number(d[i].slice(0, 8));
    const pStart = Number(d[i].slice(8, 16));
    const pCount = Number(d[i + 1].slice(24, 32));
    const form = Number(d[i + 1].slice(32, 40));
    const raw = p.slice(pStart - 1, pStart - 1 + pCount).map(l => l.slice(0, 64)).join('');
    const params = raw.trim().replace(/;$/, '').split(',').map(s => s.trim());
    assert.equal(Number(params[0]), type, `P record of DE ${i + 1} starts with its entity type`);
    entities.set(i + 1, { de: i + 1, type, form, params: params.slice(1) });
  }
  return { lines, entities, global: bySection('G').map(l => l.slice(0, 72)).join(''), d, p };
}

test('IGES: fixed 80-column records, correct Terminate counts and Global section', async () => {
  const text = await E.exportIGES(exampleGeometry('l_bracket'), 'Bracket').text();
  const { lines, global, d, p } = parseIges(text);
  for (const l of lines) assert.equal(l.length, 80, `record length: ${JSON.stringify(l.slice(0, 20))}`);
  const term = lines[lines.length - 1];
  assert.equal(term[72], 'T');
  assert.equal(Number(term.slice(9, 16)), lines.filter(l => l[72] === 'G').length);
  assert.equal(Number(term.slice(17, 24)), d.length);
  assert.equal(Number(term.slice(25, 32)), p.length);

  // Global parameters, tokenised Hollerith-aware: "nH" is followed by n raw characters
  // (parameters 1 and 2 are "1H," and "1H;", i.e. the delimiters themselves)
  const g: string[] = [];
  for (let i = 0; i < global.length;) {
    const h = global.slice(i).match(/^(\d+)H/);
    let token: string;
    if (h) {
      token = global.slice(i, i + h[0].length + Number(h[1]));
    } else {
      const end = global.slice(i).search(/[,;]/);
      token = global.slice(i, end === -1 ? undefined : i + end);
    }
    g.push(token.trim());
    i += token.length;
    if (global[i] === ';') break;
    i += 1; // skip the delimiter
  }
  assert.equal(g[12], '1.0', 'parameter 13: model space scale 1.0');
  assert.equal(g[13], '2', 'parameter 14: units flag 2 (mm)');
  assert.equal(g[14], '2HMM', 'parameter 15: units name');
  assert.equal(g[22], '11', 'parameter 23: IGES 5.3');
});

test('IGES: parameters are never split across records', async () => {
  const { p } = parseIges(await E.exportIGES(exampleGeometry('hex_bolt'), 'Bolt').text());
  for (const line of p) {
    const data = line.slice(0, 64).trimEnd();
    assert.ok(data.endsWith(',') || data.endsWith(';'), `record ends inside a parameter: ${JSON.stringify(data.slice(-20))}`);
  }
});

test('IGES: manifold solid B-rep entities follow the 5.3 layouts and point at the right types', async () => {
  const { entities } = parseIges(await E.exportIGES(new THREE.BoxGeometry(20, 10, 5), 'Box').text());
  const typeOf = (de: string | number) => entities.get(Number(de))?.type;
  const all = [...entities.values()];
  const msbo = all.filter(e => e.type === 186);
  assert.equal(msbo.length, 1);
  const shell = entities.get(Number(msbo[0].params[0]))!;
  assert.equal(shell.type, 514);
  assert.equal(shell.form, 1, 'closed shell');

  const faceCount = Number(shell.params[0]);
  assert.equal(faceCount, 12, 'one face per box triangle');
  const edgeUse = new Map<string, number[]>();
  for (let f = 0; f < faceCount; f++) {
    const face = entities.get(Number(shell.params[1 + f * 2]))!;
    assert.equal(face.type, 510);
    assert.equal(face.form, 1);
    assert.equal(typeOf(face.params[0]), 108, 'face surface is a plane');
    assert.equal(face.params[1], '1', 'one loop');
    const loop = entities.get(Number(face.params[3]))!;
    assert.equal(loop.type, 508);
    assert.equal(Number(loop.params[0]), 3);
    for (let k = 0; k < 3; k++) {
      const [type, list, idx, of, psc] = loop.params.slice(1 + k * 5, 6 + k * 5);
      assert.equal(type, '0', 'edge-type loop member');
      assert.equal(typeOf(list), 504);
      assert.equal(psc, '0');
      const key = `${list}:${idx}`;
      edgeUse.set(key, [...(edgeUse.get(key) ?? []), Number(of)]);
    }
  }
  // Closed and consistently oriented: every edge used by two faces in opposite directions
  for (const [key, uses] of edgeUse) assert.deepEqual(uses.sort(), [0, 1], `edge ${key} uses ${uses}`);

  const edgeList = all.find(e => e.type === 504)!;
  assert.equal(edgeList.form, 1);
  const n = Number(edgeList.params[0]);
  for (let e = 0; e < n; e++) {
    const [curve, svp, , tvp] = edgeList.params.slice(1 + e * 5, 5 + e * 5);
    assert.equal(typeOf(curve), 110, 'edge curve is a line');
    assert.equal(typeOf(svp), 502);
    assert.equal(typeOf(tvp), 502);
  }
  assert.equal(all.find(e => e.type === 502)!.form, 1, 'vertex list form 1');
});

// ------------------------------------------------------------------ round trips
test('STEP and IGES round-trip every example with exact volume', async () => {
  for (const ex of CAD_EXAMPLES) {
    const g = exampleGeometry(ex.id);
    const v = volume(g);
    const step = I.importSTEP(await E.exportSTEP(g, ex.id).text());
    const iges = I.importIGES(await E.exportIGES(g, ex.id).text());
    assert.ok(Math.abs(volume(step) - v) <= 1e-4 * v, `${ex.id} STEP volume ${volume(step)} vs ${v}`);
    assert.ok(Math.abs(volume(iges) - v) <= 1e-4 * v, `${ex.id} IGES volume ${volume(iges)} vs ${v}`);
  }
});

test('Importers report unreadable files instead of inventing geometry', () => {
  assert.throws(() => I.importSTEP("ISO-10303-21;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,0.,0.));\n#3=CARTESIAN_POINT('',(0.,1.,0.));\nENDSEC;"), /No faceted/);
  const igesOnlyVertices = [
    '502       1       0       0       0       0       0       000010000D      1',
    '502       0       0       1       1                                D      2',
    '502,3,0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0,0.0;                             1P      1',
  ].map(l => l.padEnd(72, ' ').slice(0, 72) + l.slice(-8)).join('\n');
  assert.throws(() => I.importIGES(igesOnlyVertices), /No faces/);
});

// ------------------------------------------------------------------ STL / OBJ / DXF
test('STL: facet normals are the geometric triangle normals; binary header does not start with "solid"', async () => {
  const g = G.revolveProfile(G.shapeFromSketchEntities([
    { type: 'line', p1: { x: 10, y: 0 }, p2: { x: 20, y: 0 } }, { type: 'line', p1: { x: 20, y: 0 }, p2: { x: 20, y: 10 } },
    { type: 'line', p1: { x: 20, y: 10 }, p2: { x: 10, y: 10 } }, { type: 'line', p1: { x: 10, y: 10 }, p2: { x: 10, y: 0 } },
  ]));
  const bytes = Buffer.from(await E.exportSTL(g, true).arrayBuffer());
  assert.ok(!bytes.subarray(0, 5).toString('latin1').startsWith('solid'));
  const n = bytes.readUInt32LE(80);
  for (let t = 0; t < n; t += 97) {
    const o = 84 + t * 50;
    const f = (k: number) => bytes.readFloatLE(o + k * 4);
    const [a, b, c] = [3, 6, 9].map(k => new THREE.Vector3(f(k), f(k + 1), f(k + 2)));
    const expected = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const stored = new THREE.Vector3(f(0), f(1), f(2));
    if (expected.lengthSq() > 0) assert.ok(stored.distanceTo(expected) < 1e-5, `facet ${t} normal`);
  }
  assert.ok(Math.abs(volume(I.importSTL(bytes)) - volume(g)) < 1e-3 * volume(g));
});

test('OBJ: negative (relative) face indices are supported', () => {
  const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n';
  const g = I.importOBJ(obj);
  assert.equal(g.getAttribute('position').count, 3);
  assert.deepEqual(Array.from(g.getAttribute('position').array).slice(3, 6), [1, 0, 0]);
});

test('DXF: defaults to R12 (AC1009), the structure this writer produces', async () => {
  const text = await E.exportDXF([{ type: 'line', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } }]).text();
  assert.match(text, /\$ACADVER\n1\nAC1009/);
  assert.match(await E.exportDXF([], { version: '2018' }).text(), /AC1032/);
});

test('MaterialLibrary: redefining a material refreshes its cached render material', () => {
  const lib = new MaterialLibrary();
  const before = lib.getThreeMaterial('Custom_X');
  lib.addCustomMaterial('Custom_X', { color: '#ff0000' });
  const after = lib.getThreeMaterial('Custom_X');
  assert.notEqual(after, before);
  assert.equal(after.color.getHexString(), 'ff0000');
});
