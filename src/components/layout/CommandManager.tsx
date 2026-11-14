// CasiWorks Pro - CommandManager Ribbon Toolbar (Professional Engineering UI)
import { useState, useSyncExternalStore } from 'react';
import {
  FilePlus, FolderOpen, Save, Undo2, Redo2, RefreshCw,
  Box, Maximize2, RotateCw, Spline, Shield, CircleDot,
  Layers, Copy, Scissors, Sliders, Play, CheckCircle2,
  XCircle, Square, Circle, PenTool, Hash,
  Download, Eye, Grid, Scale, Menu, ChevronUp, ChevronDown,
  Sparkles, Layers3, Cpu, FileText, ArrowRight,
  ArrowDownToLine, Move, Crosshair
} from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { TOOLS } from '../../utils/constants.ts';
import { CAD_EXAMPLES } from '../../utils/examples.ts';
import { macroRecorder, runCommand } from '../../commands/index.ts';

/** Same colours as the reference planes in the viewport and tree. */
const PLANE_COLORS = { Front: '#38bdf8', Top: '#4ade80', Right: '#c084fc' } as const;

export default function CommandManager() {
  const activeTab = useCADStore(s => s.activeCommandTab);
  const setCommandTab = useCADStore(s => s.setCommandTab);
  const activeTool = useCADStore(s => s.activeTool);
  const isSketchActive = useCADStore(s => s.isSketchActive);
  const constructionMode = useCADStore(s => s.constructionMode);
  const sectionActive = useCADStore(s => s.sectionViewActive);
  const documentName = useCADStore(s => s.documentName);
  const isModified = useCADStore(s => s.isModified);

  const [ribbonCollapsed, setRibbonCollapsed] = useState(false);
  // Recording state lives in the macro recorder; re-render when it changes
  const macroState = useSyncExternalStore(
    (onChange) => macroRecorder.subscribe(onChange),
    () => (macroRecorder.isRecording ? macroRecorder.stepCount : -1),
  );
  const recording = macroState >= 0;
  const [examplesOpen, setExamplesOpen] = useState(false);

  const tabList = [
    { id: 'Features', label: 'Features', icon: <Box size={14} /> },
    { id: 'Sketch', label: 'Sketch', icon: <PenTool size={14} /> },
    { id: 'Surfaces', label: 'Surfaces', icon: <Layers size={14} /> },
    { id: 'Sheet Metal', label: 'Sheet Metal', icon: <Layers3 size={14} /> },
    { id: 'Assembly', label: 'Assembly', icon: <Cpu size={14} /> },
    { id: 'Evaluate', label: 'Evaluate', icon: <Scale size={14} /> },
    { id: 'Drawing', label: 'Drawing', icon: <FileText size={14} /> },
    { id: 'Tools', label: 'Tools', icon: <Play size={14} /> },
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
                    className="ribbon-btn"
                    onClick={() => runCommand('assembly.explodedView')}
                    title="Configure Exploded View"
                  >
                    <Move size={19} color="#38bdf8" />
                    <span>Explode</span>
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

          {/* DRAWING TAB */}
          {activeTab === 'Drawing' && (
            <>
              {/* VIEWS */}
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.view', { viewType: 'standard_3_view' })}
                    title="Insert Standard 3-View (Front, Top, Right)"
                  >
                    <Grid size={19} color="#38bdf8" />
                    <span>Standard 3</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.view', { viewType: 'projected' })}
                    title="Projected Orthographic View"
                  >
                    <Box size={19} color="#4ade80" />
                    <span>Projected</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.view', { viewType: 'section' })}
                    title="Cross-Section Cut View"
                  >
                    <Scissors size={19} color="#fb923c" />
                    <span>Section</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.view', { viewType: 'isometric' })}
                    title="Isometric 3D Projected View"
                  >
                    <Layers size={19} color="#c084fc" />
                    <span>Isometric</span>
                  </button>
                </div>
                <div className="tool-group-label">VIEWS</div>
              </div>

              {/* ANNOTATIONS */}
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.dimension')}
                    title="Smart Dimension (Linear, Radius, Diameter, Angle)"
                  >
                    <Scale size={19} color="#f97316" />
                    <span>Dimension</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.gdt', { gdtType: 'fcf' })}
                    title="Feature Control Frame (Geometric Tolerance)"
                  >
                    <Shield size={19} color="#38bdf8" />
                    <span>GD&T FCF</span>
                  </button>
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.gdt', { gdtType: 'datum' })}
                    title="Datum Feature Symbol (A, B, C)"
                  >
                    <Crosshair size={19} color="#fbbf24" />
                    <span>Datum</span>
                  </button>
                </div>
                <div className="tool-group-label">ANNOTATIONS</div>
              </div>

              {/* EXPORT */}
              <div className="tool-group">
                <div className="tool-group-buttons">
                  <button
                    className="ribbon-btn"
                    onClick={() => runCommand('drawing.open')}
                    title="Export 2D Drawing to DXF / SVG"
                  >
                    <Download size={19} color="#4ade80" />
                    <span>Export 2D</span>
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

          {/* SURFACES, SHEET METAL tabs */}
          {(activeTab === 'Surfaces' || activeTab === 'Sheet Metal') && (
            <div className="tool-group">
              <div className="tool-group-buttons">
                <button
                  className="ribbon-btn"
                  onClick={() => runCommand('feature.extrude')}
                >
                  <Box size={19} color="#38bdf8" />
                  <span>{activeTab} Tool</span>
                </button>
              </div>
              <div className="tool-group-label">ACTIONS</div>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
