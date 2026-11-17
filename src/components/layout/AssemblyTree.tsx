// CasiWorks Pro - The assembly in the tree: components (with what the mates leave them free to do) and mates
import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, Box, Link2, Trash2, AlertTriangle } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { runCommand } from '../../commands/index.ts';

const TAG: Record<string, { text: string; cls: string; label: string }> = {
  fixed: { text: '(f)', cls: 'dof-fixed', label: 'fixed in place' },
  'fully-defined': { text: '', cls: 'dof-full', label: 'fully defined' },
  'under-defined': { text: '(-)', cls: 'dof-under', label: 'under defined' },
  'over-defined': { text: '(+)', cls: 'dof-over', label: 'over defined: its mates conflict' },
};

const LINK: Record<string, string> = { workspace: 'linked', library: 'library', cached: 'cached copy' };

export default function AssemblyTree({ filter = '' }: { filter?: string }) {
  const components = useCADStore(s => s.assemblyComponents);
  const mates = useCADStore(s => s.mates);
  const dof = useCADStore(s => s.assemblyDof);
  const selected = useCADStore(s => s.selectedEntities);
  const setSelection = useCADStore(s => s.setSelection);
  const addToSelection = useCADStore(s => s.addToSelection);
  const [compsOpen, setCompsOpen] = useState(true);
  const [matesOpen, setMatesOpen] = useState(true);
  const f = filter.trim().toLowerCase();
  const byId = new Map(components.map(c => [c.id, c]));
  const nameOf = (id: string) => byId.get(id)?.name ?? '?';
  const conflicts = new Set(dof?.conflicts ?? []);
  const shown = components.filter(c => !f || c.name.toLowerCase().includes(f));
  const shownMates = mates.filter(m => !f || `${m.type} ${nameOf(m.comp1Id)} ${nameOf(m.comp2Id)}`.toLowerCase().includes(f));

  const summary = !dof ? 'Empty: insert parts from the Assembly tab'
    : dof.status === 'over-defined' ? `Over defined: ${dof.conflicts.length} mate${dof.conflicts.length === 1 ? '' : 's'} conflict`
      : dof.status === 'fully-defined' ? 'Fully defined'
        : `Under defined: ${dof.dof} degree${dof.dof === 1 ? '' : 's'} of freedom`;

  const folder = (open: boolean, toggle: () => void, label: string, count: number) => (
    <div className="tree-node-item folder-node" onClick={toggle} role="button" tabIndex={0} aria-expanded={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
      {open ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
      <div className="tree-icon-badge" style={{ background: 'rgba(251, 191, 36, 0.15)' }}><Folder size={13} color="#fbbf24" /></div>
      <span className="tree-node-label">{label} ({count})</span>
    </div>
  );

  return (
    <div className="assembly-tree" aria-label="Assembly">
      <div className={`assembly-dof-summary dof-${dof?.status ?? 'empty'}`} role="status"
        style={{ fontSize: 11, padding: '4px 12px 6px', color: dof?.status === 'over-defined' ? '#f87171' : dof?.status === 'fully-defined' ? '#4ade80' : '#fbbf24' }}>
        {summary}
      </div>
      {folder(compsOpen, () => setCompsOpen(!compsOpen), 'Components', components.length)}
      {compsOpen && (
        <div role="list" aria-label="Components">
          {shown.map(c => {
            const d = dof?.components.find(x => x.id === c.id);
            const tag = TAG[d?.status ?? 'fully-defined'];
            const isSel = selected.some(e => e.id === c.id);
            const why = d ? `${c.name}: ${tag.label}${d.dof ? `, free to ${d.motions.join(', ')}` : ''}` : c.name;
            return (
              <div key={c.id} role="listitem" style={{ display: 'flex', alignItems: 'center' }}>
                <button className={`assembly-tree-item assembly-component ${isSel ? 'selected' : ''}`} title={why} aria-label={why}
                  onClick={(e) => (e.ctrlKey || e.metaKey ? addToSelection({ id: c.id }) : setSelection({ id: c.id }))}
                  onKeyDown={(e) => { if (e.key === 'Delete') { e.preventDefault(); runCommand('assembly.removeComponent', { id: c.id }); } }}>
                  <span className={`dof-tag ${tag.cls}`}>{tag.text}</span>
                  <Box size={12} color={c.source ? '#4ade80' : '#38bdf8'} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  {c.source && <span className={`link-tag ${c.source.linked === 'cached' ? 'link-cached' : ''}`} title={c.source.linked === 'cached' ? 'The part could not be found: showing the copy saved with the assembly. Open the part, or start the library, and choose Update' : `Follows ${c.source.name}`}>{LINK[c.source.linked]}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {folder(matesOpen, () => setMatesOpen(!matesOpen), 'Mates', mates.length)}
      {matesOpen && (
        <div role="list" aria-label="Mates">
          {shownMates.map(m => {
            const bad = conflicts.has(m.id);
            const value = m.type === 'distance' ? ` ${m.offset} mm` : m.type === 'angle' ? ` ${Math.round(m.angle * 10) / 10}°` : '';
            const label = `${m.type[0].toUpperCase()}${m.type.slice(1)}${value}: ${nameOf(m.comp1Id)} – ${nameOf(m.comp2Id)}`;
            return (
              <div key={m.id} role="listitem" style={{ display: 'flex', alignItems: 'center' }}>
                <button className={`assembly-tree-item assembly-mate ${bad ? 'conflict' : ''}`} title={bad ? `${label}: conflicts with other mates` : label}
                  onDoubleClick={() => { if (m.type === 'distance' || m.type === 'angle') runCommand('assembly.motion'); }}>
                  {bad ? <AlertTriangle size={12} color="#f87171" /> : <Link2 size={12} color="#22d3ee" />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: bad ? '#f87171' : undefined }}>{label}</span>
                </button>
                <button className="icon-btn" aria-label={`Delete ${label}`} title="Delete mate" style={{ padding: 2, marginRight: 6 }}
                  onClick={() => useCADStore.getState().removeAssemblyMate(m.id)}><Trash2 size={11} color="#71717a" /></button>
              </div>
            );
          })}
          {mates.length === 0 && components.length > 1 && (
            <div style={{ fontSize: 11, color: '#94a3b8', padding: '2px 22px' }}>No mates: use Mate on the Assembly tab and pick two faces.</div>
          )}
        </div>
      )}
    </div>
  );
}
