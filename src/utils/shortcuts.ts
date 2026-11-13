// CasiWorks Pro - Keyboard Shortcuts Listener
import { TOOLS } from './constants.ts';
import type { ToolId, ViewOrientation } from './constants.ts';
import { downloadProject, openProject, newProject } from './projectFile.ts';
import type { ProjectFileState, StoreHandle } from './projectFile.ts';

/** The slice of the CAD store the shortcuts use (replaced by the full store type in T.3). */
export interface ShortcutState extends ProjectFileState {
  undo(): void;
  redo(): void;
  rebuild(): void;
  cancelTool(): void;
  setActiveTool(tool: ToolId): void;
  openPropertyPanel(content: { type: string }): void;
  setViewOrientation(orientation: ViewOrientation): void;
}

const CTRL_VIEWS: Record<string, ViewOrientation> = {
  '1': 'front',
  '2': 'back',
  '3': 'left',
  '4': 'right',
  '5': 'top',
  '6': 'bottom',
  '7': 'isometric',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('input, select, textarea, [contenteditable="true"]') !== null;
}

/** Install global keyboard shortcuts. Returns a function that removes them. */
export function setupKeyboardShortcuts(store: StoreHandle<ShortcutState>): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ignore keystrokes while typing into inputs
    if (isTypingTarget(e.target)) return;

    const s = store.getState();
    const isCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (isCtrl && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      s.undo();
    } else if (isCtrl && (key === 'y' || (e.shiftKey && key === 'z'))) {
      e.preventDefault();
      s.redo();
    } else if (isCtrl && key === 's') {
      e.preventDefault();
      downloadProject(store);
    } else if (isCtrl && key === 'o') {
      e.preventDefault();
      openProject(store);
    } else if (isCtrl && e.altKey && key === 'n') {
      // Browsers reserve plain Ctrl+N for a new window, so New Part is Ctrl+Alt+N
      e.preventDefault();
      newProject(store);
    } else if (e.key === 'F5') {
      e.preventDefault();
      s.rebuild();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      s.cancelTool();
    } else if (isCtrl) {
      const view = CTRL_VIEWS[e.key];
      if (view) {
        e.preventDefault();
        s.setViewOrientation(view);
      }
    } else {
      switch (key) {
        case 'l':
          s.setActiveTool(TOOLS.SKETCH_LINE);
          break;
        case 'r':
          s.setActiveTool(TOOLS.SKETCH_RECT);
          break;
        case 'c':
          s.setActiveTool(TOOLS.SKETCH_CIRCLE);
          break;
        case 'd':
          s.setActiveTool(TOOLS.SKETCH_DIMENSION);
          break;
        case 'e':
          s.setActiveTool(TOOLS.EXTRUDE);
          s.openPropertyPanel({ type: 'extrude_boss' });
          break;
        case ' ':
          s.setViewOrientation('isometric');
          break;
        default:
          break;
      }
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
