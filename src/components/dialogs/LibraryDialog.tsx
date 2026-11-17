// CasiWorks Pro - Library dialog: documents and versions in the local library (npm run server)
import { useCallback, useEffect, useState } from 'react';
import { Library as LibraryIcon, X, FolderOpen, Save, BadgeCheck, RefreshCw, History } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { library, LibraryUnavailable, LIFECYCLE_MOVES, STATE_LABEL } from '../../library/client.ts';
import type { LibraryDocument, LibraryVersion, LifecycleEvent, LifecycleState } from '../../library/client.ts';
import { openFromLibrary, saveToLibrary } from '../../library/actions.ts';
import { workspace } from '../../workspace/index.ts';
import type { WhereUsed } from '../../library/client.ts';
import { useDialog } from '../common/useDialog.ts';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const STATE_COLOR: Record<LifecycleState, string> = { draft: '#94a3b8', in_review: '#fbbf24', released: '#4ade80', obsolete: '#f87171' };

function StateBadge({ state }: { state: LifecycleState }) {
  const color = STATE_COLOR[state];
  return <span className={`library-state library-state-${state}`} style={{ fontSize: 10, color, border: `1px solid ${color}`, borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>{STATE_LABEL[state]}</span>;
}

/** What the button that moves a document from `from` to `to` says. */
function moveLabel(from: LifecycleState, to: LifecycleState, head: LibraryVersion | undefined): string {
  if (to === 'in_review') return 'Send for review';
  if (to === 'obsolete') return 'Make obsolete';
  if (to === 'released') {
    if (head?.revision) return `Mark revision ${head.revision} current`;
    return from === 'in_review' ? `Approve: release version ${head?.number ?? ''}` : `Release version ${head?.number ?? ''}`;
  }
  return from === 'in_review' ? 'Return to draft' : from === 'obsolete' ? 'Reactivate' : 'Start next revision';
}

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
  const [history, setHistory] = useState<LifecycleEvent[]>([]);
  const [usedBy, setUsedBy] = useState<WhereUsed[]>([]);
  const [note, setNote] = useState('');
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
    if (!isOpen || !selected) { setVersions([]); setHistory([]); setUsedBy([]); return; }
    setNote('');
    void run(async () => {
      const [v, h, u] = await Promise.all([library.versions(selected), library.lifecycle(selected), library.whereUsed(selected)]);
      setVersions(v);
      setHistory(h);
      setUsedBy(u);
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
    await refresh(v.documentId);
    setChosenVersion(v.number);
  });
  const open = () => selectedDoc && chosenVersion !== null && run(async () => {
    // Opens beside the documents already open (a new tab)
    await openFromLibrary({
      getState: useCADStore.getState, subscribe: useCADStore.subscribe,
      open: (content, ref) => { workspace.open(content, { libraryRef: ref }); },
    }, selectedDoc.id, selectedDoc.name, chosenVersion);
    onClose();
  });
  const release = () => selectedDoc && chosenVersion !== null && run(async () => {
    const v = await library.release(selectedDoc.id, chosenVersion);
    useCADStore.getState().setStatus(`${selectedDoc.name} version ${v.number} released as revision ${v.revision}`);
    await refresh(selectedDoc.id);
  });

  /** Lists and the open document's state after a change on the server. */
  const refresh = async (documentId: string) => {
    const [docs, v, h] = await Promise.all([library.documents(query || undefined), library.versions(documentId), library.lifecycle(documentId)]);
    setDocuments(docs);
    setVersions(v);
    setHistory(h);
    const ref = useCADStore.getState().libraryRef;
    const doc = docs.find(d => d.id === documentId);
    if (ref && doc && ref.documentId === documentId && ref.state !== doc.state) {
      useCADStore.getState().setLibraryRef({ ...ref, state: doc.state });
    }
  };
  const move = (to: LifecycleState) => selectedDoc && run(async () => {
    if (to === 'obsolete' && !window.confirm(`Make ${selectedDoc.name} obsolete? It cannot be saved or released until it is reactivated.`)) return;
    const out = await library.setState(selectedDoc.id, to, note.trim() || undefined);
    setNote('');
    useCADStore.getState().setStatus(out.newRevision && out.version
      ? `${selectedDoc.name} version ${out.version.number} released as revision ${out.version.revision}`
      : `${selectedDoc.name} is ${STATE_LABEL[to].toLowerCase()} now`);
    await refresh(selectedDoc.id);
  });

  const chosen = versions.find(v => v.number === chosenVersion) ?? null;
  const openDoc = libraryRef ? documents.find(d => d.id === libraryRef.documentId) : undefined;
  const saveLocked = openDoc && (openDoc.state === 'in_review' || openDoc.state === 'obsolete') ? openDoc : undefined;
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
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            {d.kind === 'assembly' && <span className="library-kind" style={{ fontSize: 10, color: '#a78bfa' }}>assembly</span>}
                            <StateBadge state={d.state} />
                          </span>
                        </span>
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
                    <button className="btn-secondary library-release" disabled={busy || !chosen || !!chosen.revision || selectedDoc?.state === 'obsolete'} onClick={() => void release()}
                      title="Freeze this version as the next revision (A, B, …)">
                      <BadgeCheck size={14} /> Release
                    </button>
                    <button className="btn-primary library-open" disabled={busy || !chosen} onClick={() => void open()}>
                      <FolderOpen size={14} /> Open version {chosenVersion ?? ''}
                    </button>
                  </div>
                </div>
              </div>

              {selectedDoc && (
                <section className="library-where-used" aria-label={`Where ${selectedDoc.name} is used`} style={{ borderTop: '1px solid #333', paddingTop: 10, fontSize: 12 }}>
                  <span style={{ color: '#94a3b8' }}>{selectedDoc.kind === 'assembly' ? 'Assembly' : 'Used in'}</span>{' '}
                  {selectedDoc.kind === 'assembly' ? <span style={{ color: '#71717a' }}>(its parts are listed in its tree when opened)</span>
                    : usedBy.length === 0 ? <span className="library-unused" style={{ color: '#71717a' }}>no assembly in the library</span>
                      : usedBy.map((u, i) => (
                        <span key={u.document.id} className="library-used-by" style={{ color: u.current ? '#e4e4e7' : '#71717a' }}
                          title={u.current ? `${u.document.name} v${u.document.headVersion} uses it${u.pinnedVersion ? ` (pinned to version ${u.pinnedVersion})` : ' (follows the newest version)'}` : `Only older versions of ${u.document.name} (${u.versions.join(', ')}) use it`}>
                          {i > 0 && ', '}{u.document.name}{u.count > 1 ? ` ×${u.count}` : ''}{u.pinnedVersion ? ` (v${u.pinnedVersion})` : ''}{u.current ? '' : ' (older versions)'}
                        </span>
                      ))}
                </section>
              )}
              {selectedDoc && (
                <section className="library-lifecycle" aria-label={`Status of ${selectedDoc.name}`} style={{ borderTop: '1px solid #333', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>Status</span>
                    <StateBadge state={selectedDoc.state} />
                    <span style={{ fontSize: 11, color: '#71717a', flex: 1, minWidth: 160 }}>
                      {selectedDoc.state === 'in_review' ? 'Saving is locked while it is in review.'
                        : selectedDoc.state === 'obsolete' ? 'No longer used: saving and releasing are locked.'
                          : selectedDoc.state === 'released' ? `Revision ${selectedDoc.latestRevision ?? ''} is current; saving starts the next revision.`
                            : 'Being worked on.'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input className="library-note" aria-label="Note for the status change" placeholder="Note (optional)" value={note} style={{ ...field, flex: 1, minWidth: 160 }}
                      onChange={(e) => setNote(e.target.value)} />
                    {LIFECYCLE_MOVES[selectedDoc.state].map(to => (
                      <button key={to} className={`btn-secondary library-move library-move-${to}`} disabled={busy} onClick={() => void move(to)}>
                        {moveLabel(selectedDoc.state, to, versions[0])}
                      </button>
                    ))}
                  </div>
                  {history.length > 0 && (
                    <details className="library-history">
                      <summary style={{ fontSize: 11, color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <History size={12} /> History ({history.length})
                      </summary>
                      <ol style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, maxHeight: 120, overflowY: 'auto', fontSize: 11 }}>
                        {history.map(e => (
                          <li key={e.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0', borderBottom: '1px solid #2a2a2e' }}>
                            <span style={{ color: '#71717a', whiteSpace: 'nowrap' }}>{when(e.createdAt)}</span>
                            {e.from && <><StateBadge state={e.from} /><span aria-hidden="true">→</span></>}
                            <StateBadge state={e.to} />
                            <span style={{ color: '#71717a' }}>v{e.version}</span>
                            <span style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.note}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </section>
              )}

              <div style={{ borderTop: '1px solid #333', paddingTop: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="library-message" aria-label="Version message" placeholder="What changed? (optional)" value={message} style={{ ...field, flex: 1, minWidth: 200 }}
                  onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !saveLocked) void save(false); }} />
                <button className="btn-primary library-save" disabled={busy || !available || !!saveLocked} onClick={() => void save(false)}
                  title={saveLocked ? `${saveLocked.name} is ${STATE_LABEL[saveLocked.state].toLowerCase()}: return it to draft to save, or save as a new document`
                    : libraryRef ? `Save as version ${libraryRef.version + 1} of ${libraryRef.name}${openDoc?.state === 'released' ? ' (starts the next revision)' : ''}`
                      : `Add ${documentName} to the library`}>
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
