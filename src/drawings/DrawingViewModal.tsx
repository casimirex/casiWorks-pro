// CasiWorks Pro - 2D Engineering Drawing Sheet Viewer & Vector Exporter Modal
import { useUnits } from '../components/common/useUnits.ts';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { X, Download, Eye, FileText, Check, Ruler } from 'lucide-react';
import { drawingEngine } from './DrawingEngine.ts';
import { buildDrawingSheet, dimensionInfo, pickOnSheet, visibleSheet } from './drawingSheet.ts';
import type { Point2D } from './DrawingEngine.ts';
import type { DimensionView } from './associative.ts';
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
  const drawingDimensions = useCADStore(s => s.drawingDimensions);
  const settings = useCADStore(s => s.settings);
  const units = useUnits();
  // Shared with the Drawing tab, so the ribbon and this window always agree
  const options = useCADStore(s => s.drawingOptions);
  const setOptions = useCADStore(s => s.setDrawingOptions);
  const { hiddenLines: enableHLR, dimensions: showDimensions, gdt: showGDT, sheetSize: sheetSizeKey, subject } = options;
  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);
  // Dimension tool: on, the orientation of two-point dimensions, the first point picked, the last message
  const [dimTool, setDimTool] = useState(false);
  const [dimOrientation, setDimOrientation] = useState<'auto' | 'horizontal' | 'vertical'>('auto');
  const [pending, setPending] = useState<{ view: DimensionView; at: Point2D; sheetAt: Point2D } | null>(null);
  const [dimMessage, setDimMessage] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const toolRef = useRef({ dimTool, pending });
  toolRef.current = { dimTool, pending };

  const downloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any pending timer on unmount to prevent React state leaks
  useEffect(() => {
    return () => {
      if (downloadTimerRef.current) clearTimeout(downloadTimerRef.current);
    };
  }, []);

  // A modal dialog: focus moves in and stays in, Escape closes, focus returns after.
  // With the dimension tool on, Escape first drops the picked point, then the tool.
  const close = useCallback(() => {
    const t = toolRef.current;
    if (t.pending) { setPending(null); setDimMessage(null); return; }
    if (t.dimTool) { setDimTool(false); setDimMessage(null); return; }
    onClose?.();
  }, [onClose]);
  const dialog = useDialog(isOpen, close, '2D Engineering Drawing Sheet');
  // Escape also closes when focus is outside the sheet (e.g. on the page body)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, close]);

  // Compute 2D drawing sheet data whenever geometry or options change (annotation switches only filter it)
  const sheetData = useMemo(() => {
    if (!isOpen) return null;
    try {
      return buildDrawingSheet({ bodies, assemblyComponents, documentName, activeMaterial, drawingDimensions, settings, drawingOptions: { subject, sheetSize: sheetSizeKey, hiddenLines: enableHLR, dimensions: true, gdt: true } });
    } catch (err) {
      console.error('Failed to generate drawing sheet:', err);
      return null;
    }
  }, [isOpen, bodies, assemblyComponents, documentName, activeMaterial, drawingDimensions, settings, enableHLR, sheetSizeKey, subject]);

  const sheetSvg = useMemo(() => {
    if (!sheetData) return '';
    let svg = drawingEngine.exportSVG(visibleSheet(sheetData, options));
    // The first point of a dimension being placed
    if (pending) svg = svg.replace('</svg>', `<circle cx="${pending.sheetAt.x.toFixed(2)}" cy="${pending.sheetAt.y.toFixed(2)}" r="1.2" fill="none" stroke="#dc2626" stroke-width="0.4" /></svg>`);
    return svg;
  }, [sheetData, options, pending]);

  if (!isOpen) return null;

  const canDimension = subject === 'part' && !!sheetData;
  const dims = canDimension ? dimensionInfo({ bodies, documentName, activeMaterial, drawingOptions: options, drawingDimensions }, sheetData) : [];
  const fmt = (mm: number) => units.len(mm, { fixed: true });
  const dimLabel = (d: (typeof dims)[number]) => `${d.view[0].toUpperCase()}${d.view.slice(1)} · ${d.kind === 'diameter' ? 'Ø' : d.kind === 'radius' ? 'R' : d.kind === 'horizontal' ? '↔ ' : '↕ '}`;

  /** A click on the sheet with the dimension tool: attach to the nearest corner, centre or circle. */
  const handleSheetClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dimTool || !sheetData) return;
    const svg = sheetRef.current?.querySelector('svg');
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const pick = pickOnSheet(sheetData, { x: pt.x, y: pt.y });
    if (!pick) { setDimMessage('Nothing to attach to there: click a corner, a circle or its centre'); return; }
    const placed = sheetData.views.find(v => v.view === pick.view)!;
    const k = placed.scale || 1;
    const viewPoint = (p: Point2D) => ({ x: (p.x - (placed.offsetX ?? 0)) / k, y: ((placed.offsetY ?? 0) - p.y) / k });
    try {
      if (!pending && pick.snap === 'circle') {
        // One click on a circle: its diameter (radius for an arc)
        const r = commands.execute('drawing.addDimension', { view: pick.view, kind: 'auto', points: [viewPoint({ x: pt.x, y: pt.y })] }) as { kind: string; value: number };
        setDimMessage(`Added ${r.kind} ${fmt(r.value)}`);
        return;
      }
      if (pick.snap === 'circle') { setDimMessage('Pick a corner or a circle centre for the second point'); return; }
      if (!pending) {
        setPending({ view: pick.view, at: pick.at, sheetAt: pick.sheetAt });
        setDimMessage('Now click the second corner or centre in the same view (Esc cancels)');
        return;
      }
      if (pending.view !== pick.view) { setDimMessage(`The second point must be in the ${pending.view} view`); return; }
      const r = commands.execute('drawing.addDimension', { view: pick.view, kind: dimOrientation, points: [pending.at, pick.at] }) as { kind: string; value: number };
      setPending(null);
      setDimMessage(`Added ${r.kind} ${fmt(r.value)}`);
    } catch (err) {
      setPending(null);
      setDimMessage(err instanceof Error ? err.message : String(err));
    }
  };

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
          {/* Dimension tool (part sheet) */}
          {canDimension && (
            <>
              <button
                onClick={() => { setDimTool(!dimTool); setPending(null); setDimMessage(dimTool ? null : 'Click a corner or circle centre, then a second one; or click a circle for its diameter'); }}
                aria-pressed={dimTool}
                style={{
                  background: dimTool ? '#094771' : '#2d2d30',
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
                title="Place a dimension that follows the model"
              >
                <Ruler size={13} />
                <span>Dimension</span>
              </button>
              <select
                value={dimOrientation}
                onChange={(e) => setDimOrientation(e.target.value as typeof dimOrientation)}
                aria-label="Orientation of a two-point dimension"
                style={{ background: '#2d2d30', border: '1px solid #555', color: '#fff', borderRadius: 4, padding: '4px 8px', fontSize: 11 }}
              >
                <option value="auto">Auto</option>
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            </>
          )}

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
            ref={sheetRef}
            className="drawing-sheet-view"
            onClick={handleSheetClick}
            style={{
              cursor: dimTool ? 'crosshair' : 'default',
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
            dangerouslySetInnerHTML={{ __html: sheetSvg }}
          />
        ) : (
          <div style={{ color: '#aaa', fontSize: 14 }}>
            {subject === 'assembly'
              ? 'The assembly is empty. Insert components on the Assembly tab first, or switch the Drawing tab to Part.'
              : 'No 3D solid body found. Create a solid body first to generate drawings.'}
          </div>
        )}
      </div>

      {/* Placed dimensions and the dimension tool's messages */}
      {canDimension && (dimMessage || dims.length > 0) && (
        <div style={{ position: 'absolute', left: 16, bottom: 16, maxWidth: 360, background: '#1e1e1e', border: '1px solid #333', borderRadius: 4, padding: '8px 10px', color: '#ddd', fontSize: 11 }}>
          {dimMessage && <div role="status" style={{ color: '#7dd3fc', marginBottom: dims.length ? 6 : 0 }}>{dimMessage}</div>}
          {dims.length > 0 && (
            <ul aria-label="Drawing dimensions" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {dims.map(d => (
                <li key={d.id} className="drawing-dimension" style={{ display: 'flex', alignItems: 'center', gap: 6, color: d.dangling ? '#f87171' : '#ddd' }}>
                  <span style={{ flex: 1 }}>
                    {dimLabel(d)}{d.dangling ? `not found on the changed model (was ${fmt(d.placedValue)})` : fmt(d.value ?? 0)}
                  </span>
                  <button
                    onClick={() => commands.execute('drawing.removeDimension', { id: d.id })}
                    aria-label={`Delete ${dimLabel(d)}${d.dangling ? 'dangling dimension' : fmt(d.value ?? 0)}`}
                    style={{ background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', padding: 0 }}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
