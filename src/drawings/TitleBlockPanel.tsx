// CasiWorks Pro - Title block editor in the sheet window (roadmap 5.4)
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useCADStore } from '../store/cadStore.ts';
import { commands } from '../commands/index.ts';
import { TITLE_BLOCK_FIELDS } from './titleBlock.ts';
import type { TitleBlockFields } from './titleBlock.ts';
import { titleBlockFields } from './drawingSheet.ts';

/**
 * One field per title block entry. A field shows what was set; when empty,
 * its placeholder shows the generated value the sheet uses. Changes apply on
 * Enter or when the field loses focus (one undo step each).
 */
export default function TitleBlockPanel({ onClose }: { onClose(): void }) {
  const stored = useCADStore(s => s.drawingTitleBlock);
  const documentName = useCADStore(s => s.documentName);
  const activeMaterial = useCADStore(s => s.activeMaterial);
  const drawingOptions = useCADStore(s => s.drawingOptions);
  const generated = titleBlockFields({ documentName, activeMaterial, drawingOptions, drawingTitleBlock: {} });
  const [draft, setDraft] = useState<Partial<TitleBlockFields>>(stored);
  // Undo, redo or another document: show what is stored now
  useEffect(() => setDraft(stored), [stored]);

  const commit = (key: keyof TitleBlockFields) => {
    const value = (draft[key] ?? '').trim();
    if (value === (stored[key] ?? '')) return;
    try {
      commands.execute('drawing.titleBlock', { [key]: value });
    } catch (err) {
      useCADStore.getState().setStatus(err instanceof Error ? err.message : String(err));
      setDraft(stored);
    }
  };

  return (
    <aside className="title-block-panel" aria-label="Title block" style={{
      position: 'absolute', right: 16, top: 64, width: 280, maxHeight: 'calc(100vh - 96px)', overflowY: 'auto',
      background: '#1e1e1e', border: '1px solid #333', borderRadius: 4, padding: '10px 12px', color: '#ddd', fontSize: 11, zIndex: 2,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>Title block</strong>
        <button onClick={onClose} aria-label="Close the title block editor" style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', padding: 0 }}>
          <X size={14} />
        </button>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {TITLE_BLOCK_FIELDS.map(f => (
          <label key={f.key} style={{ display: 'grid', gap: 2 }}>
            <span style={{ color: '#9ca3af' }}>{f.label}</span>
            <input
              className={`title-block-field title-block-${f.key}`}
              value={draft[f.key] ?? ''}
              placeholder={generated[f.key] || '—'}
              maxLength={f.max}
              onChange={(e) => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
              onBlur={() => commit(f.key)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { commit(f.key); (e.target as HTMLInputElement).blur(); } }}
              style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '3px 6px', fontSize: 11 }}
            />
          </label>
        ))}
      </div>
      <p style={{ color: '#9ca3af', margin: '8px 0 0' }}>Empty fields use the value shown in grey. Saved with the document.</p>
    </aside>
  );
}
