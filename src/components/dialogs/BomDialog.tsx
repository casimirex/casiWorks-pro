// CasiWorks Pro - Bill of Materials dialog
import { useMemo } from 'react';
import { X, FileText, Download } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { MATERIALS } from '../../utils/constants.ts';
import { buildBom, massIn } from '../../assembly/bom.ts';
import { useUnits } from '../common/useUnits.ts';
import { runCommand } from '../../commands/index.ts';
import { useDialog } from '../common/useDialog.ts';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}


export default function BomDialog({ isOpen, onClose }: DialogProps) {
  const components = useCADStore(s => s.assemblyComponents);
  const activeMaterial = useCADStore(s => s.activeMaterial);
  const bom = useMemo(() => buildBom(components, activeMaterial), [components, activeMaterial]);
  // Masses in the document's mass unit (g, kg or lb)
  const u = useUnits();
  const grams = (kg: number) => Number(massIn(kg, u.massUnit as 'g' | 'kg' | 'lb')).toLocaleString(undefined, { minimumFractionDigits: u.massUnit === 'g' ? 2 : 4, maximumFractionDigits: u.massUnit === 'g' ? 2 : 4 });

  const dialog = useDialog(isOpen, onClose, 'Bill of Materials');
  if (!isOpen) return null;

  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#94a3b8', fontWeight: 600, borderBottom: '1px solid #333', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #2a2a2e' };
  const num: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box bom-dialog" style={{ width: 720, maxWidth: 'calc(100vw - 24px)' }} onClick={(e) => e.stopPropagation()} {...dialog}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FileText size={16} color="#fbbf24" />
            <span>Bill of Materials</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="dialog-body">
          {bom.rows.length === 0 ? (
            <div style={{ fontSize: 12, color: '#aaa' }}>The assembly is empty. Insert components on the Assembly tab first.</div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="bom-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={th}>Item</th><th style={th}>Part number</th><th style={th}>Description</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={th}>Material</th>
                      <th style={{ ...th, textAlign: 'right' }}>Unit mass ({u.massUnit})</th><th style={{ ...th, textAlign: 'right' }}>Total ({u.massUnit})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bom.rows.map(r => (
                      <tr key={r.item}>
                        <td style={num}>{r.item}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{r.partNumber}</td>
                        <td style={td}>{r.description}</td>
                        <td style={num}>{r.quantity}</td>
                        <td style={td}>
                          <select
                            className="bom-material property-select"
                            value={r.inherited ? '' : r.materialKey}
                            onChange={(e) => runCommand('assembly.setMaterial', { components: r.componentIds, material: e.target.value || null })}
                            aria-label={`Material of ${r.partNumber}`}
                            style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }}
                          >
                            <option value="">Part material ({bom.material})</option>
                            {Object.entries(MATERIALS).map(([key, m]) => <option key={key} value={key}>{m.name}</option>)}
                          </select>
                        </td>
                        <td style={num}>{grams(r.unitMass)}</td>
                        <td style={num}>{grams(r.totalMass)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bom-total">
                      <td style={{ ...td, fontWeight: 700 }} colSpan={3}>Total</td>
                      <td style={{ ...num, fontWeight: 700 }}>{bom.totalQuantity}</td>
                      <td style={td} colSpan={2} />
                      <td style={{ ...num, fontWeight: 700, color: '#4fc3f7' }}>{grams(bom.totalMass)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p style={{ fontSize: 11, color: '#888', margin: '10px 0 0' }}>
                Identical parts (same name, size and material) share a row. Choose a material per row; “Part material” follows the document material ({bom.material}). Masses use exact volumes of the component shapes.
              </p>
            </>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={() => runCommand('assembly.exportBom')} disabled={bom.rows.length === 0} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>
    </div>
  );
}
