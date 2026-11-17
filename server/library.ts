// CasiWorks Pro - Document library: SQLite for the records, files for the content
//
// Everything lives in one data folder (default ~/.casiworks):
//   library.db         documents, versions, revisions, lifecycle states, API keys, jobs, webhooks
//   blobs/<sha256>     project files (.casiproj JSON), stored once per distinct content
//   exports/<job id>   files made by export jobs
// A version is never changed after it is saved; releasing one gives it the next
// revision letter (A, B, … Z, AA, …).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface DocumentRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** The newest version number. */
  headVersion: number;
  /** The newest released revision, if any. */
  latestRevision: string | null;
  /** Where the document is in its lifecycle. */
  state: LifecycleState;
  /** A part or an assembly (from its newest version). */
  kind: 'part' | 'assembly';
}

/** An assembly that uses a part. */
export interface WhereUsedRecord {
  /** The assembly document. */
  document: { id: string; name: string; headVersion: number; state: LifecycleState };
  /** Versions of the assembly that contain the part (newest first). */
  versions: number[];
  /** True when the assembly's newest version uses it. */
  current: boolean;
  /** The part version the newest using version pins, or null when it follows the newest. */
  pinnedVersion: number | null;
  /** How many components in that version are this part. */
  count: number;
}

/**
 * draft: being worked on. in_review: frozen while it is checked (no saves).
 * released: the newest version is a released revision; saving starts the next
 * revision (back to draft). obsolete: no longer used (no saves until reactivated).
 */
export type LifecycleState = 'draft' | 'in_review' | 'released' | 'obsolete';
export const LIFECYCLE_STATES: LifecycleState[] = ['draft', 'in_review', 'released', 'obsolete'];
/** Which state a document may be moved to from each state (saving and releasing move it too). */
export const LIFECYCLE_MOVES: Record<LifecycleState, LifecycleState[]> = {
  draft: ['in_review', 'released', 'obsolete'],
  in_review: ['draft', 'released', 'obsolete'],
  released: ['draft', 'obsolete'],
  obsolete: ['draft'],
};
export const STATE_LABEL: Record<LifecycleState, string> = { draft: 'Draft', in_review: 'In review', released: 'Released', obsolete: 'Obsolete' };

export interface LifecycleEvent {
  id: number;
  documentId: string;
  from: LifecycleState | null;
  to: LifecycleState;
  /** The newest version when it happened. */
  version: number;
  note: string;
  createdAt: string;
}

export interface VersionRecord {
  documentId: string;
  number: number;
  message: string;
  createdAt: string;
  /** Bytes of the project file. */
  size: number;
  sha256: string;
  revision: string | null;
  releasedAt: string | null;
}

export interface ApiKeyRecord { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }

export type JobKind = 'rebuild' | 'export';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export interface JobRecord {
  id: string;
  kind: JobKind;
  documentId: string;
  version: number;
  format: string | null;
  status: JobStatus;
  error: string | null;
  /** What the job found (rebuild: errors, mass properties; export: file name and size). */
  result: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
}

export type WebhookEvent = 'document.saved' | 'revision.released' | 'document.state_changed' | 'job.finished';
export const WEBHOOK_EVENTS: WebhookEvent[] = ['document.saved', 'revision.released', 'document.state_changed', 'job.finished'];
export interface WebhookRecord { id: string; url: string; events: WebhookEvent[]; createdAt: string; active: boolean }
export interface DeliveryRecord { id: number; webhookId: string; event: WebhookEvent; status: number | null; error: string | null; createdAt: string }

/** Thrown for problems the caller can fix; `status` is the HTTP status to answer with. */
export class LibraryError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LibraryError';
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** A, B, … Z, AA, AB, … */
export function revisionLetter(index: number): string {
  let n = index + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const SCHEMA = [
  // version 1
  `CREATE TABLE documents (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, head_version INTEGER NOT NULL
   );
   CREATE TABLE versions (
     document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, number INTEGER NOT NULL,
     message TEXT NOT NULL, created_at TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
     revision TEXT, released_at TEXT, PRIMARY KEY (document_id, number)
   );
   CREATE UNIQUE INDEX versions_revision ON versions(document_id, revision) WHERE revision IS NOT NULL;
   CREATE TABLE api_keys (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
   );
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, document_id TEXT NOT NULL, version INTEGER NOT NULL, format TEXT,
     status TEXT NOT NULL, error TEXT, result TEXT, created_at TEXT NOT NULL, finished_at TEXT
   );
   CREATE TABLE webhooks (
     id TEXT PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL
   );
   CREATE TABLE deliveries (
     id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
     event TEXT NOT NULL, status INTEGER, error TEXT, created_at TEXT NOT NULL
   );`,
  // version 2: lifecycle states and their history
  `ALTER TABLE documents ADD COLUMN state TEXT NOT NULL DEFAULT 'draft';
   UPDATE documents SET state = 'released'
     WHERE EXISTS (SELECT 1 FROM versions v WHERE v.document_id = documents.id AND v.number = documents.head_version AND v.revision IS NOT NULL);
   CREATE TABLE lifecycle_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     from_state TEXT, to_state TEXT NOT NULL, version INTEGER NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
   );
   CREATE INDEX lifecycle_events_document ON lifecycle_events(document_id, id);`,
  // version 3: parts and assemblies, and which assembly versions use which library parts
  `ALTER TABLE documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'part';
   CREATE TABLE part_references (
     parent_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, parent_version INTEGER NOT NULL,
     child_id TEXT NOT NULL, child_version INTEGER, count INTEGER NOT NULL
   );
   CREATE INDEX part_references_child ON part_references(child_id);
   CREATE INDEX part_references_parent ON part_references(parent_id, parent_version);`,
];

/** What a project file says about itself: part or assembly, and the library parts its components use. */
export function analyzeContent(content: string): { kind: 'part' | 'assembly'; references: Array<{ documentId: string; version: number | null; count: number }> } {
  let p: { documentType?: string; features?: unknown[]; assemblyComponents?: Array<{ source?: { library?: { documentId?: unknown; version?: unknown } } }> };
  try { p = JSON.parse(content); } catch { return { kind: 'part', references: [] }; }
  const comps = Array.isArray(p.assemblyComponents) ? p.assemblyComponents : [];
  const kind = p.documentType === 'assembly' || (p.documentType === undefined && comps.length > 0 && (!Array.isArray(p.features) || p.features.length === 0)) ? 'assembly' : 'part';
  const refs = new Map<string, { documentId: string; version: number | null; count: number }>();
  for (const c of comps) {
    const lib = c?.source?.library;
    if (!lib || typeof lib.documentId !== 'string') continue;
    const version = Number.isInteger(lib.version) ? lib.version as number : null;
    const key = `${lib.documentId}@${version ?? ''}`;
    const r = refs.get(key) ?? { documentId: lib.documentId, version, count: 0 };
    r.count++;
    refs.set(key, r);
  }
  return { kind, references: [...refs.values()] };
}

type Row = Record<string, unknown>;

export class Library {
  readonly dir: string;
  private db: DatabaseSync;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    mkdirSync(join(dir, 'exports'), { recursive: true });
    this.db = new DatabaseSync(join(dir, 'library.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    const at = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    for (let v = at; v < SCHEMA.length; v++) {
      this.transaction(() => {
        this.db.exec(SCHEMA[v]);
        if (v === 2) this.backfillReferences();
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Version 3: read every saved version once for its kind and the parts it uses. */
  private backfillReferences(): void {
    const versions = this.db.prepare('SELECT v.document_id, v.number, v.sha256, d.head_version FROM versions v JOIN documents d ON d.id = v.document_id').all() as Row[];
    for (const v of versions) {
      let content: string;
      try { content = readFileSync(join(this.dir, 'blobs', String(v.sha256)), 'utf8'); } catch { continue; }
      this.recordContent(String(v.document_id), Number(v.number), content, Number(v.number) === Number(v.head_version));
    }
  }

  /** Note a version's kind (when it is the newest) and the library parts it uses. */
  private recordContent(documentId: string, version: number, content: string, isHead: boolean): void {
    const { kind, references } = analyzeContent(content);
    if (isHead) this.db.prepare('UPDATE documents SET kind = ? WHERE id = ?').run(kind, documentId);
    this.db.prepare('DELETE FROM part_references WHERE parent_id = ? AND parent_version = ?').run(documentId, version);
    const ins = this.db.prepare('INSERT INTO part_references (parent_id, parent_version, child_id, child_version, count) VALUES (?, ?, ?, ?, ?)');
    for (const r of references) ins.run(documentId, version, r.documentId, r.version, r.count);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------------- content
  private writeBlob(content: string): { sha: string; size: number } {
    const sha = sha256(content);
    const path = join(this.dir, 'blobs', sha);
    if (!existsSync(path)) writeFileSync(path, content);
    return { sha, size: Buffer.byteLength(content) };
  }

  private static checkContent(content: unknown): string {
    if (typeof content !== 'string' || !content.trim()) throw new LibraryError(400, 'INVALID_ARGUMENT', 'content must be the project file text');
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { features?: unknown }).features)) throw new Error('no features');
    } catch {
      throw new LibraryError(400, 'INVALID_ARGUMENT', 'content is not a CasiWorks project (expected JSON with a features list)');
    }
    return content;
  }

  private static checkName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim()) throw new LibraryError(400, 'INVALID_ARGUMENT', 'name must be a non-empty string');
    if (name.length > 200) throw new LibraryError(400, 'INVALID_ARGUMENT', 'name must be at most 200 characters');
    return name.trim();
  }

  // ---------------------------------------------------------------- documents
  private toDocument(r: Row): DocumentRecord {
    return {
      id: String(r.id), name: String(r.name), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
      headVersion: Number(r.head_version), latestRevision: (r.latest_revision as string | null) ?? null,
      state: String(r.state) as LifecycleState,
      kind: r.kind === 'assembly' ? 'assembly' : 'part',
    };
  }

  private static DOC_SELECT = `SELECT d.*, (SELECT revision FROM versions v WHERE v.document_id = d.id AND v.revision IS NOT NULL ORDER BY v.number DESC LIMIT 1) AS latest_revision FROM documents d`;

  /** Documents, newest change first; `query` filters by name, `state` by lifecycle state. */
  listDocuments(query?: string, state?: string): DocumentRecord[] {
    const where: string[] = [], args: string[] = [];
    if (query) { where.push(`d.name LIKE ? ESCAPE '\\'`); args.push(`%${query.replace(/[\\%_]/g, c => '\\' + c)}%`); }
    if (state) { where.push('d.state = ?'); args.push(Library.checkState(state)); }
    const rows = this.db.prepare(`${Library.DOC_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC`).all(...args);
    return rows.map(r => this.toDocument(r as Row));
  }

  private static checkState(state: unknown): LifecycleState {
    if (!LIFECYCLE_STATES.includes(state as LifecycleState)) throw new LibraryError(400, 'INVALID_ARGUMENT', `state must be one of ${LIFECYCLE_STATES.join(', ')}`);
    return state as LifecycleState;
  }

  getDocument(id: string): DocumentRecord {
    const r = this.db.prepare(`${Library.DOC_SELECT} WHERE d.id = ?`).get(id);
    if (!r) throw new LibraryError(404, 'NOT_FOUND', `No document ${JSON.stringify(id)}`);
    return this.toDocument(r as Row);
  }

  /** A new document with its first version. */
  createDocument(name: unknown, content: unknown, message = 'Created'): { document: DocumentRecord; version: VersionRecord } {
    const n = Library.checkName(name);
    const c = Library.checkContent(content);
    const { sha, size } = this.writeBlob(c);
    const id = randomUUID(), t = now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO documents (id, name, created_at, updated_at, head_version) VALUES (?, ?, ?, ?, 1)').run(id, n, t, t);
      this.db.prepare('INSERT INTO versions (document_id, number, message, created_at, size, sha256) VALUES (?, 1, ?, ?, ?, ?)').run(id, String(message), t, size, sha);
      this.recordMove(id, null, 'draft', 1, 'Created', t);
      this.recordContent(id, 1, c, true);
    });
    return { document: this.getDocument(id), version: this.getVersion(id, 1) };
  }

  renameDocument(id: string, name: unknown): DocumentRecord {
    const n = Library.checkName(name);
    this.getDocument(id);
    this.db.prepare('UPDATE documents SET name = ?, updated_at = ? WHERE id = ?').run(n, now(), id);
    return this.getDocument(id);
  }

  deleteDocument(id: string): void {
    this.getDocument(id);
    const users = this.whereUsed(id).filter(u => u.current);
    if (users.length) {
      throw new LibraryError(409, 'IN_USE', `Used by ${users.map(u => u.document.name).join(', ')}: remove it from ${users.length === 1 ? 'that assembly' : 'those assemblies'} first`);
    }
    this.transaction(() => {
      this.db.prepare('DELETE FROM versions WHERE document_id = ?').run(id);
      this.db.prepare('DELETE FROM lifecycle_events WHERE document_id = ?').run(id);
      this.db.prepare('DELETE FROM part_references WHERE parent_id = ?').run(id);
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    });
    this.collectBlobs();
  }

  /** Remove content no version refers to any more. */
  private collectBlobs(): void {
    const used = new Set((this.db.prepare('SELECT DISTINCT sha256 FROM versions').all() as Row[]).map(r => String(r.sha256)));
    const dir = join(this.dir, 'blobs');
    for (const f of readdirSafe(dir)) if (!used.has(f)) rmSync(join(dir, f), { force: true });
  }

  // ---------------------------------------------------------------- versions
  private toVersion(r: Row): VersionRecord {
    return {
      documentId: String(r.document_id), number: Number(r.number), message: String(r.message), createdAt: String(r.created_at),
      size: Number(r.size), sha256: String(r.sha256), revision: (r.revision as string | null) ?? null, releasedAt: (r.released_at as string | null) ?? null,
    };
  }

  listVersions(documentId: string): VersionRecord[] {
    this.getDocument(documentId);
    return (this.db.prepare('SELECT * FROM versions WHERE document_id = ? ORDER BY number DESC').all(documentId) as Row[]).map(r => this.toVersion(r));
  }

  getVersion(documentId: string, number: number): VersionRecord {
    this.getDocument(documentId);
    const r = this.db.prepare('SELECT * FROM versions WHERE document_id = ? AND number = ?').get(documentId, number);
    if (!r) throw new LibraryError(404, 'NOT_FOUND', `Document has no version ${number}`);
    return this.toVersion(r as Row);
  }

  readContent(documentId: string, number: number): string {
    const v = this.getVersion(documentId, number);
    return readFileSync(join(this.dir, 'blobs', v.sha256), 'utf8');
  }

  /**
   * Save a new version. With `baseVersion` (the version the saver started from) a
   * save on top of a newer version is refused (409 CONFLICT), so two windows
   * cannot overwrite each other's work unnoticed.
   */
  addVersion(documentId: string, content: unknown, message: unknown, baseVersion?: number): VersionRecord {
    const c = Library.checkContent(content);
    const msg = message === undefined ? '' : String(message).slice(0, 500);
    const { sha, size } = this.writeBlob(c);
    const number = this.transaction(() => {
      const doc = this.db.prepare('SELECT head_version, state FROM documents WHERE id = ?').get(documentId) as Row | undefined;
      if (!doc) throw new LibraryError(404, 'NOT_FOUND', `No document ${JSON.stringify(documentId)}`);
      const head = Number(doc.head_version);
      const state = String(doc.state) as LifecycleState;
      if (state === 'in_review') throw new LibraryError(409, 'LOCKED', 'The document is in review: return it to draft to save changes');
      if (state === 'obsolete') throw new LibraryError(409, 'LOCKED', 'The document is obsolete: reactivate it (back to draft) to save changes');
      if (baseVersion !== undefined && baseVersion !== head) {
        throw new LibraryError(409, 'CONFLICT', `Version ${head} was saved after version ${baseVersion}, which this was based on; open version ${head} and save again`);
      }
      const t = now();
      this.db.prepare('INSERT INTO versions (document_id, number, message, created_at, size, sha256) VALUES (?, ?, ?, ?, ?, ?)').run(documentId, head + 1, msg, t, size, sha);
      this.db.prepare(`UPDATE documents SET head_version = ?, updated_at = ?, state = 'draft' WHERE id = ?`).run(head + 1, t, documentId);
      this.recordContent(documentId, head + 1, c, true);
      // Changing a released document starts work on its next revision
      if (state === 'released') this.recordMove(documentId, 'released', 'draft', head + 1, `Version ${head + 1} saved: work on the next revision`, t);
      return head + 1;
    });
    return this.getVersion(documentId, number);
  }

  /**
   * Release a version: it gets the next revision letter. A version is released
   * once. Releasing the newest version makes the document released.
   */
  release(documentId: string, number: number, note = ''): VersionRecord {
    return this.transaction(() => {
      const v = this.getVersion(documentId, number);
      const doc = this.getDocument(documentId);
      if (doc.state === 'obsolete') throw new LibraryError(409, 'LOCKED', 'The document is obsolete: reactivate it before releasing');
      if (v.revision) throw new LibraryError(409, 'CONFLICT', `Version ${number} is already revision ${v.revision}`);
      const later = this.db.prepare('SELECT number, revision FROM versions WHERE document_id = ? AND revision IS NOT NULL AND number > ?').get(documentId, number) as Row | undefined;
      if (later) throw new LibraryError(409, 'CONFLICT', `A later version (${later.number}) is already revision ${later.revision}`);
      const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM versions WHERE document_id = ? AND revision IS NOT NULL').get(documentId) as Row).n);
      const t = now(), letter = revisionLetter(count);
      this.db.prepare('UPDATE versions SET revision = ?, released_at = ? WHERE document_id = ? AND number = ?').run(letter, t, documentId, number);
      if (number === doc.headVersion) {
        this.db.prepare(`UPDATE documents SET state = 'released', updated_at = ? WHERE id = ?`).run(t, documentId);
        this.recordMove(documentId, doc.state, 'released', number, note.trim() || `Version ${number} released as revision ${letter}`, t);
      }
      return this.getVersion(documentId, number);
    });
  }

  // ---------------------------------------------------------------- where used
  /** The assemblies that use this part (any of their versions), the ones using it now first. */
  whereUsed(partId: string): WhereUsedRecord[] {
    this.getDocument(partId);
    const rows = this.db.prepare(`SELECT r.parent_id, r.parent_version, r.child_version, r.count, d.name, d.head_version, d.state
      FROM part_references r JOIN documents d ON d.id = r.parent_id WHERE r.child_id = ? ORDER BY r.parent_version DESC`).all(partId) as Row[];
    const by = new Map<string, WhereUsedRecord>();
    for (const r of rows) {
      const id = String(r.parent_id);
      let u = by.get(id);
      if (!u) {
        u = { document: { id, name: String(r.name), headVersion: Number(r.head_version), state: String(r.state) as LifecycleState }, versions: [], current: false, pinnedVersion: null, count: 0 };
        by.set(id, u);
      }
      const pv = Number(r.parent_version);
      if (!u.versions.includes(pv)) u.versions.push(pv);
      if (pv === u.versions[0]) {
        u.pinnedVersion = r.child_version === null ? null : Number(r.child_version);
        u.count = Math.max(u.count, Number(r.count));
      }
      if (pv === u.document.headVersion) u.current = true;
    }
    return [...by.values()].sort((a, b) => Number(b.current) - Number(a.current) || a.document.name.localeCompare(b.document.name));
  }

  // ---------------------------------------------------------------- lifecycle
  private recordMove(documentId: string, from: LifecycleState | null, to: LifecycleState, version: number, note: string, at: string): void {
    this.db.prepare('INSERT INTO lifecycle_events (document_id, from_state, to_state, version, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(documentId, from, to, version, note, at);
  }

  /**
   * Move a document to another lifecycle state (LIFECYCLE_MOVES says which are
   * allowed). Moving to released releases the newest version as the next revision.
   */
  setState(documentId: string, to: unknown, note: unknown = ''): { document: DocumentRecord; version: VersionRecord | null; newRevision: boolean } {
    const target = Library.checkState(to);
    const text = note === undefined || note === null ? '' : String(note).slice(0, 500).trim();
    const doc = this.getDocument(documentId);
    if (doc.state === target) throw new LibraryError(409, 'CONFLICT', `The document is already ${STATE_LABEL[target].toLowerCase()}`);
    if (!LIFECYCLE_MOVES[doc.state].includes(target)) {
      throw new LibraryError(409, 'CONFLICT', `A document that is ${STATE_LABEL[doc.state].toLowerCase()} cannot be moved to ${STATE_LABEL[target].toLowerCase()}`
        + ` (it can go to: ${LIFECYCLE_MOVES[doc.state].map(s => STATE_LABEL[s].toLowerCase()).join(', ')})`);
    }
    if (target === 'released') {
      const head = this.getVersion(documentId, doc.headVersion);
      if (head.revision) {
        // Already a revision (e.g. sent to review straight after a release): just mark it released again
        this.transaction(() => {
          this.db.prepare(`UPDATE documents SET state = 'released', updated_at = ? WHERE id = ?`).run(now(), documentId);
          this.recordMove(documentId, doc.state, 'released', doc.headVersion, text || `Revision ${head.revision} (version ${head.number}) is current`, now());
        });
        return { document: this.getDocument(documentId), version: this.getVersion(documentId, doc.headVersion), newRevision: false };
      }
      const version = this.release(documentId, doc.headVersion, text);
      return { document: this.getDocument(documentId), version, newRevision: true };
    }
    const defaults: Record<LifecycleState, string> = {
      draft: doc.state === 'in_review' ? 'Returned to draft' : doc.state === 'obsolete' ? 'Reactivated' : 'Work on the next revision',
      in_review: `Version ${doc.headVersion} sent for review`,
      released: '',
      obsolete: 'Made obsolete',
    };
    const t = now();
    this.transaction(() => {
      this.db.prepare('UPDATE documents SET state = ?, updated_at = ? WHERE id = ?').run(target, t, documentId);
      this.recordMove(documentId, doc.state, target, doc.headVersion, text || defaults[target], t);
    });
    return { document: this.getDocument(documentId), version: null, newRevision: false };
  }

  /** The lifecycle history, newest first. */
  listLifecycle(documentId: string): LifecycleEvent[] {
    this.getDocument(documentId);
    return (this.db.prepare('SELECT * FROM lifecycle_events WHERE document_id = ? ORDER BY id DESC').all(documentId) as Row[]).map(r => ({
      id: Number(r.id), documentId: String(r.document_id), from: (r.from_state as LifecycleState | null) ?? null, to: String(r.to_state) as LifecycleState,
      version: Number(r.version), note: String(r.note), createdAt: String(r.created_at),
    }));
  }

  // ---------------------------------------------------------------- API keys
  /** A new key; the secret is returned only here (only its hash is kept). */
  createKey(name: unknown): { key: ApiKeyRecord; secret: string } {
    const n = Library.checkName(name);
    const secret = `cw_${randomBytes(24).toString('base64url')}`;
    const id = randomUUID();
    this.db.prepare('INSERT INTO api_keys (id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, n, secret.slice(0, 7), sha256(secret), now());
    return { key: this.listKeys().find(k => k.id === id)!, secret };
  }

  listKeys(): ApiKeyRecord[] {
    return (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at').all() as Row[]).map(r => ({
      id: String(r.id), name: String(r.name), prefix: String(r.prefix), createdAt: String(r.created_at), lastUsedAt: (r.last_used_at as string | null) ?? null,
    }));
  }

  deleteKey(id: string): void {
    const r = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    if (!r.changes) throw new LibraryError(404, 'NOT_FOUND', `No API key ${JSON.stringify(id)}`);
  }

  /** The key a secret belongs to (and note its use), or null. */
  checkKey(secret: string): ApiKeyRecord | null {
    if (!secret.startsWith('cw_')) return null;
    const hash = Buffer.from(sha256(secret), 'hex');
    for (const r of this.db.prepare('SELECT id, hash FROM api_keys').all() as Row[]) {
      if (timingSafeEqual(hash, Buffer.from(String(r.hash), 'hex'))) {
        this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), String(r.id));
        return this.listKeys().find(k => k.id === r.id) ?? null;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- jobs
  private toJob(r: Row): JobRecord {
    return {
      id: String(r.id), kind: r.kind as JobKind, documentId: String(r.document_id), version: Number(r.version), format: (r.format as string | null) ?? null,
      status: r.status as JobStatus, error: (r.error as string | null) ?? null, result: r.result ? JSON.parse(String(r.result)) as Record<string, unknown> : null,
      createdAt: String(r.created_at), finishedAt: (r.finished_at as string | null) ?? null,
    };
  }

  createJob(kind: JobKind, documentId: string, version: number, format: string | null): JobRecord {
    this.getVersion(documentId, version);
    const id = randomUUID();
    this.db.prepare('INSERT INTO jobs (id, kind, document_id, version, format, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, kind, documentId, version, format, 'queued', now());
    return this.getJob(id);
  }

  getJob(id: string): JobRecord {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!r) throw new LibraryError(404, 'NOT_FOUND', `No job ${JSON.stringify(id)}`);
    return this.toJob(r as Row);
  }

  listJobs(limit = 50): JobRecord[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(r => this.toJob(r));
  }

  nextQueuedJob(): JobRecord | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
    return r ? this.toJob(r as Row) : null;
  }

  updateJob(id: string, status: JobStatus, fields: { error?: string; result?: Record<string, unknown> } = {}): JobRecord {
    const finished = status === 'done' || status === 'failed' ? now() : null;
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(status, fields.error ?? null, fields.result ? JSON.stringify(fields.result) : null, finished, id);
    return this.getJob(id);
  }

  exportPath(jobId: string): string { return join(this.dir, 'exports', jobId); }

  // ---------------------------------------------------------------- webhooks
  private toWebhook(r: Row): WebhookRecord {
    return { id: String(r.id), url: String(r.url), events: JSON.parse(String(r.events)) as WebhookEvent[], createdAt: String(r.created_at), active: Number(r.active) === 1 };
  }

  createWebhook(url: unknown, events: unknown): { webhook: WebhookRecord; secret: string } {
    if (typeof url !== 'string') throw new LibraryError(400, 'INVALID_ARGUMENT', 'url must be a string');
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new LibraryError(400, 'INVALID_ARGUMENT', 'url is not a valid URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new LibraryError(400, 'INVALID_ARGUMENT', 'url must be http or https');
    const list = events === undefined ? WEBHOOK_EVENTS : events;
    if (!Array.isArray(list) || list.length === 0 || !list.every(e => WEBHOOK_EVENTS.includes(e as WebhookEvent))) {
      throw new LibraryError(400, 'INVALID_ARGUMENT', `events must be a non-empty list of ${WEBHOOK_EVENTS.join(', ')}`);
    }
    const id = randomUUID(), secret = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO webhooks (id, url, events, secret, created_at, active) VALUES (?, ?, ?, ?, ?, 1)').run(id, parsed.href, JSON.stringify([...new Set(list)]), secret, now());
    return { webhook: this.getWebhook(id), secret };
  }

  getWebhook(id: string): WebhookRecord {
    const r = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    if (!r) throw new LibraryError(404, 'NOT_FOUND', `No webhook ${JSON.stringify(id)}`);
    return this.toWebhook(r as Row);
  }

  listWebhooks(): WebhookRecord[] {
    return (this.db.prepare('SELECT * FROM webhooks ORDER BY created_at').all() as Row[]).map(r => this.toWebhook(r));
  }

  webhookSecret(id: string): string {
    return String((this.db.prepare('SELECT secret FROM webhooks WHERE id = ?').get(id) as Row).secret);
  }

  deleteWebhook(id: string): void {
    const r = this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    if (!r.changes) throw new LibraryError(404, 'NOT_FOUND', `No webhook ${JSON.stringify(id)}`);
  }

  recordDelivery(webhookId: string, event: WebhookEvent, status: number | null, error: string | null): void {
    this.db.prepare('INSERT INTO deliveries (webhook_id, event, status, error, created_at) VALUES (?, ?, ?, ?, ?)').run(webhookId, event, status, error, now());
  }

  listDeliveries(webhookId: string, limit = 50): DeliveryRecord[] {
    this.getWebhook(webhookId);
    return (this.db.prepare('SELECT * FROM deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?').all(webhookId, limit) as Row[]).map(r => ({
      id: Number(r.id), webhookId: String(r.webhook_id), event: r.event as WebhookEvent, status: r.status === null ? null : Number(r.status),
      error: (r.error as string | null) ?? null, createdAt: String(r.created_at),
    }));
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
