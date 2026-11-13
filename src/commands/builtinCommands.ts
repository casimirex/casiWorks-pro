// CasiWorks Pro - Built-in commands: everything the ribbon, status bar and keyboard do
import { CommandError, CommandRegistry } from './CommandRegistry.ts';
import type { CommandDefinition } from './CommandRegistry.ts';
import type { CADStore, PrimitiveDims, PrimitiveShape } from '../store/cadStore.ts';
import { FEATURE_TYPES, TOOLS } from '../utils/constants.ts';
import type { MateType, ToolId, ViewOrientation } from '../utils/constants.ts';
import type { SketchPlane } from '../types/cad.ts';
import { CAD_EXAMPLES } from '../utils/examples.ts';
import { downloadProject, newProject, openProject } from '../utils/projectFile.ts';

type Def<A = void> = CommandDefinition<CADStore, A>;
type Store = { getState(): CADStore };

const PLANES: SketchPlane[] = ['Front', 'Top', 'Right'];

/** Open the property panel for a feature tool (the panel creates the feature on OK). */
const featureTool = (id: string, label: string, tool: ToolId, type: string, shortcuts?: string[]): Def => ({
  id, label, category: 'Features', shortcuts,
  run: ({ state }) => {
    state().setActiveTool(tool);
    state().openPropertyPanel({ type });
  },
});

const sketchTool = (id: string, label: string, tool: ToolId, shortcuts?: string[]): Def => ({
  id, label, category: 'Sketch', shortcuts,
  run: ({ state }) => state().setActiveTool(tool),
});

const view = (orientation: ViewOrientation, label: string, shortcuts: string[]): Def => ({
  id: `view.${orientation}`, label, category: 'View', shortcuts,
  run: ({ state }) => state().setViewOrientation(orientation),
});

const toggle = (id: string, label: string, action: (s: CADStore) => void): Def => ({
  id, label, category: 'View', run: ({ state }) => action(state()),
});

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
  { id: 'edit.cancel', label: 'Cancel tool', category: 'Edit', shortcuts: ['Escape'], run: ({ state }) => state().cancelTool() },
  { id: 'model.rebuild', label: 'Rebuild', category: 'Model', shortcuts: ['F5'], run: ({ state }) => state().rebuild() },
  { id: 'model.material', label: 'Material…', category: 'Model', requiresUI: true, run: ({ ui }) => ui().openDialog('material') },

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
  },
  { id: 'sketch.exit', label: 'Confirm sketch', category: 'Sketch', run: ({ state }) => state().endSketch(true) },
  { id: 'sketch.discard', label: 'Discard sketch', category: 'Sketch', run: ({ state }) => state().endSketch(false) },
  sketchTool('sketch.line', 'Line', TOOLS.SKETCH_LINE, ['L']),
  sketchTool('sketch.rectangle', 'Corner rectangle', TOOLS.SKETCH_RECT, ['R']),
  sketchTool('sketch.circle', 'Center circle', TOOLS.SKETCH_CIRCLE, ['C']),
  sketchTool('sketch.point', 'Point', TOOLS.SKETCH_POINT),
  sketchTool('sketch.dimension', 'Smart dimension', TOOLS.SKETCH_DIMENSION, ['D']),
  { id: 'sketch.toggleConstruction', label: 'Construction geometry', category: 'Sketch', run: ({ state }) => state().toggleConstructionMode() },

  // ------------------------------------------------------------------ view
  view('front', 'Front view', ['Ctrl+1']),
  view('back', 'Back view', ['Ctrl+2']),
  view('left', 'Left view', ['Ctrl+3']),
  view('right', 'Right view', ['Ctrl+4']),
  view('top', 'Top view', ['Ctrl+5']),
  view('bottom', 'Bottom view', ['Ctrl+6']),
  view('isometric', 'Isometric view', ['Ctrl+7', 'Space']),
  toggle('view.toggleGrid', 'Grid', s => s.toggleGrid()),
  toggle('view.toggleEdges', 'Edges', s => s.toggleEdges()),
  toggle('view.toggleWireframe', 'Wireframe', s => s.toggleWireframe()),
  toggle('view.togglePerspective', 'Perspective / orthographic', s => s.togglePerspective()),
  toggle('view.toggleSection', 'Section view', s => s.toggleSectionView()),
  { id: 'view.toggleFeatureTree', label: 'Feature tree', category: 'View', requiresUI: true, run: ({ ui }) => ui().toggleFeatureTree() },

  // ------------------------------------------------------------------ evaluate & drawing
  { id: 'evaluate.massProperties', label: 'Mass properties…', category: 'Evaluate', requiresUI: true, run: ({ ui }) => ui().openDialog('massProperties') },
  { id: 'drawing.open', label: '2D drawing sheet…', category: 'Drawing', requiresUI: true, description: 'Standard 3-view sheet with SVG / DXF export', run: ({ ui }) => ui().openDialog('drawing') },
  {
    id: 'drawing.view', label: 'Drawing view', category: 'Drawing',
    description: "args: { viewType: 'standard_3_view' | 'projected' | 'section' | 'isometric' }",
    run: ({ state }, args: { viewType?: string } | undefined) => state().openPropertyPanel({ type: 'drawing_view', viewType: args?.viewType ?? 'standard_3_view' }),
  },
  { id: 'drawing.dimension', label: 'Drawing dimension', category: 'Drawing', run: ({ state }) => state().openPropertyPanel({ type: 'drawing_dimension', dimType: 'smart' }) },
  {
    id: 'drawing.gdt', label: 'GD&T symbol', category: 'Drawing', description: "args: { gdtType: 'fcf' | 'datum' }",
    run: ({ state }, args: { gdtType?: string } | undefined) => state().openPropertyPanel({ type: 'drawing_gdt', gdtType: args?.gdtType ?? 'fcf' }),
  },

  // ------------------------------------------------------------------ assembly
  {
    id: 'assembly.insertPart', label: 'Insert component', category: 'Assembly',
    description: "args: { name, shape: 'box' | 'cylinder' | 'flange' | 'pin', dims? }",
    run: ({ state }, args: { name: string; shape: PrimitiveShape; dims?: PrimitiveDims }) => {
      if (!args?.name || !args.shape) throw new CommandError('INVALID_ARGUMENT', 'name and shape are required');
      state().insertAssemblyPart(args.name, args.shape, args.dims);
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
  { id: 'assembly.explodedView', label: 'Exploded view', category: 'Assembly', run: ({ state }) => state().openPropertyPanel({ type: 'exploded_view' }) },
  { id: 'assembly.clear', label: 'Clear assembly', category: 'Assembly', run: ({ state }) => state().clearAssembly() },
] as Array<Def<never>>;

/** A registry with every built-in command, over the given store. */
export function createCommandRegistry(store: Store): CommandRegistry<CADStore> {
  const registry = new CommandRegistry<CADStore>(() => store.getState());
  for (const def of BUILTIN_COMMANDS) registry.register(def);
  return registry;
}
