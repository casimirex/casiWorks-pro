// CasiWorks Pro - Scripting console panel: run API snippets inside the app
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Terminal, X, Trash2, Search } from 'lucide-react';
import { evaluateSnippet } from './evaluate.ts';
import type { LogLevel } from './evaluate.ts';
import type { CasiWorksAPI } from '../api/CasiWorksAPI.ts';

interface Entry {
  kind: 'input' | 'value' | 'log' | 'error' | 'info';
  text: string;
  level?: LogLevel;
  ms?: number;
}

const HISTORY_KEY = 'casiworks.console.history';
const MAX_HISTORY = 100;

const EXAMPLES: Array<{ label: string; code: string }> = [
  { label: 'Plate with a hole', code: `api.document.new();
const plate = api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -40, y: -25 }, corner2: { x: 40, y: 25 } }] });
api.features.extrude({ sketchId: plate.sketchId, depth: 10, name: 'Plate' });
const hole = api.sketches.create({ entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 8 }] });
api.features.extrude({ sketchId: hole.sketchId, depth: 10, endCondition: 'throughall', cut: true, name: 'Hole' });
api.model.massProperties()` },
  { label: 'List features', code: 'api.features.list().map(f => `${f.index}: ${f.name} (${f.type})`)' },
  { label: 'Mass properties', code: 'api.model.massProperties()' },
  { label: 'Log rebuilds', code: "api.on('rebuild', e => console.log(e.ok ? `rebuilt: ${e.bodyCount} body` : e.errors))" },
  { label: 'Change a depth', code: "const f = api.features.list().find(f => f.type === 'extrude_boss');\napi.features.update(f.id, { depth: 40 });\napi.model.boundingBox().size" },
];

const HELP = [
  'Type JavaScript and press Enter (Shift+Enter for a new line, ↑/↓ for history).',
  'In scope: api (the public API), run(id, args) = api.commands.execute, clear().',
  'Namespaces: api.document, sketches, features, model, materials, history, commands, macros; api.on(event, handler).',
  'await works; the value of the last line is shown. Click a command or example on the right to insert it.',
].join('\n');

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch { /* private mode or storage full: history is per session then */ }
}

const COLORS: Record<Entry['kind'], string> = { input: '#93c5fd', value: '#e5e7eb', log: '#cbd5e1', error: '#f87171', info: '#94a3b8' };
const LEVEL_COLORS: Partial<Record<LogLevel, string>> = { warn: '#fbbf24', error: '#f87171' };

interface ScriptConsoleProps {
  open: boolean;
  onClose(): void;
  api: CasiWorksAPI | undefined;
}

export default function ScriptConsole({ open, onClose, api }: ScriptConsoleProps) {
  const [entries, setEntries] = useState<Entry[]>([{ kind: 'info', text: HELP }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const history = useRef<string[]>(loadHistory());
  const historyPos = useRef(history.current.length);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { outputRef.current?.scrollTo(0, outputRef.current.scrollHeight); }, [entries]);

  const commandList = useMemo(() => (open && api ? api.commands.list() : []), [open, api]);
  const shownCommands = commandList.filter(c => !filter || `${c.id} ${c.label}`.toLowerCase().includes(filter.toLowerCase()));

  if (!open) return null;

  const append = (...more: Entry[]) => setEntries(prev => [...prev, ...more].slice(-500));

  const execute = async () => {
    const code = input.trim();
    if (!code || busy) return;
    if (history.current.at(-1) !== code) history.current.push(code);
    saveHistory(history.current);
    historyPos.current = history.current.length;
    setInput('');
    append({ kind: 'input', text: code });
    if (!api) {
      append({ kind: 'error', text: 'The API is not available' });
      return;
    }
    let cleared = false;
    setBusy(true);
    const result = await evaluateSnippet(code, {
      api,
      run: (id: string, args?: unknown) => api.commands.execute(id, args),
      clear: () => { cleared = true; },
    });
    setBusy(false);
    if (cleared) {
      setEntries([]);
      return;
    }
    append(
      ...result.logs.map(l => ({ kind: 'log' as const, level: l.level, text: l.text })),
      result.ok ? { kind: 'value', text: result.value ?? 'undefined', ms: result.ms } : { kind: 'error', text: result.error ?? 'Error', ms: result.ms },
    );
  };

  const insert = (code: string) => {
    setInput(prev => (prev.trim() ? `${prev}\n${code}` : code));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void execute();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowUp' && !el.value.slice(0, el.selectionStart).includes('\n')) {
      // History only from the first line, so multi-line editing still works
      if (historyPos.current > 0) {
        e.preventDefault();
        historyPos.current -= 1;
        setInput(history.current[historyPos.current]);
      }
    } else if (e.key === 'ArrowDown' && !el.value.slice(el.selectionEnd).includes('\n')) {
      if (historyPos.current < history.current.length) {
        e.preventDefault();
        historyPos.current += 1;
        setInput(history.current[historyPos.current] ?? '');
      }
    }
  };

  return (
    <div className="script-console" role="region" aria-label="Scripting console" style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, height: '42%', minHeight: 220, zIndex: 60,
      display: 'flex', background: '#0e0f13', borderTop: '1px solid #334155',
      fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace", fontSize: 12, color: '#e5e7eb',
    }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderBottom: '1px solid #1f2937', fontFamily: 'inherit' }}>
          <Terminal size={13} color="#38bdf8" />
          <span style={{ fontWeight: 600, color: '#38bdf8' }}>Console</span>
          <span style={{ color: '#64748b' }}>API {api?.version ?? '—'}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title="Clear output" onClick={() => setEntries([])}><Trash2 size={13} /></button>
          <button className="icon-btn" title="Close console (Esc)" onClick={onClose}><X size={14} /></button>
        </div>
        <div ref={outputRef} className="script-console-output" style={{ flex: 1, overflowY: 'auto', padding: '6px 10px' }}>
          {entries.map((e, i) => (
            <div key={i} className={`console-${e.kind}`} style={{
              color: (e.level && LEVEL_COLORS[e.level]) || COLORS[e.kind], whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              padding: '2px 0', borderBottom: e.kind === 'value' || e.kind === 'error' ? '1px solid #1f2937' : undefined,
            }}>
              {e.kind === 'input' ? '› ' : e.kind === 'value' ? '← ' : ''}
              {e.text}
              {e.ms !== undefined && e.ms >= 1 && <span style={{ color: '#475569' }}>  ({e.ms.toFixed(0)} ms)</span>}
            </div>
          ))}
          {busy && <div style={{ color: '#64748b' }}>running…</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 10px', borderTop: '1px solid #1f2937' }}>
          <span style={{ color: '#38bdf8', paddingTop: 3 }}>›</span>
          <textarea
            ref={inputRef}
            className="script-console-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.min(8, Math.max(1, input.split('\n').length))}
            spellCheck={false}
            placeholder="api.features.list()"
            aria-label="Script input"
            style={{ flex: 1, resize: 'none', background: 'transparent', color: '#f8fafc', border: 'none', outline: 'none', font: 'inherit', lineHeight: 1.5 }}
          />
        </div>
      </div>

      <aside className="script-console-side" style={{ width: 250, borderLeft: '1px solid #1f2937', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ padding: '6px 8px', fontSize: 10, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.5 }}>EXAMPLES</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 8px 6px' }}>
          {EXAMPLES.map(x => (
            <button key={x.label} className="console-example" onClick={() => insert(x.code)} title={x.code}
              style={{ fontSize: 10, padding: '2px 6px', background: '#1e293b', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 3, cursor: 'pointer' }}>
              {x.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderTop: '1px solid #1f2937' }}>
          <Search size={11} color="#64748b" />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={`${commandList.length} commands`} aria-label="Filter commands"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e5e7eb', fontSize: 11 }} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px 6px' }}>
          {shownCommands.map(c => (
            <button key={c.id} className="console-command" onClick={() => insert(`run('${c.id}')`)}
              title={`${c.label}${c.description ? ' — ' + c.description : ''}${c.shortcuts.length ? ` (${c.shortcuts.join(', ')})` : ''}`}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: '#cbd5e1', padding: '2px 4px', fontSize: 11, cursor: 'pointer', fontFamily: "ui-monospace, Menlo, monospace" }}>
              {c.id}{c.requiresUI ? <span style={{ color: '#64748b' }}> · UI</span> : null}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
