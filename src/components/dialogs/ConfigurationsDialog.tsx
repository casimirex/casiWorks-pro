// CasiWorks Pro - Configurations dialog: a design table of variable values per configuration
import { useEffect, useMemo, useState } from 'react';
import { X, Layers, Plus, Trash2 } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { configurationProblems, effectiveVariables, evaluateVariables } from '../../features/equations.ts';
import type { Configuration } from '../../features/equations.ts';
import { runCommand } from '../../commands/index.ts';
import { useDialog } from '../common/useDialog.ts';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}

const fmt = (v: number | undefined) => (v === undefined ? '—' : String(+v.toFixed(4)));

export default function ConfigurationsDialog({ isOpen, onClose }: DialogProps) {
  const variables = useCADStore(s => s.variables);
  const configurations = useCADStore(s => s.configurations);
  const active = useCADStore(s => s.activeConfiguration);
  const [draft, setDraft] = useState<Configuration[]>([]);

  useEffect(() => { if (isOpen) setDraft(configurations.map(c => ({ name: c.name, values: { ...c.values } }))); }, [isOpen, configurations]);

  const problems = useMemo(() => configurationProblems(variables, draft), [variables, draft]);
  const defaults = useMemo(() => evaluateVariables(variables).values, [variables]);
  const changed = JSON.stringify(draft) !== JSON.stringify(configurations);

  const dialog = useDialog(isOpen, onClose, 'Configurations');
  if (!isOpen) return null;

  const setCell = (i: number, variable: string, expression: string) => setDraft(d => d.map((c, j) => {
    if (j !== i) return c;
    const values = { ...c.values };
    if (expression.trim()) values[variable] = expression; else delete values[variable];
    return { ...c, values };
  }));
  const valuesOf = (c: Configuration) => evaluateVariables(effectiveVariables(variables, c)).values;

  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 6px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #333', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '4px 6px', borderBottom: '1px solid #2a2a2e', verticalAlign: 'middle' };
  const input: React.CSSProperties = { width: '100%', minWidth: 70, padding: '4px 6px', fontSize: 12, fontFamily: 'ui-monospace, monospace' };
  const activate = (name: string | null) => runCommand('configurations.activate', { name });

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box configurations-dialog" style={{ width: 760, maxWidth: 'calc(100vw - 24px)' }} onClick={(e) => e.stopPropagation()} {...dialog}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={16} color="#38bdf8" />
            <span>Configurations</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="dialog-body" onKeyDown={(e) => e.stopPropagation()}>
          {variables.length === 0 ? (
            <div style={{ fontSize: 12, color: '#aaa' }}>Configurations change variable values, and there are no variables yet. Add some in <b>Equations</b> first.</div>
          ) : (
            <>
              <p style={{ fontSize: 11, color: '#999', margin: '0 0 8px' }}>
                Each row is a version of the part. Fill in only the variables it changes; an empty cell keeps the default expression (its value here is shown in grey). Click a row&apos;s circle to make it active.
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table className="config-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, width: 40 }}>Active</th>
                      <th style={th}>Configuration</th>
                      {variables.map(v => <th key={v.name} style={th}>{v.name}</th>)}
                      <th style={{ ...th, width: 32 }} />
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="config-row config-default">
                      <td style={td}><input type="radio" name="active-config" checked={active === null} onChange={() => activate(null)} aria-label="Activate Default" /></td>
                      <td style={{ ...td, fontWeight: 600 }}>Default</td>
                      {variables.map(v => (
                        <td key={v.name} style={{ ...td, fontFamily: 'ui-monospace, monospace', color: '#cbd5e1' }} title={`= ${v.expression}`}>{fmt(defaults[v.name])}</td>
                      ))}
                      <td style={td} />
                    </tr>
                    {draft.map((c, i) => {
                      const saved = configurations.some(s => s.name === c.name) && !changed;
                      const vals = valuesOf(c);
                      return (
                        <tr key={i} className="config-row">
                          <td style={td}>
                            <input type="radio" name="active-config" checked={active === c.name} disabled={!saved} onChange={() => activate(c.name)}
                              title={saved ? `Activate ${c.name}` : 'Apply first'} aria-label={`Activate ${c.name || 'row'}`} />
                          </td>
                          <td style={td}><input className="property-select config-name" style={input} value={c.name} placeholder="name" onChange={(e) => setDraft(d => d.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={`Configuration name ${i + 1}`} /></td>
                          {variables.map(v => (
                            <td key={v.name} style={td}>
                              <input className="property-select config-cell" style={input} value={c.values[v.name] ?? ''} placeholder={fmt(vals[v.name])}
                                onChange={(e) => setCell(i, v.name, e.target.value)} aria-label={`${c.name || 'row'} ${v.name}`} title={`= ${fmt(vals[v.name])}`} />
                            </td>
                          ))}
                          <td style={td}><button className="icon-btn" onClick={() => setDraft(d => d.filter((_, j) => j !== i))} aria-label={`Delete ${c.name || 'row'}`} title="Delete"><Trash2 size={14} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button className="btn-secondary config-add" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={() => setDraft(d => [...d, { name: `Config${d.length + 1}`, values: {} }])}>
                <Plus size={14} /> Add configuration
              </button>
              {problems.length > 0 && (
                <ul className="config-problems" style={{ color: '#f87171', fontSize: 11, margin: '8px 0 0', paddingLeft: 18 }}>
                  {problems.map(p => <li key={p}>{p}</li>)}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary config-apply" onClick={() => runCommand('configurations.set', { configurations: draft })} disabled={!changed || problems.length > 0}>Apply</button>
        </div>
      </div>
    </div>
  );
}
