// CasiWorks Pro - Application Entry Point
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from './components/common/ErrorBoundary.tsx';
import { exposeGlobalAPI } from './api/index.ts';
import { useCADStore } from './store/cadStore.ts';
import { commands, macroRecorder } from './commands/index.ts';
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
exposeGlobalAPI(useCADStore, window, { commands, macros: macroRecorder });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary name="CasiWorks Pro" fullScreen>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
