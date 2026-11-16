// CasiWorks Pro - Command registry
//
// Every user action (ribbon button, keyboard shortcut, script, macro, add-in)
// runs a named command through one registry, so all of them behave the same
// and can be listed, bound to keys, recorded and replayed.
//
//   registry.register({ id: 'view.top', label: 'Top view', category: 'View',
//                       shortcuts: ['Ctrl+5'], run: (ctx) => ... });
//   registry.execute('view.top');
//   registry.execute('sketch.new', { plane: 'Right' });

/** UI effects a command may need; the app provides them, headless use does not. */
export interface UIHost {
  /** Open one of the application dialogs. */
  openDialog(name: DialogName): void;
  /** Show or hide the feature tree drawer (small screens). */
  toggleFeatureTree(): void;
  /** Show or hide the scripting console. */
  toggleConsole(): void;
}

export type DialogName = 'export' | 'material' | 'massProperties' | 'drawing' | 'addins' | 'bom' | 'equations' | 'configurations';

export type CommandErrorCode = 'UNKNOWN_COMMAND' | 'DUPLICATE_COMMAND' | 'INVALID_ARGUMENT' | 'NOT_AVAILABLE' | 'FAILED';

/** Thrown when a command cannot be found, registered or run. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;
  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/** What a command's `run` receives besides its arguments. */
export interface CommandContext<S> {
  /** The application state (the CAD store). */
  state(): S;
  /** UI effects; throws NOT_AVAILABLE when there is no UI (headless). */
  ui(): UIHost;
  /** Run another command (counts as part of this one for listeners). */
  execute(id: string, args?: unknown): unknown;
}

export interface CommandDefinition<S, A = unknown> {
  /** Stable id: `<area>.<action>` in camelCase, e.g. `feature.extrudeCut`. */
  id: string;
  /** Short human-readable name (menus, tooltips, command search). */
  label: string;
  /** Grouping for menus and the command list, e.g. 'File', 'Sketch'. */
  category: string;
  description?: string;
  /** Key bindings such as 'Ctrl+S', 'Ctrl+Shift+Z', 'F5', 'L', 'Space'. */
  shortcuts?: string[];
  /** Commands that need the UI (dialogs) cannot run headless. */
  requiresUI?: boolean;
  /**
   * How a run appears in a recorded macro: false = not recorded (tools, views,
   * dialogs); a function may rewrite it into a replayable step (or skip it with
   * null). Default: recorded as run, with the ids it returned.
   */
  record?: false | ((args: A, result: unknown, state: S) => MacroStep | null);
  run(ctx: CommandContext<S>, args: A): unknown;
}

/** One replayable step of a macro. */
export interface MacroStep {
  command: string;
  args?: unknown;
  /** Ids the step created when recorded (e.g. { featureId }); replay maps them to the new ones. */
  returns?: Record<string, string>;
}

/** Ids in a command result (`featureId`, `sketchId`, `componentId`…), for macro id mapping. */
export function idsOf(result: unknown): Record<string, string> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const ids = Object.entries(result).filter(([k, v]) => /Id$/.test(k) && typeof v === 'string');
  return ids.length ? Object.fromEntries(ids) as Record<string, string> : undefined;
}

/** A registered command as listed to callers (no functions). */
export interface CommandInfo {
  id: string;
  label: string;
  category: string;
  description?: string;
  shortcuts: string[];
  requiresUI: boolean;
}

/** Reported to listeners after every top-level command run. */
export interface CommandExecution {
  id: string;
  args: unknown;
  ok: boolean;
  /** What the command returned (successful runs). */
  result?: unknown;
  error?: string;
}

const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Normalised key binding: modifiers in the order Ctrl, Alt, Shift, then the key. */
export function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split('+').map(p => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map(m => m.toLowerCase()));
  const out: string[] = [];
  if (mods.has('ctrl') || mods.has('cmd') || mods.has('meta')) out.push('Ctrl');
  if (mods.has('alt')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return out.join('+');
}

/** The binding a keyboard event corresponds to (Cmd counts as Ctrl). */
export function shortcutFromEvent(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift only counts with Ctrl/Alt or named keys: plain letters bind regardless of case
  const named = e.key.length > 1;
  if (e.shiftKey && (mods.length > 0 || named)) mods.push('Shift');
  const key = e.key === ' ' ? 'Space' : e.key;
  return normalizeShortcut([...mods, key].join('+'));
}

export class CommandRegistry<S> {
  private commands = new Map<string, CommandDefinition<S, never>>();
  private keymap = new Map<string, string>();
  private listeners = new Set<(execution: CommandExecution) => void>();
  private uiHost: UIHost | null = null;
  private depth = 0;
  private readonly getState: () => S;

  constructor(getState: () => S) {
    this.getState = getState;
  }

  /** Add a command. Ids must be unique; shortcuts already bound are taken over. */
  register<A>(def: CommandDefinition<S, A>): () => void {
    if (!ID_PATTERN.test(def.id)) throw new CommandError('INVALID_ARGUMENT', `Command id "${def.id}" must look like "area.action"`);
    if (this.commands.has(def.id)) throw new CommandError('DUPLICATE_COMMAND', `Command "${def.id}" is already registered`);
    this.commands.set(def.id, def as CommandDefinition<S, never>);
    for (const s of def.shortcuts ?? []) this.keymap.set(normalizeShortcut(s), def.id);
    return () => this.unregister(def.id);
  }

  unregister(id: string): void {
    if (!this.commands.delete(id)) return;
    for (const [key, cmd] of this.keymap) if (cmd === id) this.keymap.delete(key);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** Every command, sorted by category then id. */
  list(): CommandInfo[] {
    return [...this.commands.values()]
      .map(c => ({
        id: c.id,
        label: c.label,
        category: c.category,
        description: c.description,
        shortcuts: (c.shortcuts ?? []).map(normalizeShortcut),
        requiresUI: c.requiresUI === true,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  /** The command bound to a key combination, if any. */
  commandForShortcut(shortcut: string): string | undefined {
    return this.keymap.get(normalizeShortcut(shortcut));
  }

  /** Install (or remove, with null) the UI the commands open dialogs in. */
  setUIHost(host: UIHost | null): void {
    this.uiHost = host;
  }

  /** Called after every top-level command run (nested runs are part of their caller). */
  onExecute(listener: (execution: CommandExecution) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run a command; returns what it returns and rethrows its errors. */
  execute(id: string, args?: unknown): unknown {
    const def = this.commands.get(id);
    if (!def) throw new CommandError('UNKNOWN_COMMAND', `Unknown command "${id}"`);
    if (def.requiresUI && !this.uiHost) throw new CommandError('NOT_AVAILABLE', `Command "${id}" needs the application UI`);

    const ctx: CommandContext<S> = {
      state: this.getState,
      ui: () => {
        if (!this.uiHost) throw new CommandError('NOT_AVAILABLE', `Command "${id}" needs the application UI`);
        return this.uiHost;
      },
      execute: (nested, nestedArgs) => this.execute(nested, nestedArgs),
    };

    const topLevel = this.depth === 0;
    this.depth++;
    try {
      const result = def.run(ctx, args as never);
      if (topLevel) this.emit(result === undefined ? { id, args, ok: true } : { id, args, ok: true, result });
      return result;
    } catch (err) {
      if (topLevel) this.emit({ id, args, ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** The macro step a successful run is recorded as, or null when it is not recorded. */
  macroStepFor(execution: CommandExecution): MacroStep | null {
    const def = this.commands.get(execution.id);
    if (!def || !execution.ok || def.record === false) return null;
    // Dialog and file-picker commands cannot be replayed unless they say how
    if (def.requiresUI && typeof def.record !== 'function') return null;
    if (typeof def.record === 'function') return def.record(execution.args as never, execution.result, this.getState());
    const returns = idsOf(execution.result);
    return {
      command: execution.id,
      ...(execution.args === undefined ? {} : { args: execution.args }),
      ...(returns ? { returns } : {}),
    };
  }

  private emit(execution: CommandExecution): void {
    for (const l of this.listeners) {
      try { l(execution); } catch (e) { console.error('[CasiWorks] command listener failed:', e); }
    }
  }
}
