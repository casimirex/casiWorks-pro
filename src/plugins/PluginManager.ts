// CasiWorks Pro - Plugins (add-ins)
//
// A plugin is an ES module whose default export is a CasiWorksPlugin:
//
//   export default {
//     id: 'washer', name: 'Washer generator', version: '1.0.0', apiVersion: '1.4',
//     commands: [{ name: 'create', label: 'Washer', run: (args, host) => { … host.api … } }],
//     buttons: [{ command: 'create', label: 'Washer', icon: '◎' }],
//   };
//
// Plugins see the public API (`host.api`) only. Their commands are named
// `<pluginId>.<name>`, cannot replace built-in commands or take key bindings
// that are already used, and are removed with everything else the plugin
// registered when it is unloaded.
import type { CasiWorksAPI, CasiWorksEventHandler, CasiWorksEventName } from '../api/CasiWorksAPI.ts';
import type { CommandRegistry } from '../commands/CommandRegistry.ts';

export type PluginErrorCode = 'INVALID_PLUGIN' | 'INCOMPATIBLE' | 'ALREADY_LOADED' | 'CONFLICT' | 'NOT_FOUND' | 'ACTIVATION_FAILED' | 'LOAD_FAILED';

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

/** A command a plugin adds; its id becomes `<pluginId>.<name>`. */
export interface PluginCommand {
  /** camelCase, e.g. 'create'. */
  name: string;
  label: string;
  description?: string;
  /** Key bindings ('Ctrl+Shift+W'); only keys no other command uses. */
  shortcuts?: string[];
  run(args: unknown, host: PluginHost): unknown;
}

/** A ribbon button on the Add-ins tab that runs a command. */
export interface PluginButton {
  /** A command name of this plugin, or any full command id. */
  command: string;
  label: string;
  title?: string;
  args?: unknown;
  /** A short text or emoji shown as the icon. */
  icon?: string;
}

/** What a plugin module exports (its manifest and code). */
export interface CasiWorksPlugin {
  /** camelCase, unique, e.g. 'washer'. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Minimum API version the plugin needs, e.g. '1.4' (same major version). */
  apiVersion: string;
  commands?: PluginCommand[];
  buttons?: PluginButton[];
  /** Called once after the commands and buttons are registered. */
  activate?(host: PluginHost): void | Promise<void>;
  /** Called on unload, before its commands and buttons are removed. */
  deactivate?(): void;
}

/** What a plugin can use. */
export interface PluginHost {
  readonly pluginId: string;
  readonly api: CasiWorksAPI;
  /** Register another command at run time; returns its full id. */
  registerCommand(command: PluginCommand): string;
  addButton(button: PluginButton): void;
  /** Listen for an API event; removed automatically on unload. */
  on<K extends CasiWorksEventName>(event: K, handler: CasiWorksEventHandler<K>): void;
}

/** A loaded plugin as listed to the UI and API (plain data). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  source: string;
  commands: string[];
}

/** A button as shown on the Add-ins tab. */
export interface RibbonButton {
  pluginId: string;
  pluginName: string;
  commandId: string;
  label: string;
  title: string;
  args?: unknown;
  icon?: string;
}

interface Loaded {
  plugin: CasiWorksPlugin;
  source: string;
  commands: string[];
  buttons: RibbonButton[];
  cleanups: Array<() => void>;
}

const ID = /^[a-z][a-zA-Z0-9]*$/;

/** true when `required` ('1.4' or '1.4.0') is satisfied by `current` ('1.4.2'). */
export function apiVersionSatisfies(required: string, current: string): boolean {
  const [rMaj, rMin = 0, rPatch = 0] = required.split('.').map(Number);
  const [cMaj, cMin, cPatch] = current.split('.').map(Number);
  if (![rMaj, rMin, rPatch].every(Number.isInteger)) return false;
  return rMaj === cMaj && (cMin > rMin || (cMin === rMin && cPatch >= rPatch));
}

function validate(p: unknown): CasiWorksPlugin {
  const plugin = p as Partial<CasiWorksPlugin> | null;
  const bad = (msg: string): never => { throw new PluginError('INVALID_PLUGIN', msg); };
  if (!plugin || typeof plugin !== 'object') bad('A plugin module must export a plugin object as its default export');
  if (typeof plugin!.id !== 'string' || !ID.test(plugin!.id)) bad('id must be camelCase letters and digits, e.g. "washer"');
  for (const k of ['name', 'version', 'apiVersion'] as const) if (typeof plugin![k] !== 'string' || !plugin![k]) bad(`${k} is required`);
  if (plugin!.commands !== undefined && !Array.isArray(plugin!.commands)) bad('commands must be an array');
  if (plugin!.buttons !== undefined && !Array.isArray(plugin!.buttons)) bad('buttons must be an array');
  return plugin as CasiWorksPlugin;
}

export class PluginManager<S> {
  private loaded = new Map<string, Loaded>();
  private listeners = new Set<() => void>();
  private snapshot: { plugins: PluginInfo[]; buttons: RibbonButton[] } = { plugins: [], buttons: [] };
  private readonly registry: CommandRegistry<S>;
  private readonly getApi: () => CasiWorksAPI;

  constructor(registry: CommandRegistry<S>, getApi: () => CasiWorksAPI) {
    this.registry = registry;
    this.getApi = getApi;
  }

  /** Load a plugin object (already imported). Rolls back everything if activation fails. */
  async load(pluginObject: unknown, source = 'code'): Promise<PluginInfo> {
    const plugin = validate(pluginObject);
    const api = this.getApi();
    if (!apiVersionSatisfies(plugin.apiVersion, api.version)) {
      throw new PluginError('INCOMPATIBLE', `"${plugin.name}" needs API ${plugin.apiVersion}; this app has ${api.version}`);
    }
    if (this.loaded.has(plugin.id)) throw new PluginError('ALREADY_LOADED', `"${plugin.id}" is already loaded`);
    // The id is the plugin's command namespace: built-in areas (file, feature, view…) are taken
    if (this.registry.list().some(c => c.id.startsWith(`${plugin.id}.`))) {
      throw new PluginError('CONFLICT', `"${plugin.id}" is a reserved command namespace; choose another plugin id`);
    }

    const entry: Loaded = { plugin, source, commands: [], buttons: [], cleanups: [] };
    const host: PluginHost = {
      pluginId: plugin.id,
      api,
      registerCommand: (cmd) => this.addCommand(entry, cmd, host),
      addButton: (btn) => this.addButton(entry, btn),
      on: (event, handler) => { entry.cleanups.push(api.on(event, handler)); },
    };
    this.loaded.set(plugin.id, entry);
    try {
      for (const cmd of plugin.commands ?? []) this.addCommand(entry, cmd, host);
      for (const btn of plugin.buttons ?? []) this.addButton(entry, btn);
      await plugin.activate?.(host);
    } catch (err) {
      this.teardown(entry);
      this.loaded.delete(plugin.id);
      this.changed();
      if (err instanceof PluginError) throw err;
      throw new PluginError('ACTIVATION_FAILED', `"${plugin.name}" failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.changed();
    return this.info(entry);
  }

  /** Import a plugin module from a URL and load its default export. */
  async loadFromUrl(url: string): Promise<PluginInfo> {
    let mod: { default?: unknown; plugin?: unknown };
    try {
      mod = await import(/* @vite-ignore */ url);
    } catch (err) {
      throw new PluginError('LOAD_FAILED', `Cannot load ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.load(mod.default ?? mod.plugin, url);
  }

  /** Load a plugin from the text of a module file (e.g. a file the user picked). */
  async loadFromSource(code: string, name = 'file'): Promise<PluginInfo> {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      const info = await this.loadFromUrl(url);
      return { ...info, source: name };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  unload(id: string): void {
    const entry = this.loaded.get(id);
    if (!entry) throw new PluginError('NOT_FOUND', `No plugin "${id}" is loaded`);
    try {
      entry.plugin.deactivate?.();
    } catch (err) {
      console.error(`[CasiWorks] plugin "${id}" deactivate failed:`, err);
    }
    this.teardown(entry);
    this.loaded.delete(id);
    this.changed();
  }

  list(): PluginInfo[] {
    return this.snapshot.plugins;
  }

  /** Buttons for the Add-ins tab, in load order. */
  buttons(): RibbonButton[] {
    return this.snapshot.buttons;
  }

  /** Notified when plugins are loaded or unloaded (for UI). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private addCommand(entry: Loaded, cmd: PluginCommand, host: PluginHost): string {
    if (!cmd || typeof cmd.name !== 'string' || !ID.test(cmd.name) || typeof cmd.run !== 'function' || typeof cmd.label !== 'string') {
      throw new PluginError('INVALID_PLUGIN', `Command ${JSON.stringify(cmd?.name)} needs a camelCase name, a label and a run function`);
    }
    const id = `${entry.plugin.id}.${cmd.name}`;
    if (this.registry.has(id)) throw new PluginError('CONFLICT', `Command "${id}" already exists`);
    for (const s of cmd.shortcuts ?? []) {
      const owner = this.registry.commandForShortcut(s);
      if (owner) throw new PluginError('CONFLICT', `${s} is already used by ${owner}`);
    }
    this.registry.register({
      id,
      label: cmd.label,
      category: entry.plugin.name,
      description: cmd.description,
      shortcuts: cmd.shortcuts,
      run: (_ctx, args: unknown) => cmd.run(args, host),
    });
    entry.commands.push(id);
    return id;
  }

  private addButton(entry: Loaded, btn: PluginButton): void {
    if (!btn || typeof btn.command !== 'string' || typeof btn.label !== 'string') {
      throw new PluginError('INVALID_PLUGIN', 'A button needs a command and a label');
    }
    const commandId = btn.command.includes('.') ? btn.command : `${entry.plugin.id}.${btn.command}`;
    if (!this.registry.has(commandId)) throw new PluginError('INVALID_PLUGIN', `Button "${btn.label}" runs unknown command "${commandId}"`);
    entry.buttons.push({
      pluginId: entry.plugin.id, pluginName: entry.plugin.name, commandId,
      label: btn.label, title: btn.title ?? btn.label, args: btn.args, icon: btn.icon,
    });
    this.changed();
  }

  private teardown(entry: Loaded): void {
    for (const stop of entry.cleanups.splice(0)) {
      try { stop(); } catch { /* listener already gone */ }
    }
    for (const id of entry.commands.splice(0)) this.registry.unregister(id);
    entry.buttons.length = 0;
  }

  private info(entry: Loaded): PluginInfo {
    const { id, name, version, description, author } = entry.plugin;
    return { id, name, version, description, author, source: entry.source, commands: [...entry.commands] };
  }

  private changed(): void {
    const loaded = [...this.loaded.values()];
    // New arrays only on change, so React's useSyncExternalStore sees stable snapshots
    this.snapshot = { plugins: loaded.map(e => this.info(e)), buttons: loaded.flatMap(e => e.buttons) };
    for (const l of this.listeners) l();
  }
}
