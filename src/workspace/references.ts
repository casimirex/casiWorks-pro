// CasiWorks Pro - Keep an assembly's part components up to date with their parts
//
// A component that is a part document is found, in order: open in the workspace
// (live, with unsaved changes), then in the library (its pinned version or the
// newest), and only then from the copy cached in the assembly file.
import { partFingerprint, partShape } from '../assembly/partGeometry.ts';
import type { PartShape } from '../assembly/partGeometry.ts';
import type { PartSource, StoreAssemblyComponent } from '../store/cadStore.ts';

export interface ReferenceStore {
  getState(): {
    documentId: string;
    assemblyComponents: StoreAssemblyComponent[];
    updatePartComponents(updates: Array<{ componentId: string; shape: PartShape | null; source: PartSource }>): void;
  };
}

export interface ReferenceSources {
  /** The content of an open document, or null when it is not open. */
  workspace(documentId: string): string | null;
  /** The content of a library document's version (null = newest), or null when the library cannot be reached. */
  library?(documentId: string, version: number | null): Promise<string | null>;
}

/** Shapes rebuilt from the same content are reused (a part used several times is rebuilt once). */
const shapeCache = new Map<string, PartShape>();
function shapeOf(content: string): PartShape | null {
  try {
    const key = partFingerprint(content);
    let s = shapeCache.get(key);
    if (!s) {
      s = partShape(content);
      shapeCache.set(key, s);
      if (shapeCache.size > 50) shapeCache.delete(shapeCache.keys().next().value!);
    }
    // Each component gets its own geometry object
    return { ...s, geometry: s.geometry.clone() };
  } catch {
    return null;
  }
}

/** Update from open documents now (synchronous). Returns the components still to look up in the library. */
export function refreshFromWorkspace(store: ReferenceStore, sources: ReferenceSources): StoreAssemblyComponent[] {
  const state = store.getState();
  const updates: Array<{ componentId: string; shape: PartShape | null; source: PartSource }> = [];
  const pending: StoreAssemblyComponent[] = [];
  for (const c of state.assemblyComponents) {
    const src = c.source;
    if (!src) continue;
    if (src.documentId === state.documentId) continue; // an assembly cannot contain itself
    const content = sources.workspace(src.documentId);
    if (content !== null) {
      const fp = safeFingerprint(content);
      const shape = fp === src.fingerprint ? null : shapeOf(content);
      if (fp !== src.fingerprint && !shape) { pending.push(c); continue; } // not a usable part now (e.g. no body)
      updates.push({ componentId: c.id, shape, source: { ...src, snapshot: content, name: nameOf(content) ?? src.name, linked: 'workspace' } });
    } else {
      pending.push(c);
    }
  }
  if (updates.length) store.getState().updatePartComponents(updates);
  return pending;
}

/** Update everything: open documents first, then the library for the rest. */
export async function refreshReferences(store: ReferenceStore, sources: ReferenceSources): Promise<{ workspace: number; library: number; cached: number }> {
  const before = store.getState().assemblyComponents.filter(c => c.source).length;
  const pending = refreshFromWorkspace(store, sources);
  let fromLibrary = 0;
  const updates: Array<{ componentId: string; shape: PartShape | null; source: PartSource }> = [];
  const fetched = new Map<string, Promise<string | null>>();
  for (const c of pending) {
    const src = c.source!;
    let content: string | null = null;
    if (src.library && sources.library) {
      const key = `${src.library.documentId}@${src.library.version ?? 'latest'}`;
      if (!fetched.has(key)) fetched.set(key, sources.library(src.library.documentId, src.library.version).catch(() => null));
      content = await fetched.get(key)!;
    }
    if (content !== null) {
      const fp = safeFingerprint(content);
      const shape = fp === src.fingerprint ? null : shapeOf(content);
      if (fp === src.fingerprint || shape) {
        updates.push({ componentId: c.id, shape, source: { ...src, snapshot: content, name: nameOf(content) ?? src.name, linked: 'library' } });
        fromLibrary++;
        continue;
      }
    }
    if (src.linked !== 'cached') updates.push({ componentId: c.id, shape: null, source: { ...src, linked: 'cached' } });
  }
  // The assembly may have been switched away while waiting: only touch components still there
  const ids = new Set(store.getState().assemblyComponents.map(c => c.id));
  const live = updates.filter(u => ids.has(u.componentId));
  if (live.length) store.getState().updatePartComponents(live);
  return { workspace: before - pending.length, library: fromLibrary, cached: pending.length - fromLibrary };
}

function safeFingerprint(content: string): string | null {
  try { return partFingerprint(content); } catch { return null; }
}
function nameOf(content: string): string | null {
  try { return (JSON.parse(content) as { documentName?: string }).documentName ?? null; } catch { return null; }
}
