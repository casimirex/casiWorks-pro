// CasiWorks Pro - CommandManager Ribbon Toolbar (Professional Engineering UI)
import { useState, useSyncExternalStore } from 'react';
import {
  FilePlus, FolderOpen, Save, Undo2, Redo2, RefreshCw,
  Box, Maximize2, RotateCw, Spline, Shield, CircleDot,
  Layers, Copy, Scissors, Sliders, Play, CheckCircle2,
  XCircle, Square, Circle, PenTool, Hash,
  Download, Eye, Grid, Scale, Menu, ChevronUp, ChevronDown,
  Sparkles, Cpu, FileText, ArrowRight,
  ArrowDownToLine, ArrowRightToLine, Sigma, FlipHorizontal2, CopyPlus, Move, Puzzle, Hexagon, RectangleHorizontal
} from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { TOOLS } from '../../utils/constants.ts';
import { CAD_EXAMPLES } from '../../utils/examples.ts';
import { macroRecorder, runCommand } from '../../commands/index.ts';
import { pluginManager } from '../../plugins/index.ts';

/** Same colours as the reference planes in the viewport and tree. */
const PLANE_COLORS = { Front: '#38bdf8', Top: '#4ade80', Right: '#c084fc' } as const;

export default function CommandManager() {
  const activeTab = useCADStore(s => s.activeCommandTab);
  const setCommandTab = useCADStore(s => s.setCommandTab);
  const activeTool = useCADStore(s => s.activeTool);
  const polygonSides = useCADStore(s => s.sketchPolygonSides);
  const offsetDistance = useCADStore(s => s.sketchOffsetDistance);
  const exploded = useCADStore(s => s.explodedView !== null);
  const isSketchActive = useCADStore(s => s.isSketchActive);
  const constructionMode = useCADStore(s => s.constructionMode);
  const sectionActive = useCADStore(s => s.sectionViewActive);
  const documentName = useCADStore(s => s.documentName);
  const configurations = useCADStore(s => s.configurations);
  const activeConfiguration = useCADStore(s => s.activeConfiguration);
  const isModified = useCADStore(s => s.isModified);

  const [ribbonCollapsed, setRibbonCollapsed] = useState(false);
  // Recording state lives in the macro recorder; re-render when it changes
  const macroState = useSyncExternalStore(
    (onChange) => macroRecorder.subscribe(onChange),
    () => (macroRecorder.isRecording ? macroRecorder.stepCount : -1),
  );
  const recording = macroState >= 0;
  const addinButtons = useSyncExternalStore((onChange) => pluginManager.subscribe(onChange), () => pluginManager.buttons());
  const addinGroups = [...new Set(addinButtons.map(b => b.pluginId))].map(id => addinButtons.filter(b => b.pluginId === id));
  const [examplesOpen, setExamplesOpen] = useState(false);
  const drawingOptions = useCADStore(s => s.drawingOptions);

  const tabList = [
    { id: 'Features', label: 'Features', icon: <Box size={14} /> },
    { id: 'Sketch', label: 'Sketch', icon: <PenTool size={14} /> },
    { id: 'Assembly', label: 'Assembly', icon: <Cpu size={14} /> },
    { id: 'Evaluate', label: 'Evaluate', icon: <Scale size={14} /> },
    { id: 'Drawing', label: 'Drawing', icon: <FileText size={14} /> },
    { id: 'Tools', label: 'Tools', icon: <Play size={14} /> },
    { id: 'Add-ins', label: 'Add-ins', icon: <Puzzle size={14} /> },
  ];

  return (
    <header className="top-header">
      {/* Quick Access Toolbar */}
      <div className="quick-access-bar">
        <div className="qa-group">
          {(
            <button className="qa-btn tree-toggle-btn" onClick={() => runCommand('view.toggleFeatureTree')} title="Feature Tree (Sidebar)">
              <Menu size={16} color="#38bdf8" />
              <span className="qa-label">Tree</span>
            </button>
          )}

          <div className="brand-title">
            <div className="brand-logo-glow">
              <Box size={16} color="#38bdf8" />
            </div>
            <span className="brand-text">CasiWorks <span className="brand-pro-badge">PRO</span></span>
          </div>

          <div className="qa-separator" />

          <button className="qa-btn" onClick={() => runCommand('file.new')} title="New Part (Ctrl+Alt+N)">
            <FilePlus size={14} /> <span className="qa-label">New</span>
          </button>
          <button className="qa-btn" onClick={() => runCommand('file.open')} title="Open Document (Ctrl+O)">
            <FolderOpen size={14} /> <span className="qa-label">Open</span>
          </button>
          <button className="qa-btn" onClick={() => runCommand('file.save')} title="Save Document (Ctrl+S)">
            <Save size={14} /> <span className="qa-label">Save</span>
          </button>
          <button className="qa-btn" onClick={() => runCommand('edit.undo')} title="Undo (Ctrl+Z)">
            <Undo2 size={14} />
          </button>
          <button className="qa-btn" onClick={() => runCommand('edit.redo')} title="Redo (Ctrl+Y)">
            <Redo2 size={14} />
          </button>
          <button className="qa-btn rebuild-btn" onClick={() => runCommand('model.rebuild')} title="Rebuild Feature Tree (F5)">
            <RefreshCw size={14} color="#38bdf8" /> <span className="qa-label">Rebuild</span>
          </button>

          {/* Examples Dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              className="qa-btn"
              onClick={() => setExamplesOpen(!examplesOpen)}
              title="Load Mechanical CAD Examples"
              style={{ background: 'rgba(251, 191, 36, 0.15)', borderColor: 'rgba(251, 191, 36, 0.4)' }}
            >
              <Sparkles size={14} color="#fbbf24" />
              <span className="qa-label" style={{ color: '#fbbf24', fontWeight: 600 }}>Examples</span>
              <ChevronDown size={11} color="#fbbf24" />
            </button>

            {examplesOpen && (
              <div className="examples-dropdown-menu" style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 4,
                background: '#181b22',
                border: '1px solid #38bdf840',
                borderRadius: 6,
                boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                width: 280,
                zIndex: 1000,
                padding: '6px 0',
              }}>
                <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: '#94a3b8', borderBottom: '1px solid #334155', letterSpacing: '0.5px' }}>
                  PARAMETRIC MECHANICAL EXAMPLES
                </div>
                {CAD_EXAMPLES.map(ex => (
                  <button
                    key={ex.id}
                    className="example-item-btn"
                    onClick={() => {
                      runCommand('file.loadExample', { id: ex.id });
                      setExamplesOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      width: '100%',
                      padding: '8px 12px',
                      background: 'none',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9' }}>{ex.name}</span>
                    <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{ex.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Center Document Title with Modified indicator */}
        <div className="doc-name-pill">
          <span className={`doc-status-dot ${isModified ? 'modified' : 'saved'}`} />
          <span className="doc-title-text">{documentName}</span>
          {activeConfiguration && <span className="doc-unit-tag doc-config-tag" title="Active configuration">{activeConfiguration}</span>}
          <span className="doc-unit-tag">MMGS</span>
        </div>

        {/* Right Tools */}
        <div className="qa-group">
          <button className="qa-btn" onClick={() => runCommand('model.material')} title="Material Library">
            <Sliders size={14} /> <span className="qa-label">Material</span>
          </button>
          <button className="qa-btn" onClick={() => runCommand('evaluate.massProperties')} title="Mass Properties">
            <Scale size={14} /> <span className="qa-label">Mass Props</span>
          </button>
          <button className="qa-btn export-btn" onClick={() => runCommand('file.export')} title="Export CAD Model">
            <Download size={14} /> <span className="qa-label">Export</span>
          </button>
          <button
            className="qa-btn ribbon-toggle-btn"
            onClick={() => setRibbonCollapsed(!ribbonCollapsed)}
            title={ribbonCollapsed ? "Expand Ribbon" : "Collapse Ribbon"}
          >
            {ribbonCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>

      {/* Modern Segmented Ribbon Tabs */}
      <div className="command-tabs-header">
        {tabList.map((t) => (
          <button
            key={t.id}
            className={`tab-btn ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => {
              setCommandTab(t.id);
              if (ribbonCollapsed) setRibbonCollapsed(false);
            }}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Ribbon Toolbars with Category Group Dividers */}
      {!ribbonCollapsed && (
        <div className="command-ribbon">
          {/* FEATURES TAB */}
          {activeTab === 'Features' && (
            <>
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.EXTRUDE ? 'active' : ''}`}
                    onClick={() => runCommand('feature.extrude')}
                    title="Extruded Boss/Base"
                  >
                    <Maximize2 size={19} color="#38bdf8" />
                    <span>Extrude</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.EXTRUDE_CUT ? 'active' : ''}`}
                    onClick={() => runCommand('feature.extrudeCut')}
                    title="Extruded Cut"
                  >
                    <Scissors size={19} color="#fb923c" />
                    <span>Extrude Cut</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.REVOLVE ? 'active' : ''}`}
                    onClick={() => runCommand('feature.revolve')}
                    title="Revolved Boss/Base"
                  >
                    <RotateCw size={19} color="#38bdf8" />
                    <span>Revolve</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SWEEP ? 'active' : ''}`}
                    onClick={() => runCommand('feature.sweep')}
                    title="Swept Boss/Base"
                  >
                    <Spline size={19} color="#4ade80" />
                    <span>Sweep</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.LOFT ? 'active' : ''}`}
                    onClick={() => runCommand('feature.loft')}
                    title="Lofted Boss/Base"
                  >
                    <Layers size={19} color="#c084fc" />
                    <span>Loft</span>
                  </button>
                </div>
                <div className="tool-group-label">SOLIDS</div>
              </div>

              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.FILLET ? 'active' : ''}`}
                    onClick={() => runCommand('feature.fillet')}
                    title="Fillet Edges"
                  >
                    <CircleDot size={19} color="#2dd4bf" />
                    <span>Fillet</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.CHAMFER ? 'active' : ''}`}
                    onClick={() => runCommand('feature.chamfer')}
                    title="Chamfer Edges"
                  >
                    <Shield size={19} color="#fde047" />
                    <span>Chamfer</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SHELL ? 'active' : ''}`}
                    onClick={() => runCommand('feature.shell')}
                    title="Shell Hollow Part"
                  >
                    <Box size={19} color="#fbbf24" />
                    <span>Shell</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.HOLE ? 'active' : ''}`}
                    onClick={() => runCommand('feature.hole')}
                    title="Hole Wizard"
                  >
                    <CircleDot size={19} color="#f87171" />
                    <span>Hole</span>
                  </button>
                </div>
                <div className="tool-group-label">FINISHING</div>
              </div>

              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.LINEAR_PATTERN ? 'active' : ''}`}
                    onClick={() => runCommand('feature.linearPattern')}
                    title="Linear Pattern"
                  >
                    <Grid size={19} color="#93c5fd" />
                    <span>Lin Pattern</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.CIRCULAR_PATTERN ? 'active' : ''}`}
                    onClick={() => runCommand('feature.circularPattern')}
                    title="Circular Pattern"
                  >
                    <RotateCw size={19} color="#93c5fd" />
                    <span>Cir Pattern</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.MIRROR ? 'active' : ''}`}
                    onClick={() => runCommand('feature.mirror')}
                    title="Mirror Feature"
                  >
                    <Copy size={19} color="#e879f9" />
                    <span>Mirror</span>
                  </button>
                </div>
                <div className="tool-group-label">PATTERN</div>
              </div>
            </>
          )}

          {/* SKETCH TAB */}
          {activeTab === 'Sketch' && (
            <>
              <div className="tool-group">
                <div className="tool-group-buttons">
                  {!isSketchActive ? (
                    (['Front', 'Top', 'Right'] as const).map(plane => (
                      <button
                        key={plane}
                        className="ribbon-btn primary-action-btn"
                        onClick={() => runCommand('sketch.new', { plane })}
                        title={`Sketch on the ${plane} plane`}
                      >
                        <PenTool size={19} color={PLANE_COLORS[plane]} />
                        <span>{plane}</span>
                      </button>
                    ))
                  ) : (
                    <>
                      <button className="ribbon-btn active exit-sketch-btn" onClick={() => runCommand('sketch.exit')} title="Confirm & Exit Sketch">
                        <CheckCircle2 size={19} color="#4ade80" />
                        <span>Exit Sketch</span>
                      </button>
                      <button className="ribbon-btn cancel-sketch-btn" onClick={() => runCommand('sketch.discard')} title="Discard Sketch Changes">
                        <XCircle size={19} color="#f87171" />
                        <span>Discard</span>
                      </button>
                    </>
                  )}
                </div>
                <div className="tool-group-label">SKETCH</div>
              </div>

              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_LINE ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.line')}
                    title="Line Tool (L)"
                  >
                    <PenTool size={19} color="#f1f5f9" />
                    <span>Line</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_RECT ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.rectangle')}
                    title="Corner Rectangle (R)"
                  >
                    <Square size={19} color="#f1f5f9" />
                    <span>Rectangle</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_CIRCLE ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.circle')}
                    title="Center Circle (C)"
                  >
                    <Circle size={19} color="#f1f5f9" />
                    <span>Circle</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_ARC ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.arc')}
                    title="Centre Arc (A): centre, start, end"
                  >
                    <Spline size={19} color="#f1f5f9" />
                    <span>Arc</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_POLYGON ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.polygon')}
                    title={`Polygon (${polygonSides} sides): centre, vertex`}
                  >
                    <Hexagon size={19} color="#f1f5f9" />
                    <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      Polygon
                      <select
                        className="polygon-sides"
                        value={polygonSides}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => runCommand('sketch.polygon', { sides: Number(e.target.value) })}
                        aria-label="Polygon sides"
                        title="Number of sides"
                        style={{ background: 'transparent', color: 'inherit', border: 'none', fontSize: 10, padding: 0 }}
                      >
                        {[3, 4, 5, 6, 8, 10, 12].map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_SLOT ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.slot')}
                    title="Straight Slot: first centre, second centre, side"
                  >
                    <RectangleHorizontal size={19} color="#f1f5f9" />
                    <span>Slot</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_SPLINE ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.spline')}
                    title="Spline: click points; click the last again to finish, or the first to close (S)"
                  >
                    <Spline size={19} color="#f1f5f9" />
                    <span>Spline</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_POINT ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.point')}
                    title="Sketch Point"
                  >
                    <CircleDot size={19} color="#f1f5f9" />
                    <span>Point</span>
                  </button>
                </div>
                <div className="tool-group-label">DRAW</div>
              </div>

              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_TRIM ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.trim')}
                    title="Trim: click the part to remove, up to the nearest crossings (T)"
                  >
                    <Scissors size={19} color="#f87171" />
                    <span>Trim</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_EXTEND ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.extend')}
                    title="Extend: click a line near the end to lengthen to the next entity"
                  >
                    <ArrowRightToLine size={19} color="#4ade80" />
                    <span>Extend</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_OFFSET ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.offset')}
                    title="Offset: click an entity (its connected chain offsets too), then the side"
                  >
                    <CopyPlus size={19} color="#38bdf8" />
                    <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      Offset
                      <input
                        className="offset-distance"
                        type="number"
                        min={0.1}
                        step={0.5}
                        value={offsetDistance}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        onChange={(e) => { const d = Number(e.target.value); if (d > 0) runCommand('sketch.offset', { distance: d }); }}
                        aria-label="Offset distance (mm)"
                        title="Offset distance (mm)"
                        style={{ width: 34, background: 'transparent', color: 'inherit', border: 'none', fontSize: 10, padding: 0 }}
                      />
                    </span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_MIRROR ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.mirror')}
                    title="Mirror: click the mirror line, then the entities to mirror"
                  >
                    <FlipHorizontal2 size={19} color="#c084fc" />
                    <span>Mirror</span>
                  </button>
                </div>
                <div className="tool-group-label">EDIT</div>
              </div>

              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className={`ribbon-btn ${constructionMode ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.toggleConstruction')}
                    title="Toggle Construction Line"
                  >
                    <Hash size={19} color="#fbbf24" />
                    <span>Construct</span>
                  </button>
                  <button
                    className={`ribbon-btn ${activeTool === TOOLS.SKETCH_DIMENSION ? 'active' : ''}`}
                    onClick={() => runCommand('sketch.dimension')}
                    title="Smart Dimension (D)"
                  >
                    <Scale size={19} color="#f97316" />
                    <span>Dimension</span>
                  </button>
                </div>
                <div className="tool-group-label">TOOLS</div>
              </div>
            </>
          )}

          {/* EVALUATE TAB */}
          {activeTab === 'Evaluate' && (
            <div className="tool-group">
              <div className="tool-group-buttons">
                <button className="ribbon-btn" onClick={() => runCommand('evaluate.massProperties')} title="Compute Mass Properties">
                  <Scale size={19} color="#38bdf8" />
                  <span>Mass Props</span>
                </button>
                <button
                  className={`ribbon-btn ${sectionActive ? 'active' : ''}`}
                  onClick={() => runCommand('view.toggleSection')}
                  title="Cross-Section Cut View"
                >
                  <Eye size={19} color="#fbbf24" />
                  <span>Section</span>
                </button>
              </div>
              <div className="tool-group-label">MEASURE</div>
            </div>
          )}

          {/* ASSEMBLY TAB */}
          {activeTab === 'Assembly' && (
            <>
              {/* INSERT COMPONENTS */}
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.insertPart', { name: 'Base_Plate', shape: 'box', dims: { width: 50, height: 12, depth: 50 } })}
                    title="Insert Base Mounting Plate"
                  >
                    <Box size={19} color="#38bdf8" />
                    <span>Plate</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.insertPart', { name: 'Pin_Shaft', shape: 'pin' })}
                    title="Insert Cylindrical Alignment Pin"
                  >
                    <CircleDot size={19} color="#fbbf24" />
                    <span>Pin</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.insertPart', { name: 'Flange_Ring', shape: 'flange' })}
                    title="Insert Circular Bolt Flange"
                  >
                    <Circle size={19} color="#2dd4bf" />
                    <span>Flange</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.insertPart', { name: 'Cylinder_Rod', shape: 'cylinder', dims: { radius: 12, height: 35 } })}
                    title="Insert Cylinder Rod"
                  >
                    <Box size={19} color="#a78bfa" />
                    <span>Cylinder</span>
                  </button>
                </div>
                <div className="tool-group-label">COMPONENTS</div>
              </div>

              {/* ASSEMBLY MATES */}
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'coincident' })}
                    title="Coincident Mate (Align top and bottom faces)"
                  >
                    <Layers size={19} color="#38bdf8" />
                    <span>Coincident</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'distance' })}
                    title="Distance Mate (15mm Offset)"
                  >
                    <ArrowRight size={19} color="#fb923c" />
                    <span>Distance</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'concentric' })}
                    title="Concentric Mate (Align cylindrical axes)"
                  >
                    <CircleDot size={19} color="#2dd4bf" />
                    <span>Concentric</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'parallel' })}
                    title="Parallel Mate (Align face normals)"
                  >
                    <Spline size={19} color="#fde047" />
                    <span>Parallel</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'perpendicular' })}
                    title="Perpendicular Mate (90° face normal orientation)"
                  >
                    <ArrowDownToLine size={19} color="#c084fc" />
                    <span>Perpendic</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'tangent' })}
                    title="Tangent Mate (Cylinder to planar surface contact)"
                  >
                    <Circle size={19} color="#f472b6" />
                    <span>Tangent</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'width' })}
                    title="Width Mate (Centers component between two boundary faces)"
                  >
                    <Maximize2 size={19} color="#34d399" />
                    <span>Width</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.mate', { type: 'path' })}
                    title="Path Mate (Restrains component along guide curve)"
                  >
                    <Spline size={19} color="#fbbf24" />
                    <span>Path</span>
                  </button>
                </div>
                <div className="tool-group-label">MATES</div>
              </div>

              {/* ACTIONS */}
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.solve')}
                    title="Re-solve all assembly mates numerically"
                  >
                    <Play size={19} color="#4ade80" />
                    <span>Solve</span>
                  </button>
                  <button
                    className={`ribbon-btn ${exploded ? 'active' : ''}`}
                    onClick={() => runCommand('assembly.explodedView')}
                    title={exploded ? 'Exploded view is on: change it or collapse it' : 'Configure Exploded View'}
                  >
                    <Move size={19} color="#38bdf8" />
                    <span>Explode</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.billOfMaterials')}
                    title="Bill of Materials: parts, quantities and masses, with CSV export"
                  >
                    <FileText size={19} color="#fbbf24" />
                    <span>BOM</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.clear')}
                    title="Remove all components and mates"
                  >
                    <Scissors size={19} color="#f87171" />
                    <span>Clear</span>
                  </button>
                </div>
                <div className="tool-group-label">ACTIONS</div>
              </div>
            </>
          )}

          {/* DRAWING TAB: the standard 3-view sheet of the first body */}
          {activeTab === 'Drawing' && (
            <>
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button className="ribbon-btn drawing-open" onClick={() => runCommand('drawing.open')} title="Open the 2D drawing sheet: front, top, right and isometric views with a title block">
                    <FileText size={19} color="#38bdf8" />
                    <span>Open Sheet</span>
                  </button>
                  <label className="ribbon-btn" title="What the sheet shows: the part, or the assembly with a parts list and balloons" style={{ cursor: 'default' }}>
                    <Cpu size={19} color="#a78bfa" />
                    <select
                      className="drawing-subject"
                      value={drawingOptions.subject}
                      onChange={(e) => runCommand('drawing.options', { subject: e.target.value })}
                      aria-label="Drawing of"
                      style={{ background: 'transparent', color: 'inherit', border: 'none', fontSize: 10, padding: 0 }}
                    >
                      <option value="part">Part</option>
                      <option value="assembly">Assembly</option>
                    </select>
                  </label>
                  <label className="ribbon-btn" title="Sheet size" style={{ cursor: 'default' }}>
                    <Grid size={19} color="#94a3b8" />
                    <select
                      className="drawing-sheet-size"
                      value={drawingOptions.sheetSize}
                      onChange={(e) => runCommand('drawing.options', { sheetSize: e.target.value })}
                      aria-label="Sheet size"
                      style={{ background: 'transparent', color: 'inherit', border: 'none', fontSize: 10, padding: 0 }}
                    >
                      <option value="A4_LANDSCAPE">A4 Landscape</option>
                      <option value="A4_PORTRAIT">A4 Portrait</option>
                      <option value="A3_LANDSCAPE">A3 Landscape</option>
                      <option value="ANSI_B">ANSI B</option>
                    </select>
                  </label>
                </div>
                <div className="tool-group-label">SHEET</div>
              </div>

              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className={`ribbon-btn drawing-hidden-lines ${drawingOptions.hiddenLines ? 'active' : ''}`}
                    onClick={() => runCommand('drawing.options', { hiddenLines: !drawingOptions.hiddenLines })}
                    title="Hidden line removal: leave out edges that are behind faces"
                    aria-pressed={drawingOptions.hiddenLines}
                  >
                    <Eye size={19} color="#c084fc" />
                    <span>Hidden Lines</span>
                  </button>
                  <button
                    className={`ribbon-btn drawing-dimensions ${drawingOptions.dimensions ? 'active' : ''}`}
                    onClick={() => runCommand('drawing.options', { dimensions: !drawingOptions.dimensions })}
                    title="Overall width, height and depth dimensions"
                    aria-pressed={drawingOptions.dimensions}
                  >
                    <Scale size={19} color="#f97316" />
                    <span>Dimensions</span>
                  </button>
                  <button
                    className={`ribbon-btn drawing-gdt ${drawingOptions.gdt ? 'active' : ''}`}
                    onClick={() => runCommand('drawing.options', { gdt: !drawingOptions.gdt })}
                    title="Datum A and a perpendicularity feature control frame (SVG only)"
                    aria-pressed={drawingOptions.gdt}
                  >
                    <Shield size={19} color="#38bdf8" />
                    <span>GD&amp;T</span>
                  </button>
                </div>
                <div className="tool-group-label">SHOW</div>
              </div>

              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button className="ribbon-btn drawing-export-svg" onClick={() => runCommand('drawing.export', { format: 'svg' })} title="Download the sheet as SVG">
                    <Download size={19} color="#4ade80" />
                    <span>SVG</span>
                  </button>
                  <button className="ribbon-btn drawing-export-dxf" onClick={() => runCommand('drawing.export', { format: 'dxf' })} title="Download the sheet as DXF (views and dimensions)">
                    <Download size={19} color="#fbbf24" />
                    <span>DXF</span>
                  </button>
                </div>
                <div className="tool-group-label">EXPORT</div>
              </div>
            </>
          )}

          {/* TOOLS TAB: macros */}
          {activeTab === 'Tools' && (
            <div className="tool-group">
              <div className="tool-group-buttons">
                {recording ? (
                  <button className="ribbon-btn active" onClick={() => runCommand('macro.stop')} title="Stop recording and save the macro file">
                    <Square size={19} color="#f87171" />
                    <span>Stop ({macroState} step{macroState === 1 ? '' : 's'})</span>
                  </button>
                ) : (
                  <button className="ribbon-btn" onClick={() => runCommand('macro.record')} title="Record a macro of model changes">
                    <Circle size={19} color="#f87171" fill="#f87171" />
                    <span>Record</span>
                  </button>
                )}
                <button className="ribbon-btn" onClick={() => runCommand('macro.runFile')} title="Run a macro file (.casimacro.json)">
                  <Play size={19} color="#4ade80" />
                  <span>Run Macro</span>
                </button>
                <button className="ribbon-btn" onClick={() => runCommand('macro.saveScript')} title="Save the last recorded macro as a JavaScript file for the console or Node">
                  <FileText size={19} color="#38bdf8" />
                  <span>Save as Script</span>
                </button>
              </div>
              <div className="tool-group-label">MACROS</div>
            </div>
          )}
          {activeTab === 'Tools' && (
            <div className="tool-group">
              <div className="tool-group-buttons">
                <button className="ribbon-btn" onClick={() => runCommand('view.toggleConsole')} title="Scripting console (Ctrl+`)">
                  <Hash size={19} color="#a78bfa" />
                  <span>Console</span>
                </button>
                <button className="ribbon-btn" onClick={() => runCommand('tools.equations')} title="Equations: global variables that drive feature sizes">
                  <Sigma size={19} color="#a78bfa" />
                  <span>Equations</span>
                </button>
                <button className="ribbon-btn" onClick={() => runCommand('tools.configurations')} title="Configurations: versions of the part from variable values (design table)">
                  <Layers size={19} color="#38bdf8" />
                  <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    Configs
                    <select
                      className="config-switch"
                      value={activeConfiguration ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => runCommand('configurations.activate', { name: e.target.value || null })}
                      aria-label="Active configuration"
                      title="Active configuration"
                      style={{ background: 'transparent', color: 'inherit', border: 'none', fontSize: 10, padding: 0, maxWidth: 70 }}
                    >
                      <option value="">Default</option>
                      {configurations.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </span>
                </button>
                <button className="ribbon-btn" onClick={() => runCommand('help.apiReference')} title="API reference (opens in a new tab)">
                  <FileText size={19} color="#94a3b8" />
                  <span>API Reference</span>
                </button>
              </div>
              <div className="tool-group-label">SCRIPTING</div>
            </div>
          )}

          {/* ADD-INS TAB: buttons contributed by plugins, grouped per plugin */}
          {activeTab === 'Add-ins' && (
            <>
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button className="ribbon-btn" onClick={() => runCommand('addins.manage')} title="Load, list and unload add-ins">
                    <Puzzle size={19} color="#a78bfa" />
                    <span>Manage</span>
                  </button>
                </div>
                <div className="tool-group-label">ADD-INS</div>
              </div>
              {addinGroups.map(group => (
                <div className="tool-group addin-group" key={group[0].pluginId}>
                  <div className="tool-group-buttons">
                    {group.map(b => (
                      <button key={b.commandId + b.label} className="ribbon-btn addin-btn" onClick={() => runCommand(b.commandId, b.args)} title={b.title}>
                        <span style={{ fontSize: 17, lineHeight: '19px', height: 19 }}>{b.icon ?? '◆'}</span>
                        <span>{b.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="tool-group-label">{group[0].pluginName.toUpperCase()}</div>
                </div>
              ))}
            </>
          )}

        </div>
      )}
    </header>
  );
}
