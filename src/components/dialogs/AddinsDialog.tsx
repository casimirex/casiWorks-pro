// CasiWorks Pro - Add-ins dialog: load plugins from a URL or file, list and unload them
import { useRef, useState, useSyncExternalStore } from 'react';
import { X, Puzzle, AlertTriangle, Trash2 } from 'lucide-react';
import { pluginManager } from '../../plugins/index.ts';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}

const EXAMPLE_URL = `${import.meta.env.BASE_URL}plugins/washer.js`;

export default function AddinsDialog({ isOpen, onClose }: DialogProps) {
  const plugins = useSyncExternalStore((l) => pluginManager.subscribe(l), () => pluginManager.list());
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const attempt = async (what: string, load: () => Promise<{ name: string; version: string; commands: string[] }>) => {
    setBusy(true);
    setMessage(null);
    try {
      const info = await load();
      setMessage({ ok: true, text: `Loaded ${info.name} ${info.version} (${info.commands.length} command${info.commands.length === 1 ? '' : 's'}) — see the Add-ins tab` });
      setUrl('');
    } catch (err) {
      setMessage({ ok: false, text: `${what}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const loadUrl = () => {
    const target = url.trim();
    if (target) void attempt(`Could not load ${target}`, () => pluginManager.loadFromUrl(new URL(target, window.location.href).href));
  };

  const loadFile = (file: File | undefined) => {
    if (file) void attempt(`Could not load ${file.name}`, async () => pluginManager.loadFromSource(await file.text(), file.name));
    if (fileRef.current) fileRef.current.value = '';
  };

  const unload = (id: string, name: string) => {
    try {
      pluginManager.unload(id);
      setMessage({ ok: true, text: `Unloaded ${name}` });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box addins-dialog" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Puzzle size={16} color="#a78bfa" />
            <span>Add-ins</span>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        <div className="dialog-body" style={{ fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 8, padding: 8, borderRadius: 4, background: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.35)', color: '#fcd34d' }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span>An add-in is a program: it runs with the same access as CasiWorks (your model, your files when you save, the network). Only load add-ins from sources you trust.</span>
          </div>

          <div style={{ fontWeight: 600, marginTop: 4 }}>Loaded</div>
          {plugins.length === 0 ? (
            <div style={{ color: '#888' }}>No add-ins loaded.</div>
          ) : (
            <div className="addins-list" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {plugins.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: '#1c1c1f', borderRadius: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div><strong>{p.name}</strong> <span style={{ color: '#888' }}>{p.version}{p.author ? ` · ${p.author}` : ''}</span></div>
                    {p.description && <div style={{ color: '#aaa' }}>{p.description}</div>}
                    <div style={{ color: '#666', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.source}>
                      {p.commands.join(', ') || 'no commands'} · {p.source}
                    </div>
                  </div>
                  <button className="icon-btn" title={`Unload ${p.name}`} onClick={() => unload(p.id, p.name)}><Trash2 size={14} color="#f87171" /></button>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontWeight: 600, marginTop: 8 }}>Load an add-in</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="url"
              className="addins-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') loadUrl(); }}
              placeholder={`Module URL, e.g. ${EXAMPLE_URL}`}
              aria-label="Add-in module URL"
              style={{ flex: 1, background: '#1e1e22', border: '1px solid #444', color: '#fff', padding: '6px 10px', borderRadius: 4, fontSize: 12, outline: 'none' }}
            />
            <button className="btn-primary" disabled={busy || !url.trim()} onClick={loadUrl}>Load</button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>Load from file…</button>
            <button className="btn-secondary" disabled={busy} onClick={() => setUrl(EXAMPLE_URL)} title="Fill in the bundled example add-in">Example: washer generator</button>
            <input ref={fileRef} type="file" accept=".js,.mjs" style={{ display: 'none' }} onChange={(e) => loadFile(e.target.files?.[0])} />
          </div>
          {message && (
            <div className="addins-message" style={{ color: message.ok ? '#4ade80' : '#f87171' }}>{message.text}</div>
          )}
          <div style={{ color: '#888' }}>
            Writing an add-in: export a plugin object (<code>id</code>, <code>name</code>, <code>version</code>, <code>apiVersion</code>, <code>commands</code>, <code>buttons</code>) — see the API reference (Tools ▸ API Reference).
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
