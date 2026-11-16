// CasiWorks Pro - Autosave: keep the open document in the browser and bring it back after a reload
//
// The document is written (as the same JSON a .casiproj file holds) shortly after
// each change, and when the page is hidden. On start-up the app restores it, so a
// reload, a crash or a closed tab does not lose work. Undo history is not kept.

/** Where the snapshot lives. IndexedDB in the browser; anything with these three methods in tests. */
export interface AutosaveStorage {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  clear(): Promise<void>;
}

/** What autosave needs from the store (CADStore satisfies it). */
export interface AutosaveState {
  documentName: string;
  isModified: boolean;
  statusMessage: string;
  features: unknown;
  sketchEntities: unknown;
  sketchConstraints: unknown;
  sketchDimensions: unknown;
  rollbackIndex: number;
  activeMaterial: string;
  settings: unknown;
  assemblyComponents: unknown;
  mates: unknown;
  variables: unknown;
  saveProject(): string;
  loadProject(json: string): void;
  setStatus(message: string): void;
}

export interface AutosaveStore<S> {
  getState(): S;
  setState(partial: Partial<S>): void;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

interface Snapshot {
  format: 'casiworks-autosave';
  version: 1;
  savedAt: number;
  /** The unsaved-changes flag at the time, so the title bar dot survives the reload. */
  modified: boolean;
  project: string;
}

/** The parts of the state that are saved in a project: a change to any of them is a document change. */
const DOCUMENT_KEYS = [
  'documentName', 'features', 'sketchEntities', 'sketchConstraints', 'sketchDimensions',
  'rollbackIndex', 'activeMaterial', 'settings', 'assemblyComponents', 'mates', 'variables',
] as const satisfies ReadonlyArray<keyof AutosaveState>;

/** True when the store update changed the document (the store is immutable, so comparing references is enough). */
export function documentChanged(a: AutosaveState, b: AutosaveState): boolean {
  return DOCUMENT_KEYS.some(k => a[k] !== b[k]);
}

function parseSnapshot(text: string | null): Snapshot | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as Partial<Snapshot>;
    if (s.format !== 'casiworks-autosave' || s.version !== 1 || typeof s.project !== 'string') return null;
    return { format: s.format, version: 1, savedAt: Number(s.savedAt) || 0, modified: s.modified === true, project: s.project };
  } catch {
    return null;
  }
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Restore the autosaved document, if there is one. Returns the message saying so (also shown in the
 * status bar), or null when nothing was restored.
 * A snapshot that cannot be read or loaded is removed, so a bad one cannot block start-up again.
 */
export async function restoreAutosave<S extends AutosaveState>(store: AutosaveStore<S>, storage: AutosaveStorage): Promise<string | null> {
  let snapshot: Snapshot | null;
  try {
    snapshot = parseSnapshot(await storage.read());
  } catch {
    return null; // storage unavailable (private window, blocked site data)
  }
  if (!snapshot) {
    await storage.clear().catch(() => {});
    return null;
  }
  store.getState().loadProject(snapshot.project);
  if (store.getState().statusMessage.startsWith('Error loading project')) {
    await storage.clear().catch(() => {});
    return null;
  }
  store.setState({ isModified: snapshot.modified } as Partial<S>);
  const message = `Restored ${store.getState().documentName} from autosave (${clock(snapshot.savedAt)})`;
  store.getState().setStatus(message);
  return message;
}

export interface AutosaveHandle {
  /** Write now if a change is waiting. */
  flush(): Promise<void>;
  stop(): void;
}

/** Save the document `delayMs` after the last change. */
export function startAutosave<S extends AutosaveState>(
  store: AutosaveStore<S>,
  storage: AutosaveStorage,
  { delayMs = 1000, now = Date.now }: { delayMs?: number; now?: () => number } = {},
): AutosaveHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let failed = false;

  const write = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    pending = false;
    const state = store.getState();
    const snapshot: Snapshot = { format: 'casiworks-autosave', version: 1, savedAt: now(), modified: state.isModified, project: state.saveProject() };
    try {
      await storage.write(JSON.stringify(snapshot));
      failed = false;
    } catch (err) {
      if (!failed) state.setStatus(`Autosave failed: ${err instanceof Error ? err.message : String(err)}`);
      failed = true; // say it once, keep trying on later changes
    }
  };

  const unsubscribe = store.subscribe((state, prev) => {
    // The unsaved-changes flag alone (e.g. after Save) also updates the snapshot
    if (!documentChanged(state, prev) && state.isModified === prev.isModified) return;
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void write(); }, delayMs);
  });

  return {
    flush: write,
    stop: () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// ------------------------------------------------------------------ IndexedDB

const DB_NAME = 'casiworks';
const STORE = 'autosave';
const KEY = 'current';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** The browser's IndexedDB, one record holding the current document. */
export function indexedDBStorage(idb: IDBFactory = indexedDB): AutosaveStorage {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { db = null; reject(req.error ?? new Error('Cannot open IndexedDB')); };
      req.onblocked = () => { db = null; reject(new Error('IndexedDB is blocked by another tab')); };
    });
    return db;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    read: async () => {
      const v = await request((await tx('readonly')).get(KEY));
      return typeof v === 'string' ? v : null;
    },
    write: async (text) => { await request((await tx('readwrite')).put(text, KEY)); },
    clear: async () => { await request((await tx('readwrite')).delete(KEY)); },
  };
}

/** A storage in memory (tests, and browsers without IndexedDB). */
export function memoryStorage(initial: string | null = null): AutosaveStorage & { text: string | null } {
  const s = {
    text: initial,
    read: async () => s.text,
    write: async (text: string) => { s.text = text; },
    clear: async () => { s.text = null; },
  };
  return s;
}
