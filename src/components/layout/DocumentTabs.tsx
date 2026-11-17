// CasiWorks Pro - Tabs for the open documents (parts and assemblies)
import { useSyncExternalStore } from 'react';
import { Box, Cpu, X, Plus } from 'lucide-react';
import { workspace } from '../../workspace/index.ts';
import { runCommand } from '../../commands/index.ts';

export default function DocumentTabs() {
  const docs = useSyncExternalStore(cb => workspace.subscribe(cb), () => workspace.list());

  const close = (id: string, name: string, modified: boolean) => {
    if (modified && !window.confirm(`Close ${name} without saving its changes?`)) return;
    runCommand('workspace.close', { id, discard: true });
  };

  return (
    <div className="document-tabs" role="tablist" aria-label="Open documents">
      {docs.map((d, i) => (
        <div key={d.id} className={`document-tab ${d.active ? 'active' : ''}`}>
          <button
            role="tab"
            aria-selected={d.active}
            tabIndex={d.active ? 0 : -1}
            className="document-tab-name"
            title={`${d.name} (${d.type})${d.modified ? ': unsaved changes' : ''}`}
            onClick={() => runCommand('workspace.activate', { id: d.id })}
            onKeyDown={(e) => {
              const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
              if (to === null || docs.length < 2) return;
              e.preventDefault();
              const next = docs[(to + docs.length) % docs.length];
              runCommand('workspace.activate', { id: next.id });
              requestAnimationFrame(() => (document.querySelector('.document-tab.active [role="tab"]') as HTMLElement | null)?.focus());
            }}
          >
            {d.type === 'assembly' ? <Cpu size={12} color="#a78bfa" /> : <Box size={12} color="#38bdf8" />}
            <span>{d.name}</span>
            {d.modified && <span className="document-tab-dot" aria-label="unsaved changes">●</span>}
          </button>
          <button className="document-tab-close" aria-label={`Close ${d.name}`} title={`Close ${d.name}`} onClick={() => close(d.id, d.name, d.modified)}>
            <X size={11} />
          </button>
        </div>
      ))}
      <button className="document-tab-new" onClick={() => runCommand('workspace.newPart')} title="New part" aria-label="New part">
        <Plus size={12} /> New part
      </button>
      <button className="document-tab-new" onClick={() => runCommand('workspace.newAssembly')} title="New assembly (Ctrl+Alt+A)" aria-label="New assembly">
        <Plus size={12} /> New assembly
      </button>
    </div>
  );
}
