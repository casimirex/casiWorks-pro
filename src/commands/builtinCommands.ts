// CasiWorks Pro - Built-in commands: everything the ribbon, status bar and keyboard do
import { CommandError, CommandRegistry } from './CommandRegistry.ts';
import type { CommandDefinition, MacroStep } from './CommandRegistry.ts';
import type { CADStore, DrawingOptions, PrimitiveDims, PrimitiveShape } from '../store/cadStore.ts';
import { drawingFile } from '../drawings/drawingSheet.ts';
import type { DrawingFormat } from '../drawings/drawingSheet.ts';
import { downloadBlob } from '../utils/download.ts';
import { FEATURE_TYPES, MATERIALS, TOOLS } from '../utils/constants.ts';
import type { MateType, ToolId, ViewOrientation } from '../utils/constants.ts';
import type { FeatureData, SketchEntity, SketchPlane } from '../types/cad.ts';
import { generateId } from '../utils/math.ts';
import { CAD_EXAMPLES } from '../utils/examples.ts';
import { downloadProject, newProject, openProject } from '../utils/projectFile.ts';

const DRAWING_SHEET_SIZES = ['A4_LANDSCAPE', 'A4_PORTRAIT', 'A3_LANDSCAPE', 'ANSI_B'] as const;

type Def<A = void> = CommandDefinition<CADStore, A>;
type Store = { getState(): CADStore };

const PLANES: SketchPlane[] = ['Front', 'Top', 'Right'];

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

/** Default references the ribbon mate buttons use (first two components). */
const MATE_DEFAULTS: Record<MateType, { ref1: string; ref2: string; offset: number; swap?: boolean }> = {
  coincident: { ref1: 'top', ref2: 'bottom', offset: 0 },
  distance: { ref1: 'top', ref2: 'bottom', offset: 15 },
  // three.js cylinders (pin, flange, rod) have their axis along Y
  concentric: { ref1: 'y', ref2: 'y', offset: 0 },
  parallel: { ref1: 'top', ref2: 'top', offset: 0 },
  perpendicular: { ref1: 'top', ref2: 'front', offset: 0 },
  // Second component's cylinder axis (Y) tangent to the first component's top face
  tangent: { ref1: 'y', ref2: 'top', offset: 0, swap: true },
  // Centre the second component between the first component's left and right faces
  width: { ref1: 'left', ref2: 'left', offset: 0 },
  // Keep the second component on the first component's top centre line
  path: { ref1: 'top', ref2: 'top', offset: 0 },
} as Record<MateType, { ref1: string; ref2: string; offset: number; swap?: boolean }>;

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
    description: "args: { plane: 'Front' | 'Top' | 'Right' } (default Front)",
    run: ({ state }, args: { plane?: SketchPlane } | undefined) => {
      const plane = args?.plane ?? 'Front';
      if (!PLANES.includes(plane)) throw new CommandError('INVALID_ARGUMENT', `plane must be one of ${PLANES.join(', ')}`);
      if (state().isSketchActive) throw new CommandError('NOT_AVAILABLE', 'Finish the current sketch first');
      state().startSketch(plane);
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
      const plane = feature?.type === FEATURE_TYPES.SKETCH ? feature.plane : 'Front';
      return { command: 'sketch.create', args: { plane, name: feature?.name, entities }, returns: { sketchId: r.sketchId, featureId: r.featureId } };
    },
  },
  { id: 'sketch.discard', label: 'Discard sketch', category: 'Sketch', record: false, run: ({ state }) => state().endSketch(false) },
  {
    id: 'sketch.create', label: 'Create sketch', category: 'Sketch',
    description: "args: { plane?, name?, entities } in the store's entity format; returns { sketchId, featureId }",
    run: ({ state }, args: { plane?: SketchPlane; name?: string; entities: SketchEntity[] }) => {
      const plane = args?.plane ?? 'Front';
      if (!PLANES.includes(plane)) throw new CommandError('INVALID_ARGUMENT', `plane must be one of ${PLANES.join(', ')}`);
      const entities = requireEntities(args?.entities);
      const sketchId = generateId('sketch');
      const featureId = generateId('feat_sketch');
      state().createSketchFeature({ id: featureId, sketchId, plane, name: args.name, entities: JSON.parse(JSON.stringify(entities)) });
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
  { id: 'evaluate.massProperties', label: 'Mass properties…', category: 'Evaluate', requiresUI: true, run: ({ ui }) => ui().openDialog('massProperties') },
  { id: 'drawing.open', label: '2D drawing sheet…', category: 'Drawing', requiresUI: true, description: 'Standard 3-view sheet with SVG / DXF export', run: ({ ui }) => ui().openDialog('drawing') },
  {
    id: 'drawing.options', label: 'Drawing sheet options', category: 'Drawing', record: false,
    description: "args: { sheetSize?: 'A4_LANDSCAPE' | 'A4_PORTRAIT' | 'A3_LANDSCAPE' | 'ANSI_B', hiddenLines?, dimensions?, gdt? } — only the given ones change",
    run: ({ state }, args: Partial<DrawingOptions> | undefined) => {
      const next: Partial<DrawingOptions> = {};
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
    id: 'drawing.export', label: 'Export drawing (SVG / DXF)', category: 'Drawing', requiresUI: true, record: false,
    description: "args: { format: 'svg' | 'dxf' } — downloads the sheet with the current drawing options",
    run: ({ state }, args: { format?: DrawingFormat } | undefined) => {
      const format = args?.format ?? 'svg';
      if (format !== 'svg' && format !== 'dxf') throw new CommandError('INVALID_ARGUMENT', "format must be 'svg' or 'dxf'");
      const file = drawingFile(state(), format);
      if (!file) throw new CommandError('NOT_AVAILABLE', 'Create a solid body first: the drawing is made from it');
      downloadBlob(file.text, file.filename, file.mimeType);
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
  { id: 'assembly.clear', label: 'Clear assembly', category: 'Assembly', run: ({ state }) => state().clearAssembly() },
] as Array<Def<never>>;

/** A registry with every built-in command, over the given store. */
export function createCommandRegistry(store: Store): CommandRegistry<CADStore> {
  const registry = new CommandRegistry<CADStore>(() => store.getState());
  for (const def of BUILTIN_COMMANDS) registry.register(def);
  return registry;
}
