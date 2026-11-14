// CasiWorks Pro - Macros: record commands, replay them, export them as a script
//
// A macro is the list of model-changing commands a user (or script) ran, as
// plain JSON. Replaying runs the same commands again; ids created while
// recording (sketches, features, components) are mapped to the ids created by
// the replay, so later steps refer to the right objects and a macro can run
// any number of times in the same document.
import { CommandError } from './CommandRegistry.ts';
import type { CommandExecution, CommandRegistry, MacroStep } from './CommandRegistry.ts';
import { downloadBlob } from '../utils/download.ts';

export const MACRO_FORMAT = 'casiworks-macro';
export const MACRO_FORMAT_VERSION = 1;

export interface Macro {
  format: typeof MACRO_FORMAT;
  version: typeof MACRO_FORMAT_VERSION;
  name: string;
  /** ISO date-time. */
  recordedAt: string;
  steps: MacroStep[];
}

/** The parts of a command registry macros use. */
export interface MacroRegistry {
  execute(id: string, args?: unknown): unknown;
  has(id: string): boolean;
  onExecute(listener: (execution: CommandExecution) => void): () => void;
  macroStepFor(execution: CommandExecution): MacroStep | null;
}

export class MacroError extends Error {
  readonly step: number;
  constructor(step: number, message: string) {
    super(message);
    this.name = 'MacroError';
    this.step = step;
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

/** Records the steps of every command run while recording is on. */
export class MacroRecorder {
  private registry: MacroRegistry;
  private steps: MacroStep[] | null = null;
  private name = '';
  private stopListening: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private replaying = 0;

  constructor(registry: MacroRegistry) {
    this.registry = registry;
  }

  get isRecording(): boolean {
    return this.steps !== null;
  }

  get stepCount(): number {
    return this.steps?.length ?? 0;
  }

  start(name = 'Macro'): void {
    if (this.steps) throw new CommandError('NOT_AVAILABLE', 'Already recording');
    this.steps = [];
    this.name = name;
    this.stopListening = this.registry.onExecute(e => {
      if (!this.steps || this.replaying) return;
      const step = this.registry.macroStepFor(e);
      if (step) {
        this.steps.push(clone(step));
        this.changed();
      }
    });
    this.changed();
  }

  stop(): Macro {
    if (!this.steps) throw new CommandError('NOT_AVAILABLE', 'Not recording');
    const macro: Macro = { format: MACRO_FORMAT, version: MACRO_FORMAT_VERSION, name: this.name, recordedAt: new Date().toISOString(), steps: this.steps };
    this.stopListening?.();
    this.stopListening = null;
    this.steps = null;
    this.changed();
    return macro;
  }

  /** Replay a macro (not recorded itself, even while recording). */
  run(macro: unknown): { steps: number; ids: Record<string, string> } {
    this.replaying++;
    try {
      return runMacro(this.registry, macro);
    } finally {
      this.replaying--;
    }
  }

  /** Notified when recording starts, stops or gains a step (for UI state). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}

/** Check that `value` is a macro and return it. */
export function parseMacro(value: unknown): Macro {
  const m = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<Macro> | null;
  if (!m || typeof m !== 'object' || m.format !== MACRO_FORMAT) throw new CommandError('INVALID_ARGUMENT', 'Not a CasiWorks macro');
  if (m.version !== MACRO_FORMAT_VERSION) throw new CommandError('INVALID_ARGUMENT', `Unsupported macro version ${m.version}`);
  if (!Array.isArray(m.steps) || m.steps.some(s => !s || typeof s.command !== 'string')) throw new CommandError('INVALID_ARGUMENT', 'Macro steps must be { command, args? }');
  return m as Macro;
}

/** Replace every string that is a recorded id with the id the replay created. */
function remap(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map(v => remap(v, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, ids)]));
  return value;
}

/** Run every step in order; stops at the first failing step (MacroError with its index). */
export function runMacro(registry: Pick<MacroRegistry, 'execute' | 'has'>, macro: unknown): { steps: number; ids: Record<string, string> } {
  const m = parseMacro(macro);
  const unknown = m.steps.map(s => s.command).filter(c => !registry.has(c));
  if (unknown.length) throw new MacroError(m.steps.findIndex(s => !registry.has(s.command)), `Unknown command(s): ${[...new Set(unknown)].join(', ')}`);

  const ids = new Map<string, string>();
  m.steps.forEach((step, i) => {
    let result: unknown;
    try {
      result = registry.execute(step.command, remap(clone(step.args), ids));
    } catch (err) {
      throw new MacroError(i, `Step ${i + 1} (${step.command}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const [key, recorded] of Object.entries(step.returns ?? {})) {
      const created = (result as Record<string, unknown> | undefined)?.[key];
      if (typeof created === 'string') ids.set(recorded, created);
    }
  });
  return { steps: m.steps.length, ids: Object.fromEntries(ids) };
}

/**
 * The macro as a JavaScript module that runs it through the public API, in the
 * app (paste into the console) or headless (`node macro.mjs`). Created ids are
 * held in variables, so the script is readable and safe to edit.
 */
export function macroToScript(macro: Macro): string {
  const vars = new Map<string, string>(); // recorded id → expression
  let counter = 0;
  const lit = (v: unknown, indent: string): string => {
    if (typeof v === 'string') return vars.get(v) ?? JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return `[\n${v.map(x => `${indent}  ${lit(x, indent + '  ')}`).join(',\n')},\n${indent}]`;
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return '{}';
      const inline = entries.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${lit(x, indent + '  ')}`);
      const one = `{ ${inline.join(', ')} }`;
      return one.length <= 100 && !one.includes('\n') ? one : `{\n${inline.map(e => `${indent}  ${e}`).join(',\n')},\n${indent}}`;
    }
    return JSON.stringify(v);
  };

  const lines = [
    `// CasiWorks macro "${macro.name.replace(/\n/g, ' ')}" — recorded ${macro.recordedAt}`,
    '// Run it in the app (paste into the browser console) or headless with Node 22.18+:',
    '//   node this-file.mjs   (in a project with casiworks-pro installed)',
    "const api = globalThis.casiworks ?? (await import('casiworks-pro/api')).createHeadlessAPI();",
    'const run = (command, args) => api.commands.execute(command, args);',
    '',
  ];
  for (const step of macro.steps) {
    const call = `run(${JSON.stringify(step.command)}${step.args === undefined ? '' : `, ${lit(step.args, '')}`});`;
    const returns = Object.entries(step.returns ?? {});
    if (returns.length) {
      const name = `r${++counter}`;
      for (const [key, id] of returns) vars.set(id, `${name}.${key}`);
      lines.push(`const ${name} = ${call}`);
    } else {
      lines.push(call);
    }
  }
  lines.push('', `console.log('Macro "${macro.name.replace(/['\\\n]/g, ' ')}": ${macro.steps.length} steps done');`, '');
  return lines.join('\n');
}

// ------------------------------------------------------------------ commands

export const MACRO_EXTENSION = '.casimacro.json';

const fileName = (name: string) => name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'macro';

/**
 * Give a registry macro recording: creates its recorder and registers the
 * macro.* commands (record, stop & save, save as script, run, run from file).
 */
export function attachMacros<S>(registry: CommandRegistry<S>): MacroRecorder {
  const recorder = new MacroRecorder(registry);
  let last: Macro | null = null;
  const status = (state: S, message: string) => (state as { setStatus?(m: string): void }).setStatus?.(message);

  registry.register({
    id: 'macro.record', label: 'Record macro', category: 'Macro', record: false,
    description: 'args: { name? } — record model-changing commands until macro.stop',
    run: ({ state }, args: { name?: string } | undefined) => {
      recorder.start(args?.name || `Macro ${new Date().toLocaleString()}`);
      status(state(), 'Recording macro… (Tools ▸ Stop to save it)');
    },
  });
  registry.register({
    id: 'macro.stop', label: 'Stop recording and save', category: 'Macro', record: false, requiresUI: true,
    description: `Stops recording and downloads the macro (${MACRO_EXTENSION})`,
    run: ({ state }) => {
      last = recorder.stop();
      downloadBlob(JSON.stringify(last, null, 2), fileName(last.name) + MACRO_EXTENSION, 'application/json');
      status(state(), `Macro saved: ${last.steps.length} step(s)`);
      return last;
    },
  });
  registry.register({
    id: 'macro.saveScript', label: 'Save last macro as script', category: 'Macro', record: false, requiresUI: true,
    description: 'Downloads the last recorded macro as a JavaScript module (.mjs) for the console or Node',
    run: ({ state }) => {
      if (!last) throw new CommandError('NOT_AVAILABLE', 'Record a macro first');
      downloadBlob(macroToScript(last), fileName(last.name) + '.mjs', 'text/javascript');
      status(state(), `Script saved: ${fileName(last.name)}.mjs`);
    },
  });
  registry.register({
    id: 'macro.run', label: 'Run macro', category: 'Macro', record: false,
    description: 'args: { macro } — a recorded macro object or its JSON text; returns { steps, ids }',
    run: ({ state }, args: { macro: unknown }) => {
      const result = recorder.run(args?.macro);
      status(state(), `Macro ran ${result.steps} step(s)`);
      return result;
    },
  });
  registry.register({
    id: 'macro.runFile', label: 'Run macro from file…', category: 'Macro', record: false, requiresUI: true,
    run: ({ state }) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = `${MACRO_EXTENSION},.json`;
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const result = recorder.run(await file.text());
          status(state(), `Macro "${file.name}" ran ${result.steps} step(s)`);
        } catch (err) {
          status(state(), `Macro "${file.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      input.click();
    },
  });
  return recorder;
}
