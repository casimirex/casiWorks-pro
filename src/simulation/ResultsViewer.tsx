// CasiWorks Pro - FEA Results Viewer (Responsive Mobile & Desktop, 3D Solid & Beam FEA)
import { useEffect, useRef, useState } from 'react';
import { Play, ShieldAlert, Award, ChevronDown, ChevronUp, FileText } from 'lucide-react';
import { useCADStore } from '../store/cadStore.ts';
import { ELEMENT_TYPES } from './FEAEngine.ts';
import type { ElementType, FEAResults } from './FEAEngine.ts';
import { startSolve, CancelledError } from './feaRunner.ts';
import type { SolveHandle } from './feaRunner.ts';
import type { SolvePhase } from './feaTransfer.ts';
import { buildResultPlot, COLORMAP_CSS } from './resultPlot.ts';
import type { PlotMesh, PlotQuantity } from './resultPlot.ts';
import { COVERAGE_TOLERANCE, MESH_BUDGET } from './autoMesh.ts';
import type { MeshInfo, MeshQuality } from './autoMesh.ts';
import { DEFAULT_SETUP, DIRECTIONS, FACES, FACE_LABELS, setupProblems } from './studySetup.ts';
import type { Direction, StudySetup } from './studySetup.ts';
import type { BoxPlane } from './FEAEngine.ts';
import { materialLibrary } from '../kernel/MaterialLibrary.ts';
import { runCommand } from '../commands/index.ts';

export default function ResultsViewer() {
  const bodies = useCADStore(s => s.bodies);
  const activeMaterial = useCADStore(s => s.activeMaterial);
  const documentRevision = useCADStore(s => s.documentRevision);

  const [load, setLoad] = useState(5000); // 5000 N
  const [solved, setSolved] = useState<{
    results: FEAResults;
    mesh: PlotMesh | null;
    meshInfo?: MeshInfo;
    // What the results were computed for
    geometry: unknown; material: string; load: number; elementType: ElementType; quality: MeshQuality; setup: StudySetup; documentRevision: number;
  } | null>(null);
  const [minimized, setMinimized] = useState(window.innerWidth <= 768);
  // Quadratic tetrahedra by default: linear Tet4 is far too stiff in bending (≈34% of the true deflection on a cantilever)
  const [elementType, setElementType] = useState<ElementType>(ELEMENT_TYPES.TET10);
  const [showTensors, setShowTensors] = useState(false);
  const [quality, setQuality] = useState<MeshQuality>('medium');
  const [setup, setSetup] = useState<StudySetup>(DEFAULT_SETUP);
  const setFeaSetupMarkers = useCADStore(s => s.setFeaSetupMarkers);
  // Result plot on the model
  const [showPlot, setShowPlot] = useState(true);
  const [quantity, setQuantity] = useState<PlotQuantity>('vonMises');
  const [deformed, setDeformed] = useState(false);
  const feaPlot = useCADStore(s => s.feaPlot);
  const setFeaPlot = useCADStore(s => s.setFeaPlot);

  // Results of another document are dropped; results of an earlier state of this
  // model (geometry, material, load or element type changed) are shown as stale
  const results = solved && solved.documentRevision === documentRevision ? solved.results : null;
  const stale = !!results && !!solved && (solved.geometry !== bodies[0]?.geometry || solved.material !== activeMaterial
    || solved.load !== load || solved.elementType !== elementType || solved.quality !== quality
    || solved.setup.fixedFace !== setup.fixedFace || solved.setup.loadFace !== setup.loadFace || solved.setup.loadDirection !== setup.loadDirection);

  // Show the fixed face and the load on the model while the panel is open
  useEffect(() => {
    setFeaSetupMarkers(minimized ? null : setup);
  }, [minimized, setup, setFeaSetupMarkers]);
  useEffect(() => () => setFeaSetupMarkers(null), [setFeaSetupMarkers]);

  // The plot is shown only for current results (never for an older model state)
  const plotMesh = solved?.mesh ?? null;
  const solidResult = results?.solidResult ?? null;
  const plotVisible = showPlot && !stale && !!plotMesh && !!solidResult;
  useEffect(() => {
    setFeaPlot(plotVisible && plotMesh && solidResult ? buildResultPlot(plotMesh, solidResult, { quantity, deformed }) : null);
  }, [plotVisible, plotMesh, solidResult, quantity, deformed, setFeaPlot]);
  // Free the plot's GPU buffers when it is replaced
  useEffect(() => () => feaPlot?.geometry.dispose(), [feaPlot]);

  // Stress state of the most-stressed element (by von Mises at its centre)
  const elementStresses = results?.solidResult?.elementStresses ?? [];
  const peakIndex = elementStresses.reduce((best, e, i) => (e?.stress && e.vonMises > (elementStresses[best]?.vonMises ?? -1) ? i : best), -1);
  const peak = peakIndex >= 0 ? elementStresses[peakIndex] : null;
  const mpa = (pa: number | undefined) => ((pa || 0) / 1e6).toFixed(2);

  // Solving runs in a worker: the UI stays responsive and the solve can be cancelled
  const [phase, setPhase] = useState<SolvePhase | null>(null);
  const solveRef = useRef<SolveHandle | null>(null);
  useEffect(() => () => solveRef.current?.cancel(), []);

  const handleRunFEA = async () => {
    const geometry = bodies[0]?.geometry;
    if (!geometry) {
      useCADStore.getState().setStatus('FEA: create a 3D solid body first');
      return;
    }
    const problems = setupProblems(setup);
    if (problems.length) {
      useCADStore.getState().setStatus(`FEA: ${problems[0]}`);
      return;
    }
    const mat = materialLibrary.getMaterial(activeMaterial);
    // What this solve is for: compared with the current state to mark results stale
    const input = { geometry, material: activeMaterial, load, elementType, quality, setup, documentRevision };
    const handle = startSolve({
      geometry,
      elementType,
      load,
      yieldStrength: mat.yieldStrength || 250e6,
      youngsModulus: mat.youngsModulus || 200e9,
      poissonRatio: mat.poissonsRatio ?? 0.3,
      quality,
      setup,
    }, setPhase);
    solveRef.current = handle;
    setPhase('meshing');
    try {
      const { results: res, mesh, meshInfo } = await handle.promise;
      setSolved({ results: res, mesh, meshInfo, ...input });
      setShowPlot(true);
      useCADStore.getState().setStatus(`FEA solved: max von Mises ${res.maxStressMPa.toFixed(1)} MPa`);
    } catch (err) {
      if (err instanceof CancelledError) {
        useCADStore.getState().setStatus('FEA solve cancelled');
      } else {
        console.error('FEA solve failed:', err);
        useCADStore.getState().setStatus('Simulation error: ' + ((err instanceof Error && err.message) || 'unable to solve the FEA model'));
        setSolved(null);
      }
    } finally {
      if (solveRef.current === handle) {
        solveRef.current = null;
        setPhase(null);
      }
    }
  };

  const cancelSolve = () => solveRef.current?.cancel();

  return (
    <>
      {minimized ? (
        <div style={{ position: 'absolute', bottom: 12, right: 12, display: 'flex', gap: 8, zIndex: 50 }}>
          <button
            className="fea-minimized-badge"
            onClick={() => setMinimized(false)}
            title="Open FEA Simulation"
            style={{
              background: 'rgba(9, 71, 113, 0.92)',
              border: '1px solid #4fc3f7',
              color: '#fff',
              borderRadius: 20,
              padding: '6px 12px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              backdropFilter: 'blur(4px)',
            }}
          >
            <Play size={12} color="#4fc3f7" />
            <span>3D FEA Stress</span>
          </button>

          <button
            onClick={() => runCommand('drawing.open')}
            title="Open 2D Engineering Drawing"
            style={{
              background: 'rgba(16, 85, 45, 0.92)',
              border: '1px solid #34d399',
              color: '#fff',
              borderRadius: 20,
              padding: '6px 12px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              backdropFilter: 'blur(4px)',
            }}
          >
            <FileText size={12} color="#34d399" />
            <span>2D Drawing</span>
          </button>
        </div>
      ) : (
        <div className="fea-panel" style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          maxHeight: 'calc(100% - 24px)',
          overflowY: 'auto',
          background: 'rgba(25, 25, 28, 0.95)',
          border: '1px solid #444',
          borderRadius: 8,
          padding: 12,
          width: 290,
          maxWidth: 'calc(100% - 24px)',
          color: '#fff',
          zIndex: 50,
          boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(6px)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 12, color: '#4fc3f7' }}>3D Solid FEA Simulation</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                onClick={() => runCommand('drawing.open')}
                title="2D Engineering Drawing"
                style={{
                  background: '#059669',
                  border: 'none',
                  color: '#fff',
                  borderRadius: 4,
                  padding: '3px 7px',
                  cursor: 'pointer',
                  fontSize: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                <FileText size={11} /> 2D Dwg
              </button>
              <button
                className={phase ? 'fea-cancel' : 'fea-solve'}
                onClick={phase ? cancelSolve : () => void handleRunFEA()}
                title={phase ? 'Stop the running solve' : 'Mesh the part and solve the linear static study'}
                style={{
                  background: phase ? '#b45309' : '#007acc',
                  border: 'none',
                  color: '#fff',
                  borderRadius: 4,
                  padding: '3px 8px',
                  cursor: 'pointer',
                  fontSize: 11,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {phase ? <>Cancel</> : <><Play size={12} /> Solve</>}
              </button>
              <button
                className="icon-btn"
                onClick={() => setMinimized(true)}
                title="Minimize"
                style={{ padding: 2, background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer' }}
              >
                <ChevronDown size={14} />
              </button>
            </div>
          </div>

          <div style={{ fontSize: 11, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Mesh Element:</span>
            <select
              value={elementType}
              onChange={(e) => setElementType(e.target.value as ElementType)}
              style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: 10 }}
            >
              <option value={ELEMENT_TYPES.TET10}>Tet10 (Quadratic)</option>
              <option value={ELEMENT_TYPES.TET4} title="Quick preview: linear tetrahedra underestimate bending deflection and stress">Tet4 (Linear, preview)</option>
            </select>
          </div>

          <div style={{ fontSize: 11, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Mesh Size:</span>
            <select
              className="fea-mesh-quality"
              value={quality}
              onChange={(e) => setQuality(e.target.value as MeshQuality)}
              title="Finer meshes follow the part more closely but take longer to solve"
              style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: 10 }}
            >
              <option value="coarse">Coarse (~{MESH_BUDGET.coarse.toLocaleString()} elements)</option>
              <option value="medium">Medium (~{MESH_BUDGET.medium.toLocaleString()} elements)</option>
              <option value="fine">Fine (~{MESH_BUDGET.fine.toLocaleString()} elements)</option>
            </select>
          </div>

          <div style={{ fontSize: 11, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Fixed Face:</span>
            <select
              className="fea-fixed-face"
              value={setup.fixedFace}
              onChange={(e) => setSetup({ ...setup, fixedFace: e.target.value as BoxPlane })}
              style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: 10 }}
            >
              {FACES.map(f => <option key={f} value={f}>{FACE_LABELS[f]}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 11, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Load On:</span>
            <select
              className="fea-load-face"
              value={setup.loadFace}
              onChange={(e) => setSetup({ ...setup, loadFace: e.target.value as BoxPlane })}
              style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: 10 }}
            >
              {FACES.map(f => <option key={f} value={f}>{FACE_LABELS[f]}</option>)}
            </select>
          </div>
          <div style={{ fontSize: 11, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Load Direction:</span>
            <select
              className="fea-load-direction"
              value={setup.loadDirection}
              onChange={(e) => setSetup({ ...setup, loadDirection: e.target.value as Direction })}
              style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: 10 }}
            >
              {DIRECTIONS.map(d => <option key={d} value={d}>{d.replace('-', '−')}</option>)}
            </select>
          </div>
          {setupProblems(setup).map(p => <div key={p} className="fea-setup-problem" style={{ fontSize: 10, color: '#f87171', marginBottom: 6 }}>{p}</div>)}

          <div style={{ fontSize: 11, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Applied Force:</span>
            <div>
              <input
                type="number"
                value={load}
                onChange={(e) => setLoad(parseFloat(e.target.value) || 0)}
                style={{ width: 65, background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '3px 6px', fontSize: 11 }}
              /> N
            </div>
          </div>

          {phase && (
            <div className="fea-solving" style={{ fontSize: 11, color: '#fbbf24', marginBottom: 6 }}>
              {phase === 'meshing' ? 'Meshing the part…' : 'Solving…'} (the app stays usable; Cancel stops it)
            </div>
          )}

          {results && (
            <div className="fea-results" style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4, opacity: stale ? 0.55 : 1 }}>
              {stale && (
                <div className="fea-stale" style={{ color: '#fbbf24', fontWeight: 600 }}>
                  Out of date — the model or study changed. Press Solve to update.
                </div>
              )}
              {solved?.meshInfo && (() => {
                const info = solved.meshInfo;
                const off = Math.abs(info.coverage - 1) > COVERAGE_TOLERANCE;
                return (
                  <div className={off ? 'fea-mesh-report fea-mesh-warning' : 'fea-mesh-report'} style={{ color: off ? '#fbbf24' : '#94a3b8' }}
                    title="Meshed volume compared with the part's volume. The mesh is made of grid cells, so thin walls and small features are approximated.">
                    Mesh: {info.elements.toLocaleString()} elements, {(info.coverage * 100).toFixed(0)}% of the part volume
                    {off && (info.coverage > 1
                      ? ' — thicker than the part (thin walls?): stress and deflection are likely too low'
                      : ' — thinner than the part (small features missed): stress and deflection are likely too high')}
                  </div>
                );
              })()}
              <div><strong>Max von Mises:</strong> {results.maxStressMPa.toFixed(1)} MPa</div>
              <div><strong>Max Deflection:</strong> {(results.maxDisplacementMM * 1000).toFixed(3)} μm</div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: results.factorOfSafety >= 1.5 ? '#4caf50' : '#f44336',
                fontWeight: 700,
              }}>
                {results.factorOfSafety >= 1.5 ? <Award size={14} /> : <ShieldAlert size={14} />}
                <span>Safety Factor: {results.factorOfSafety.toFixed(2)}</span>
              </div>

              {/* Result plot on the model */}
              <div className="fea-plot-controls" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                  <input type="checkbox" className="fea-show-plot" checked={showPlot} onChange={(e) => setShowPlot(e.target.checked)} /> Show on model
                </label>
                <select className="fea-quantity" value={quantity} onChange={(e) => setQuantity(e.target.value as PlotQuantity)} disabled={!showPlot}
                  style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '1px 3px', fontSize: 10 }}>
                  <option value="vonMises">von Mises stress</option>
                  <option value="displacement">Displacement</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                  <input type="checkbox" className="fea-deformed" checked={deformed} onChange={(e) => setDeformed(e.target.checked)} disabled={!showPlot} /> Deformed
                </label>
              </div>

              {/* Colour legend of the plot (or of the stress range when the plot is off) */}
              <div style={{ marginTop: 2 }}>
                <div style={{ height: 10, borderRadius: 3, background: COLORMAP_CSS }} />
                <div className="fea-legend" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#aaa', marginTop: 2 }}>
                  {feaPlot ? (
                    <>
                      <span>{feaPlot.min.toPrecision(3)} {feaPlot.unit}</span>
                      {feaPlot.deformationScale > 0 && <span>deformation ×{feaPlot.deformationScale.toPrecision(3)}</span>}
                      <span>{feaPlot.max.toPrecision(3)} {feaPlot.unit}</span>
                    </>
                  ) : (
                    <>
                      <span>{results.minStressMPa.toFixed(0)} MPa</span>
                      <span>{results.maxStressMPa.toFixed(0)} MPa</span>
                    </>
                  )}
                </div>
              </div>

              {/* 3D Cauchy & Principal Stress Details Toggle */}
              <button
                onClick={() => setShowTensors(!showTensors)}
                style={{
                  marginTop: 6,
                  background: 'transparent',
                  border: '1px solid #444',
                  color: '#4fc3f7',
                  borderRadius: 4,
                  padding: '2px 6px',
                  fontSize: 10,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>Stress tensor at peak element</span>
                {showTensors ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>

              {showTensors && peak && (
                <div style={{
                  background: '#18181b',
                  padding: 6,
                  borderRadius: 4,
                  fontSize: 9,
                  color: '#ccc',
                  fontFamily: 'monospace',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}>
                  <div style={{ color: '#aaa' }}>Element {peakIndex} (centre), von Mises {mpa(peak.vonMises)} MPa</div>
                  <div>σ_xx: {mpa(peak.stress[0])}  σ_yy: {mpa(peak.stress[1])}  σ_zz: {mpa(peak.stress[2])} MPa</div>
                  <div>τ_xy: {mpa(peak.stress[3])}  τ_yz: {mpa(peak.stress[4])}  τ_zx: {mpa(peak.stress[5])} MPa</div>
                  {peak.principalStresses && (
                    <div style={{ color: '#4fc3f7', marginTop: 2 }}>
                      σ_1: {mpa(peak.principalStresses[0])} | σ_2: {mpa(peak.principalStresses[1])} | σ_3: {mpa(peak.principalStresses[2])} MPa
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

    </>
  );
}

