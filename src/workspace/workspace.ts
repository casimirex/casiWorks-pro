// CasiWorks Pro - Workspace: several open documents (parts and assemblies), one of them active
//
// The store holds the active document. The others wait here as their project
// content, with their unsaved-changes flag, library link and undo history, and
// are swapped into the store when activated. Each document keeps its own id (it
// is saved in its file), which is what an assembly's components refer to.
import { generateId } from '../utils/math.ts';
import type { CADStore, DocumentType, LibraryRef } from '../store/cadStore.ts';

export interface WorkspaceDocument {
  id: string;
  name: string;
  type: DocumentType;
  modified: boolean;
  active: boolean;
  /** The library document this was opened from or saved to. */
  libraryRef: LibraryRef | null;
}

interface Entry {
  id: string;
  name: string;
  type: DocumentType;
  modified: boolean;
  libraryRef: LibraryRef | null;
  /** Project content while inactive (null for the active document, which lives in the store). */
  content: string | null;
  undoStack: CADStore['undoStack'];
  redoStack: CADStore['redoStack'];
}

export interface WorkspaceStore {
  getState(): CADStore;
  setState(partial: Partial<CADStore>): void;
  subscribe(listener: (state: CADStore, prev: CADStore) => void): () => void;
}

/** The same project content, apart from when it was saved. */
function sameDocument(a: string | null, b: string): boolean {
  if (a === null) return false;
  try {
    const strip = (s: string) => { const o = JSON.parse(s) as Record<string, unknown>; delete o.timestamp; return JSON.stringify(o); };
    return strip(a) === strip(b);
  } catch {
    return a === b;
  }
}

export class Workspace {
  private store: WorkspaceStore;
  private entries: Entry[] = [];
  private listeners = new Set<() => void>();
  private snapshot: WorkspaceDocument[] = [];
  private switching = false;

  constructor(store: WorkspaceStore) {
    this.store = store;
    this.adoptActive();
    // The active document can be replaced or renamed in place (Open, New, rename): follow it
    store.subscribe((s, prev) => {
      if (this.switching) return;
      if (s.documentId !== prev.documentId || s.documentName !== prev.documentName || s.documentType !== prev.documentType
        || s.isModified !== prev.isModified || s.libraryRef !== prev.libraryRef) this.adoptActive();
    });
  }

  /** Keep the active entry in step with the store; a document whose id is already open elsewhere gets a new id. */
  private adoptActive(): void {
    const s = this.store.getState();
    let active = this.entries.find(e => e.content === null);
    if (this.entries.some(e => e.content !== null && e.id === s.documentId)) {
      // The same file opened twice: the second copy is a separate document
      this.switching = true;
      this.store.setState({ documentId: generateId('doc') });
      this.switching = false;
    }
    const st = this.store.getState();
    if (!active) {
      active = { id: st.documentId, name: st.documentName, type: st.documentType, modified: st.isModified, libraryRef: st.libraryRef, content: null, undoStack: [], redoStack: [] };
      this.entries.push(active);
    }
    Object.assign(active, { id: st.documentId, name: st.documentName, type: st.documentType, modified: st.isModified, libraryRef: st.libraryRef });
    this.emit();
  }

  private emit(): void {
    this.snapshot = this.entries.map(e => ({ id: e.id, name: e.name, type: e.type, modified: e.modified, active: e.content === null, libraryRef: e.libraryRef }));
    for (const l of this.listeners) l();
  }

  /** Called on every change of the open documents (for React's useSyncExternalStore). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The open documents, in tab order (the same array until something changes). */
  list(): WorkspaceDocument[] {
    return this.snapshot;
  }

  activeId(): string {
    return this.store.getState().documentId;
  }

  /** A document's project content: the active one as it is now, the others as they were left. */
  contentOf(id: string): string | null {
    const e = this.entries.find(x => x.id === id);
    if (!e) return null;
    return e.content ?? this.store.getState().saveProject();
  }

  /** Put the active document away (its content and state kept in its entry). */
  private stash(): void {
    const s = this.store.getState();
    const e = this.entries.find(x => x.content === null);
    if (!e) return;
    Object.assign(e, {
      id: s.documentId, name: s.documentName, type: s.documentType, modified: s.isModified, libraryRef: s.libraryRef,
      content: s.saveProject(), undoStack: s.undoStack, redoStack: s.redoStack,
    });
  }

  /** Bring an entry into the store. */
  private bringIn(e: Entry, status?: string): void {
    const content = e.content!;
    this.switching = true;
    try {
      this.store.getState().loadProject(content);
      e.content = null;
      this.store.setState({
        documentId: e.id,
        isModified: e.modified,
        libraryRef: e.libraryRef,
        undoStack: e.undoStack,
        redoStack: e.redoStack,
        activeCommandTab: e.type === 'assembly' ? 'Assembly' : 'Features',
        propertyPanelOpen: false,
        propertyPanelContent: null,
        selectedEntities: [],
        ...(status ? { statusMessage: status } : {}),
      });
    } finally {
      this.switching = false;
    }
    this.emit();
  }

  /** Make a document the active one. */
  activate(id: string): void {
    const target = this.entries.find(e => e.id === id);
    if (!target) throw new Error(`No open document ${JSON.stringify(id)}`);
    if (target.content === null) return;
    this.stash();
    this.bringIn(target, `${target.name}`);
  }

  /** A new, empty part or assembly, made active. Returns its id. */
  newDocument(type: DocumentType, name?: string): string {
    this.stash();
    this.switching = true;
    try {
      const s = this.store.getState();
      s.newProject();
      if (type === 'assembly') this.store.getState().setDocumentType('assembly');
      const base = type === 'assembly' ? 'Assembly' : 'Part';
      let n = 1;
      while (this.entries.some(e => e.name === `${base}${n}`)) n++;
      this.store.setState({ documentName: name ?? `${base}${n}`, statusMessage: `New ${type}` });
      const fresh = this.store.getState();
      this.entries.push({ id: fresh.documentId, name: fresh.documentName, type, modified: false, libraryRef: null, content: null, undoStack: [], redoStack: [] });
    } finally {
      this.switching = false;
    }
    this.emit();
    return this.activeId();
  }

  /** True when the active document is an untouched new one (opening a file can replace it). */
  private activeIsBlank(): boolean {
    const s = this.store.getState();
    return !s.isModified && !s.libraryRef && /^(Untitled Part|Part\d+|Assembly\d+)$/.test(s.documentName)
      && (s.documentType === 'part' || s.assemblyComponents.length === 0);
  }

  /**
   * Open project content as a document (made active). A document already open (same
   * id and the same content) is just activated. Returns its id.
   */
  open(content: string, options: { libraryRef?: LibraryRef | null } = {}): string {
    let parsedId: string | null = null;
    try { parsedId = (JSON.parse(content) as { documentId?: string }).documentId ?? null; } catch { /* loadProject reports it */ }
    const same = parsedId ? this.entries.find(e => e.id === parsedId) : undefined;
    if (same && sameDocument(this.contentOf(same.id), content)) {
      this.activate(same.id);
      return same.id;
    }
    const replaceBlank = this.activeIsBlank();
    if (!replaceBlank) this.stash();
    else this.entries = this.entries.filter(e => e.content !== null);
    this.switching = true;
    try {
      const s = this.store.getState();
      s.loadProject(content);
      if (this.store.getState().statusMessage.startsWith('Error loading project')) {
        // Nothing was loaded: put the previous document back
        const back = this.entries.find(e => e.content !== null && e.id === s.documentId) ?? this.entries[this.entries.length - 1];
        this.switching = false;
        if (back && !replaceBlank) { const msg = this.store.getState().statusMessage; this.bringIn(back, msg); }
        throw new Error(this.store.getState().statusMessage.replace(/^Error loading project: /, ''));
      }
      if (this.entries.some(e => e.id === this.store.getState().documentId)) this.store.setState({ documentId: generateId('doc') });
      if (options.libraryRef !== undefined) this.store.setState({ libraryRef: options.libraryRef });
      const st = this.store.getState();
      this.store.setState({ activeCommandTab: st.documentType === 'assembly' ? 'Assembly' : 'Features' });
      this.entries.push({ id: st.documentId, name: st.documentName, type: st.documentType, modified: st.isModified, libraryRef: st.libraryRef, content: null, undoStack: [], redoStack: [] });
    } finally {
      this.switching = false;
    }
    this.emit();
    return this.activeId();
  }

  /** Close a document (unsaved changes are lost: ask first). The last one closed leaves a new part. */
  close(id: string): void {
    const i = this.entries.findIndex(e => e.id === id);
    if (i < 0) throw new Error(`No open document ${JSON.stringify(id)}`);
    const wasActive = this.entries[i].content === null;
    this.entries.splice(i, 1);
    if (!wasActive) { this.emit(); return; }
    const next = this.entries[Math.min(i, this.entries.length - 1)];
    if (next) {
      this.bringIn(next, `Closed; ${next.name} is open`);
    } else {
      this.newDocument('part');
    }
  }

  /** The content of the open document with this id, if it is open (for resolving references). */
  documentContent(documentId: string): string | null {
    return this.contentOf(documentId);
  }

  /** For autosave: every open document with its state. */
  serialize(): { activeId: string; documents: Array<{ id: string; content: string; modified: boolean; libraryRef: LibraryRef | null }> } {
    return {
      activeId: this.activeId(),
      documents: this.entries.map(e => ({ id: e.id, content: e.content ?? this.store.getState().saveProject(), modified: e.content === null ? this.store.getState().isModified : e.modified, libraryRef: e.content === null ? this.store.getState().libraryRef : e.libraryRef })),
    };
  }

  /** For autosave: put back documents saved by serialize() (the active one is already in the store). */
  restoreOthers(documents: Array<{ id: string; content: string; modified: boolean; libraryRef: LibraryRef | null }>, activeId: string): void {
    const activeIndex = documents.findIndex(d => d.id === activeId);
    const before: Entry[] = [], after: Entry[] = [];
    documents.forEach((d, i) => {
      if (d.id === activeId || this.entries.some(e => e.id === d.id)) return;
      let name = 'Document', type: DocumentType = 'part';
      try {
        const p = JSON.parse(d.content) as { documentName?: string; documentType?: DocumentType };
        name = p.documentName ?? name;
        type = p.documentType === 'assembly' ? 'assembly' : 'part';
      } catch { return; }
      (i < activeIndex ? before : after).push({ id: d.id, name, type, modified: d.modified, libraryRef: d.libraryRef, content: d.content, undoStack: [], redoStack: [] });
    });
    this.entries = [...before, ...this.entries, ...after];
    this.emit();
  }
}
