// CasiWorks Pro - Bottom Status Bar (Modern Engineering Pill Layout)
import { useCADStore } from '../../store/cadStore.ts';
import { runCommand } from '../../commands/index.ts';
import { Grid, Layers, Box, Compass, Magnet } from 'lucide-react';

export default function StatusBar() {
  const statusMessage = useCADStore(s => s.statusMessage);
  const isSketchActive = useCADStore(s => s.isSketchActive);
  const solve = useCADStore(s => s.sketchSolveState);
  const selectedEntities = useCADStore(s => s.selectedEntities);
  const showGrid = useCADStore(s => s.showGrid);
  const snapEnabled = useCADStore(s => s.snapEnabled);
  const wireframeMode = useCADStore(s => s.wireframeMode);
  const edgeDisplay = useCADStore(s => s.edgeDisplay);
  const perspectiveView = useCADStore(s => s.perspectiveView);

  return (
    <footer className="status-bar">
      <div className="status-left">
        <div className="status-indicator">
          <span className="status-pulse-dot" />
          <span className="status-msg-text">{statusMessage}</span>
        </div>

        {isSketchActive && (
          <span className="sketch-active-tag">
            <span className="sketch-tag-dot" />
            <span>Editing Sketch</span>
          </span>
        )}
        {isSketchActive && solve && (
          <span className={`sketch-solve-tag sketch-solve-${solve.state}`} title="How fully the sketch's relations and dimensions fix its geometry">
            {solve.message}
          </span>
        )}
      </div>

      <div className="status-right">
        {/* Quick Viewport Visual Toggles */}
        <button
          className={`status-btn-pill ${showGrid ? 'active' : ''}`}
          onClick={() => runCommand('view.toggleGrid')}
          title="Toggle Model Grid"
        >
          <Grid size={12} />
          <span>Grid</span>
        </button>

        <button
          className={`status-btn-pill snap-toggle ${snapEnabled ? 'active' : ''}`}
          onClick={() => runCommand('view.toggleSnap')}
          title="Snap sketch points to the 5 mm grid"
        >
          <Magnet size={12} />
          <span>Snap</span>
        </button>

        <button
          className={`status-btn-pill ${edgeDisplay ? 'active' : ''}`}
          onClick={() => runCommand('view.toggleEdges')}
          title="Toggle Sharp Edges"
        >
          <Box size={12} />
          <span>Edges</span>
        </button>

        <button
          className={`status-btn-pill ${wireframeMode ? 'active' : ''}`}
          onClick={() => runCommand('view.toggleWireframe')}
          title="Toggle Wireframe Mode"
        >
          <Layers size={12} />
          <span>Wireframe</span>
        </button>

        <button
          className="status-btn-pill"
          onClick={() => runCommand('view.togglePerspective')}
          title="Switch Perspective / Orthographic Camera"
        >
          <Compass size={12} />
          <span>{perspectiveView ? 'Persp' : 'Ortho'}</span>
        </button>

        <div className="status-separator" />

        {/* Selected Counter */}
        <div className="status-item-pill">
          <Layers size={12} color="#94a3b8" />
          <span>Selected: <strong style={{ color: '#38bdf8' }}>{selectedEntities.length}</strong></span>
        </div>

        {/* Unit Pill */}
        <div className="status-unit-badge" title="Units: Millimeter, Gram, Second">
          <span>MMGS</span>
        </div>
      </div>
    </footer>
  );
}
