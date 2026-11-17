// CasiWorks Pro - Built-in commands: everything the ribbon, status bar and keyboard do
import { CommandError, CommandRegistry } from './CommandRegistry.ts';
import type { CommandDefinition, MacroStep } from './CommandRegistry.ts';
import type { CADStore, DrawingOptions, PrimitiveDims, PrimitiveShape } from '../store/cadStore.ts';
import { drawingFile } from '../drawings/drawingSheet.ts';
import type { DrawingFormat } from '../drawings/drawingSheet.ts';
import { downloadBlob } from '../utils/download.ts';
import { MATE_DEFAULTS } from '../assembly/mateDefaults.ts';
import { findInterferences } from '../assembly/interference.ts';
import { naturalFrequencies } from '../simulation/modal.ts';
import { rebuildModel } from '../features/rebuildModel.ts';
import { FACES } from '../simulation/studySetup.ts';
import { materialLibrary } from '../kernel/MaterialLibrary.ts';
import { RELATIONS, dimensionConstraint, measureForDimension } from '../kernel/sketchSolve.ts';
import type { RelationKind, SketchPick } from '../kernel/sketchSolve.ts';
import type { SketchConstraint } from '../kernel/ConstraintSolver.ts';
import { faceFrame, isPlaneFrame, referencePlaneFrame } from '../utils/math.ts';
import { bomCSV, buildBom } from '../assembly/bom.ts';
import { configurationProblems, effectiveVariables, evaluateExpression, evaluateLinks, evaluateVariables, isPlainNumber, parseExpression, dimensionLinks } from '../features/equations.ts';
import type { Configuration, GlobalVariable } from '../features/equations.ts';
import { FEATURE_TYPES, MATERIALS, TOOLS } from '../utils/constants.ts';
import type { MateType, ToolId, ViewOrientation } from '../utils/constants.ts';
import type { FeatureData, PlaneFrame, ReferenceFeature, SketchEntity, SketchPlane } from '../types/cad.ts';
import { generateId } from '../utils/math.ts';
import { CAD_EXAMPLES } from '../utils/examples.ts';
import { downloadProject, newProject, openProject } from '../utils/projectFile.ts';

const DRAWING_SHEET_SIZES = ['A4_LANDSCAPE', 'A4_PORTRAIT', 'A3_LANDSCAPE', 'ANSI_B'] as const;

/** The variables as the active configuration sees them. */
const activeVariables = (s: CADStore) => effectiveVariables(s.variables, s.configurations.find(c => c.name === s.activeConfiguration));

/** A dimension value given as a number or an expression ('wall * 2'): the value, and the expression to keep when it uses variables. */
function dimensionInput(s: CADStore, input: unknown): { value: number; expression?: string } {
  if (typeof input === 'number') {
    if (!(input > 0) || !Number.isFinite(input)) throw new CommandError('INVALID_ARGUMENT', 'value must be a number above 0');
    return { value: input };
  }
  if (typeof input !== 'string' || !input.trim()) throw new CommandError('INVALID_ARGUMENT', 'value must be a number or an expression');
  const text = input.trim().replace(/^=\s*/, '');
  let value: number;
  try { value = evaluateExpression(text, evaluateVariables(activeVariables(s)).values); } catch (e) {
    throw new CommandError('INVALID_ARGUMENT', `${text}: ${(e as Error).message}`);
  }
  if (!(value > 0)) throw new CommandError('INVALID_ARGUMENT', `${text} = ${value}: a dimension must be above 0`);
  // Keep the expression only when it uses variables; plain arithmetic is just a number
  return isPlainNumber(text) || parseExpression(text).names.size === 0 ? { value } : { value, expression: text };
}

/** Check a feature's `expressions` against the current variables; throws INVALID_ARGUMENT naming the bad one. */
function requireExpressions(state: CADStore, expressions: unknown): void {
  if (expressions === undefined) return;
  if (!expressions || typeof expressions !== 'object' || Array.isArray(expressions)) throw new CommandError('INVALID_ARGUMENT', 'expressions must be an object of parameter → expression');
  const { values } = evaluateVariables(activeVariables(state));
  for (const [param, expr] of Object.entries(expressions as Record<string, unknown>)) {
    if (typeof expr !== 'string') throw new CommandError('INVALID_ARGUMENT', `expression for ${param} must be text`);
    try { evaluateExpression(expr, values); } catch (e) {
      throw new CommandError('INVALID_ARGUMENT', `${param} = ${expr}: ${(e as Error).message}`);
    }
  }
}

type Def<A = void> = CommandDefinition<CADStore, A>;
type Store = { getState(): CADStore };

const PLANES: SketchPlane[] = ['Front', 'Top', 'Right'];

/**
 * A sketch plane argument: 'Front' | 'Top' | 'Right', the id of a reference plane
 * feature, or a plane frame { origin, xAxis, normal }.
 */
function resolvePlane(state: CADStore, plane: unknown): { plane: SketchPlane; planeRef?: string; frame?: PlaneFrame } {
  const value = plane ?? 'Front';
  if (typeof value === 'string') {
    if (PLANES.includes(value as SketchPlane)) return { plane: value as SketchPlane };
    const ref = state.features.find(f => f.id === value && f.type === FEATURE_TYPES.REFERENCE_PLANE);
    if (ref) return { plane: 'Front', planeRef: ref.id };
    throw new CommandError('INVALID_ARGUMENT', `plane must be ${PLANES.join(', ')}, a reference plane id or { origin, xAxis, normal } (got ${JSON.stringify(value)})`);
  }
  if (isPlaneFrame(value)) {
    const nums = [value.origin, value.xAxis, value.normal].flatMap(p => [p?.x, p?.y, p?.z]);
    if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) throw new CommandError('INVALID_ARGUMENT', 'plane frame: origin, xAxis and normal need finite x, y, z');
    const n = value.normal, x = value.xAxis;
    const nl = Math.hypot(n.x, n.y, n.z);
    const cross = Math.hypot(n.y * x.z - n.z * x.y, n.z * x.x - n.x * x.z, n.x * x.y - n.y * x.x);
    if (nl < 1e-9 || cross < 1e-9 * nl) throw new CommandError('INVALID_ARGUMENT', 'plane frame: normal must be non-zero and xAxis not parallel to it');
    return { plane: 'Front', frame: { origin: { ...value.origin }, xAxis: { ...value.xAxis }, normal: { ...value.normal } } };
  }
  throw new CommandError('INVALID_ARGUMENT', `plane must be ${PLANES.join(', ')}, a reference plane id or { origin, xAxis, normal }`);
}

/** Open the property panel for a feature tool (the panel creates the feature on OK). */
const featureTool = (id: string, label: string, tool: ToolId, type: string, shortcuts?: string[]): Def => ({
  id, label, category: 'Features', shortcuts,
  record: false, // the panel's OK runs feature.create, which is recorded
  run: ({ state }) => {
    state().setActiveTool(tool);
    state().openPropertyPanel({ type });
  },
});

const sketchTool = (id: string, label: string, tool: ToolId, shortcuts?: string[]): Def => ({
  id, label, category: 'Sketch', shortcuts, record: false,
  run: ({ state }) => state().setActiveTool(tool),
});

const view = (orientation: ViewOrientation, label: string, shortcuts: string[]): Def => ({
  id: `view.${orientation}`, label, category: 'View', shortcuts, record: false,
  run: ({ state }) => state().setViewOrientation(orientation),
});

const toggle = (id: string, label: string, action: (s: CADStore) => void): Def => ({
  id, label, category: 'View', record: false, run: ({ state }) => action(state()),
});

const FEATURE_TYPE_VALUES = new Set<string>(Object.values(FEATURE_TYPES));

const requireFeature = (s: CADStore, id: unknown) => {
  const f = s.features.find(x => x.id === id);
  if (!f) throw new CommandError('INVALID_ARGUMENT', `No feature with id ${JSON.stringify(id)}`);
  return f;
};

const requireEntities = (entities: unknown): SketchEntity[] => {
  if (!Array.isArray(entities) || entities.some(e => !e || typeof e !== 'object' || typeof (e as { type?: unknown }).type !== 'string')) {
    throw new CommandError('INVALID_ARGUMENT', 'entities must be an array of sketch entities ({ type, … })');
  }
  return entities as SketchEntity[];
};

/** Mate defaults (MATE_DEFAULTS) are shared with the API: assembly/mateDefaults.ts. */
interface MateArgs {
  type: MateType;
  /** Defaults: the first two components. */
  component1?: string;
  component2?: string;
  ref1?: string;
  ref2?: string;
  offset?: number;
}

export const BUILTIN_COMMANDS: Array<Def<never>> = [
  // ------------------------------------------------------------------ file & edit
  {
    id: 'file.new', label: 'New part', category: 'File', shortcuts: ['Ctrl+Alt+N'], requiresUI: true,
    // Replayed without the "discard changes?" question
    record: (_args, _result, state) => (state.features.length === 0 ? { command: 'document.new' } : null),
    // Browsers reserve plain Ctrl+N for a new window
    description: 'Start a new part (asks before discarding unsaved changes)',
    run: ({ state }) => newProject({ getState: state }),
  },
  { id: 'file.open', label: 'Open…', category: 'File', shortcuts: ['Ctrl+O'], requiresUI: true, run: ({ state }) => openProject({ getState: state }) },
  { id: 'file.save', label: 'Save', category: 'File', shortcuts: ['Ctrl+S'], requiresUI: true, description: 'Download the project file', run: ({ state }) => downloadProject({ getState: state }) },
  { id: 'file.export', label: 'Export model…', category: 'File', requiresUI: true, run: ({ ui }) => ui().openDialog('export') },
  {
    id: 'file.loadExample', label: 'Load example', category: 'File',
    description: 'args: { id } — one of the built-in example ids',
    run: ({ state }, args: { id: string }) => {
      const ex = CAD_EXAMPLES.find(e => e.id === args?.id);
      if (!ex) throw new CommandError('INVALID_ARGUMENT', `Unknown example "${args?.id}" (known: ${CAD_EXAMPLES.map(e => e.id).join(', ')})`);
      state().loadExampleModel(ex.create());
    },
  },
  { id: 'edit.undo', label: 'Undo', category: 'Edit', shortcuts: ['Ctrl+Z'], run: ({ state }) => state().undo() },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', shortcuts: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: ({ state }) => state().redo() },
  {
    id: 'document.new', label: 'New part (no questions)', category: 'File',
    description: 'Start a new, empty part, discarding the current one (for scripts and macros)',
    run: ({ state }) => state().newProject(),
  },
  { id: 'edit.cancel', label: 'Cancel tool', category: 'Edit', shortcuts: ['Escape'], record: false, run: ({ state }) => state().cancelTool() },
  { id: 'model.rebuild', label: 'Rebuild', category: 'Model', shortcuts: ['F5'], run: ({ state }) => state().rebuild() },
  { id: 'model.material', label: 'Material…', category: 'Model', requiresUI: true, run: ({ ui }) => ui().openDialog('material') },
  {
    id: 'model.setMaterial', label: 'Set material', category: 'Model', description: 'args: { key } — e.g. Aluminum_6061',
    run: ({ state }, args: { key: string }) => {
      if (!args || !MATERIALS[args.key]) throw new CommandError('INVALID_ARGUMENT', `Unknown material ${JSON.stringify(args?.key)} (known: ${Object.keys(MATERIALS).join(', ')})`);
      state().setMaterial(args.key);
    },
  },
  {
    id: 'model.rollbackTo', label: 'Roll back to', category: 'Model', description: 'args: { index } — features after index are inactive; -1 = end of tree',
    run: ({ state }, args: { index: number }) => {
      const n = state().features.length;
      if (!args || !Number.isInteger(args.index) || args.index < -1 || args.index >= n) throw new CommandError('INVALID_ARGUMENT', `index must be an integer from -1 to ${n - 1}`);
      state().setRollbackIndex(args.index === n - 1 ? -1 : args.index);
    },
  },

  // ------------------------------------------------------------------ feature data (what the panel and tree do)
  {
    id: 'feature.create', label: 'Create feature', category: 'Features',
    description: "args: { type, name?, …parameters } e.g. { type: 'extrude_boss', sketchId, depth: 25 }; returns { featureId }",
    run: ({ state }, args: { type: string; name?: string } & Record<string, unknown>) => {
      if (!args || !FEATURE_TYPE_VALUES.has(args.type) || args.type === FEATURE_TYPES.SKETCH) {
        throw new CommandError('INVALID_ARGUMENT', `type must be a feature type other than sketch (got ${JSON.stringify(args?.type)})`);
      }
      requireExpressions(state(), args.expressions);
      const featureId = generateId('feat');
      const name = args.name || args.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      state().addFeature({ ...args, name, id: featureId } as unknown as FeatureData);
      if (!state().features.some(f => f.id === featureId)) throw new CommandError('FAILED', 'The feature was not added');
      return { featureId };
    },
  },
  {
    id: 'feature.update', label: 'Edit feature', category: 'Features', description: 'args: { id, changes }',
    run: ({ state }, args: { id: string; changes: Record<string, unknown> }) => {
      requireFeature(state(), args?.id);
      if (!args.changes || typeof args.changes !== 'object') throw new CommandError('INVALID_ARGUMENT', 'changes must be an object');
      requireExpressions(state(), args.changes.expressions);
      state().updateFeature(args.id, args.changes);
    },
  },
  {
    id: 'feature.remove', label: 'Delete feature', category: 'Features', description: 'args: { id }',
    run: ({ state }, args: { id: string }) => {
      requireFeature(state(), args?.id);
      state().removeFeature(args.id);
    },
  },
  {
    id: 'feature.setSuppressed', label: 'Suppress / unsuppress', category: 'Features', description: 'args: { id, suppressed }',
    run: ({ state }, args: { id: string; suppressed: boolean }) => {
      const f = requireFeature(state(), args?.id);
      if (typeof args.suppressed !== 'boolean') throw new CommandError('INVALID_ARGUMENT', 'suppressed must be true or false');
      if (Boolean(f.suppressed) !== args.suppressed) state().toggleFeatureSuppressed(args.id);
    },
  },

  // ------------------------------------------------------------------ features
  featureTool('feature.extrude', 'Extruded boss', TOOLS.EXTRUDE, FEATURE_TYPES.EXTRUDE_BOSS, ['E']),
  featureTool('feature.extrudeCut', 'Extruded cut', TOOLS.EXTRUDE_CUT, FEATURE_TYPES.EXTRUDE_CUT),
  featureTool('feature.revolve', 'Revolved boss', TOOLS.REVOLVE, FEATURE_TYPES.REVOLVE_BOSS),
  featureTool('feature.sweep', 'Swept boss', TOOLS.SWEEP, FEATURE_TYPES.SWEEP_BOSS),
  featureTool('feature.loft', 'Lofted boss', TOOLS.LOFT, FEATURE_TYPES.LOFT_BOSS),
  featureTool('feature.fillet', 'Fillet', TOOLS.FILLET, FEATURE_TYPES.FILLET),
  featureTool('feature.chamfer', 'Chamfer', TOOLS.CHAMFER, FEATURE_TYPES.CHAMFER),
  featureTool('feature.shell', 'Shell', TOOLS.SHELL, FEATURE_TYPES.SHELL),
  featureTool('feature.hole', 'Hole', TOOLS.HOLE, FEATURE_TYPES.HOLE),
  featureTool('feature.linearPattern', 'Linear pattern', TOOLS.LINEAR_PATTERN, FEATURE_TYPES.LINEAR_PATTERN),
  featureTool('feature.circularPattern', 'Circular pattern', TOOLS.CIRCULAR_PATTERN, FEATURE_TYPES.CIRCULAR_PATTERN),
  featureTool('feature.mirror', 'Mirror', TOOLS.MIRROR, FEATURE_TYPES.MIRROR),

  // ------------------------------------------------------------------ sketch
  {
    id: 'sketch.new', label: 'New sketch', category: 'Sketch',
    description: "args: { plane: 'Front' | 'Top' | 'Right' | reference plane id | { origin, xAxis, normal } } (default Front)",
    run: ({ state }, args: { plane?: unknown } | undefined) => {
      const r = resolvePlane(state(), args?.plane);
      if (state().isSketchActive) throw new CommandError('NOT_AVAILABLE', 'Finish the current sketch first');
      if (r.planeRef) {
        const ref = state().features.find(f => f.id === r.planeRef)!;
        if (ref.suppressed) throw new CommandError('NOT_AVAILABLE', `${ref.name} is suppressed`);
        const rf = ref as ReferenceFeature;
        state().startSketch(referencePlaneFrame(rf.base ?? 'Front', rf.offset ?? 0, rf.angle ?? 0), ref.id);
      } else {
        state().startSketch(r.frame ?? r.plane);
      }
    },
    record: false, // the confirmed sketch is recorded by sketch.exit
  },
  {
    id: 'sketch.exit', label: 'Confirm sketch', category: 'Sketch',
    description: 'returns { sketchId, featureId } of the confirmed sketch',
    run: ({ state }) => {
      const sketchId = state().activeSketchId;
      const existed = state().features.some(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId);
      state().endSketch(true);
      const feature = state().features.find(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId);
      return sketchId && feature ? { sketchId, featureId: feature.id, created: !existed } : undefined;
    },
    // Recorded as the finished geometry, not the clicks that drew it
    record: (_args, result, state): MacroStep | null => {
      const r = result as { sketchId: string; featureId: string; created: boolean } | undefined;
      if (!r) return null;
      const entities = state.sketchEntities[r.sketchId] ?? [];
      if (!r.created) return { command: 'sketch.setEntities', args: { sketchId: r.sketchId, entities } };
      const feature = state.features.find(f => f.id === r.featureId);
      const sk = feature?.type === FEATURE_TYPES.SKETCH ? feature : null;
      const plane = sk?.planeRef ?? sk?.frame ?? sk?.plane ?? 'Front';
      return { command: 'sketch.create', args: { plane, name: feature?.name, entities }, returns: { sketchId: r.sketchId, featureId: r.featureId } };
    },
  },
  {
    id: 'sketch.onFace', label: 'Sketch on face', category: 'Sketch', record: false,
    description: 'Without args: click a flat face of the part to sketch on it. args: { point, normal } starts a sketch on that plane directly',
    run: ({ state }, args: { point?: { x: number; y: number; z: number }; normal?: { x: number; y: number; z: number } } | undefined) => {
      if (state().isSketchActive) throw new CommandError('NOT_AVAILABLE', 'Finish the current sketch first');
      if (!args?.point || !args.normal) {
        state().setActiveTool(TOOLS.SKETCH_ON_FACE);
        state().setStatus('Sketch on face: click a flat face of the part');
        return;
      }
      const ok = (p: { x: number; y: number; z: number }) => [p.x, p.y, p.z].every(v => typeof v === 'number' && Number.isFinite(v));
      if (!ok(args.point) || !ok(args.normal) || Math.hypot(args.normal.x, args.normal.y, args.normal.z) < 1e-9) {
        throw new CommandError('INVALID_ARGUMENT', 'point and normal need finite x, y, z (normal non-zero)');
      }
      state().cancelTool();
      state().startSketch(faceFrame(args.point, args.normal));
    },
  },
  {
    id: 'feature.referencePlane', label: 'Reference plane', category: 'Features', record: false,
    description: 'Opens the reference plane panel; create one directly with feature.create { type: "reference_plane", base, offset, angle }',
    run: ({ state }) => state().openPropertyPanel({ type: FEATURE_TYPES.REFERENCE_PLANE }),
  },
  {
    id: 'feature.referenceAxis', label: 'Reference axis', category: 'Features', record: false,
    description: 'Opens the reference axis panel; or feature.create { type: "reference_axis", direction: "X" | "Y" | "Z", point | throughRef }',
    run: ({ state }) => state().openPropertyPanel({ type: FEATURE_TYPES.REFERENCE_AXIS }),
  },
  {
    id: 'feature.referencePoint', label: 'Reference point', category: 'Features', record: false,
    description: 'Opens the reference point panel; or feature.create { type: "reference_point", point: { x, y, z } }',
    run: ({ state }) => state().openPropertyPanel({ type: FEATURE_TYPES.REFERENCE_POINT }),
  },
  { id: 'sketch.discard', label: 'Discard sketch', category: 'Sketch', record: false, run: ({ state }) => state().endSketch(false) },
  {
    id: 'sketch.create', label: 'Create sketch', category: 'Sketch',
    description: "args: { plane?, name?, entities } — plane: 'Front' | 'Top' | 'Right' | reference plane id | { origin, xAxis, normal }; entities in the store's format; returns { sketchId, featureId }",
    run: ({ state }, args: { plane?: unknown; name?: string; entities: SketchEntity[] }) => {
      const where = resolvePlane(state(), args?.plane);
      const entities = requireEntities(args?.entities);
      const sketchId = generateId('sketch');
      const featureId = generateId('feat_sketch');
      state().createSketchFeature({ id: featureId, sketchId, ...where, name: args.name, entities: JSON.parse(JSON.stringify(entities)) });
      return { sketchId, featureId };
    },
  },
  {
    id: 'sketch.setEntities', label: 'Replace sketch geometry', category: 'Sketch', description: 'args: { sketchId, entities }',
    run: ({ state }, args: { sketchId: string; entities: SketchEntity[] }) => {
      if (!state().features.some(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === args?.sketchId)) {
        throw new CommandError('INVALID_ARGUMENT', `No sketch with id ${JSON.stringify(args?.sketchId)}`);
      }
      state().setSketchEntities(args.sketchId, requireEntities(args.entities));
    },
  },
  sketchTool('sketch.line', 'Line', TOOLS.SKETCH_LINE, ['L']),
  sketchTool('sketch.rectangle', 'Corner rectangle', TOOLS.SKETCH_RECT, ['R']),
  sketchTool('sketch.circle', 'Center circle', TOOLS.SKETCH_CIRCLE, ['C']),
  sketchTool('sketch.point', 'Point', TOOLS.SKETCH_POINT),
  sketchTool('sketch.arc', 'Centre arc', TOOLS.SKETCH_ARC, ['A']),
  sketchTool('sketch.slot', 'Straight slot', TOOLS.SKETCH_SLOT),
  sketchTool('sketch.spline', 'Spline', TOOLS.SKETCH_SPLINE, ['S']),
  sketchTool('sketch.trim', 'Trim', TOOLS.SKETCH_TRIM, ['T']),
  sketchTool('sketch.extend', 'Extend', TOOLS.SKETCH_EXTEND),
  sketchTool('sketch.mirror', 'Mirror entities', TOOLS.SKETCH_MIRROR),
  {
    id: 'sketch.offset', label: 'Offset entities', category: 'Sketch', record: false,
    description: 'args: { distance? } in mm (default: the last used, initially 5)',
    run: ({ state }, args: { distance?: number } | undefined) => {
      if (args?.distance !== undefined) {
        if (typeof args.distance !== 'number' || !(args.distance > 0) || args.distance > 1000) throw new CommandError('INVALID_ARGUMENT', 'distance must be a number of mm above 0 and at most 1000');
        state().setSketchOffsetDistance(args.distance);
      }
      state().setActiveTool(TOOLS.SKETCH_OFFSET);
    },
  },
  {
    id: 'sketch.polygon', label: 'Polygon', category: 'Sketch', record: false,
    description: 'args: { sides? } (3–64, default: the last used, initially 6)',
    run: ({ state }, args: { sides?: number } | undefined) => {
      if (args?.sides !== undefined) {
        if (!Number.isInteger(args.sides) || args.sides < 3 || args.sides > 64) throw new CommandError('INVALID_ARGUMENT', 'sides must be an integer from 3 to 64');
        state().setSketchPolygonSides(args.sides);
      }
      state().setActiveTool(TOOLS.SKETCH_POLYGON);
    },
  },
  sketchTool('sketch.dimension', 'Smart dimension', TOOLS.SKETCH_DIMENSION, ['D']),
  {
    id: 'sketch.relation', label: 'Add relation', category: 'Sketch', record: false,
    description: `args: { type } — ${Object.keys(RELATIONS).join(', ')}; then click the item(s) in the sketch`,
    run: ({ state }, args: { type?: RelationKind } | undefined) => {
      if (args?.type !== undefined) {
        if (!(args.type in RELATIONS)) throw new CommandError('INVALID_ARGUMENT', `type must be one of ${Object.keys(RELATIONS).join(', ')}`);
        state().setSketchRelationKind(args.type);
      }
      state().setActiveTool(TOOLS.SKETCH_RELATION);
      const spec = RELATIONS[state().sketchRelationKind];
      state().setStatus(`${spec.label}: click the item${spec.picks === 2 ? 's' : ''} to relate`);
    },
  },
  {
    id: 'sketch.entities', label: 'Open sketch geometry', category: 'Sketch', record: false,
    description: 'Returns { sketchId, entities, constraints, state } of the sketch being edited (null when none is open)',
    run: ({ state }) => {
      const s = state();
      if (!s.activeSketchId) return null;
      return JSON.parse(JSON.stringify({
        sketchId: s.activeSketchId,
        entities: s.sketchEntities[s.activeSketchId] ?? [],
        constraints: s.sketchConstraints[s.activeSketchId] ?? [],
        state: s.sketchSolveState,
      }));
    },
  },
  {
    id: 'sketch.constrain', label: 'Add sketch relation / dimension', category: 'Sketch',
    description: "args: { sketchId?, constraint } — a solver constraint, e.g. { type: 'horizontal', entity1Id } or { type: 'dimension', entity1Id, value }; default: the open sketch. Returns { id }",
    run: ({ state }, args: { sketchId?: string; constraint?: SketchConstraint }) => {
      const sketchId = args?.sketchId ?? state().activeSketchId;
      if (!sketchId || !(sketchId in state().sketchEntities)) throw new CommandError('INVALID_ARGUMENT', 'No sketch: open one or give sketchId');
      const c = args?.constraint;
      if (!c || typeof c !== 'object' || typeof c.type !== 'string') throw new CommandError('INVALID_ARGUMENT', 'constraint { type, entity1Id, … } is required');
      const ids = new Set((state().sketchEntities[sketchId] ?? []).map(e => e.id));
      for (const k of ['entity1Id', 'entity2Id'] as const) {
        if (c[k] !== undefined && !ids.has(c[k]!)) throw new CommandError('INVALID_ARGUMENT', `No entity ${JSON.stringify(c[k])} in the sketch`);
      }
      const withId = { ...c, id: c.id ?? generateId(c.type === 'dimension' ? 'dim' : 'rel') };
      const existing = (state().sketchConstraints[sketchId] ?? []) as SketchConstraint[];
      const error = state().applySketchConstraints(sketchId, [...existing, withId], c.type === 'dimension' ? 'Dimension added' : `${c.type} added`);
      if (error) throw new CommandError('FAILED', error);
      return { id: withId.id };
    },
  },
  {
    id: 'sketch.dimensionPicks', label: 'Dimension picked items', category: 'Sketch',
    description: "args: { picks: [{ id, ref? }], value? } — dimensions the open sketch; value: mm or an expression such as 'wall * 2' (default: the current size; a circle: its diameter); returns { id }",
    run: ({ state }, args: { picks?: SketchPick[]; value?: number | string }) => {
      const sketchId = state().activeSketchId;
      if (!sketchId) throw new CommandError('NOT_AVAILABLE', 'Open a sketch first');
      const entities = state().sketchEntities[sketchId] ?? [];
      const picks = args?.picks ?? [];
      const m = measureForDimension(picks, entities);
      if (typeof m === 'string') throw new CommandError('INVALID_ARGUMENT', m);
      const { value, expression } = dimensionInput(state(), args?.value ?? m.value);
      const c = { ...dimensionConstraint(picks, value, entities), ...(expression ? { expression } : {}) };
      const error = state().applySketchConstraints(sketchId, [...(state().sketchConstraints[sketchId] ?? []) as SketchConstraint[], c], `${m.label} ${+value.toFixed(4)} mm`);
      if (error) throw new CommandError('FAILED', error);
      return { id: c.id };
    },
  },
  {
    id: 'sketch.setDimension', label: 'Change a sketch dimension', category: 'Sketch',
    description: "args: { sketchId?, id, value } — value in mm or an expression such as 'wall * 2' (a circle: its diameter); the sketch is solved again",
    run: ({ state }, args: { sketchId?: string; id?: string; value?: number | string }) => {
      const sketchId = args?.sketchId ?? state().activeSketchId;
      if (!sketchId) throw new CommandError('INVALID_ARGUMENT', 'No sketch: open one or give sketchId');
      const list = (state().sketchConstraints[sketchId] ?? []) as Array<SketchConstraint & { diameter?: boolean }>;
      const c = list.find(x => x.id === args?.id && x.type === 'dimension');
      if (!c) throw new CommandError('INVALID_ARGUMENT', `No dimension ${JSON.stringify(args?.id)} in the sketch`);
      const { value, expression } = dimensionInput(state(), args?.value);
      const next = list.map(x => {
        if (x.id !== c.id) return x;
        const { expression: _old, ...rest } = x as typeof x & { expression?: string };
        return { ...rest, value: x.diameter ? value / 2 : value, ...(expression ? { expression } : {}) };
      });
      const error = state().applySketchConstraints(sketchId, next, `Dimension ${+value.toFixed(4)} mm`);
      if (error) throw new CommandError('FAILED', error);
    },
  },
  {
    id: 'sketch.removeConstraint', label: 'Delete a sketch relation / dimension', category: 'Sketch',
    description: 'args: { sketchId?, id }',
    run: ({ state }, args: { sketchId?: string; id?: string }) => {
      const sketchId = args?.sketchId ?? state().activeSketchId;
      if (!sketchId) throw new CommandError('INVALID_ARGUMENT', 'No sketch: open one or give sketchId');
      const list = (state().sketchConstraints[sketchId] ?? []) as SketchConstraint[];
      if (!list.some(x => x.id === args?.id)) throw new CommandError('INVALID_ARGUMENT', `No relation or dimension ${JSON.stringify(args?.id)}`);
      const error = state().applySketchConstraints(sketchId, list.filter(x => x.id !== args!.id), 'Removed');
      if (error) throw new CommandError('FAILED', error);
    },
  },
  { id: 'sketch.toggleConstruction', label: 'Construction geometry', category: 'Sketch', record: false, run: ({ state }) => state().toggleConstructionMode() },

  // ------------------------------------------------------------------ view
  view('front', 'Front view', ['Ctrl+1']),
  view('back', 'Back view', ['Ctrl+2']),
  view('left', 'Left view', ['Ctrl+3']),
  view('right', 'Right view', ['Ctrl+4']),
  view('top', 'Top view', ['Ctrl+5']),
  view('bottom', 'Bottom view', ['Ctrl+6']),
  view('isometric', 'Isometric view', ['Ctrl+7', 'Space']),
  toggle('view.toggleGrid', 'Grid', s => s.toggleGrid()),
  toggle('view.toggleSnap', 'Snap to grid', s => s.toggleSnap()),
  toggle('view.toggleEdges', 'Edges', s => s.toggleEdges()),
  toggle('view.toggleWireframe', 'Wireframe', s => s.toggleWireframe()),
  toggle('view.togglePerspective', 'Perspective / orthographic', s => s.togglePerspective()),
  toggle('view.toggleSection', 'Section view', s => s.toggleSectionView()),
  { id: 'view.toggleFeatureTree', label: 'Feature tree', category: 'View', requiresUI: true, run: ({ ui }) => ui().toggleFeatureTree() },
  {
    id: 'addins.manage', label: 'Manage add-ins…', category: 'Add-ins', requiresUI: true, record: false,
    description: 'Load add-ins (plugins) from a URL or file, list and unload them',
    run: ({ ui }) => ui().openDialog('addins'),
  },
  {
    id: 'help.apiReference', label: 'API reference', category: 'Help', requiresUI: true, record: false,
    description: 'Opens the generated API reference (/api/) in a new tab',
    run: () => { window.open(`${import.meta.env?.BASE_URL ?? '/'}api/`, '_blank', 'noopener'); },
  },
  { id: 'view.toggleConsole', label: 'Scripting console', category: 'View', shortcuts: ['Ctrl+`'], requiresUI: true, record: false, run: ({ ui }) => ui().toggleConsole() },

  // ------------------------------------------------------------------ evaluate & drawing
  {
    id: 'evaluate.measure', label: 'Measure', category: 'Evaluate', shortcuts: ['M'], record: false,
    description: 'Click two points on the model: distance, dX/dY/dZ, the angle between the faces and, for parallel faces, the gap',
    run: ({ state }) => {
      state().setActiveTool(TOOLS.MEASURE);
      state().setStatus('Measure: click a point on the model (corners snap)');
    },
  },
  {
    id: 'simulation.modal', label: 'Natural frequencies', category: 'Simulation', record: false,
    description: "Modal analysis of the part in its material with one face held. args: { fixedFace?: 'xMin'…'zMax' (default zMin), modes?: 1–20 (default 6), elementType?: 'tet10' | 'tet4', quality?: 'coarse' | 'medium' | 'fine' }. Returns { frequencies (Hz, lowest first), mass (kg), elements }",
    run: ({ state }, args?: { fixedFace?: string; modes?: number; elementType?: string; quality?: string }) => {
      const a = args ?? {};
      if (a.fixedFace !== undefined && !FACES.includes(a.fixedFace as never)) throw new CommandError('INVALID_ARGUMENT', `fixedFace must be one of ${FACES.join(', ')}`);
      if (a.modes !== undefined && !(Number.isInteger(a.modes) && a.modes >= 1 && a.modes <= 20)) throw new CommandError('INVALID_ARGUMENT', 'modes must be a whole number from 1 to 20');
      if (a.elementType !== undefined && a.elementType !== 'tet10' && a.elementType !== 'tet4') throw new CommandError('INVALID_ARGUMENT', "elementType must be 'tet10' or 'tet4'");
      if (a.quality !== undefined && !['coarse', 'medium', 'fine'].includes(a.quality)) throw new CommandError('INVALID_ARGUMENT', "quality must be 'coarse', 'medium' or 'fine'");
      if (state().needsRebuild) rebuildModel({ getState: state });
      const geometry = state().bodies.find(b => b.visible !== false && b.geometry)?.geometry;
      if (!geometry) throw new CommandError('NOT_AVAILABLE', 'Create a 3D solid body first');
      const r = naturalFrequencies(geometry, materialLibrary.getMaterial(state().activeMaterial), a as never);
      state().setStatus(`Natural frequencies: ${r.frequencies.slice(0, 3).map(f => `${f.toFixed(1)} Hz`).join(', ')}${r.frequencies.length > 3 ? '…' : ''}`);
      return { frequencies: r.frequencies, mass: r.mass, elements: r.elements };
    },
  },
  { id: 'evaluate.clearMeasure', label: 'Clear measurement', category: 'Evaluate', record: false, run: ({ state }) => state().clearMeasure() },
  { id: 'evaluate.massProperties', label: 'Mass properties…', category: 'Evaluate', requiresUI: true, run: ({ ui }) => ui().openDialog('massProperties') },
  { id: 'drawing.open', label: '2D drawing sheet…', category: 'Drawing', requiresUI: true, description: 'Standard 3-view sheet with SVG / DXF export', run: ({ ui }) => ui().openDialog('drawing') },
  {
    id: 'drawing.options', label: 'Drawing sheet options', category: 'Drawing', record: false,
    description: "args: { subject?: 'part' | 'assembly', sheetSize?: 'A4_LANDSCAPE' | 'A4_PORTRAIT' | 'A3_LANDSCAPE' | 'ANSI_B', hiddenLines?, dimensions?, gdt? } — only the given ones change",
    run: ({ state }, args: Partial<DrawingOptions> | undefined) => {
      const next: Partial<DrawingOptions> = {};
      if (args?.subject !== undefined) {
        if (args.subject !== 'part' && args.subject !== 'assembly') throw new CommandError('INVALID_ARGUMENT', "subject must be 'part' or 'assembly'");
        next.subject = args.subject;
      }
      if (args?.sheetSize !== undefined) {
        if (!(DRAWING_SHEET_SIZES as readonly string[]).includes(args.sheetSize)) {
          throw new CommandError('INVALID_ARGUMENT', `sheetSize must be one of ${DRAWING_SHEET_SIZES.join(', ')}`);
        }
        next.sheetSize = args.sheetSize;
      }
      for (const key of ['hiddenLines', 'dimensions', 'gdt'] as const) {
        const v = args?.[key];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') throw new CommandError('INVALID_ARGUMENT', `${key} must be true or false`);
        next[key] = v;
      }
      state().setDrawingOptions(next);
      return { ...state().drawingOptions };
    },
  },
  {
    id: 'drawing.export', label: 'Export drawing (SVG / DXF / PDF)', category: 'Drawing', requiresUI: true, record: false,
    description: "args: { format: 'svg' | 'dxf' | 'pdf' } — downloads the sheet with the current drawing options",
    run: ({ state }, args: { format?: DrawingFormat } | undefined) => {
      const format = args?.format ?? 'svg';
      if (format !== 'svg' && format !== 'dxf' && format !== 'pdf') throw new CommandError('INVALID_ARGUMENT', "format must be 'svg', 'dxf' or 'pdf'");
      const file = drawingFile(state(), format);
      if (!file) {
        throw new CommandError('NOT_AVAILABLE', state().drawingOptions.subject === 'assembly'
          ? 'Insert components first: the assembly drawing is made from them'
          : 'Create a solid body first: the drawing is made from it');
      }
      downloadBlob(file.bytes ? new Blob([file.bytes as BlobPart], { type: file.mimeType }) : file.text, file.filename, file.mimeType);
      state().setStatus(`Drawing exported: ${file.filename}`);
      return { filename: file.filename };
    },
  },

  // ------------------------------------------------------------------ assembly
  {
    id: 'assembly.insertPart', label: 'Insert component', category: 'Assembly',
    description: "args: { name, shape: 'box' | 'cylinder' | 'flange' | 'pin', dims? }",
    run: ({ state }, args: { name: string; shape: PrimitiveShape; dims?: PrimitiveDims }) => {
      if (!args?.name || !args.shape) throw new CommandError('INVALID_ARGUMENT', 'name and shape are required');
      state().insertAssemblyPart(args.name, args.shape, args.dims);
      const inserted = state().assemblyComponents.at(-1);
      return inserted ? { componentId: inserted.id } : undefined;
    },
  },
  {
    id: 'assembly.mate', label: 'Add mate', category: 'Assembly',
    description: 'args: { type, component1?, component2?, ref1?, ref2?, offset? } — defaults to the first two components',
    run: ({ state }, args: MateArgs) => {
      const d = MATE_DEFAULTS[args?.type];
      if (!d) throw new CommandError('INVALID_ARGUMENT', `Unknown mate type "${args?.type}"`);
      const comps = state().assemblyComponents;
      const c1 = args.component1 ?? comps[0]?.id;
      const c2 = args.component2 ?? comps[1]?.id;
      if (!c1 || !c2) throw new CommandError('NOT_AVAILABLE', 'Insert at least two components to mate');
      const [a, b] = d.swap && !args.component1 && !args.component2 ? [c2, c1] : [c1, c2];
      state().addAssemblyMate(args.type, a, args.ref1 ?? d.ref1, b, args.ref2 ?? d.ref2, args.offset ?? d.offset);
    },
  },
  { id: 'assembly.solve', label: 'Solve mates', category: 'Assembly', run: ({ state }) => state().solveAssembly() },
  { id: 'assembly.explodedView', label: 'Exploded view', category: 'Assembly', record: false, run: ({ state }) => state().openPropertyPanel({ type: 'exploded_view' }) },
  {
    id: 'assembly.explode', label: 'Explode assembly', category: 'Assembly', record: false,
    description: 'args: { distance? (mm, default 40), leaderLines? (default true) } — display only, positions are kept',
    run: ({ state }, args: { distance?: number; leaderLines?: boolean } | undefined) => {
      const distance = args?.distance ?? 40;
      if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0 || distance > 1000) {
        throw new CommandError('INVALID_ARGUMENT', 'distance must be a number of mm above 0 and at most 1000');
      }
      if (state().assemblyComponents.length < 2) throw new CommandError('NOT_AVAILABLE', 'Insert at least two components to explode');
      state().setExplodedView({ distance, leaderLines: args?.leaderLines ?? true });
    },
  },
  { id: 'assembly.collapse', label: 'Collapse exploded view', category: 'Assembly', record: false, run: ({ state }) => state().setExplodedView(null) },
  {
    id: 'assembly.bom', label: 'Bill of materials (data)', category: 'Assembly', record: false,
    description: 'Returns { rows: [{ item, partNumber, description, quantity, material, unitVolume (mm³), unitMass, totalMass (kg), componentIds }], totalQuantity, totalMass, material }',
    run: ({ state }) => buildBom(state().assemblyComponents, state().activeMaterial),
  },
  {
    id: 'assembly.setMaterial', label: 'Component material', category: 'Assembly',
    description: "args: { components: string[] (component ids), material: key such as 'Brass_C36000', or null for the part material }",
    run: ({ state }, args: { components?: string[]; material?: string | null }) => {
      const ids = args?.components;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) throw new CommandError('INVALID_ARGUMENT', 'components must be a list of component ids');
      const known = new Set(state().assemblyComponents.map(c => c.id));
      const missing = ids.filter(id => !known.has(id));
      if (missing.length) throw new CommandError('INVALID_ARGUMENT', `No component with id ${missing.map(m => JSON.stringify(m)).join(', ')}`);
      const material = args.material ?? null;
      if (material !== null && !(material in MATERIALS)) throw new CommandError('INVALID_ARGUMENT', `Unknown material ${JSON.stringify(material)}; one of ${Object.keys(MATERIALS).join(', ')}`);
      state().setComponentMaterial(ids, material);
    },
  },
  {
    id: 'equations.set', label: 'Set global variables', category: 'Tools',
    description: "args: { variables: [{ name, expression }] } — replaces them all; e.g. [{ name: 'wall', expression: '3' }, { name: 'depth', expression: 'wall * 8' }]",
    run: ({ state }, args: { variables?: GlobalVariable[] }) => {
      const vars = args?.variables;
      if (!Array.isArray(vars) || !vars.every(v => v && typeof v.name === 'string' && typeof v.expression === 'string')) {
        throw new CommandError('INVALID_ARGUMENT', 'variables must be a list of { name, expression }');
      }
      const { values, errors } = evaluateVariables(vars);
      const bad = Object.entries(errors);
      if (bad.length) throw new CommandError('INVALID_ARGUMENT', bad.map(([n, m]) => `${n}: ${m}`).join('; '));
      const configProblems = configurationProblems(vars, state().configurations).filter(p => !/no variable/.test(p));
      if (configProblems.length) throw new CommandError('INVALID_ARGUMENT', `With these variables a configuration fails: ${configProblems.join('; ')}`);
      state().setVariables(vars);
      return values;
    },
  },
  {
    id: 'equations.list', label: 'List equations', category: 'Tools', record: false,
    description: 'Returns { variables: [{ name, expression, value, error? }], links: [{ featureId, featureName, parameter, expression, value, error? }] }',
    run: ({ state }) => {
      const active = activeVariables(state());
      const { values, errors } = evaluateVariables(active);
      return {
        configuration: state().activeConfiguration,
        variables: state().variables.map((v, i) => ({ ...v, ...(active[i].expression !== v.expression ? { override: active[i].expression } : {}), value: values[v.name] ?? null, ...(errors[v.name] ? { error: errors[v.name] } : {}) })),
        links: [...evaluateLinks(state().features, values).links, ...dimensionLinks(state().features, state().sketchConstraints, values)],
      };
    },
  },
  {
    id: 'configurations.set', label: 'Set configurations', category: 'Tools',
    description: "args: { configurations: [{ name, values: { variable: expression } }] } — replaces them all; e.g. [{ name: 'Large', values: { wall: '6' } }]",
    run: ({ state }, args: { configurations?: Configuration[] }) => {
      const list = args?.configurations;
      if (!Array.isArray(list) || !list.every(c => c && typeof c.name === 'string' && c.values && typeof c.values === 'object' && Object.values(c.values).every(v => typeof v === 'string'))) {
        throw new CommandError('INVALID_ARGUMENT', 'configurations must be a list of { name, values: { variable: expression } }');
      }
      const problems = configurationProblems(state().variables, list);
      if (problems.length) throw new CommandError('INVALID_ARGUMENT', problems.join('; '));
      state().setConfigurations(list);
    },
  },
  {
    id: 'configurations.activate', label: 'Activate configuration', category: 'Tools',
    description: 'args: { name } — a configuration name, or null / "Default" for the plain variable values',
    run: ({ state }, args: { name?: string | null } | undefined) => {
      const raw = args?.name ?? null;
      const name = raw === null || raw === 'Default' ? null : raw;
      if (name !== null && !state().configurations.some(c => c.name === name)) {
        throw new CommandError('INVALID_ARGUMENT', `No configuration "${name}"; one of Default, ${state().configurations.map(c => c.name).join(', ') || '(none defined)'}`);
      }
      state().activateConfiguration(name);
      return { configuration: name ?? 'Default' };
    },
  },
  {
    id: 'configurations.list', label: 'List configurations', category: 'Tools', record: false,
    description: 'Returns { active, configurations: [{ name, values, variables: { name: value } }] } (Default first)',
    run: ({ state }) => {
      const s = state();
      const evaluate = (c: Configuration | null) => evaluateVariables(effectiveVariables(s.variables, c)).values;
      return {
        active: s.activeConfiguration ?? 'Default',
        configurations: [
          { name: 'Default', values: {}, variables: evaluate(null) },
          ...s.configurations.map(c => ({ name: c.name, values: { ...c.values }, variables: evaluate(c) })),
        ],
      };
    },
  },
  { id: 'tools.configurations', label: 'Configurations…', category: 'Tools', requiresUI: true, record: false, run: ({ ui }) => ui().openDialog('configurations') },
  { id: 'tools.equations', label: 'Equations…', category: 'Tools', requiresUI: true, record: false, run: ({ ui }) => ui().openDialog('equations') },
  { id: 'assembly.billOfMaterials', label: 'Bill of materials…', category: 'Assembly', requiresUI: true, record: false, run: ({ ui }) => ui().openDialog('bom') },
  {
    id: 'assembly.exportBom', label: 'Export bill of materials (CSV)', category: 'Assembly', requiresUI: true, record: false,
    run: ({ state }) => {
      const s = state();
      if (s.assemblyComponents.length === 0) throw new CommandError('NOT_AVAILABLE', 'Insert components first: the assembly is empty');
      const filename = `${(s.documentName || 'Assembly').replace(/\s+/g, '_')}_BOM.csv`;
      downloadBlob(bomCSV(buildBom(s.assemblyComponents, s.activeMaterial)), filename, 'text/csv;charset=utf-8');
      s.setStatus(`Bill of materials exported: ${filename}`);
      return { filename };
    },
  },
  {
    id: 'assembly.interference', label: 'Interference detection', category: 'Assembly', record: false,
    description: 'Checks every pair of components for overlap at their assembled positions; shows the overlaps in red. Returns { pairs: [{ a, b, aName, bName, volume (mm³) }] }',
    run: ({ state }) => {
      const comps = state().assemblyComponents;
      if (comps.length < 2) throw new CommandError('NOT_AVAILABLE', 'Insert at least two components to check');
      const found = findInterferences(comps);
      state().setInterference(found);
      const total = found.reduce((v, f) => v + f.volume, 0);
      state().setStatus(found.length === 0
        ? `No interference between ${comps.length} components`
        : `${found.length} interference${found.length === 1 ? '' : 's'}, ${total.toFixed(1)} mm³ in all`);
      return { pairs: found.map(f => ({ a: f.a, b: f.b, aName: f.aName, bName: f.bName, volume: f.volume })) };
    },
  },
  { id: 'assembly.clearInterference', label: 'Hide interference', category: 'Assembly', record: false, run: ({ state }) => state().setInterference(null) },
  { id: 'assembly.clear', label: 'Clear assembly', category: 'Assembly', run: ({ state }) => state().clearAssembly() },
] as Array<Def<never>>;

/** A registry with every built-in command, over the given store. */
export function createCommandRegistry(store: Store): CommandRegistry<CADStore> {
  const registry = new CommandRegistry<CADStore>(() => store.getState());
  for (const def of BUILTIN_COMMANDS) registry.register(def);
  return registry;
}
