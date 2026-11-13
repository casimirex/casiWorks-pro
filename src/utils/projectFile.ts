// CasiWorks Pro - Project file save / open / new (shared by toolbar and keyboard shortcuts)

/** The slice of the CAD store these helpers use (cadStore.ts checks the store satisfies it). */
export interface ProjectFileState {
  documentName: string;
  isModified: boolean;
  saveProject(): string;
  loadProject(json: string): void;
  newProject(): void;
  setStatus(message: string): void;
}

export interface StoreHandle<S> {
  getState(): S;
}

import { downloadBlob } from './download.ts';

export const PROJECT_EXTENSION = '.casiproj';
// Older builds saved as .cadproj; keep opening them.
const OPENABLE_EXTENSIONS = ['.casiproj', '.cadproj', '.json'] as const;

export function projectFileName(documentName: string | null | undefined): string {
  const base = String(documentName || 'Untitled').trim().replace(/[^\w.-]+/g, '_') || 'Untitled';
  return `${base}${PROJECT_EXTENSION}`;
}

export function downloadProject(store: StoreHandle<ProjectFileState>): void {
  const state = store.getState();
  const filename = projectFileName(state.documentName);
  downloadBlob(state.saveProject(), filename, 'application/json');
  state.setStatus(`Saved ${filename}`);
}

export function openProject(store: StoreHandle<ProjectFileState>): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = OPENABLE_EXTENSIONS.join(',');
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!OPENABLE_EXTENSIONS.some(ext => name.endsWith(ext))) {
      store.getState().setStatus(`Cannot open "${file.name}": expected a ${PROJECT_EXTENSION} project file`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') store.getState().loadProject(reader.result);
    };
    reader.onerror = () => store.getState().setStatus(`Failed to read "${file.name}"`);
    reader.readAsText(file);
  };
  input.click();
}

export function newProject(store: StoreHandle<ProjectFileState>): void {
  const state = store.getState();
  if (state.isModified && !window.confirm('Discard unsaved changes and start a new part?')) return;
  state.newProject();
}
