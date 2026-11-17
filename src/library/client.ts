// CasiWorks Pro - Talk to the local library server (npm run server) from the app
//
// The app finds the server at /api/v1 on its own origin: served by the local
// server itself, or through the Vite dev server's proxy. Without one, every
// call fails with LibraryUnavailable and the app works as before (files only).

export type LifecycleState = 'draft' | 'in_review' | 'released' | 'obsolete';
export const STATE_LABEL: Record<LifecycleState, string> = { draft: 'Draft', in_review: 'In review', released: 'Released', obsolete: 'Obsolete' };
/** Where a document may be moved from each state (as the server allows). */
export const LIFECYCLE_MOVES: Record<LifecycleState, LifecycleState[]> = {
  draft: ['in_review', 'released', 'obsolete'],
  in_review: ['draft', 'released', 'obsolete'],
  released: ['draft', 'obsolete'],
  obsolete: ['draft'],
};
export interface LibraryDocument { id: string; name: string; createdAt: string; updatedAt: string; headVersion: number; latestRevision: string | null; state: LifecycleState }
export interface LifecycleEvent { id: number; documentId: string; from: LifecycleState | null; to: LifecycleState; version: number; note: string; createdAt: string }
export interface LibraryVersion { documentId: string; number: number; message: string; createdAt: string; size: number; sha256: string; revision: string | null; releasedAt: string | null }

export class LibraryUnavailable extends Error {
  constructor() {
    super('The document library is not running: start it with `npm run server` and open the app from it (http://127.0.0.1:5180)');
    this.name = 'LibraryUnavailable';
  }
}

/** An error the server answered with (code as in the API, e.g. CONFLICT). */
export class LibraryRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LibraryRequestError';
    this.status = status;
    this.code = code;
  }
}

const BASE = '/api/v1';
let token: Promise<string> | null = null;

async function sessionToken(): Promise<string> {
  token ??= (async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/session`, { signal: AbortSignal.timeout(3000) });
    } catch {
      throw new LibraryUnavailable();
    }
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('json')) throw new LibraryUnavailable();
    return ((await res.json()) as { token: string }).token;
  })();
  try {
    return await token;
  } catch (err) {
    token = null; // try again next time (the server may have been started since)
    throw err;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const t = await sessionToken();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${t}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    token = null;
    throw new LibraryUnavailable();
  }
  if (res.status === 401) token = null; // the server restarted: a new session
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    if (!res.ok) throw new LibraryUnavailable();
    return (await res.text()) as T;
  }
  const data = await res.json() as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new LibraryRequestError(res.status, data.error?.code ?? 'ERROR', data.error?.message ?? `HTTP ${res.status}`);
  return data;
}

export const library = {
  /** true when the server answers. */
  async available(): Promise<boolean> {
    try { await sessionToken(); return true; } catch { return false; }
  },
  async documents(query?: string): Promise<LibraryDocument[]> {
    return (await call<{ documents: LibraryDocument[] }>('GET', `/documents${query ? `?q=${encodeURIComponent(query)}` : ''}`)).documents;
  },
  document(documentId: string) {
    return call<LibraryDocument>('GET', `/documents/${encodeURIComponent(documentId)}`);
  },
  create(name: string, content: string, message?: string) {
    return call<{ document: LibraryDocument; version: LibraryVersion }>('POST', '/documents', { name, content, ...(message ? { message } : {}) });
  },
  async versions(documentId: string): Promise<LibraryVersion[]> {
    return (await call<{ versions: LibraryVersion[] }>('GET', `/documents/${encodeURIComponent(documentId)}/versions`)).versions;
  },
  /** Save on top of `baseVersion`; a CONFLICT error when someone saved since. */
  save(documentId: string, content: string, message: string, baseVersion: number) {
    return call<LibraryVersion>('POST', `/documents/${encodeURIComponent(documentId)}/versions`, { content, message, baseVersion });
  },
  /** The project file of a version (as text). */
  async content(documentId: string, version: number | 'latest'): Promise<string> {
    const data = await call<unknown>('GET', `/documents/${encodeURIComponent(documentId)}/versions/${version}/content`);
    return typeof data === 'string' ? data : JSON.stringify(data);
  },
  release(documentId: string, version: number) {
    return call<LibraryVersion>('POST', `/documents/${encodeURIComponent(documentId)}/versions/${version}/release`);
  },
  /** The lifecycle history, newest first. */
  async lifecycle(documentId: string): Promise<LifecycleEvent[]> {
    return (await call<{ events: LifecycleEvent[] }>('GET', `/documents/${encodeURIComponent(documentId)}/lifecycle`)).events;
  },
  /** Move a document to another state; released releases the newest version. */
  setState(documentId: string, state: LifecycleState, note?: string) {
    return call<{ document: LibraryDocument; version: LibraryVersion | null; newRevision: boolean; event: LifecycleEvent }>(
      'POST', `/documents/${encodeURIComponent(documentId)}/lifecycle`, { state, ...(note ? { note } : {}) });
  },
  remove(documentId: string) {
    return call<void>('DELETE', `/documents/${encodeURIComponent(documentId)}`);
  },
};
