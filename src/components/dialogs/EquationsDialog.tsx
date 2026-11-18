// CasiWorks Pro - Equations dialog: global variables and the feature sizes they drive
import { useEffect, useMemo, useState } from 'react';
import { X, Sigma, Plus, Trash2 } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { dimensionLinks, effectiveVariables, evaluateLinks, evaluateVariables } from '../../features/equations.ts';
import type { GlobalVariable } from '../../features/equations.ts';
import { runCommand } from '../../commands/index.ts';
import { useDialog } from '../common/useDialog.ts';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(+v.toFixed(4)));

export default function EquationsDialog({ isOpen, onClose }: DialogProps) {
  const variables = useCADStore(s => s.variables);
  const features = useCADStore(s => s.features);
  const configurations = useCADStore(s => s.configurations);
  const activeConfiguration = useCADStore(s => s.activeConfiguration);
  const [draft, setDraft] = useState<GlobalVariable[]>([]);

  // Start from the document's variables each time the dialog opens
  useEffect(() => { if (isOpen) setDraft(variables.map(v => ({ ...v }))); }, [isOpen, variables]);

  const config = configurations.find(c => c.name === activeConfiguration);
  const { values, errors } = useMemo(() => evaluateVariables(effectiveVariables(draft.filter(v => v.name || v.expression), config)), [draft, config]);
  const sketchConstraints = useCADStore(s => s.sketchConstraints);
  const links = useMemo(() => [...evaluateLinks(features, values).links, ...dimensionLinks(features, sketchConstraints, values)], [features, values, sketchConstraints]);
  const changed = JSON.stringify(draft) !== JSON.stringify(variables);
  const blank = draft.some(v => !v.name.trim() || !v.expression.trim());
  const hasErrors = Object.keys(errors).length > 0 || blank;

  const dialog = useDialog(isOpen, onClose, 'Equations');
  if (!isOpen) return null;

  const update = (i: number, patch: Partial<GlobalVariable>) => setDraft(d => d.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const apply = () => {
    runCommand('equations.set', { variables: draft.map(v => ({ name: v.name.trim(), expression: v.expression.trim() })) });
  };

  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #333' };
  const td: React.CSSProperties = { padding: '4px 6px', borderBottom: '1px solid #2a2a2e', verticalAlign: 'middle' };
  const input: React.CSSProperties = { width: '100%', padding: '4px 6px', fontSize: 12, fontFamily: 'ui-monospace, monospace' };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box equations-dialog" style={{ width: 640, maxWidth: 'calc(100vw - 24px)' }} onClick={(e) => e.stopPropagation()} {...dialog}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sigma size={16} color="#a78bfa" />
            <span>Equations</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="dialog-body" onKeyDown={(e) => e.stopPropagation()}>
          <p style={{ fontSize: 11, color: '#999', margin: '0 0 8px' }}>
            Name sizes once and use them anywhere: type an expression such as <code>wall * 2</code> into a feature&apos;s number field.
            Lengths are in mm (whatever the unit system: equations work in model units), angles in degrees. Operators: + − * / ^ ( ); functions sqrt, abs, round, floor, ceil, sin, cos, tan, min, max; constant pi.
          </p>
          {config && (
            <p className="eq-config-note" style={{ fontSize: 11, color: '#38bdf8', margin: '0 0 8px' }}>
              Configuration <b>{config.name}</b> is active: values include its changes ({Object.keys(config.values).join(', ') || 'none'}). Expressions here are the defaults.
            </p>
          )}
          <table className="equations-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr><th style={{ ...th, width: '26%' }}>Name</th><th style={th}>Expression</th><th style={{ ...th, width: '18%', textAlign: 'right' }}>Value</th><th style={{ ...th, width: 32 }} /></tr>
            </thead>
            <tbody>
              {draft.map((v, i) => (
                <tr key={i} className="equation-row">
                  <td style={td}><input className="property-select eq-name" style={input} value={v.name} placeholder="name" onChange={(e) => update(i, { name: e.target.value })} aria-label={`Name ${i + 1}`} /></td>
                  <td style={td}><input className="property-select eq-expression" style={input} value={v.expression} placeholder="e.g. 3 or wall * 2" onChange={(e) => update(i, { expression: e.target.value })} aria-label={`Expression ${i + 1}`} /></td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {errors[v.name]
                      ? <span className="eq-error" style={{ color: '#f87171', fontSize: 11 }} title={errors[v.name]}>{errors[v.name]}</span>
                      : <span className="eq-value">{fmt(values[v.name])}</span>}
                  </td>
                  <td style={td}>
                    <button className="icon-btn" onClick={() => setDraft(d => d.filter((_, j) => j !== i))} title={`Delete ${v.name || 'row'}`} aria-label={`Delete ${v.name || 'row'}`}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn-secondary eq-add" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 4 }} onClick={() => setDraft(d => [...d, { name: '', expression: '' }])}>
            <Plus size={14} /> Add variable
          </button>

          <div style={{ marginTop: 14, fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>Linked feature sizes</div>
          {links.length === 0 ? (
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>None yet. In a feature&apos;s panel, type an expression that uses a variable; the field shows ƒ.</div>
          ) : (
            <table className="equation-links" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 4 }}>
              <tbody>
                {links.map(l => (
                  <tr key={`${l.featureId}-${l.parameter}-${l.expression}`}>
                    <td style={td}>{l.featureName}</td>
                    <td style={td}>{l.parameter}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>= {l.expression}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{l.error ? <span style={{ color: '#f87171' }} title={l.error}>{l.error}</span> : fmt(l.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary eq-apply" onClick={apply} disabled={!changed || hasErrors} title={hasErrors ? 'Fix the errors first' : 'Apply and rebuild'}>Apply</button>
        </div>
      </div>
    </div>
  );
}
