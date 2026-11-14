// CasiWorks Pro - The application's plugin manager (add-ins of the running app)
import { commands } from '../commands/index.ts';
import { PluginManager } from './PluginManager.ts';
import type { CasiWorksAPI } from '../api/CasiWorksAPI.ts';

export * from './PluginManager.ts';

/** Add-ins of the running app; they use the app's public API (window.casiworks). */
export const pluginManager = new PluginManager(commands, () => {
  const api = (globalThis as { casiworks?: CasiWorksAPI }).casiworks;
  if (!api) throw new Error('The CasiWorks API is not installed yet');
  return api;
});
