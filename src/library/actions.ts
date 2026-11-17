// CasiWorks Pro - Save to and open from the local library (used by commands and the Library dialog)
import { library, LibraryRequestError } from './client.ts';
import type { LibraryVersion } from './client.ts';
import type { LibraryRef } from '../store/cadStore.ts';

/** The store slice these actions use. */
export interface LibraryState {
  documentName: string;
  needsRebuild: boolean;
  statusMessage: string;
  libraryRef: LibraryRef | null;
  saveProject(): string;
  loadProject(json: string): void;
  setLibraryRef(ref: LibraryRef | null, saved?: boolean): void;
  setStatus(message: string): void;
}
interface Store {
  getState(): LibraryState;
  /** When given, opening waits for the rebuild so its own message is not replaced by the rebuild's. */
  subscribe?(listener: (state: LibraryState) => void): () => void;
}

/** Show a message once the model has rebuilt (keeping a rebuild warning next to it). */
function statusAfterRebuild(store: Store, message: string): void {
  const show = () => {
    const after = store.getState().statusMessage;
    store.getState().setStatus(/warning|error/i.test(after) ? `${message} · ${after}` : message);
  };
  if (!store.subscribe || !store.getState().needsRebuild) { store.getState().setStatus(message); return; }
  store.getState().setStatus(message);
  const stop = store.subscribe(state => {
    if (state.needsRebuild) return;
    stop();
    // The rebuild writes its own status right after clearing the flag
    setTimeout(show, 0);
  });
}

/**
 * Save the open document to the library: a new version of the library document
 * it came from, or (the first time, or with `asNew`) a new library document.
 * A save on top of a version someone else has saved since is refused.
 */
export async function saveToLibrary(store: Store, options: { message?: string; asNew?: boolean } = {}): Promise<LibraryVersion> {
  const s = store.getState();
  const content = s.saveProject();
  const ref = options.asNew ? null : s.libraryRef;
  try {
    if (ref) {
      const v = await library.save(ref.documentId, content, options.message ?? '', ref.version);
      store.getState().setLibraryRef({ ...ref, version: v.number, opened: v.number }, true);
      store.getState().setStatus(`Saved ${ref.name} version ${v.number} to the library`);
      return v;
    }
    const { document, version } = await library.create(s.documentName, content, options.message || undefined);
    store.getState().setLibraryRef({ documentId: document.id, name: document.name, version: version.number, opened: version.number }, true);
    store.getState().setStatus(`Added ${document.name} to the library (version 1)`);
    return version;
  } catch (err) {
    const message = err instanceof LibraryRequestError && err.code === 'CONFLICT'
      ? `Not saved: ${err.message}. Your changes are still open; Save as new document keeps them separately.`
      : `Not saved to the library: ${err instanceof Error ? err.message : String(err)}`;
    store.getState().setStatus(message);
    throw err;
  }
}

/**
 * Open a version (default the newest) of a library document. Saving then makes
 * the next version, also when an older one was opened (to build on it).
 */
export async function openFromLibrary(store: Store, documentId: string, name: string, version: number | 'latest' = 'latest'): Promise<void> {
  const head = (await library.versions(documentId))[0].number;
  const number = version === 'latest' ? head : version;
  const content = await library.content(documentId, number);
  store.getState().loadProject(content);
  store.getState().setLibraryRef({ documentId, name, version: head, opened: number }, true);
  statusAfterRebuild(store, number === head
    ? `Opened ${name} version ${number} from the library`
    : `Opened ${name} version ${number} (the newest is ${head}); saving makes version ${head + 1}`);
}
