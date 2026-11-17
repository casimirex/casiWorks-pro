// CasiWorks Pro - 2D Engineering Drawing Sheet Viewer & Vector Exporter Modal
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { X, Download, Eye, FileText, Check } from 'lucide-react';
import { drawingEngine } from './DrawingEngine.ts';
import { buildDrawingSheet, visibleSheet } from './drawingSheet.ts';
import type { DrawingFormat } from './drawingSheet.ts';
import { useCADStore } from '../store/cadStore.ts';
import type { DrawingSheetSize } from '../store/cadStore.ts';
import { commands } from '../commands/index.ts';
import { useDialog } from '../components/common/useDialog.ts';

interface DrawingViewModalProps {
  isOpen: boolean;
  onClose(): void;
}

export default function DrawingViewModal({ isOpen, onClose }: DrawingViewModalProps) {
  const bodies = useCADStore(s => s.bodies);
  const assemblyComponents = useCADStore(s => s.assemblyComponents);
  const documentName = useCADStore(s => s.documentName);
  const activeMaterial = useCADStore(s => s.activeMaterial);
  // Shared with the Drawing tab, so the ribbon and this window always agree
  const options = useCADStore(s => s.drawingOptions);
  const setOptions = useCADStore(s => s.setDrawingOptions);
  const { hiddenLines: enableHLR, dimensions: showDimensions, gdt: showGDT, sheetSize: sheetSizeKey, subject } = options;
  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);

  const downloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any pending timer on unmount to prevent React state leaks
  useEffect(() => {
    return () => {
      if (downloadTimerRef.current) clearTimeout(downloadTimerRef.current);
    };
  }, []);

  // A modal dialog: focus moves in and stays in, Escape closes, focus returns after
  const close = useCallback(() => onClose?.(), [onClose]);
  const dialog = useDialog(isOpen, close, '2D Engineering Drawing Sheet');
  // Escape also closes when focus is outside the sheet (e.g. on the page body)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Compute 2D drawing sheet data whenever geometry or options change (annotation switches only filter it)
  const sheetData = useMemo(() => {
    if (!isOpen) return null;
    try {
      return buildDrawingSheet({ bodies, assemblyComponents, documentName, activeMaterial, drawingOptions: { subject, sheetSize: sheetSizeKey, hiddenLines: enableHLR, dimensions: true, gdt: true } });
    } catch (err) {
      console.error('Failed to generate drawing sheet:', err);
      return null;
    }
  }, [isOpen, bodies, assemblyComponents, documentName, activeMaterial, enableHLR, sheetSizeKey, subject]);

  if (!isOpen) return null;

  const handleExport = (format: DrawingFormat) => {
    try {
      commands.execute('drawing.export', { format });
    } catch (err) {
      console.error(`Failed to export ${format.toUpperCase()} drawing:`, err);
      return;
    }
    setDownloadSuccess(`${format.toUpperCase()} Exported`);
    if (downloadTimerRef.current) clearTimeout(downloadTimerRef.current);
    downloadTimerRef.current = setTimeout(() => setDownloadSuccess(null), 2500);
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      backgroundColor: 'rgba(0, 0, 0, 0.82)',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      backdropFilter: 'blur(8px)',
    }} {...dialog}>
      {/* Top Header Bar */}
      <div style={{
        height: 48,
        background: '#1e1e1e',
        borderBottom: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        color: '#fff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileText size={18} color="#38bdf8" />
          <span style={{ fontWeight: 600, fontSize: 14 }}>2D Engineering Drawing Sheet</span>
          <span style={{ fontSize: 12, color: '#888' }}>— {documentName}</span>
        </div>

        {/* Toolbar Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* HLR Toggle */}
          <button
            onClick={() => setOptions({ hiddenLines: !enableHLR })}
            style={{
              background: enableHLR ? '#094771' : '#2d2d30',
              border: '1px solid #4fc3f7',
              color: '#fff',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
            title="Toggle Hidden Line Removal"
          >
            <Eye size={13} />
            <span>Hidden Lines (HLR): {enableHLR ? 'ON' : 'OFF'}</span>
          </button>

          {/* Dimensions Toggle */}
          <button
            onClick={() => setOptions({ dimensions: !showDimensions })}
            style={{
              background: showDimensions ? '#094771' : '#2d2d30',
              border: '1px solid #555',
              color: '#fff',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Dimensions: {showDimensions ? 'ON' : 'OFF'}
          </button>

          {/* GD&T Toggle */}
          <button
            onClick={() => setOptions({ gdt: !showGDT })}
            style={{
              background: showGDT ? '#094771' : '#2d2d30',
              border: '1px solid #555',
              color: '#fff',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            GD&T: {showGDT ? 'ON' : 'OFF'}
          </button>

          {/* Sheet Size Selector */}
          <select
            value={sheetSizeKey}
            onChange={(e) => setOptions({ sheetSize: e.target.value as DrawingSheetSize })}
            style={{
              background: '#2d2d30',
              border: '1px solid #555',
              color: '#fff',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            <option value="A4_LANDSCAPE">A4 Landscape (297 x 210 mm)</option>
            <option value="A4_PORTRAIT">A4 Portrait (210 x 297 mm)</option>
            <option value="A3_LANDSCAPE">A3 Landscape (420 x 297 mm)</option>
            <option value="ANSI_B">ANSI B (17 x 11 in)</option>
          </select>

          {/* Export SVG */}
          <button
            onClick={() => handleExport('svg')}
            style={{
              background: '#0284c7',
              border: 'none',
              color: '#fff',
              borderRadius: 4,
              padding: '5px 12px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Download size={13} />
            <span>Export SVG</span>
          </button>

          {/* Export DXF */}
          <button
            onClick={() => handleExport('dxf')}
            style={{
              background: '#059669',
              border: 'none',
              color: '#fff',
              borderRadius: 4,
              padding: '5px 12px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Download size={13} />
            <span>Export DXF</span>
          </button>

          {/* Export PDF */}
          <button
            onClick={() => handleExport('pdf')}
            style={{
              background: '#b91c1c',
              border: 'none',
              color: '#fff',
              borderRadius: 4,
              padding: '5px 12px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Download size={13} />
            <span>Export PDF</span>
          </button>

          {downloadSuccess && (
            <span style={{ fontSize: 11, color: '#4caf50', display: 'flex', alignItems: 'center', gap: 3 }}>
              <Check size={13} /> {downloadSuccess}
            </span>
          )}

          {/* Close Modal */}
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#aaa',
              cursor: 'pointer',
              padding: 4,
              marginLeft: 8,
            }}
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Main Drawing Sheet Canvas */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: '#2b2b2b',
      }}>
        {sheetData ? (
          <div
            className="drawing-sheet-view"
            style={{
              background: '#ffffff',
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              borderRadius: 2,
              padding: 0,
              // Fit the whole sheet: as wide as the screen allows, or as tall, keeping its proportions
              aspectRatio: `${sheetData.sheetSize.width} / ${sheetData.sheetSize.height}`,
              width: `min(92vw, calc((100vh - 120px) * ${sheetData.sheetSize.width / sheetData.sheetSize.height}))`,
              overflow: 'hidden',
              display: 'flex',
            }}
            dangerouslySetInnerHTML={{
              __html: drawingEngine.exportSVG(visibleSheet(sheetData, options)),
            }}
          />
        ) : (
          <div style={{ color: '#aaa', fontSize: 14 }}>
            {subject === 'assembly'
              ? 'The assembly is empty. Insert components on the Assembly tab first, or switch the Drawing tab to Part.'
              : 'No 3D solid body found. Create a solid body first to generate drawings.'}
          </div>
        )}
      </div>
    </div>
  );
}
