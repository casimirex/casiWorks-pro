// CasiWorks Pro - Local server: the app, the document library and REST API v1
//
// Meant for one person on one machine: it listens on 127.0.0.1 only and turns
// away requests for any other host name (DNS rebinding) or from other web sites.
// Every /api/v1 call needs `Authorization: Bearer <token>`, where the token is
// either an API key (`cw_…`, for scripts) or the session token the app itself
// reads from /api/v1/session (which only the app's own pages can read).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { LIFECYCLE_STATES, Library, LibraryError, WEBHOOK_EVENTS } from './library.ts';
import type { JobKind } from './library.ts';
import { EXPORT_FORMATS, JobRunner } from './jobs.ts';
import type { ExportFormat } from './jobs.ts';
import { Webhooks } from './webhooks.ts';

export const SERVER_API_VERSION = '1.2.0';
const MAX_BODY = 25 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface ServerOptions {
  /** Data folder (database, project files, exports). */
  dataDir: string;
  /** The built app to serve (dist/); omit for the API alone. */
  distDir?: string;
  /** Other origins allowed to call the API (the Vite dev server). */
  allowedOrigins?: string[];
  /** Webhook retry delays (tests shorten them). */
  webhookRetryDelays?: number[];
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
}
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** OpenAPI style: /documents/{id} */
  path: string;
  summary: string;
  tag: string;
  /** false: no token needed. */
  auth?: boolean;
  /** OpenAPI schemas (component names) for the request body and the success answer. */
  request?: string;
  response?: string;
  status?: number;
  handler: Handler;
}

/** An answer that is not JSON (a file). */
class Raw {
  readonly body: Buffer | string;
  readonly type: string;
  readonly fileName?: string;
  constructor(body: Buffer | string, type: string, fileName?: string) {
    this.body = body; this.type = type; this.fileName = fileName;
  }
}

const fail = (status: number, code: string, message: string): never => { throw new LibraryError(status, code, message); };
const str = (v: unknown, name: string) => (typeof v === 'string' && v ? v : fail(400, 'INVALID_ARGUMENT', `${name} must be a non-empty string`));

export interface LocalServer {
  server: Server;
  library: Library;
  jobs: JobRunner;
  webhooks: Webhooks;
  sessionToken: string;
  /** The routes, for the OpenAPI document and tests. */
  routes: Route[];
  openapi(): Record<string, unknown>;
  close(): Promise<void>;
}

export function createLocalServer(options: ServerOptions): LocalServer {
  const library = new Library(options.dataDir);
  const webhooks = new Webhooks(library, options.webhookRetryDelays);
  const jobs = new JobRunner(library, job => webhooks.emit('job.finished', { job }));
  const sessionToken = randomBytes(24).toString('base64url');
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  const versionNumber = (documentId: string, v: string) => {
    if (v === 'latest') return library.getDocument(documentId).headVersion;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fail(400, 'INVALID_ARGUMENT', 'version must be a positive whole number or "latest"');
  };

  const routes: Route[] = [
    { method: 'GET', path: '/', tag: 'Server', summary: 'Where to start: links to the API description and the main collections', auth: false, response: 'Index',
      handler: () => ({
        name: 'CasiWorks local API', apiVersion: SERVER_API_VERSION,
        description: 'Every call except this one, /health and /openapi.json needs Authorization: Bearer <API key> (npm run server -- key create NAME)',
        links: { openapi: '/api/v1/openapi.json', health: '/api/v1/health', documents: '/api/v1/documents', jobs: '/api/v1/jobs', keys: '/api/v1/keys', webhooks: '/api/v1/webhooks' },
      }) },
    { method: 'GET', path: '/health', tag: 'Server', summary: 'Is the server up', auth: false, response: 'Health',
      handler: () => ({ ok: true, apiVersion: SERVER_API_VERSION }) },
    { method: 'GET', path: '/session', tag: 'Server', summary: 'The session token for the app (readable only by the app\'s own pages)', auth: false, response: 'Session',
      handler: ({ req }) => {
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') fail(403, 'FORBIDDEN', 'Only the CasiWorks app may read the session token');
        return { token: sessionToken };
      } },
    { method: 'GET', path: '/openapi.json', tag: 'Server', summary: 'This API described in OpenAPI 3.1', auth: false,
      handler: () => openapi() },

    // ------------------------------------------------------------ documents
    { method: 'GET', path: '/documents', tag: 'Documents', summary: 'List documents, newest change first (?q= filters by name, ?state= by lifecycle state)', response: 'DocumentList',
      handler: ({ query }) => ({ documents: library.listDocuments(query.get('q') ?? undefined, query.get('state') ?? undefined) }) },
    { method: 'POST', path: '/documents', tag: 'Documents', summary: 'Create a document with its first version', request: 'NewDocument', response: 'DocumentAndVersion', status: 201,
      handler: async ({ body }) => {
        const b = await body();
        const out = library.createDocument(b.name, b.content, b.message === undefined ? 'Created' : String(b.message));
        webhooks.emit('document.saved', { document: out.document, version: out.version });
        return out;
      } },
    { method: 'GET', path: '/documents/{id}', tag: 'Documents', summary: 'One document', response: 'Document',
      handler: ({ params }) => library.getDocument(params.id) },
    { method: 'PATCH', path: '/documents/{id}', tag: 'Documents', summary: 'Rename a document', request: 'Rename', response: 'Document',
      handler: async ({ params, body }) => library.renameDocument(params.id, (await body()).name) },
    { method: 'DELETE', path: '/documents/{id}', tag: 'Documents', summary: 'Delete a document and all its versions (409 IN_USE while an assembly\'s newest version uses it)', status: 204,
      handler: ({ params }) => { library.deleteDocument(params.id); return null; } },

    // ------------------------------------------------------------ versions and revisions
    { method: 'GET', path: '/documents/{id}/versions', tag: 'Versions', summary: 'Every version, newest first', response: 'VersionList',
      handler: ({ params }) => ({ versions: library.listVersions(params.id) }) },
    { method: 'POST', path: '/documents/{id}/versions', tag: 'Versions', summary: 'Save a new version (409 if baseVersion is not the newest)', request: 'NewVersion', response: 'Version', status: 201,
      handler: async ({ params, body }) => {
        const b = await body();
        const base = b.baseVersion === undefined ? undefined : Number(b.baseVersion);
        if (base !== undefined && !(Number.isInteger(base) && base > 0)) fail(400, 'INVALID_ARGUMENT', 'baseVersion must be a positive whole number');
        const before = library.getDocument(params.id).state;
        const version = library.addVersion(params.id, b.content, b.message, base);
        const document = library.getDocument(params.id);
        webhooks.emit('document.saved', { document, version });
        if (document.state !== before) webhooks.emit('document.state_changed', { document, from: before, event: library.listLifecycle(params.id)[0] });
        return version;
      } },
    { method: 'GET', path: '/documents/{id}/versions/{version}', tag: 'Versions', summary: 'One version ("latest" for the newest)', response: 'Version',
      handler: ({ params }) => library.getVersion(params.id, versionNumber(params.id, params.version)) },
    { method: 'GET', path: '/documents/{id}/versions/{version}/content', tag: 'Versions', summary: 'The project file of a version (.casiproj JSON)',
      handler: ({ params }) => {
        const n = versionNumber(params.id, params.version);
        const doc = library.getDocument(params.id);
        return new Raw(library.readContent(params.id, n), 'application/json', `${doc.name.replace(/[^\w.-]+/g, '_')}_v${n}.casiproj`);
      } },
    { method: 'POST', path: '/documents/{id}/versions/{version}/release', tag: 'Versions', summary: 'Release a version as the next revision (A, B, …)', response: 'Version',
      handler: ({ params }) => {
        const before = library.getDocument(params.id).state;
        const version = library.release(params.id, versionNumber(params.id, params.version));
        const document = library.getDocument(params.id);
        webhooks.emit('revision.released', { document, version });
        if (document.state !== before) webhooks.emit('document.state_changed', { document, from: before, event: library.listLifecycle(params.id)[0] });
        return version;
      } },

    { method: 'GET', path: '/documents/{id}/where-used', tag: 'Documents', summary: 'The assemblies that use this part (current users first)', response: 'WhereUsedList',
      handler: ({ params }) => ({ usedBy: library.whereUsed(params.id) }) },

    // ------------------------------------------------------------ lifecycle
    { method: 'GET', path: '/documents/{id}/lifecycle', tag: 'Lifecycle', summary: 'The lifecycle state history, newest first', response: 'LifecycleList',
      handler: ({ params }) => ({ state: library.getDocument(params.id).state, events: library.listLifecycle(params.id) }) },
    { method: 'POST', path: '/documents/{id}/lifecycle', tag: 'Lifecycle',
      summary: 'Move a document to another state (draft, in_review, released, obsolete); released releases the newest version', request: 'StateChange', response: 'StateChanged',
      handler: async ({ params, body }) => {
        const b = await body();
        const before = library.getDocument(params.id).state;
        const out = library.setState(params.id, b.state, b.note);
        const event = library.listLifecycle(params.id)[0];
        if (out.newRevision && out.version) {
          webhooks.emit('revision.released', { document: out.document, version: out.version });
        }
        webhooks.emit('document.state_changed', { document: out.document, from: before, event });
        return { ...out, event };
      } },

    // ------------------------------------------------------------ jobs
    { method: 'GET', path: '/jobs', tag: 'Jobs', summary: 'Recent jobs, newest first', response: 'JobList',
      handler: () => ({ jobs: library.listJobs() }) },
    { method: 'POST', path: '/jobs', tag: 'Jobs', summary: 'Queue a rebuild or export of a version', request: 'NewJob', response: 'Job', status: 202,
      handler: async ({ body }) => {
        const b = await body();
        const kind = b.kind as JobKind;
        if (kind !== 'rebuild' && kind !== 'export') fail(400, 'INVALID_ARGUMENT', 'kind must be "rebuild" or "export"');
        const documentId = str(b.documentId, 'documentId');
        const version = b.version === undefined ? library.getDocument(documentId).headVersion : versionNumber(documentId, String(b.version));
        let format: string | null = null;
        if (kind === 'export') {
          format = String(b.format ?? '');
          if (!(format in EXPORT_FORMATS)) fail(400, 'INVALID_ARGUMENT', `format must be one of ${Object.keys(EXPORT_FORMATS).join(', ')}`);
        }
        const job = library.createJob(kind, documentId, version, format);
        jobs.kick();
        return job;
      } },
    { method: 'GET', path: '/jobs/{id}', tag: 'Jobs', summary: 'A job and, once done, its result', response: 'Job',
      handler: ({ params }) => library.getJob(params.id) },
    { method: 'GET', path: '/jobs/{id}/result', tag: 'Jobs', summary: 'The file an export job made',
      handler: ({ params }) => {
        const job = library.getJob(params.id);
        if (job.kind !== 'export') fail(400, 'INVALID_ARGUMENT', 'Only export jobs make a file');
        if (job.status !== 'done') fail(409, 'NOT_READY', `The job is ${job.status}${job.error ? `: ${job.error}` : ''}`);
        const r = job.result as { fileName: string; contentType: string };
        return new Raw(readFileSync(library.exportPath(job.id)), r.contentType, r.fileName);
      } },

    // ------------------------------------------------------------ API keys
    { method: 'GET', path: '/keys', tag: 'API keys', summary: 'API keys (never their secrets)', response: 'KeyList',
      handler: () => ({ keys: library.listKeys() }) },
    { method: 'POST', path: '/keys', tag: 'API keys', summary: 'Create an API key; the secret is shown only in this answer', request: 'NewKey', response: 'KeyAndSecret', status: 201,
      handler: async ({ body }) => library.createKey((await body()).name) },
    { method: 'DELETE', path: '/keys/{id}', tag: 'API keys', summary: 'Revoke an API key', status: 204,
      handler: ({ params }) => { library.deleteKey(params.id); return null; } },

    // ------------------------------------------------------------ webhooks
    { method: 'GET', path: '/webhooks', tag: 'Webhooks', summary: 'Registered webhooks', response: 'WebhookList',
      handler: () => ({ webhooks: library.listWebhooks() }) },
    { method: 'POST', path: '/webhooks', tag: 'Webhooks', summary: 'Register a webhook; its signing secret is shown only in this answer', request: 'NewWebhook', response: 'WebhookAndSecret', status: 201,
      handler: async ({ body }) => { const b = await body(); return library.createWebhook(b.url, b.events); } },
    { method: 'DELETE', path: '/webhooks/{id}', tag: 'Webhooks', summary: 'Remove a webhook', status: 204,
      handler: ({ params }) => { library.deleteWebhook(params.id); return null; } },
    { method: 'GET', path: '/webhooks/{id}/deliveries', tag: 'Webhooks', summary: 'Recent delivery attempts, newest first', response: 'DeliveryList',
      handler: ({ params }) => ({ deliveries: library.listDeliveries(params.id) }) },
  ];

  const matchers = routes.map(r => ({
    route: r,
    re: new RegExp('^/api/v1' + r.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$'),
  }));

  function openapi(): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of routes) {
      const params = [...r.path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      const ok = String(r.status ?? 200);
      paths[r.path] ??= {};
      paths[r.path][r.method.toLowerCase()] = {
        summary: r.summary,
        tags: [r.tag],
        ...(params.length ? { parameters: params } : {}),
        ...(r.path === '/documents' && r.method === 'GET' ? { parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { enum: LIFECYCLE_STATES } },
        ] } : {}),
        ...(r.auth === false ? { security: [] } : {}),
        ...(r.request ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${r.request}` } } } } } : {}),
        responses: {
          [ok]: r.status === 204 ? { description: 'Done' }
            : { description: 'OK', content: r.response ? { 'application/json': { schema: { $ref: `#/components/schemas/${r.response}` } } } : { 'application/octet-stream': {} } },
          default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      };
    }
    return { openapi: '3.1.0', info: { title: 'CasiWorks local API', version: SERVER_API_VERSION }, servers: [{ url: '/api/v1' }],
      security: [{ bearer: [] }], paths, components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: SCHEMAS } };
  }

  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (body instanceof Raw) {
      res.writeHead(status, {
        'content-type': body.type,
        ...(body.fileName ? { 'content-disposition': `attachment; filename="${body.fileName}"` } : {}),
        'cache-control': 'no-store',
      });
      res.end(body.body);
      return;
    }
    if (status === 204 || body === null) { res.writeHead(status === 200 ? 204 : status); res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const sendError = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

  const readBody = (req: IncomingMessage) => new Promise<Record<string, unknown>>((resolveBody, reject) => {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('application/json')) return reject(new LibraryError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new LibraryError(413, 'TOO_LARGE', `Body over ${MAX_BODY / 1024 / 1024} MB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolveBody(v as Record<string, unknown>);
      } catch { reject(new LibraryError(400, 'INVALID_JSON', 'The body is not a JSON object')); }
    });
    req.on('error', reject);
  });

  const authorised = (req: IncomingMessage) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
    if (!m) return false;
    return m[1] === sessionToken || library.checkKey(m[1]) !== null;
  };

  const serveStatic = (pathname: string, res: ServerResponse) => {
    if (!options.distDir) return sendError(res, 404, 'NOT_FOUND', 'Nothing here');
    const root = resolve(options.distDir);
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) return sendError(res, 403, 'FORBIDDEN', 'Outside the app');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    // Unknown paths are the app's own routes
    if (!existsSync(file)) file = join(root, 'index.html');
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.txt': 'text/plain',
    };
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(readFileSync(file));
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Only this machine, by a local name: guards against DNS rebinding
        const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
        if (!LOCAL_HOSTS.has(host)) return sendError(res, 403, 'FORBIDDEN', 'Use http://127.0.0.1 or http://localhost');
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        if (!url.pathname.startsWith('/api/v1/') && url.pathname !== '/api/v1') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'The app is read only');
          return serveStatic(url.pathname, res);
        }
        // Other web sites may not call the API (no CORS is offered either)
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && !allowedOrigins.has(origin)) {
          return sendError(res, 403, 'FORBIDDEN', `Requests from ${origin} are not allowed`);
        }
        const path = url.pathname === '/api/v1' ? '/api/v1/' : url.pathname;
        const hit = matchers.map(m => ({ m, match: m.re.exec(path) })).filter(x => x.match);
        if (hit.length === 0) return sendError(res, 404, 'NOT_FOUND', `No API route ${url.pathname}`);
        const found = hit.find(x => x.m.route.method === req.method);
        if (!found) return sendError(res, 405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed here (allowed: ${hit.map(x => x.m.route.method).join(', ')})`);
        const route = found.m.route;
        if (route.auth !== false && !authorised(req)) {
          res.setHeader('www-authenticate', 'Bearer');
          return sendError(res, 401, 'UNAUTHORIZED', 'Send Authorization: Bearer <API key>');
        }
        const params = Object.fromEntries(Object.entries(found.match!.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        const out = await route.handler({ req, res, params, query: url.searchParams, body: () => readBody(req) });
        send(res, route.status ?? 200, out);
      } catch (err) {
        if (err instanceof LibraryError) return sendError(res, err.status, err.code, err.message);
        console.error('casiworks server:', err);
        sendError(res, 500, 'INTERNAL', err instanceof Error ? err.message : String(err));
      }
    })();
  });

  return {
    server, library, jobs, webhooks, sessionToken, routes, openapi,
    async close() {
      await new Promise<void>(r => server.close(() => r()));
      server.closeAllConnections?.();
      await jobs.idle;
      await webhooks.settled();
      library.close();
    },
  };
}

// ------------------------------------------------------------------ OpenAPI schemas
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required });
const s = { type: 'string' }, i = { type: 'integer' }, nullable = (t: object) => ({ oneOf: [t, { type: 'null' }] });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const list = (key: string, item: string) => obj({ [key]: { type: 'array', items: ref(item) } });

const SCHEMAS: Record<string, unknown> = {
  Error: obj({ error: obj({ code: s, message: s }) }),
  Health: obj({ ok: { type: 'boolean' }, apiVersion: s }),
  Index: obj({ name: s, apiVersion: s, description: s, links: { type: 'object', additionalProperties: s } }),
  Session: obj({ token: s }),
  Document: obj({ id: s, name: s, createdAt: s, updatedAt: s, headVersion: i, latestRevision: nullable(s), state: { enum: LIFECYCLE_STATES }, kind: { enum: ['part', 'assembly'] } }),
  WhereUsed: obj({ document: obj({ id: s, name: s, headVersion: i, state: { enum: LIFECYCLE_STATES } }), versions: { type: 'array', items: i }, current: { type: 'boolean' },
    pinnedVersion: nullable(i), count: i }),
  WhereUsedList: list('usedBy', 'WhereUsed'),
  DocumentList: list('documents', 'Document'),
  Version: obj({ documentId: s, number: i, message: s, createdAt: s, size: i, sha256: s, revision: nullable(s), releasedAt: nullable(s) }),
  VersionList: list('versions', 'Version'),
  DocumentAndVersion: obj({ document: ref('Document'), version: ref('Version') }),
  NewDocument: obj({ name: s, content: { type: 'string', description: 'The project file text (.casiproj JSON)' }, message: s }, ['name', 'content']),
  Rename: obj({ name: s }),
  NewVersion: obj({ content: s, message: s, baseVersion: { ...i, description: 'The version this was based on; refused (409) if it is not the newest' } }, ['content']),
  LifecycleEvent: obj({ id: i, documentId: s, from: nullable({ enum: LIFECYCLE_STATES }), to: { enum: LIFECYCLE_STATES }, version: i, note: s, createdAt: s }),
  LifecycleList: obj({ state: { enum: LIFECYCLE_STATES }, events: { type: 'array', items: ref('LifecycleEvent') } }),
  StateChange: obj({ state: { enum: LIFECYCLE_STATES }, note: s }, ['state']),
  StateChanged: obj({ document: ref('Document'), version: nullable(ref('Version')), newRevision: { type: 'boolean', description: 'true when this released the newest version as a new revision' }, event: ref('LifecycleEvent') }),
  Job: obj({ id: s, kind: { enum: ['rebuild', 'export'] }, documentId: s, version: i, format: nullable(s), status: { enum: ['queued', 'running', 'done', 'failed'] },
    error: nullable(s), result: nullable({ type: 'object' }), createdAt: s, finishedAt: nullable(s) }),
  JobList: list('jobs', 'Job'),
  NewJob: obj({ kind: { enum: ['rebuild', 'export'] }, documentId: s, version: { oneOf: [i, { const: 'latest' }] }, format: { enum: Object.keys(EXPORT_FORMATS) } }, ['kind', 'documentId']),
  ApiKey: obj({ id: s, name: s, prefix: s, createdAt: s, lastUsedAt: nullable(s) }),
  KeyList: list('keys', 'ApiKey'),
  NewKey: obj({ name: s }),
  KeyAndSecret: obj({ key: ref('ApiKey'), secret: s }),
  Webhook: obj({ id: s, url: s, events: { type: 'array', items: { enum: WEBHOOK_EVENTS } }, createdAt: s, active: { type: 'boolean' } }),
  WebhookList: list('webhooks', 'Webhook'),
  NewWebhook: obj({ url: s, events: { type: 'array', items: { enum: WEBHOOK_EVENTS } } }, ['url']),
  WebhookAndSecret: obj({ webhook: ref('Webhook'), secret: s }),
  Delivery: obj({ id: i, webhookId: s, event: { enum: WEBHOOK_EVENTS }, status: nullable(i), error: nullable(s), createdAt: s }),
  DeliveryList: list('deliveries', 'Delivery'),
};

export type { ExportFormat };
