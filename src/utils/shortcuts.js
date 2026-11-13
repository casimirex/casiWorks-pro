// CasiWorks Pro - Keyboard Shortcuts Listener
import { TOOLS } from './constants.js';
import { downloadProject, openProject, newProject } from './projectFile.js';

export function setupKeyboardShortcuts(store) {
  const handleKeyDown = (e) => {
    // Ignore keystrokes when typing into text/numeric input fields or contenteditable elements
    const target = e.target;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        (target.closest && target.closest('input, select, textarea, [contenteditable="true"]')))
    ) {
      return;
    }

    const isCtrl = e.ctrlKey || e.metaKey;

    if (isCtrl && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      e.preventDefault();
      store.getState().undo();
    } else if (isCtrl && ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
      e.preventDefault();
      store.getState().redo();
    } else if (isCtrl && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      downloadProject(store);
    } else if (isCtrl && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      openProject(store);
    } else if (isCtrl && e.altKey && (e.key === 'n' || e.key === 'N')) {
      // Browsers reserve plain Ctrl+N for a new window, so New Part is Ctrl+Alt+N
      e.preventDefault();
      newProject(store);
    } else if (e.key === 'F5') {
      e.preventDefault();
      store.getState().rebuild();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      store.getState().cancelTool();
    } else if (!isCtrl) {
      switch (e.key.toLowerCase()) {
        case 'l':
          store.getState().setActiveTool(TOOLS.SKETCH_LINE);
          break;
        case 'r':
          store.getState().setActiveTool(TOOLS.SKETCH_RECT);
          break;
        case 'c':
          store.getState().setActiveTool(TOOLS.SKETCH_CIRCLE);
          break;
        case 'd':
          store.getState().setActiveTool(TOOLS.SKETCH_DIMENSION);
          break;
        case 'e':
          store.getState().setActiveTool(TOOLS.EXTRUDE);
          store.getState().openPropertyPanel({ type: 'extrude_boss' });
          break;
        case ' ': // Space bar - toggle isometric
          store.getState().setViewOrientation('isometric');
          break;
        default:
          break;
      }
    } else if (isCtrl) {
      // Ctrl+1..7 standard view orientations
      const views = {
        '1': 'front',
        '2': 'back',
        '3': 'left',
        '4': 'right',
        '5': 'top',
        '6': 'bottom',
        '7': 'isometric',
      };
      if (views[e.key]) {
        e.preventDefault();
        store.getState().setViewOrientation(views[e.key]);
      }
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
