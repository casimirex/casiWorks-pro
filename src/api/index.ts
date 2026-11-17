// CasiWorks Pro - Public API entry point
//
// Two ways to use the API:
//
//   1. In the running app (browser console, bookmarklets, extensions, an
//      embedding page): `window.casiworks`, installed at start-up. Scripts
//      that load before the app can wait for the `casiworks:ready` event:
//
//        window.addEventListener('casiworks:ready', (e) => {
//          const api = e.detail.api;
//          console.log(api.version);
//        });
//
//   2. As an ES module, headless (Node scripts, tests, a server):
//
//        import { createHeadlessAPI } from 'casiworks-pro/api';
//        const api = createHeadlessAPI();
//        const s = api.sketches.create({ entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 10 }] });
//        api.features.extrude({ sketchId: s.sketchId, depth: 5 });
//        console.log(api.model.massProperties());
//
//      Node runs the TypeScript sources directly (Node 22.18+ type stripping).
//
// Both give the same object; it is versioned with semantic versioning
// (`api.version`): minor versions only add, major versions may break.
import { createCasiWorksAPI } from './CasiWorksAPI.ts';
import type { ApiStore, CasiWorksAPI, CasiWorksAPIOptions } from './CasiWorksAPI.ts';
import { useCADStore } from '../store/cadStore.ts';
import { commands, macroRecorder } from '../commands/index.ts';
import { PluginManager } from '../plugins/PluginManager.ts';
import { apiWorkspace } from '../workspace/index.ts';

export * from './CasiWorksAPI.ts';
/** Types for writing plugins (add-ins); see `api.plugins`. */
export type { CasiWorksPlugin, PluginCommand, PluginButton, PluginHost } from '../plugins/PluginManager.ts';

/** Name of the event dispatched on the target once `casiworks` is installed. */
export const READY_EVENT = 'casiworks:ready';

/** Detail of the `casiworks:ready` event. */
export interface ReadyEventDetail {
  api: CasiWorksAPI;
  version: string;
}

declare global {
  interface Window {
    /** The CasiWorks public API of the running app. */
    readonly casiworks?: CasiWorksAPI;
  }
  interface WindowEventMap {
    'casiworks:ready': CustomEvent<ReadyEventDetail>;
  }
}

/**
 * The API over the application's document store, for use without the UI.
 * There is one document per process (the store is a module singleton), so
 * every call returns an API over the same document.
 */
export function createHeadlessAPI(): CasiWorksAPI {
  // The plugin manager hands plugins this API, created right after it
  const self: { api?: CasiWorksAPI } = {};
  const plugins = new PluginManager(commands, () => self.api!);
  self.api = createCasiWorksAPI(useCADStore, { commands, macros: macroRecorder, plugins, workspace: apiWorkspace });
  return self.api;
}

/** Where the API is installed: `window` in the app, any object in tests. */
interface GlobalTarget {
  dispatchEvent?: (event: Event) => boolean;
}

/**
 * Create the API over `store`, install it as `target.casiworks` (read-only)
 * and announce it with a `casiworks:ready` event. Installing again (e.g. after
 * a hot reload) replaces the previous instance.
 */
export function exposeGlobalAPI(store: ApiStore, target: GlobalTarget = globalThis as GlobalTarget, options: CasiWorksAPIOptions = {}): CasiWorksAPI {
  const api = createCasiWorksAPI(store, options);
  Object.defineProperty(target, 'casiworks', {
    value: api,
    enumerable: true,
    writable: false,
    configurable: true, // so a reload can replace it
  });
  if (typeof target.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    target.dispatchEvent(new CustomEvent<ReadyEventDetail>(READY_EVENT, { detail: { api, version: api.version } }));
  }
  return api;
}
