// CasiWorks Pro - Insert a part into the assembly: an open part document or a library part
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Package, X, Library as LibraryIcon, FileBox } from 'lucide-react';
import { workspace } from '../../workspace/index.ts';
import { library, LibraryUnavailable } from '../../library/client.ts';
import type { LibraryDocument, LibraryVersion } from '../../library/client.ts';
import { runCommand } from '../../commands/index.ts';
import { useCADStore } from '../../store/cadStore.ts';
import { useDialog } from '../common/useDialog.ts';

interface DialogProps { isOpen: boolean; onClose(): void }

export default function InsertPartDialog({ isOpen, onClose }: DialogProps) {
  const dialog = useDialog(isOpen, onClose, 'Insert part');
  const docs = useSyncExternalStore(cb => workspace.subscribe(cb), () => workspace.list());
  const activeId = useCADStore(s => s.documentId);
  const parts = docs.filter(d => d.type === 'part' && d.id !== activeId);
  const [libDocs, setLibDocs] = useState<LibraryDocument[] | null>(null);
  const [libProblem, setLibProblem] = useState<string | null>(null);
  const [chosenLib, setChosenLib] = useState<string | null>(null);
  const [versions, setVersions] = useState<LibraryVersion[]>([]);
  const [version, setVersion] = useState<string>('latest');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLibProblem(null);
    setChosenLib(null);
    library.documents()
      .then(d => setLibDocs(d.filter(x => x.kind !== 'assembly')))
      .catch(e => { setLibDocs(null); setLibProblem(e instanceof LibraryUnavailable ? 'The library is not running (npm run server), so only open documents can be inserted.' : String(e.message ?? e)); });
  }, [isOpen]);

  useEffect(() => {
    setVersion('latest');
    if (!chosenLib) { setVersions([]); return; }
    library.versions(chosenLib).then(setVersions).catch(() => setVersions([]));
  }, [chosenLib]);

  if (!isOpen) return null;

  const insertOpen = (id: string) => {
    runCommand('assembly.insertDocument', { documentId: id });
    onClose();
  };
  const insertLibrary = async () => {
    if (!chosenLib) return;
    setBusy(true);
    try {
      await runCommand('assembly.insertFromLibrary', { documentId: chosenLib, ...(version !== 'latest' ? { version: Number(version) } : {}) });
      onClose();
    } catch (e) {
      setLibProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const row = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left' as const, padding: '7px 8px', background: 'transparent', border: 'none', borderBottom: '1px solid #2a2a2e', color: '#fff', cursor: 'pointer', fontSize: 12 };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box insert-part-dialog" style={{ width: 560, maxWidth: 'calc(100vw - 24px)' }} onClick={(e) => e.stopPropagation()} {...dialog}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Package size={16} color="#4ade80" /><span>Insert part</span></div>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
            The component refers to the part: change the part and the assembly follows. Insert the same part again for another copy.
          </p>
          <section aria-label="Open part documents">
            <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Open documents</div>
            <div style={{ border: '1px solid #333', borderRadius: 4 }}>
              {parts.length === 0 && <div style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>No other part is open. Open or create one (New → Part), then come back here.</div>}
              {parts.map(d => (
                <button key={d.id} className="insert-open-part" style={row} onClick={() => insertOpen(d.id)} title={`Insert ${d.name}`}>
                  <FileBox size={14} color="#38bdf8" />
                  <span style={{ flex: 1, fontWeight: 600 }}>{d.name}</span>
                  {d.modified && <span style={{ fontSize: 10, color: '#fbbf24' }}>unsaved changes</span>}
                </button>
              ))}
            </div>
          </section>
          <section aria-label="Library parts">
            <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
              <LibraryIcon size={12} /> Library
            </div>
            {libProblem && <div className="insert-library-problem" style={{ fontSize: 12, color: '#fbbf24', marginBottom: 6 }}>{libProblem}</div>}
            {libDocs && (
              <>
                <div role="listbox" aria-label="Library parts" style={{ border: '1px solid #333', borderRadius: 4, maxHeight: 180, overflowY: 'auto' }}>
                  {libDocs.length === 0 && <div style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>No parts in the library yet.</div>}
                  {libDocs.map(d => (
                    <button key={d.id} role="option" aria-selected={chosenLib === d.id} className="insert-library-part"
                      style={{ ...row, background: chosenLib === d.id ? 'var(--bg-active)' : 'transparent' }} onClick={() => setChosenLib(d.id)}>
                      <LibraryIcon size={14} color="#a78bfa" />
                      <span style={{ flex: 1, fontWeight: 600 }}>{d.name}</span>
                      <span style={{ fontSize: 10, color: '#94a3b8' }}>v{d.headVersion}{d.latestRevision ? ` · rev ${d.latestRevision}` : ''}</span>
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <label style={{ fontSize: 12, color: '#94a3b8' }} htmlFor="insert-version">Version</label>
                  <select id="insert-version" className="property-select insert-version" style={{ flex: 1 }} value={version} onChange={(e) => setVersion(e.target.value)} disabled={!chosenLib}>
                    <option value="latest">Newest (follows new versions)</option>
                    {versions.map(v => <option key={v.number} value={v.number}>Version {v.number}{v.revision ? ` · rev ${v.revision}` : ''} (pinned)</option>)}
                  </select>
                  <button className="btn-primary insert-library-go" disabled={!chosenLib || busy} onClick={() => void insertLibrary()}>Insert</button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
