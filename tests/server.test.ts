// CasiWorks Pro - Local server: library, REST API v1, jobs, webhooks, guards
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalServer } from '../server/app.ts';
import { revisionLetter } from '../server/library.ts';
import { signature } from '../server/webhooks.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';

const projectOf = (example: string) => {
  createCommandRegistry(useCADStore).execute('file.loadExample', { id: example });
  return useCADStore.getState().saveProject();
};

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'casiworks-server-'));
  const app = createLocalServer({ dataDir: dir, webhookRetryDelays: [20, 20] });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${app.sessionToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data: data as Record<string, any>, headers: res.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { app, base, call, dir, stop: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Revision letters run A … Z, AA, AB', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(revisionLetter), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
});

test('Server guards: tokens, API keys, other hosts and other web sites', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/health', undefined, { authorization: '' })).status, 200, 'health needs no token');
    const anon = await s.call('GET', '/documents', undefined, { authorization: '' });
    assert.equal(anon.status, 401);
    assert.equal(anon.data.error.code, 'UNAUTHORIZED');
    assert.equal((await s.call('GET', '/documents', undefined, { authorization: 'Bearer nope' })).status, 401);
    // Another host name (DNS rebinding) and another web site
    // (fetch will not send another Host header, so this one goes out with node:http)
    const rebind = await new Promise<number>((resolve, reject) => {
      const req = request(`${s.base}/api/v1/health`, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebind, 403);
    assert.equal((await s.call('GET', '/documents', undefined, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await s.call('GET', '/session', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    // The app's own page reads the session token
    const session = await s.call('GET', '/session', undefined, { authorization: '', 'sec-fetch-site': 'same-origin', origin: s.base });
    assert.equal(session.data.token, s.app.sessionToken);

    // API keys: shown once, work, can be revoked
    const made = await s.call('POST', '/keys', { name: 'build script' });
    assert.equal(made.status, 201);
    const secret = made.data.secret as string;
    assert.match(secret, /^cw_/);
    const withKey = { authorization: `Bearer ${secret}` };
    assert.equal((await s.call('GET', '/documents', undefined, withKey)).status, 200);
    const keys = await s.call('GET', '/keys');
    assert.equal(keys.data.keys.length, 1);
    assert.ok(!JSON.stringify(keys.data).includes(secret), 'the secret is never listed');
    assert.ok(keys.data.keys[0].lastUsedAt, 'use is noted');
    assert.equal((await s.call('DELETE', `/keys/${made.data.key.id}`)).status, 204);
    assert.equal((await s.call('GET', '/documents', undefined, withKey)).status, 401, 'revoked');

    // Bad requests
    assert.equal((await s.call('GET', '/nowhere')).status, 404);
    assert.equal((await s.call('PATCH', '/documents')).status, 405);
    const notJson = await fetch(`${s.base}/api/v1/documents`, { method: 'POST', headers: { authorization: `Bearer ${s.app.sessionToken}`, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(notJson.status, 415);
  } finally {
    await s.stop();
  }
});

test('Documents, versions, conflicts and revisions', async () => {
  const s = await start();
  try {
    const content = projectOf('l_bracket');
    assert.equal((await s.call('POST', '/documents', { name: 'Bracket', content: 'not json' })).status, 400);
    assert.equal((await s.call('POST', '/documents', { name: '', content })).status, 400);
    const made = await s.call('POST', '/documents', { name: 'Bracket', content });
    assert.equal(made.status, 201);
    const id = made.data.document.id as string;
    assert.equal(made.data.document.headVersion, 1);
    assert.equal(made.data.version.message, 'Created');

    // Content comes back byte for byte; "latest" is the newest
    const back = await s.call('GET', `/documents/${id}/versions/latest/content`);
    assert.equal(back.status, 200);
    assert.equal(JSON.stringify(back.data), JSON.stringify(JSON.parse(content)));
    assert.match(String(back.headers.get('content-disposition')), /Bracket_v1\.casiproj/);

    // Two windows start from version 1: the second save is refused
    const v2 = await s.call('POST', `/documents/${id}/versions`, { content: content.replace('Mounting_L_Bracket', 'Bracket B'), message: 'Thicker', baseVersion: 1 });
    assert.equal(v2.status, 201);
    assert.equal(v2.data.number, 2);
    const stale = await s.call('POST', `/documents/${id}/versions`, { content, baseVersion: 1 });
    assert.equal(stale.status, 409);
    assert.match(stale.data.error.message, /Version 2 was saved after version 1/);
    // Without a base it just adds one (scripts that only append)
    assert.equal((await s.call('POST', `/documents/${id}/versions`, { content })).data.number, 3);
    const versions = await s.call('GET', `/documents/${id}/versions`);
    assert.deepEqual(versions.data.versions.map((v: { number: number }) => v.number), [3, 2, 1]);
    assert.equal(versions.data.versions[2].sha256, versions.data.versions[0].sha256, 'same content, same hash');
    assert.equal(readdirSync(join(s.dir, 'blobs')).length, 2, 'stored once per distinct content');

    // Revisions
    const a = await s.call('POST', `/documents/${id}/versions/2/release`);
    assert.equal(a.data.revision, 'A');
    assert.equal((await s.call('POST', `/documents/${id}/versions/2/release`)).status, 409, 'released once');
    assert.equal((await s.call('POST', `/documents/${id}/versions/1/release`)).status, 409, 'not before a released one');
    assert.equal((await s.call('POST', `/documents/${id}/versions/latest/release`)).data.revision, 'B');
    assert.equal((await s.call('GET', `/documents/${id}`)).data.latestRevision, 'B');

    // List, search, rename, delete
    await s.call('POST', '/documents', { name: 'Flange 100%', content: projectOf('pipe_flange') });
    assert.equal((await s.call('GET', '/documents')).data.documents.length, 2);
    assert.deepEqual((await s.call('GET', '/documents?q=100%25')).data.documents.map((d: { name: string }) => d.name), ['Flange 100%']);
    assert.equal((await s.call('GET', '/documents?q=_')).data.documents.length, 0, 'LIKE wildcards are literal');
    assert.equal((await s.call('PATCH', `/documents/${id}`, { name: 'Bracket, rev B' })).data.name, 'Bracket, rev B');
    assert.equal((await s.call('DELETE', `/documents/${id}`)).status, 204);
    assert.equal((await s.call('GET', `/documents/${id}`)).status, 404);
    assert.equal(readdirSync(join(s.dir, 'blobs')).length, 1, 'its content is removed');
    assert.equal((await s.call('GET', `/documents/${id}/versions/1`)).status, 404);
  } finally {
    await s.stop();
  }
});

test('Headless jobs: rebuild and export a saved version', async () => {
  const s = await start();
  try {
    const content = projectOf('l_bracket');
    rebuildModel(useCADStore);
    const expectedVolume = useCADStore.getState().bodies[0].geometry!.attributes.position.count > 0
      ? (await import('../src/kernel/GeometryEngine.ts')).geometryEngine.computeMassProperties(useCADStore.getState().bodies[0].geometry!)!.volume : 0;
    const id = (await s.call('POST', '/documents', { name: 'Bracket', content })).data.document.id as string;

    const bad = await s.call('POST', '/jobs', { kind: 'export', documentId: id, format: 'pdf' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error.message, /format must be one of stl, stl-ascii, obj, step, iges, dxf/);
    assert.equal((await s.call('POST', '/jobs', { kind: 'export', documentId: 'nope', format: 'stl' })).status, 404);

    const rebuild = await s.call('POST', '/jobs', { kind: 'rebuild', documentId: id });
    assert.equal(rebuild.status, 202);
    const exp = await s.call('POST', '/jobs', { kind: 'export', documentId: id, version: 1, format: 'stl' });
    const early = await s.call('GET', `/jobs/${exp.data.id}/result`);
    assert.ok(early.status === 409 || early.status === 200);
    await s.app.jobs.idle;

    const r = (await s.call('GET', `/jobs/${rebuild.data.id}`)).data;
    assert.equal(r.status, 'done');
    assert.equal(r.result.documentName, 'Mounting_L_Bracket');
    assert.ok(Math.abs(r.result.mass.volume - expectedVolume) < 1e-6, `volume ${r.result.mass.volume} vs ${expectedVolume}`);
    assert.ok(r.result.errors.some((e: { feature: string }) => /Fillet/.test(e.feature)), 'the fillet warning is reported');

    const e = (await s.call('GET', `/jobs/${exp.data.id}`)).data;
    assert.equal(e.status, 'done', e.error);
    const file = await s.call('GET', `/jobs/${exp.data.id}/result`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'model/stl');
    assert.match(String(file.headers.get('content-disposition')), /Mounting_L_Bracket_v1\.stl/);
    const stl = file.data as unknown as Buffer;
    const triangles = stl.readUInt32LE(80);
    assert.ok(triangles > 10 && stl.length === 84 + 50 * triangles, 'a well-formed binary STL');
    assert.equal(e.result.size, stl.length);

    // A version without a body fails cleanly
    const empty = JSON.stringify({ documentName: 'Empty', features: [] });
    const emptyId = (await s.call('POST', '/documents', { name: 'Empty', content: empty })).data.document.id as string;
    const failed = await s.call('POST', '/jobs', { kind: 'export', documentId: emptyId, format: 'step' });
    await s.app.jobs.idle;
    const f = (await s.call('GET', `/jobs/${failed.data.id}`)).data;
    assert.equal(f.status, 'failed');
    assert.match(f.error, /no solid body/);
    assert.equal((await s.call('GET', `/jobs/${failed.data.id}/result`)).status, 409);
    assert.equal((await s.call('GET', '/jobs')).data.jobs.length, 3);
  } finally {
    await s.stop();
  }
});

test('Webhooks: signed deliveries for saves, releases and jobs; failures retried and logged', async () => {
  const received: Array<{ event: string; signature: string; body: string }> = [];
  let failNext = 0;
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ event: String(req.headers['x-casiworks-event']), signature: String(req.headers['x-casiworks-signature']), body });
      res.writeHead(failNext-- > 0 ? 500 : 204);
      res.end();
    });
  });
  await new Promise<void>(r => receiver.listen(0, '127.0.0.1', () => r()));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  const s = await start();
  try {
    assert.equal((await s.call('POST', '/webhooks', { url: 'ftp://x' })).status, 400);
    assert.equal((await s.call('POST', '/webhooks', { url: hookUrl, events: ['nope'] })).status, 400);
    const made = await s.call('POST', '/webhooks', { url: hookUrl });
    assert.equal(made.status, 201);
    const secret = made.data.secret as string;
    const hookId = made.data.webhook.id as string;
    assert.deepEqual(made.data.webhook.events, ['document.saved', 'revision.released', 'job.finished']);
    assert.ok(!JSON.stringify((await s.call('GET', '/webhooks')).data).includes(secret));

    const id = (await s.call('POST', '/documents', { name: 'Bracket', content: projectOf('l_bracket') })).data.document.id as string;
    await s.call('POST', `/documents/${id}/versions/1/release`);
    await s.call('POST', '/jobs', { kind: 'rebuild', documentId: id });
    await s.app.jobs.idle;
    await s.app.webhooks.settled();
    assert.deepEqual(received.map(r => r.event).sort(), ['document.saved', 'job.finished', 'revision.released']);
    for (const r of received) assert.equal(r.signature, signature(secret, r.body), 'HMAC of the body');
    const released = JSON.parse(received.find(r => r.event === 'revision.released')!.body);
    assert.equal(released.data.version.revision, 'A');
    assert.equal(released.data.document.id, id);

    // A failing receiver: retried twice, every attempt logged
    received.length = 0;
    failNext = 3;
    await s.call('POST', `/documents/${id}/versions`, { content: projectOf('hex_bolt'), message: 'x' });
    await s.app.webhooks.settled();
    assert.equal(received.length, 3, 'one try and two retries');
    const log = (await s.call('GET', `/webhooks/${hookId}/deliveries`)).data.deliveries;
    assert.deepEqual(log.slice(0, 3).map((d: { status: number }) => d.status), [500, 500, 500]);
    assert.equal(log.length, 6);

    assert.equal((await s.call('DELETE', `/webhooks/${hookId}`)).status, 204);
    received.length = 0;
    await s.call('POST', `/documents/${id}/versions`, { content: projectOf('l_bracket') });
    await s.app.webhooks.settled();
    assert.equal(received.length, 0, 'removed: nothing sent');
  } finally {
    await s.stop();
    receiver.close();
  }
});

test('OpenAPI document covers every route and every schema it names', async () => {
  const s = await start();
  try {
    const spec = (await s.call('GET', '/openapi.json', undefined, { authorization: '' })).data as {
      openapi: string; paths: Record<string, Record<string, { security?: unknown[] }>>; components: { schemas: Record<string, unknown> };
    };
    assert.equal(spec.openapi, '3.1.0');
    for (const r of s.app.routes) assert.ok(spec.paths[r.path]?.[r.method.toLowerCase()], `${r.method} ${r.path}`);
    const refs = [...JSON.stringify(spec).matchAll(/#\/components\/schemas\/(\w+)/g)].map(m => m[1]);
    for (const name of refs) assert.ok(name in spec.components.schemas, `schema ${name}`);
    assert.deepEqual(spec.paths['/health'].get.security, [], 'open routes are marked');
  } finally {
    await s.stop();
  }
});
