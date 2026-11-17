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
  { value: 'tapped', label: 'Tapped (thread)' },
];
import NumericInput from '../common/NumericInput.tsx';
import { runCommand } from '../../commands/index.ts';
import { debounce } from '../../utils/debounce.ts';
import { evaluateExpression, evaluateVariables } from '../../features/equations.ts';
import { CLEARANCE_FITS, METRIC_SIZES, standardHole } from '../../features/holeStandards.ts';
import type { ClearanceFit, MetricSize } from '../../features/holeStandards.ts';
import { ExplodeStepsCard, MateFacesPanel, MotionPanel } from './AssemblyPanels.tsx';

/** Fields the panel reads from what it was opened with (a feature being edited, or a tool's defaults). */
interface PanelContentFields {
  type: string;
  id?: string;
  name?: string;
  isEditing?: boolean;
  /** Parameters linked to equations. */
  expressions?: Record<string, string>;
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
  standard?: HoleFeature['standard'];
  cbDiameter?: number;
  cbDepth?: number;
  csDiameter?: number;
  csAngle?: number;
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
  base?: SketchPlane;
  offset?: number;
  axisLine?: string;
  axisRef?: string;
  point?: Point3;
  throughRef?: string;
  rotation?: Point3;
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

  // Equations: parameters typed as expressions that use variables stay linked
  const variables = useCADStore(s => s.variables);
  const setStatusMessage = useCADStore(s => s.setStatus);
  const variableValues = useMemo(() => evaluateVariables(variables).values, [variables]);
  const [expressions, setExpressions] = useState<Record<string, string>>({});
  /** Props that let a NumericInput take an expression for feature parameter `key`. */
  const linkable = (key: string) => ({
    evaluate: (text: string) => evaluateExpression(text, variableValues),
    expression: expressions[key] ?? null,
    onExpressionChange: (e: string | null) => setExpressions(x => {
      const next = { ...x };
      if (e) next[key] = e; else delete next[key];
      return next;
    }),
    onError: (message: string) => setStatusMessage(`${key}: ${message}`),
    label: key,
  });
  const [diameter, setDiameter] = useState(10);
  const [direction, setDirection] = useState<ExtrudeEndCondition>('blind');
  const [flipDir, setFlipDir] = useState(false);
  const [thin, setThin] = useState(false);
  const [wallThickness, setWallThickness] = useState(2);
  const [selectedSketchId, setSelectedSketchId] = useState('');
  const [holeType, setHoleType] = useState<NonNullable<HoleFeature['holeType']>>('simple');
  // Hole Wizard: an ISO metric size ('' = custom sizes), the clearance fit, custom counterbore / countersink
  const [holeSize, setHoleSize] = useState<MetricSize | ''>('');
  const [holeFit, setHoleFit] = useState<ClearanceFit>('normal');
  const [cbDiameter, setCbDiameter] = useState(18);
  const [cbDepth, setCbDepth] = useState(5);
  const [csDiameter, setCsDiameter] = useState(16);
  const [csAngle, setCsAngle] = useState(90);
  // Reference plane: a standard plane, moved along its normal and tilted about its X axis
  const [refBase, setRefBase] = useState<SketchPlane>('Front');
  const [refOffset, setRefOffset] = useState(20);
  const [refAngle, setRefAngle] = useState(0);
  // Revolve axis: 'y' | 'x' (sketch axes), 'line:<entity id>', 'ref:<axis feature id>'
  const [revolveAxis, setRevolveAxis] = useState('y');
  // Reference axis / point
  const [refDirection, setRefDirection] = useState<'X' | 'Y' | 'Z'>('Y');
  const [refPoint, setRefPoint] = useState<Point3>({ x: 0, y: 0, z: 0 });
  const [refThrough, setRefThrough] = useState('');
  const [refRotation, setRefRotation] = useState<Point3>({ x: 0, y: 0, z: 0 });
  const sketchEntitiesMap = useCADStore(s => s.sketchEntities);
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
      setExpressions({ ...(propertyPanelContent.expressions ?? {}) });
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
      setHoleSize(c.standard && (METRIC_SIZES as string[]).includes(c.standard.size) ? c.standard.size as MetricSize : '');
      if (c.standard?.fit) setHoleFit(c.standard.fit);
      if (c.cbDiameter !== undefined) setCbDiameter(c.cbDiameter);
      if (c.cbDepth !== undefined) setCbDepth(c.cbDepth);
      if (c.csDiameter !== undefined) setCsDiameter(c.csDiameter);
      if (c.csAngle !== undefined) setCsAngle(c.csAngle);
      if (c.position) setHolePosition({ ...c.position });
      if (c.axis) setHoleAxis(nearestAxis(c.axis, '+Z'));
      if (c.count !== undefined) setCount(c.count);
      if (c.spacing !== undefined) setSpacing(c.spacing);
      if (c.type === FEATURE_TYPES.LINEAR_PATTERN) setPatternDirection(nearestAxis({ x: c.directionX, y: c.directionY, z: c.directionZ }, '+X'));
      if (c.type === FEATURE_TYPES.CIRCULAR_PATTERN) setPatternAxis(nearestAxis({ x: c.axisX, y: c.axisY, z: c.axisZ }, '+Y'));
      if (c.type === FEATURE_TYPES.MIRROR && c.plane) setMirrorPlane(c.plane);
      if (c.type === FEATURE_TYPES.REVOLVE_BOSS || c.type === FEATURE_TYPES.REVOLVE_CUT) {
        setRevolveAxis(c.axisLine ? `line:${c.axisLine}` : c.axisRef ? `ref:${c.axisRef}` : (c as { axis?: unknown }).axis === 'x' ? 'x' : 'y');
      }
      if (c.type === FEATURE_TYPES.COORDINATE_SYSTEM) setRefRotation({ ...(c.rotation ?? { x: 0, y: 0, z: 0 }) });
      if (c.type === FEATURE_TYPES.REFERENCE_AXIS || c.type === FEATURE_TYPES.REFERENCE_POINT || c.type === FEATURE_TYPES.COORDINATE_SYSTEM) {
        const dir = (c as { direction?: string }).direction;
        if (dir === 'X' || dir === 'Y' || dir === 'Z') setRefDirection(dir);
        setRefPoint({ ...(c.point ?? { x: 0, y: 0, z: 0 }) });
        setRefThrough(c.throughRef ?? '');
      }
      if (c.type === FEATURE_TYPES.REFERENCE_PLANE) {
        setRefBase(c.base ?? 'Front');
        setRefOffset(c.offset ?? 20);
        setRefAngle(c.angle ?? 0);
      }
    }
  }, [propertyPanelContent]);

  if (!propertyPanelOpen || !propertyPanelContent) return null;

  const featureType = propertyPanelContent.type;
  if (featureType === 'mate_faces') return <MateFacesPanel />;
  if (featureType === 'assembly_motion') return <MotionPanel />;
  // What the panel is for, as its title and its name for screen readers
  const typeLabel = featureType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const panelTitle = propertyPanelContent.isEditing && propertyPanelContent.name ? `Edit ${propertyPanelContent.name}` : typeLabel;

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
        return {
          sketchId: selectedSketchId, angle,
          axis: revolveAxis === 'x' ? 'x' : revolveAxis === 'y' ? 'y' : undefined,
          axisLine: revolveAxis.startsWith('line:') ? revolveAxis.slice(5) : undefined,
          axisRef: revolveAxis.startsWith('ref:') ? revolveAxis.slice(4) : undefined,
        };
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
        const placement = { depth, holeType, position: { ...holePosition }, axis: { x, y, z } };
        if (holeSize) {
          const std = standardHole(holeType, holeSize, holeFit);
          return {
            ...placement, diameter: std.diameter, standard: { size: holeSize, fit: holeFit },
            cbDiameter: std.cbDiameter, cbDepth: std.cbDepth, csDiameter: std.csDiameter, csAngle: std.csAngle, thread: std.thread,
          };
        }
        return {
          ...placement, diameter, standard: undefined, thread: undefined,
          cbDiameter: holeType === 'counterbore' ? cbDiameter : undefined,
          cbDepth: holeType === 'counterbore' ? cbDepth : undefined,
          csDiameter: holeType === 'countersink' ? csDiameter : undefined,
          csAngle: holeType === 'countersink' ? csAngle : undefined,
        };
      }
      case FEATURE_TYPES.LINEAR_PATTERN:
        return { count, spacing, directionX: dx, directionY: dy, directionZ: dz };
      case FEATURE_TYPES.CIRCULAR_PATTERN:
        return { count, angle, axisX: ax, axisY: ay, axisZ: az };
      case FEATURE_TYPES.MIRROR:
        return { plane: mirrorPlane };
      case FEATURE_TYPES.REFERENCE_PLANE:
        return { base: refBase, offset: refOffset, angle: refAngle };
      case FEATURE_TYPES.REFERENCE_AXIS:
        return { direction: refDirection, point: { ...refPoint }, throughRef: refThrough || undefined };
      case FEATURE_TYPES.REFERENCE_POINT:
        return { point: { ...refPoint } };
      case FEATURE_TYPES.COORDINATE_SYSTEM:
        return { point: { ...refPoint }, throughRef: refThrough || undefined, rotation: { ...refRotation } };
      default:
        return {};
    }
  };

  const axisSelect = (value: AxisName, onChange: (a: AxisName) => void, label: string) => (
    <div className="property-row">
      <span className="property-label">{label}</span>
      <select aria-label={label} className="property-select" style={{ width: 90 }} value={value} onChange={(e) => onChange(e.target.value as AxisName)}>
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
      const params = featureParameters();
      // Only links to this feature type's own parameters; an edit always sends them, so unlinking sticks
      const links = Object.fromEntries(Object.entries(expressions).filter(([k]) => k.split('.')[0] in params
        // a standard sets the hole, counterbore and countersink sizes
        && !(featureType === FEATURE_TYPES.HOLE && holeSize && ['diameter', 'cbDiameter', 'cbDepth', 'csDiameter', 'csAngle'].includes(k))));
      const featData = {
        type: featureType,
        name: propertyPanelContent.name
          || (featureType === FEATURE_TYPES.HOLE && holeSize ? standardHole(holeType, holeSize, holeFit).label : '')
          || (featureType === FEATURE_TYPES.REFERENCE_PLANE ? `Plane${useCADStore.getState().features.filter(f => f.type === FEATURE_TYPES.REFERENCE_PLANE).length + 1}` : '')
          || (featureType === FEATURE_TYPES.REFERENCE_AXIS ? `Axis${useCADStore.getState().features.filter(f => f.type === FEATURE_TYPES.REFERENCE_AXIS).length + 1}` : '')
          || (featureType === FEATURE_TYPES.COORDINATE_SYSTEM ? `CS${useCADStore.getState().features.filter(f => f.type === FEATURE_TYPES.COORDINATE_SYSTEM).length + 1}` : '')
          || (featureType === FEATURE_TYPES.REFERENCE_POINT ? `Point${useCADStore.getState().features.filter(f => f.type === FEATURE_TYPES.REFERENCE_POINT).length + 1}` : '')
          || `${featureType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`,
        ...params,
        ...(isEdit || Object.keys(links).length ? { expressions: links } : {}),
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
    <aside className="property-panel" aria-label={panelTitle}>
      {/* Header with OK and Cancel actions */}
      <div className="property-actions-header">
        <button className="action-btn-green" onClick={handleApply} title="Apply & Close (Enter)">
          <Check size={16} strokeWidth={2.5} /> <span>OK</span>
        </button>
        <div className="property-header-title" title={panelTitle}>
          <span className="property-panel-title">{panelTitle}</span>
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
              <select aria-label="Mate type" className="property-select" value={mateType} onChange={(e) => setMateType(e.target.value as MateType)}>
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
              <select aria-label="Component 1" className="property-select" value={comp1Id} onChange={(e) => setComp1Id(e.target.value)}>
                {assemblyComponents.map(c => (
                  <option key={c.id} value={c.id}>{c.name} {c.isFixed ? '(Fixed)' : ''}</option>
                ))}
              </select>

              <label className="property-label" style={{ marginTop: 8 }}>Reference 1</label>
              <select aria-label="Reference 1" className="property-select" value={ref1} onChange={(e) => setRef1(e.target.value)}>
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
              <select aria-label="Component 2" className="property-select" value={comp2Id} onChange={(e) => setComp2Id(e.target.value)}>
                {assemblyComponents.map(c => (
                  <option key={c.id} value={c.id}>{c.name} {c.isFixed ? '(Fixed)' : ''}</option>
                ))}
              </select>

              <label className="property-label" style={{ marginTop: 8 }}>Reference 2</label>
              <select aria-label="Reference 2" className="property-select" value={ref2} onChange={(e) => setRef2(e.target.value)}>
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
                  <input aria-label="Leader Lines" type="checkbox" className="explode-leaders" checked={explodeLeaders} onChange={(e) => setExplodeLeaders(e.target.checked)} />
                  <span className="slider round" />
                </label>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
                Moves the components apart on screen only. Their real positions and mates are kept.
              </div>
              {assemblyComponents.length < 2 && (
                <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 6 }}>Insert at least two components to explode.</div>
              )}
            </div>
          </div>
        )}
        {featureType === 'exploded_view' && assemblyComponents.length >= 2 && <ExplodeStepsCard />}
        {featureType === 'exploded_view' && (
          <div className="property-card">
            <div className="property-card-body">
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
              <select aria-label="Profile & Sketch"
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
                    <NumericInput value={depth} onChange={setDepth} min={0.5} max={5000} step={5} unit="mm" {...linkable('depth')} />
                  </div>
                )}

                <div className="property-row switch-row">
                  <span className="property-label">Reverse Extrude Direction</span>
                  <label className="custom-switch">
                    <input aria-label="Reverse Extrude Direction" type="checkbox" checked={flipDir} onChange={(e) => setFlipDir(e.target.checked)} />
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
                  <input type="checkbox" aria-label="Thin feature" checked={thin} onChange={(e) => setThin(e.target.checked)} />
                  <span className="slider round" />
                </label>
              </div>
              {thin && (
                <div className="property-card-body">
                  <div className="property-row">
                    <span className="property-label">Wall Thickness (T1):</span>
                    <NumericInput value={wallThickness} onChange={setWallThickness} min={0.2} max={100} step={0.5} unit="mm" {...linkable('wallThickness')} />
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
                <NumericInput value={angle} onChange={setAngle} min={1} max={360} step={15} unit="°" {...linkable('angle')} />
              </div>
              <div className="property-row">
                <span className="property-label">Axis:</span>
                <select aria-label="Axis" className="property-select revolve-axis" style={{ width: 150 }} value={revolveAxis} onChange={(e) => setRevolveAxis(e.target.value)}>
                  <option value="y">Sketch vertical (Y)</option>
                  <option value="x">Sketch horizontal (X)</option>
                  {(sketchEntitiesMap[selectedSketchId] ?? [])
                    .filter(e => e.type === 'line')
                    .sort((a, b) => Number(!!b.construction) - Number(!!a.construction))
                    .map((e, i) => {
                      const l = e as { id: string; p1: Point3; p2: Point3; construction?: boolean };
                      const f = (v: number) => +v.toFixed(1);
                      return <option key={l.id} value={`line:${l.id}`}>{l.construction ? 'Centreline' : `Line ${i + 1}`} ({f(l.p1.x)}, {f(l.p1.y)}) → ({f(l.p2.x)}, {f(l.p2.y)})</option>;
                    })}
                  {features.filter(f => f.type === FEATURE_TYPES.REFERENCE_AXIS && !f.suppressed).map(f => <option key={f.id} value={`ref:${f.id}`}>{f.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {(featureType === FEATURE_TYPES.REFERENCE_AXIS || featureType === FEATURE_TYPES.REFERENCE_POINT) && (
          <div className="property-card">
            <div className="property-card-header">{featureType === FEATURE_TYPES.REFERENCE_AXIS ? 'Reference Axis' : 'Reference Point'}</div>
            <div className="property-card-body">
              {featureType === FEATURE_TYPES.REFERENCE_AXIS && (
                <>
                  <div className="property-row">
                    <span className="property-label">Parallel to:</span>
                    <select aria-label="Parallel to" className="property-select ref-direction" style={{ width: 110 }} value={refDirection} onChange={(e) => setRefDirection(e.target.value as 'X' | 'Y' | 'Z')}>
                      {(['X', 'Y', 'Z'] as const).map(d => <option key={d} value={d}>Model {d}</option>)}
                    </select>
                  </div>
                  <div className="property-row">
                    <span className="property-label">Through:</span>
                    <select aria-label="Through" className="property-select ref-through" style={{ width: 110 }} value={refThrough} onChange={(e) => setRefThrough(e.target.value)}>
                      <option value="">This point</option>
                      {features.filter(f => f.type === FEATURE_TYPES.REFERENCE_POINT && !f.suppressed).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </div>
                </>
              )}
              {(featureType === FEATURE_TYPES.REFERENCE_POINT || !refThrough) && (['x', 'y', 'z'] as const).map(k => (
                <div className="property-row" key={k}>
                  <span className="property-label">{k.toUpperCase()}:</span>
                  <NumericInput value={refPoint[k]} onChange={(v) => setRefPoint(p => ({ ...p, [k]: v }))} step={5} unit="mm" {...linkable(`point.${k}`)} />
                </div>
              ))}
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                {featureType === FEATURE_TYPES.REFERENCE_AXIS
                  ? 'Use it as the axis of a Revolve when it lies in the sketch plane.'
                  : 'Reference axes can pass through it, and follow it when it moves.'}
              </div>
            </div>
          </div>
        )}

        {featureType === FEATURE_TYPES.COORDINATE_SYSTEM && (
          <div className="property-card">
            <div className="property-card-header">Coordinate System</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">Origin at:</span>
                <select aria-label="Origin at" className="property-select cs-through" style={{ width: 110 }} value={refThrough} onChange={(e) => setRefThrough(e.target.value)}>
                  <option value="">This point</option>
                  {features.filter(f => f.type === FEATURE_TYPES.REFERENCE_POINT && !f.suppressed).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              {!refThrough && (['x', 'y', 'z'] as const).map(k => (
                <div className="property-row" key={k}>
                  <span className="property-label">Origin {k.toUpperCase()}:</span>
                  <NumericInput value={refPoint[k]} onChange={(v) => setRefPoint(p => ({ ...p, [k]: v }))} step={5} unit="mm" {...linkable(`point.${k}`)} />
                </div>
              ))}
              {(['x', 'y', 'z'] as const).map(k => (
                <div className="property-row" key={`r${k}`}>
                  <span className="property-label">Turn about {k.toUpperCase()}:</span>
                  <NumericInput value={refRotation[k]} onChange={(v) => setRefRotation(r => ({ ...r, [k]: v }))} min={-360} max={360} step={15} unit="°" {...linkable(`rotation.${k}`)} />
                </div>
              ))}
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                Turns apply about model X, then Y, then Z. Mass Properties can report the centre of mass and inertia in it.
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
                <NumericInput value={radius} onChange={setRadius} min={0.5} max={100} step={1} unit="mm" {...linkable('radius')} />
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
                <NumericInput value={radius} onChange={setRadius} min={0.5} max={100} step={1} unit="mm" {...linkable('distance')} />
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
                <NumericInput value={thickness} onChange={setThickness} min={0.5} max={50} step={0.5} unit="mm" {...linkable('thickness')} />
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
                <span className="property-label">Hole Type:</span>
                <select aria-label="Hole Type" className="property-select hole-type" style={{ width: 130 }} value={holeType} onChange={(e) => setHoleType(e.target.value as typeof holeType)}>
                  {HOLE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="property-row">
                <span className="property-label">Standard:</span>
                <select aria-label="Standard" className="property-select hole-size" style={{ width: 130 }} value={holeSize} onChange={(e) => setHoleSize(e.target.value as MetricSize | '')}>
                  <option value="">Custom sizes</option>
                  {METRIC_SIZES.map(sz => <option key={sz} value={sz}>ISO metric {sz}</option>)}
                </select>
              </div>
              {holeSize && holeType !== 'tapped' && (
                <div className="property-row">
                  <span className="property-label">Fit:</span>
                  <select aria-label="Fit" className="property-select hole-fit" style={{ width: 130 }} value={holeFit} onChange={(e) => setHoleFit(e.target.value as ClearanceFit)}>
                    {CLEARANCE_FITS.map(fit => <option key={fit} value={fit}>{fit[0].toUpperCase() + fit.slice(1)} clearance</option>)}
                  </select>
                </div>
              )}
              {holeSize ? (
                <div className="hole-standard-info" style={{ fontSize: 11, color: '#a5b4fc', margin: '2px 0 6px' }}>
                  {standardHole(holeType, holeSize, holeFit).description}
                </div>
              ) : (
                <div className="property-row">
                  <span className="property-label">Diameter (Ø):</span>
                  <NumericInput value={diameter} onChange={setDiameter} min={1} max={200} step={1} unit="mm" {...linkable('diameter')} />
                </div>
              )}
              <div className="property-row">
                <span className="property-label">Hole Depth:</span>
                <NumericInput value={depth} onChange={setDepth} min={1} max={500} step={5} unit="mm" {...linkable('depth')} />
              </div>
              {!holeSize && holeType === 'counterbore' && (
                <>
                  <div className="property-row">
                    <span className="property-label">Counterbore Ø:</span>
                    <NumericInput value={cbDiameter} onChange={setCbDiameter} min={diameter + 0.1} max={300} step={1} unit="mm" {...linkable('cbDiameter')} />
                  </div>
                  <div className="property-row">
                    <span className="property-label">Counterbore Depth:</span>
                    <NumericInput value={cbDepth} onChange={setCbDepth} min={0.1} max={depth} step={0.5} unit="mm" {...linkable('cbDepth')} />
                  </div>
                </>
              )}
              {!holeSize && holeType === 'countersink' && (
                <>
                  <div className="property-row">
                    <span className="property-label">Countersink Ø:</span>
                    <NumericInput value={csDiameter} onChange={setCsDiameter} min={diameter + 0.1} max={300} step={1} unit="mm" {...linkable('csDiameter')} />
                  </div>
                  <div className="property-row">
                    <span className="property-label">Countersink Angle:</span>
                    <NumericInput value={csAngle} onChange={setCsAngle} min={60} max={120} step={1} unit="°" {...linkable('csAngle')} />
                  </div>
                </>
              )}
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
                  <NumericInput value={holePosition[k]} onChange={(v) => setHolePosition(p => ({ ...p, [k]: v }))} step={1} unit="mm" {...linkable(`position.${k}`)} />
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
                <NumericInput value={count} onChange={setCount} min={2} max={100} step={1} precision={0} {...linkable('count')} />
              </div>
              <div className="property-row">
                <span className="property-label">Spacing:</span>
                <NumericInput value={spacing} onChange={setSpacing} min={0.1} max={5000} step={5} unit="mm" {...linkable('spacing')} />
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
                <NumericInput value={count} onChange={setCount} min={2} max={360} step={1} precision={0} {...linkable('count')} />
              </div>
              <div className="property-row">
                <span className="property-label">Total Angle:</span>
                <NumericInput value={angle} onChange={setAngle} min={1} max={360} step={15} unit="°" {...linkable('angle')} />
              </div>
            </div>
          </div>
        )}

        {featureType === FEATURE_TYPES.REFERENCE_PLANE && (
          <div className="property-card">
            <div className="property-card-header">Reference Plane</div>
            <div className="property-card-body">
              <div className="property-row">
                <span className="property-label">From plane:</span>
                <select aria-label="From plane" className="property-select ref-base" style={{ width: 110 }} value={refBase} onChange={(e) => setRefBase(e.target.value as SketchPlane)}>
                  {(['Front', 'Top', 'Right'] as const).map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="property-row">
                <span className="property-label">Offset:</span>
                <NumericInput value={refOffset} onChange={setRefOffset} min={-5000} max={5000} step={5} unit="mm" {...linkable('offset')} />
              </div>
              <div className="property-row">
                <span className="property-label">Tilt (about its X):</span>
                <NumericInput value={refAngle} onChange={setRefAngle} min={-89} max={89} step={5} unit="°" {...linkable('angle')} />
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                Sketch on it from the Sketch tab. Sketches on it move with it when you change the offset or tilt.
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
                <select aria-label="Mirror Plane" className="property-select" style={{ width: 110 }} value={mirrorPlane} onChange={(e) => setMirrorPlane(e.target.value as SketchPlane)}>
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
