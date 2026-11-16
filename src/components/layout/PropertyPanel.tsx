// CasiWorks Pro - Properties Side Panel (Elevated Modern Design)
import { useState, useEffect, useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { FEATURE_TYPES } from '../../utils/constants.ts';
import type { MateType } from '../../utils/constants.ts';
import type { ExtrudeEndCondition, HoleFeature, Point3, SketchPlane } from '../../types/cad.ts';

/** Axis directions offered for holes and patterns. */
const AXES = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0],
  '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
} as const;
type AxisName = keyof typeof AXES;
const AXIS_NAMES = Object.keys(AXES) as AxisName[];

/** The listed axis closest to a stored vector (features may hold any vector). */
function nearestAxis(v: { x?: number; y?: number; z?: number }, fallback: AxisName): AxisName {
  const [x, y, z] = [v.x ?? 0, v.y ?? 0, v.z ?? 0];
  if (x === 0 && y === 0 && z === 0) return fallback;
  return AXIS_NAMES.reduce((best, name) => {
    const dot = (n: AxisName) => AXES[n][0] * x + AXES[n][1] * y + AXES[n][2] * z;
    return dot(name) > dot(best) ? name : best;
  }, fallback);
}

const HOLE_TYPES: Array<{ value: NonNullable<HoleFeature['holeType']>; label: string }> = [
  { value: 'simple', label: 'Simple (drilled)' },
  { value: 'counterbore', label: 'Counterbore' },
  { value: 'countersink', label: 'Countersink' },
];
import NumericInput from '../common/NumericInput.tsx';
import { runCommand } from '../../commands/index.ts';
import { debounce } from '../../utils/debounce.ts';

/** Fields the panel reads from what it was opened with (a feature being edited, or a tool's defaults). */
interface PanelContentFields {
  type: string;
  id?: string;
  name?: string;
  isEditing?: boolean;
  depth?: number;
  angle?: number;
  radius?: number;
  thickness?: number;
  diameter?: number;
  sketchId?: string;
  direction?: ExtrudeEndCondition;
  flip?: boolean;
  thin?: boolean;
  wallThickness?: number;
  distance?: number;
  holeType?: HoleFeature['holeType'];
  position?: Point3;
  axis?: Point3;
  count?: number;
  spacing?: number;
  directionX?: number;
  directionY?: number;
  directionZ?: number;
  axisX?: number;
  axisY?: number;
  axisZ?: number;
  plane?: SketchPlane;
}

export default function PropertyPanel() {
  const propertyPanelOpen = useCADStore(s => s.propertyPanelOpen);
  const propertyPanelContent = useCADStore(s => s.propertyPanelContent) as PanelContentFields | null;
  const closePropertyPanel = useCADStore(s => s.closePropertyPanel);
  const cancelTool = useCADStore(s => s.cancelTool);
  const features = useCADStore(s => s.features);
  const assemblyComponents = useCADStore(s => s.assemblyComponents);
  const explodedView = useCADStore(s => s.explodedView);

  // Form State
  const [depth, setDepth] = useState(25);
  const [angle, setAngle] = useState(360);
  const [radius, setRadius] = useState(5);
  const [thickness, setThickness] = useState(2);
  const [diameter, setDiameter] = useState(10);
  const [direction, setDirection] = useState<ExtrudeEndCondition>('blind');
  const [flipDir, setFlipDir] = useState(false);
  const [thin, setThin] = useState(false);
  const [wallThickness, setWallThickness] = useState(2);
  const [selectedSketchId, setSelectedSketchId] = useState('');
  const [holeType, setHoleType] = useState<NonNullable<HoleFeature['holeType']>>('simple');
  const [holePosition, setHolePosition] = useState<Point3>({ x: 0, y: 0, z: 0 });
  const [holeAxis, setHoleAxis] = useState<AxisName>('+Z');
  const [count, setCount] = useState(3);
  const [spacing, setSpacing] = useState(20);
  const [patternDirection, setPatternDirection] = useState<AxisName>('+X');
  const [patternAxis, setPatternAxis] = useState<AxisName>('+Y');
  const [mirrorPlane, setMirrorPlane] = useState<SketchPlane>('Right');

  // Assembly Mate State
  const [mateType, setMateType] = useState<MateType>('coincident');
  const [comp1Id, setComp1Id] = useState('');
  const [comp2Id, setComp2Id] = useState('');
  const [ref1, setRef1] = useState('top');
  const [ref2, setRef2] = useState('bottom');
  const [mateOffset, setMateOffset] = useState(0);

  // Exploded View State
  const [explodeDist, setExplodeDist] = useState(() => useCADStore.getState().explodedView?.distance ?? 40);
  const [explodeLeaders, setExplodeLeaders] = useState(() => useCADStore.getState().explodedView?.leaderLines ?? true);



  // Debounced slider handler to keep UI fluid
  const debouncedSetExplodeDist = useMemo(
    () => debounce((val: number) => setExplodeDist(val), 60),
    []
  );


  // Available sketches for feature references
  const sketchFeatures = features.filter(f => f.type === FEATURE_TYPES.SKETCH);

  // The chosen sketch must exist in the current document (New, Open and examples
  // replace the document; a stale id made the new feature reference a missing sketch)
  useEffect(() => {
    if (!sketchFeatures.some(f => f.sketchId === selectedSketchId)) {
      setSelectedSketchId(sketchFeatures.at(-1)?.sketchId ?? '');
    }
  }, [sketchFeatures, selectedSketchId]);

  useEffect(() => {
    if (assemblyComponents.length >= 2) {
      if (!comp1Id) setComp1Id(assemblyComponents[0].id);
      if (!comp2Id) setComp2Id(assemblyComponents[1].id);
    }
  }, [assemblyComponents, comp1Id, comp2Id]);

  useEffect(() => {
    // A new feature starts from the most recent sketch; editing keeps its own (below)
    if (propertyPanelContent && !propertyPanelContent.isEditing) {
      const latest = useCADStore.getState().features.filter(f => f.type === FEATURE_TYPES.SKETCH).at(-1);
      if (latest?.type === FEATURE_TYPES.SKETCH) setSelectedSketchId(latest.sketchId);
    }
    if (propertyPanelContent) {
      if (propertyPanelContent.depth !== undefined) setDepth(propertyPanelContent.depth);
      if (propertyPanelContent.angle !== undefined) setAngle(propertyPanelContent.angle);
      if (propertyPanelContent.radius !== undefined) setRadius(propertyPanelContent.radius);
      if (propertyPanelContent.thickness !== undefined) setThickness(propertyPanelContent.thickness);
      if (propertyPanelContent.diameter !== undefined) setDiameter(propertyPanelContent.diameter);
      if (propertyPanelContent.sketchId) setSelectedSketchId(propertyPanelContent.sketchId);
      if (propertyPanelContent.direction) setDirection(propertyPanelContent.direction);
      if (propertyPanelContent.flip !== undefined) setFlipDir(propertyPanelContent.flip);
      if (propertyPanelContent.thin !== undefined) setThin(propertyPanelContent.thin);
      if (propertyPanelContent.wallThickness !== undefined) setWallThickness(propertyPanelContent.wallThickness);
      const c = propertyPanelContent;
      if (c.type === FEATURE_TYPES.CHAMFER && c.distance !== undefined) setRadius(c.distance);
      if (c.holeType) setHoleType(c.holeType);
      if (c.position) setHolePosition({ ...c.position });
      if (c.axis) setHoleAxis(nearestAxis(c.axis, '+Z'));
      if (c.count !== undefined) setCount(c.count);
      if (c.spacing !== undefined) setSpacing(c.spacing);
      if (c.type === FEATURE_TYPES.LINEAR_PATTERN) setPatternDirection(nearestAxis({ x: c.directionX, y: c.directionY, z: c.directionZ }, '+X'));
      if (c.type === FEATURE_TYPES.CIRCULAR_PATTERN) setPatternAxis(nearestAxis({ x: c.axisX, y: c.axisY, z: c.axisZ }, '+Y'));
      if (c.type === FEATURE_TYPES.MIRROR && c.plane) setMirrorPlane(c.plane);
    }
  }, [propertyPanelContent]);

  if (!propertyPanelOpen || !propertyPanelContent) return null;

  const featureType = propertyPanelContent.type;

  /** The parameters of the feature type being edited (and only those). */
  const featureParameters = (): Record<string, unknown> => {
    const [ax, ay, az] = AXES[patternAxis];
    const [dx, dy, dz] = AXES[patternDirection];
    switch (featureType) {
      case FEATURE_TYPES.EXTRUDE_BOSS:
      case FEATURE_TYPES.EXTRUDE_CUT:
        return { sketchId: selectedSketchId, depth, direction, flip: flipDir, thin, wallThickness };
      case FEATURE_TYPES.REVOLVE_BOSS:
      case FEATURE_TYPES.REVOLVE_CUT:
        return { sketchId: selectedSketchId, angle };
      case FEATURE_TYPES.SWEEP_BOSS:
      case FEATURE_TYPES.SWEEP_CUT:
        return { sketchId: selectedSketchId };
      case FEATURE_TYPES.FILLET:
        return { radius };
      case FEATURE_TYPES.CHAMFER:
        return { distance: radius };
      case FEATURE_TYPES.SHELL:
        return { thickness };
      case FEATURE_TYPES.HOLE: {
        const [x, y, z] = AXES[holeAxis];
        return { diameter, depth, holeType, position: { ...holePosition }, axis: { x, y, z } };
      }
      case FEATURE_TYPES.LINEAR_PATTERN:
        return { count, spacing, directionX: dx, directionY: dy, directionZ: dz };
      case FEATURE_TYPES.CIRCULAR_PATTERN:
        return { count, angle, axisX: ax, axisY: ay, axisZ: az };
      case FEATURE_TYPES.MIRROR:
        return { plane: mirrorPlane };
      default:
        return {};
    }
  };

  const axisSelect = (value: AxisName, onChange: (a: AxisName) => void, label: string) => (
    <div className="property-row">
      <span className="property-label">{label}</span>
      <select className="property-select" style={{ width: 90 }} value={value} onChange={(e) => onChange(e.target.value as AxisName)}>
        {AXIS_NAMES.map(a => <option key={a} value={a}>{a}</option>)}
      </select>
    </div>
  );

  const handleApply = () => {
    const isEdit = propertyPanelContent.isEditing;
    const featId = propertyPanelContent.id;

    if (featureType === 'mate' || featureType === 'assembly_mate') {
      if (comp1Id && comp2Id) {
        runCommand('assembly.mate', { type: mateType, component1: comp1Id, ref1, component2: comp2Id, ref2, offset: mateOffset });
      }
    } else if (featureType === 'exploded_view') {
      // Close first: closing resets the status bar, which should report the explode
      closePropertyPanel();
      cancelTool();
      runCommand('assembly.explode', { distance: explodeDist, leaderLines: explodeLeaders });
      return;
    } else {
      const featData = {
        type: featureType,
        name: propertyPanelContent.name || `${featureType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`,
        ...featureParameters(),
      };

      // Through commands, so edits made in the panel are recorded in macros
      if (isEdit && featId) {
        runCommand('feature.update', { id: featId, changes: featData });
      } else {
        runCommand('feature.create', featData);
      }
    }

    closePropertyPanel();
    cancelTool();
  };

  const handleCancel = () => {
    closePropertyPanel();
    cancelTool();
  };

  return (
    <aside className="property-panel">
      {/* Header with OK and Cancel actions */}
      <div className="property-actions-header">
        <button className="action-btn-green" onClick={handleApply} title="Apply & Close (Enter)">
          <Check size={16} strokeWidth={2.5} /> <span>OK</span>
        </button>
        <div className="property-header-title">
          <span>Properties</span>
        </div>
        <button className="action-btn-red" onClick={handleCancel} title="Cancel (Esc)">
          <X size={16} strokeWidth={2.5} /> <span>Cancel</span>
        </button>
      </div>

      <div className="property-feature-banner">
        <div className="property-feature-name">
          {featureType.replace(/_/g, ' ').toUpperCase()}
        </div>
      </div>

      <div className="panel-content property-scroll-area">
        {/* ==================== ASSEMBLY MATE CARD ==================== */}
        {(featureType === 'mate' || featureType === 'assembly_mate') && (
          <div className="property-card">
            <div className="property-card-header">Assembly Mate Configuration</div>
            <div className="property-card-body">
              <label className="property-label">Mate Type</label>
              <select className="property-select" value={mateType} onChange={(e) => setMateType(e.target.value as MateType)}>
                <option value="coincident">Coincident (Contact Align)</option>
                <option value="distance">Distance Offset</option>
                <option value="concentric">Concentric (Axis Align)</option>
                <option value="parallel">Parallel (Normals Match)</option>
                <option value="perpendicular">Perpendicular (90° Normals)</option>
                <option value="tangent">Tangent (Cylinder to Plane)</option>
                <option value="width">Width (Centering Tab in Slot)</option>
                <option value="path">Path (Guide Curve Polyline)</option>
              </select>

              <label className="property-label" style={{ marginTop: 8 }}>Component 1</label>
              <select className="property-select" value={comp1Id} onChange={(e) => setComp1Id(e.target.value)}>
                {assemblyComponents.map(c => (
                  <option key={c.id} value={c.id}>{c.name} {c.isFixed ? '(Fixed)' : ''}</option>
                ))}
              </select>

              <label className="property-label" style={{ marginTop: 8 }}>Reference 1</label>
              <select className="property-select" value={ref1} onChange={(e) => setRef1(e.target.value)}>
                <option value="top">Top Face</option>
                <option value="bottom">Bottom Face</option>
                <option value="front">Front Face</option>
                <option value="back">Back Face</option>
                <option value="right">Right Face</option>
                <option value="left">Left Face</option>
                <option value="z">Z Axis (Cylinder)</option>
                <option value="tab">Tab Reference</option>
              </select>

              <label className="property-label" style={{ marginTop: 8 }}>Component 2</label>
              <select className="property-select" value={comp2Id} onChange={(e) => setComp2Id(e.target.value)}>
                {assemblyComponents.map(c => (
                  <option key={c.id} value={c.id}>{c.name} {c.isFixed ? '(Fixed)' : ''}</option>
                ))}
              </select>

              <label className="property-label" style={{ marginTop: 8 }}>Reference 2</label>
              <select className="property-select" value={ref2} onChange={(e) => setRef2(e.target.value)}>
                <option value="bottom">Bottom Face</option>
                <option value="top">Top Face</option>
                <option value="front">Front Face</option>
                <option value="back">Back Face</option>
                <option value="right">Right Face</option>
                <option value="left">Left Face</option>
                <option value="z">Z Axis (Cylinder)</option>
                <option value="boundary">Boundary Face</option>
              </select>

              {(mateType === 'distance' || mateType === 'width') && (
                <div className="property-row" style={{ marginTop: 8 }}>
                  <span className="property-label">Offset / Gap:</span>
                  <NumericInput value={mateOffset} onChange={setMateOffset} min={-500} max={500} step={1} unit="mm" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== EXPLODED VIEW CARD ==================== */}
        {featureType === 'exploded_view' && (
          <div className="property-card">
            <div className="property-card-header">Exploded View Properties</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Explode Distance:</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#38bdf8' }}>{explodeDist} mm</span>
              </div>
              <input
                type="range"
                className="explode-distance"
                min="2"
                max="200"
                step="2"
                value={explodeDist}
                onChange={(e) => debouncedSetExplodeDist(parseFloat(e.target.value))}
                style={{ width: '100%', margin: '8px 0', accentColor: '#38bdf8' }}
              />
              <div className="property-row switch-row">
                <span className="property-label">Leader Lines</span>
                <label className="custom-switch">
                  <input type="checkbox" className="explode-leaders" checked={explodeLeaders} onChange={(e) => setExplodeLeaders(e.target.checked)} />
                  <span className="slider round" />
                </label>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
                Moves the components apart on screen only. Their real positions and mates are kept.
              </div>
              {assemblyComponents.length < 2 && (
                <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 6 }}>Insert at least two components to explode.</div>
              )}
              {explodedView && (
                <button
                  className="segment-btn explode-collapse"
                  style={{ marginTop: 8, width: '100%' }}
                  onClick={() => { closePropertyPanel(); cancelTool(); runCommand('assembly.collapse'); }}
                >
                  Collapse
                </button>
              )}
            </div>
          </div>
        )}

        {/* Sketch reference picker */}
        {(featureType === FEATURE_TYPES.EXTRUDE_BOSS ||
          featureType === FEATURE_TYPES.EXTRUDE_CUT ||
          featureType === FEATURE_TYPES.REVOLVE_BOSS ||
          featureType === FEATURE_TYPES.REVOLVE_CUT ||
          featureType === FEATURE_TYPES.SWEEP_BOSS ||
          featureType === FEATURE_TYPES.SWEEP_CUT) && (
          <div className="property-card">
            <div className="property-card-header">Profile & Sketch</div>
            <div className="property-card-body">
              <label className="property-label">Selected Sketch Profile</label>
              <select
                className="property-select"
                value={selectedSketchId}
                onChange={(e) => setSelectedSketchId(e.target.value)}
              >
                {sketchFeatures.map(sf => (
                  <option key={sf.sketchId} value={sf.sketchId}>
                    {sf.name} ({sf.plane} Plane)
                  </option>
                ))}
                {sketchFeatures.length === 0 && (
                  <option value="">No Sketches Created Yet</option>
                )}
              </select>
            </div>
          </div>
        )}

        {/* Extrude parameters */}
        {(featureType === FEATURE_TYPES.EXTRUDE_BOSS || featureType === FEATURE_TYPES.EXTRUDE_CUT) && (
          <>
            <div className="property-card">
              <div className="property-card-header">Direction 1</div>
              <div className="property-card-body">
                {/* Segmented condition control */}
                <div className="segmented-control">
                  <button
                    className={`segment-btn ${direction === 'blind' ? 'active' : ''}`}
                    onClick={() => setDirection('blind')}
                  >
                    Blind
                  </button>
                  <button
                    className={`segment-btn ${direction === 'midplane' ? 'active' : ''}`}
                    onClick={() => setDirection('midplane')}
                  >
                    Mid Plane
                  </button>
                  <button
                    className={`segment-btn ${direction === 'throughall' ? 'active' : ''}`}
                    onClick={() => setDirection('throughall')}
                  >
                    Through All
                  </button>
                </div>

                {direction !== 'throughall' && (
                  <div className="property-row">
                    <span className="property-label">Extrude Depth (D1):</span>
                    <NumericInput value={depth} onChange={setDepth} min={0.5} max={5000} step={5} unit="mm" />
                  </div>
                )}

                <div className="property-row switch-row">
                  <span className="property-label">Reverse Extrude Direction</span>
                  <label className="custom-switch">
                    <input type="checkbox" checked={flipDir} onChange={(e) => setFlipDir(e.target.checked)} />
                    <span className="slider round" />
                  </label>
                </div>
              </div>
            </div>

            {/* Thin Feature Card */}
            <div className="property-card">
              <div className="property-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Thin Feature</span>
                <label className="custom-switch" style={{ width: 34, height: 18 }}>
                  <input type="checkbox" checked={thin} onChange={(e) => setThin(e.target.checked)} />
                  <span className="slider round" />
                </label>
              </div>
              {thin && (
                <div className="property-card-body">
                  <div className="property-row">
                    <span className="property-label">Wall Thickness (T1):</span>
                    <NumericInput value={wallThickness} onChange={setWallThickness} min={0.2} max={100} step={0.5} unit="mm" />
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Revolve parameters */}
        {(featureType === FEATURE_TYPES.REVOLVE_BOSS || featureType === FEATURE_TYPES.REVOLVE_CUT) && (
          <div className="property-card">
            <div className="property-card-header">Revolution Parameters</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Angle:</span>
                <NumericInput value={angle} onChange={setAngle} min={1} max={360} step={15} unit="°" />
              </div>
            </div>
          </div>
        )}

        {/* Fillet parameters */}
        {featureType === FEATURE_TYPES.FILLET && (
          <div className="property-card">
            <div className="property-card-header">Fillet Parameters</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Radius (R):</span>
                <NumericInput value={radius} onChange={setRadius} min={0.5} max={100} step={1} unit="mm" />
              </div>
            </div>
          </div>
        )}

        {/* Chamfer parameters */}
        {featureType === FEATURE_TYPES.CHAMFER && (
          <div className="property-card">
            <div className="property-card-header">Chamfer Parameters</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Distance (D):</span>
                <NumericInput value={radius} onChange={setRadius} min={0.5} max={100} step={1} unit="mm" />
              </div>
            </div>
          </div>
        )}

        {/* Shell parameters */}
        {featureType === FEATURE_TYPES.SHELL && (
          <div className="property-card">
            <div className="property-card-header">Shell Parameters</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Wall Thickness (T):</span>
                <NumericInput value={thickness} onChange={setThickness} min={0.5} max={50} step={0.5} unit="mm" />
              </div>
            </div>
          </div>
        )}

        {/* Hole Wizard parameters */}
        {featureType === FEATURE_TYPES.HOLE && (
          <div className="property-card">
            <div className="property-card-header">Hole Specification</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Diameter (Ø):</span>
                <NumericInput value={diameter} onChange={setDiameter} min={1} max={200} step={1} unit="mm" />
              </div>
              <div className="property-row">
                <span className="property-label">Hole Depth:</span>
                <NumericInput value={depth} onChange={setDepth} min={1} max={500} step={5} unit="mm" />
              </div>
              <div className="property-row">
                <span className="property-label">Hole Type:</span>
                <select className="property-select" style={{ width: 130 }} value={holeType} onChange={(e) => setHoleType(e.target.value as typeof holeType)}>
                  {HOLE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {featureType === FEATURE_TYPES.HOLE && (
          <div className="property-card">
            <div className="property-card-header">Hole Position</div>
            <div className="property-card-body">
              {(['x', 'y', 'z'] as const).map(k => (
                <div className="property-row" key={k}>
                  <span className="property-label">Entry {k.toUpperCase()}:</span>
                  <NumericInput value={holePosition[k]} onChange={(v) => setHolePosition(p => ({ ...p, [k]: v }))} step={1} unit="mm" />
                </div>
              ))}
              {axisSelect(holeAxis, setHoleAxis, 'Drill Direction:')}
            </div>
          </div>
        )}

        {featureType === FEATURE_TYPES.LINEAR_PATTERN && (
          <div className="property-card">
            <div className="property-card-header">Linear Pattern</div>
            <div className="property-card-body">
              {axisSelect(patternDirection, setPatternDirection, 'Direction:')}
              <div className="property-row">
                <span className="property-label">Instances:</span>
                <NumericInput value={count} onChange={setCount} min={2} max={100} step={1} precision={0} />
              </div>
              <div className="property-row">
                <span className="property-label">Spacing:</span>
                <NumericInput value={spacing} onChange={setSpacing} min={0.1} max={5000} step={5} unit="mm" />
              </div>
            </div>
          </div>
        )}

        {featureType === FEATURE_TYPES.CIRCULAR_PATTERN && (
          <div className="property-card">
            <div className="property-card-header">Circular Pattern</div>
            <div className="property-card-body">
              {axisSelect(patternAxis, setPatternAxis, 'Axis:')}
              <div className="property-row">
                <span className="property-label">Instances:</span>
                <NumericInput value={count} onChange={setCount} min={2} max={360} step={1} precision={0} />
              </div>
              <div className="property-row">
                <span className="property-label">Total Angle:</span>
                <NumericInput value={angle} onChange={setAngle} min={1} max={360} step={15} unit="°" />
              </div>
            </div>
          </div>
        )}

        {featureType === FEATURE_TYPES.MIRROR && (
          <div className="property-card">
            <div className="property-card-header">Mirror</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Mirror Plane:</span>
                <select className="property-select" style={{ width: 110 }} value={mirrorPlane} onChange={(e) => setMirrorPlane(e.target.value as SketchPlane)}>
                  <option value="Front">Front (XY)</option>
                  <option value="Top">Top (XZ)</option>
                  <option value="Right">Right (YZ)</option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
