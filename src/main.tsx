// CasiWorks Pro - Application Entry Point
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from './components/common/ErrorBoundary.tsx';
import { exposeGlobalAPI } from './api/index.ts';
import { useCADStore } from './store/cadStore.ts';
import { commands, macroRecorder } from './commands/index.ts';
import { pluginManager } from './plugins/index.ts';
import { indexedDBStorage, memoryStorage, restoreAutosave, startAutosave } from './utils/autosave.ts';
import './index.css';

// Remove loading splash screen once mounted
window.addEventListener('load', () => {
  setTimeout(() => {
    const loading = document.getElementById('loading-screen');
    if (loading) {
      loading.style.opacity = '0';
      setTimeout(() => loading.remove(), 500);
    }
  }, 600);
});

// Public API for scripts, the console and embedding pages: window.casiworks
exposeGlobalAPI(useCADStore, window, { commands, macros: macroRecorder, plugins: pluginManager });

// Bring back the document from the last session before the first render, then keep saving it
const storage = typeof indexedDB === 'undefined' ? memoryStorage() : indexedDBStorage();
void restoreAutosave(useCADStore, storage).then((restored) => {
  if (restored) {
    // The first rebuild reports its own result; keep the restore notice in front of it
    const rebuilds = useCADStore.getState().rebuildCount;
    const unsubscribe = useCADStore.subscribe((state, prev) => {
      // The rebuild's own message arrives just after its count goes up
      if (state.rebuildCount > rebuilds && state.statusMessage !== prev.statusMessage) {
        unsubscribe();
        state.setStatus(`${restored} · ${state.statusMessage}`);
      }
    });
  }
  const autosave = startAutosave(useCADStore, storage);
  // A closing or backgrounded tab writes at once instead of waiting for the delay
  const flush = () => { void autosave.flush(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary name="CasiWorks Pro" fullScreen>
        <App seedStarter={!restored} />
      </ErrorBoundary>
    </React.StrictMode>
  );
});
