// CasiWorks Pro - The app's workspace (open documents), bound to the store
import { useCADStore } from '../store/cadStore.ts';
import { library } from '../library/client.ts';
import { Workspace } from './workspace.ts';
import { refreshReferences } from './references.ts';
import type { ReferenceSources } from './references.ts';

export const workspace = new Workspace(useCADStore);

/** Where referenced parts are looked up: open documents, then the library. */
export const referenceSources: ReferenceSources = {
  workspace: (documentId) => workspace.documentContent(documentId),
  library: async (documentId, version) => {
    try { return await library.content(documentId, version ?? 'latest'); } catch { return null; }
  },
};

/** Bring the active assembly's part components up to date (open parts at once, library parts when they arrive). */
export function updateReferences() {
  return refreshReferences(useCADStore, referenceSources);
}

// An assembly that becomes active (switched to, opened, restored) picks up its parts' changes
let lastActive = '';
useCADStore.subscribe((s) => {
  if (s.documentId === lastActive) return;
  lastActive = s.documentId;
  if (s.documentType === 'assembly' && s.assemblyComponents.some(c => c.source)) {
    // After the switch has finished (its unsaved-changes flag and undo history restored)
    queueMicrotask(() => { if (useCADStore.getState().documentId === lastActive) void updateReferences(); });
  }
});

/** The workspace as the public API uses it. */
export const apiWorkspace = {
  list: () => workspace.list(),
  newDocument: (type: 'part' | 'assembly', name?: string) => workspace.newDocument(type, name),
  activate: (id: string) => workspace.activate(id),
  close: (id: string) => workspace.close(id),
  open: (content: string) => workspace.open(content),
  contentOf: (id: string) => workspace.contentOf(id),
  updateReferences,
  libraryContent: (documentId: string, version: number | null) => referenceSources.library!(documentId, version),
};

export { Workspace } from './workspace.ts';
export type { WorkspaceDocument } from './workspace.ts';
