// CasiWorks Pro - Command palette (Ctrl+K or F1): every command, by name, from the keyboard
//
// Type to filter (all words must match the name, id or category), Up/Down to
// choose, Enter to run, Escape to close. A command that needs input it was not
// given says so here, and the palette stays open.
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { commands } from '../../commands/index.ts';
import { useDialog } from './useDialog.ts';

interface Props {
  isOpen: boolean;
  onClose(): void;
}

const MAX_SHOWN = 60;

export default function CommandPalette({ isOpen, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<{ message: string; help?: string } | null>(null);
  const dialog = useDialog(isOpen, onClose, 'Command palette');

  const all = useMemo(() => (isOpen ? commands.list().filter(c => c.id !== 'view.commandPalette') : []), [isOpen]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(c => {
      const text = `${c.label} ${c.id} ${c.category}`.toLowerCase();
      return words.every(w => text.includes(w));
    }).slice(0, MAX_SHOWN);
  }, [all, query]);

  if (!isOpen) return null;

  const close = () => { setQuery(''); setActive(0); setError(null); onClose(); };
  const run = (id: string) => {
    const info = all.find(c => c.id === id);
    try {
      commands.execute(id);
      close();
    } catch (err) {
      // Most often a command that needs input: say which, and what it takes
      const message = err instanceof Error ? err.message : String(err);
      setError({ message: `“${info?.label ?? id}” could not run: ${message}`, help: info?.description });
    }
  };
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const optionId = (i: number) => `palette-option-${i}`;

  return (
    <div className="dialog-backdrop command-palette-backdrop" onClick={close}>
      <div className="dialog-box command-palette" style={{ width: 560, maxWidth: 'calc(100vw - 24px)', alignSelf: 'flex-start', marginTop: '12vh' }}
        onClick={(e) => e.stopPropagation()} {...dialog} onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = shown.length;
            if (n) setActive((at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
            requestAnimationFrame(() => document.getElementById(optionId((at + (e.key === 'ArrowDown' ? 1 : -1) + n) % Math.max(1, n)))?.scrollIntoView({ block: 'nearest' }));
            return;
          }
          if (e.key === 'Enter' && shown[at]) { e.preventDefault(); run(shown[at].id); return; }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
          dialog.onKeyDown(e);
        }}>
        <div className="command-palette-search" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          <Search size={16} color="#94a3b8" aria-hidden="true" />
          <input
            className="command-palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={shown[at] ? optionId(at) : undefined}
            aria-label="Command name"
            placeholder="Type a command… (e.g. extrude, mass, isometric)"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); setError(null); }}
            style={{ flex: 1, background: 'transparent', border: 'none', color: '#fff', fontSize: 14, outline: 'none' }}
          />
        </div>
        {error && (
          <div className="command-palette-error" role="alert" style={{ padding: '6px 12px', fontSize: 12, color: '#f87171' }}>
            {error.message}
            {error.help && <div style={{ color: '#94a3b8', marginTop: 2 }}>It takes: {error.help}. Use its panel or the scripting console.</div>}
          </div>
        )}
        <ul id="command-palette-list" role="listbox" aria-label="Commands" style={{ listStyle: 'none', margin: 0, padding: 4, maxHeight: '50vh', overflowY: 'auto' }}>
          {shown.map((c, i) => (
            <li
              key={c.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              className={`command-palette-option ${i === at ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 4, cursor: 'pointer', background: i === at ? 'var(--bg-active)' : 'transparent', fontSize: 13 }}
            >
              <span style={{ flex: 1 }}>{c.label}</span>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{c.category}</span>
              {c.shortcuts[0] && <kbd style={{ fontSize: 10, color: '#cbd5e1', border: '1px solid #444', borderRadius: 3, padding: '0 4px' }}>{c.shortcuts[0]}</kbd>}
            </li>
          ))}
          {shown.length === 0 && <li style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>No command matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
