// CasiWorks Pro - Scripting console: run API snippets typed by the user
//
// Snippets run in the user's own browser with the same rights as the browser's
// developer console; they see only what is passed in `scope` (api, run, …) as
// local names, can use `await`, and the value of a lone expression is returned.

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface ConsoleLine {
  level: LogLevel;
  text: string;
}

export interface SnippetResult {
  ok: boolean;
  /** The value of the snippet (expression value or `return`), formatted. */
  value?: string;
  /** Lines the snippet logged with console.log / info / warn / error. */
  logs: ConsoleLine[];
  /** Error message (with the API error code when there is one). */
  error?: string;
  ms: number;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** Format any value for display: JSON for data, readable forms for the rest. */
export function formatValue(value: unknown, maxLength = 20000): string {
  const text = describe(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… (${text.length - maxLength} more characters)` : text;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}()`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'function') return `ƒ ${(v as { name?: string }).name || 'anonymous'}()`;
      if (typeof v === 'bigint') return `${v}n`;
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        // Typed arrays and three.js buffers would print thousands of numbers
        if (ArrayBuffer.isView(v)) return `[${v.constructor.name} × ${(v as unknown as { length: number }).length}]`;
      }
      return v;
    }, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return `${err.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${err.message}`;
  }
  return `Thrown: ${formatValue(err)}`;
}

/** Compile the snippet: as an expression when it is one, otherwise as statements. */
function compile(code: string, names: string[]): (...args: unknown[]) => Promise<unknown> {
  const trimmed = code.trim().replace(/;+\s*$/, '');
  try {
    // A single expression (no top-level statements): return its value
    return new AsyncFunction(...names, `return (${trimmed}\n);`);
  } catch {
    // Statements: like the browser console, show the value of a final expression line
    const lines = trimmed.split('\n');
    const last = lines.pop() ?? '';
    const lastStatement = last.split(';').map(x => x.trim()).filter(Boolean);
    const tail = lastStatement.pop();
    if (tail && !/^(return|const|let|var|if|for|while|function|class|throw|try|switch|\})\b/.test(tail)) {
      try {
        return new AsyncFunction(...names, [...lines, lastStatement.join(';') + (lastStatement.length ? ';' : ''), `return (${tail}\n);`].join('\n'));
      } catch { /* not an expression: run as written */ }
    }
    return new AsyncFunction(...names, code);
  }
}

/**
 * Run a snippet with `scope` as its local names (e.g. { api, run }). A
 * `console` local captures logging; it also forwards to the real console.
 */
export async function evaluateSnippet(code: string, scope: Record<string, unknown>): Promise<SnippetResult> {
  const logs: ConsoleLine[] = [];
  const capture = (level: LogLevel) => (...args: unknown[]) => {
    logs.push({ level, text: args.map(a => (typeof a === 'string' ? a : formatValue(a))).join(' ') });
    console[level](...args);
  };
  const localConsole = { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error') };
  const names = [...Object.keys(scope), 'console'];
  const start = performance.now();
  try {
    const fn = compile(code, names);
    const value = await fn(...Object.values(scope), localConsole);
    return { ok: true, value: formatValue(value), logs, ms: performance.now() - start };
  } catch (err) {
    return { ok: false, error: errorText(err), logs, ms: performance.now() - start };
  }
}
