// CasiWorks Pro - Library dialog: documents and versions in the local library (npm run server)
import { useCallback, useEffect, useState } from 'react';
import { Library as LibraryIcon, X, FolderOpen, Save, BadgeCheck, RefreshCw } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { library, LibraryUnavailable } from '../../library/client.ts';
import type { LibraryDocument, LibraryVersion } from '../../library/client.ts';
import { openFromLibrary, saveToLibrary } from '../../library/actions.ts';
import { useDialog } from '../common/useDialog.ts';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export default function LibraryDialog({ isOpen, onClose }: DialogProps) {
  const libraryRef = useCADStore(s => s.libraryRef);
  const documentName = useCADStore(s => s.documentName);
  const isModified = useCADStore(s => s.isModified);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<LibraryVersion[]>([]);
  const [chosenVersion, setChosenVersion] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dialog = useDialog(isOpen, onClose, 'Library');

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try { await fn(); } catch (err) {
      if (err instanceof LibraryUnavailable) setAvailable(false);
      setProblem(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }, []);

  const loadDocuments = useCallback(() => run(async () => {
    const docs = await library.documents(query || undefined);
    setAvailable(true);
    setDocuments(docs);
  }), [query, run]);

  // On open: the documents, with the open document's one selected
  useEffect(() => {
    if (!isOpen) return;
    setMessage('');
    setProblem(null);
    setSelected(useCADStore.getState().libraryRef?.documentId ?? null);
    void loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !selected) { setVersions([]); return; }
    void run(async () => {
      const v = await library.versions(selected);
      setVersions(v);
      setChosenVersion(v[0]?.number ?? null);
    });
  }, [isOpen, selected, run]);

  if (!isOpen) return null;

  const selectedDoc = documents.find(d => d.id === selected) ?? null;
  const save = (asNew: boolean) => run(async () => {
    const v = await saveToLibrary(useCADStore, { message: message.trim() || undefined, asNew });
    setMessage('');
    const docs = await library.documents(query || undefined);
    setDocuments(docs);
    setSelected(v.documentId);
    setVersions(await library.versions(v.documentId));
    setChosenVersion(v.number);
  });
  const open = () => selectedDoc && chosenVersion !== null && run(async () => {
    if (useCADStore.getState().isModified && !window.confirm('Discard unsaved changes and open this version?')) return;
    await openFromLibrary(useCADStore, selectedDoc.id, selectedDoc.name, chosenVersion);
    onClose();
  });
  const release = () => selectedDoc && chosenVersion !== null && run(async () => {
    const v = await library.release(selectedDoc.id, chosenVersion);
    useCADStore.getState().setStatus(`${selectedDoc.name} version ${v.number} released as revision ${v.revision}`);
    setVersions(await library.versions(selectedDoc.id));
    setDocuments(await library.documents(query || undefined));
  });

  const chosen = versions.find(v => v.number === chosenVersion) ?? null;
  const field = { background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 4, padding: '5px 8px', fontSize: 12 } as const;
  const row = (active: boolean) => ({ display: 'flex', flexDirection: 'column' as const, gap: 2, width: '100%', textAlign: 'left' as const, padding: '6px 8px',
    background: active ? 'var(--bg-active)' : 'transparent', border: 'none', borderBottom: '1px solid #2a2a2e', color: '#fff', cursor: 'pointer', fontSize: 12 });

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box library-dialog" style={{ width: 820, maxWidth: 'calc(100vw - 24px)' }} onClick={(e) => e.stopPropagation()} {...dialog}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <LibraryIcon size={16} color="#38bdf8" />
            <span>Library</span>
            {libraryRef && <span style={{ fontSize: 11, color: '#94a3b8' }}>· open: {libraryRef.name} v{libraryRef.opened}{isModified ? ' (changed)' : ''}</span>}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {available === false ? (
            <div className="library-unavailable" role="alert" style={{ fontSize: 12, color: '#fbbf24', lineHeight: 1.5 }}>
              The library is not running. In a terminal in the project folder run <code>npm run build</code> once, then <code>npm run server</code>,
              and open <code>http://127.0.0.1:5180</code>. Documents and their versions are kept on this computer (in <code>~/.casiworks</code>).
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.3fr)', gap: 10, minHeight: 260 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="library-search" aria-label="Search documents" placeholder="Search documents" value={query} style={{ ...field, flex: 1 }}
                      onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void loadDocuments(); }} />
                    <button className="icon-btn" onClick={() => void loadDocuments()} title="Refresh" aria-label="Refresh"><RefreshCw size={14} /></button>
                  </div>
                  <div role="listbox" aria-label="Documents" className="library-documents" style={{ border: '1px solid #333', borderRadius: 4, overflowY: 'auto', maxHeight: 300 }}>
                    {documents.map(d => (
                      <button key={d.id} role="option" aria-selected={d.id === selected} className="library-document" style={row(d.id === selected)} onClick={() => setSelected(d.id)}>
                        <span style={{ fontWeight: 600 }}>{d.name}</span>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>v{d.headVersion}{d.latestRevision ? ` · rev ${d.latestRevision}` : ''} · {when(d.updatedAt)}</span>
                      </button>
                    ))}
                    {documents.length === 0 && available && <div style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>{query ? 'No document matches.' : 'The library is empty: save this part to start it.'}</div>}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>{selectedDoc ? `Versions of ${selectedDoc.name}` : 'Choose a document to see its versions'}</div>
                  <div role="listbox" aria-label="Versions" className="library-versions" style={{ border: '1px solid #333', borderRadius: 4, overflowY: 'auto', maxHeight: 300, flex: 1 }}>
                    {versions.map(v => (
                      <button key={v.number} role="option" aria-selected={v.number === chosenVersion} className="library-version" style={row(v.number === chosenVersion)}
                        onClick={() => setChosenVersion(v.number)} onDoubleClick={() => { setChosenVersion(v.number); void open(); }}>
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <strong>Version {v.number}</strong>
                          {v.revision && <span className="library-revision" style={{ fontSize: 10, color: '#4ade80', border: '1px solid #4ade80', borderRadius: 3, padding: '0 4px' }}>Rev {v.revision}</span>}
                          {libraryRef?.documentId === v.documentId && libraryRef.opened === v.number && <span style={{ fontSize: 10, color: '#38bdf8' }}>open</span>}
                        </span>
                        <span style={{ fontSize: 11, color: '#cbd5e1' }}>{v.message || <i style={{ color: '#71717a' }}>no message</i>}</span>
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>{when(v.createdAt)} · {kb(v.size)}</span>
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button className="btn-secondary library-release" disabled={busy || !chosen || !!chosen.revision} onClick={() => void release()}
                      title="Freeze this version as the next revision (A, B, …)">
                      <BadgeCheck size={14} /> Release
                    </button>
                    <button className="btn-primary library-open" disabled={busy || !chosen} onClick={() => void open()}>
                      <FolderOpen size={14} /> Open version {chosenVersion ?? ''}
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ borderTop: '1px solid #333', paddingTop: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="library-message" aria-label="Version message" placeholder="What changed? (optional)" value={message} style={{ ...field, flex: 1, minWidth: 200 }}
                  onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(false); }} />
                <button className="btn-primary library-save" disabled={busy || !available} onClick={() => void save(false)}
                  title={libraryRef ? `Save as version ${libraryRef.version + 1} of ${libraryRef.name}` : `Add ${documentName} to the library`}>
                  <Save size={14} /> {libraryRef ? `Save version ${libraryRef.version + 1}` : 'Save to library'}
                </button>
                {libraryRef && (
                  <button className="btn-secondary library-save-new" disabled={busy || !available} onClick={() => void save(true)} title={`A new library document named ${documentName}`}>
                    Save as new document
                  </button>
                )}
              </div>
            </>
          )}
          {problem && available !== false && <div className="library-problem" role="alert" style={{ fontSize: 12, color: '#f87171' }}>{problem}</div>}
        </div>
      </div>
    </div>
  );
}
