// CasiWorks Pro - Public API v1
//
// The supported way for scripts, macros, add-ins and tests to drive the
// modeler. Everything here goes through the same store actions the UI uses,
// so API edits appear in the feature tree and are undoable.
//
// Contract:
//  - Inputs are validated; invalid calls throw CasiWorksAPIError with a stable `code`.
//  - Return values are plain JSON-safe data (never internal or three.js objects),
//    so callers cannot corrupt application state by mutating them.
//  - Queries (model.*) rebuild first if the feature tree changed, so results are
//    always current, with or without the UI running.
//  - Units: millimetres, degrees, kilograms, kg/m³.

import type { CommandExecution, CommandInfo } from '../commands/CommandRegistry.ts';
import type { Macro } from '../commands/macros.ts';
import { macroToScript, parseMacro } from '../commands/macros.ts';
import type { BufferGeometry } from 'three';
import { configurationProblems, effectiveVariables, evaluateExpression, evaluateLinks, evaluateVariables } from '../features/equations.ts';
import type { Configuration, GlobalVariable, LinkedParameter } from '../features/equations.ts';
import { extendLine, mirrorEntities, offsetEntity, trimEntity } from '../kernel/sketchEdit.ts';
import type { EditResult } from '../kernel/sketchEdit.ts';
import { buildBom } from '../assembly/bom.ts';
import type { Bom, BomComponent } from '../assembly/bom.ts';
import { MATE_DEFAULTS } from '../assembly/mateDefaults.ts';
import { drawingFile } from '../drawings/drawingSheet.ts';
import type { DrawingSource } from '../drawings/drawingSheet.ts';
import type { DrawingComponent } from '../drawings/assemblyDrawing.ts';
import { MATERIALS, MATE_TYPES } from '../utils/constants.ts';
import { measure as measurePicks } from '../kernel/measure.ts';
import { solveSketch } from '../kernel/sketchSolve.ts';
import { CLEARANCE_FITS, METRIC_SIZES, standardHole } from '../features/holeStandards.ts';
import type { ClearanceFit, HoleKind, MetricSize } from '../features/holeStandards.ts';
import type { Measurement } from '../kernel/measure.ts';
import type { MateType } from '../utils/constants.ts';
import { FEATURE_TYPES, SKETCH_ENTITY_TYPES } from '../utils/constants.ts';
import type { FeatureType } from '../utils/constants.ts';
import { generateId } from '../utils/math.ts';
import { materialLibrary } from '../kernel/MaterialLibrary.ts';
import { geometryEngine } from '../kernel/GeometryEngine.ts';
import { rebuildModel } from '../features/rebuildModel.ts';
import type { RebuildResult, RebuildState } from '../features/rebuildModel.ts';
import type {
  BoundingBox,
  ExtrudeEndCondition,
  Feature,
  FeatureData,
  MassProperties,
  Point2,
  RebuildError,
  SketchEntity,
  SketchPlane,
  PlaneFrame,
} from '../types/cad.ts';

export const API_VERSION = '1.11.0';

// =====================================================================
// Public types
// =====================================================================

export type CasiWorksAPIErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'INVALID_DOCUMENT' | 'OPERATION_FAILED';

/** Sketch entities accepted by the API. Angles are in degrees. */
export type ApiSketchEntity =
  | { type: 'line'; p1: Point2; p2: Point2; construction?: boolean }
  | { type: 'circle'; center: Point2; radius: number; construction?: boolean }
  | { type: 'arc'; center: Point2; radius: number; startAngle: number; endAngle: number; construction?: boolean }
  | { type: 'rectangle'; corner1: Point2; corner2: Point2; construction?: boolean };

export interface SketchSpec {
  /**
   * Default 'Front'. Since 1.9 also the id of a reference plane (the sketch follows
   * it) or any plane frame { origin, xAxis, normal }, e.g. the face of a part.
   */
  plane?: SketchPlane | string | PlaneFrame;
  entities: ApiSketchEntity[];
  name?: string;
}

export interface SketchRef {
  featureId: string;
  sketchId: string;
}

export interface ExtrudeSpec {
  sketchId: string;
  /** mm, > 0 */
  depth: number;
  /** Default 'blind'. */
  endCondition?: ExtrudeEndCondition;
  /** true removes material. */
  cut?: boolean;
  flip?: boolean;
  name?: string;
}

export interface RevolveSpec {
  sketchId: string;
  /** Degrees, 0 < angle ≤ 360. Default 360. */
  angle?: number;
  cut?: boolean;
  name?: string;
  /**
   * Axis of revolution (since 1.10): 'y' (the sketch's vertical axis, default), 'x',
   * { line: entityId } for a line of the sketch, or { axis: featureId } for a reference
   * axis lying in the sketch plane.
   */
  axis?: 'x' | 'y' | { line: string } | { axis: string };
}

export interface FilletSpec { radius: number; name?: string }
export interface ChamferSpec { distance: number; name?: string }
export interface ShellSpec { thickness: number; name?: string }

/** A hole from the Hole Wizard. Give `standard` for ISO metric sizes, or `diameter` (and the counterbore / countersink sizes) for custom ones. */
export interface HoleSpec {
  /** Entry point on the part (mm). */
  position: { x: number; y: number; z: number };
  /** Drilling direction; default +Z. */
  axis?: { x: number; y: number; z: number };
  /** mm, > 0 */
  depth: number;
  /** Default 'simple'. A tapped hole is drilled at the tap drill size; the thread is not modelled. */
  type?: HoleKind;
  /** ISO metric size and, for clearance holes, the fit (default 'normal'). */
  standard?: { size: MetricSize; fit?: ClearanceFit };
  /** Custom sizes (ignored with a standard). */
  diameter?: number;
  cbDiameter?: number;
  cbDepth?: number;
  csDiameter?: number;
  csAngle?: number;
  name?: string;
}

/** Parameters that may be changed with features.update(). */
export type FeatureChanges = Record<string, number | string | boolean>;

export interface FeatureInfo {
  id: string;
  name: string;
  type: FeatureType;
  /** Position in the feature tree. */
  index: number;
  sketchId: string | null;
  suppressed: boolean;
  parentIds: string[];
  childIds: string[];
  /** Type-specific parameters (depth, angle, radius, …). */
  parameters: Record<string, unknown>;
}

export type { RebuildResult };

export interface MaterialInfo {
  key: string;
  name: string;
  /** kg/m³ */
  density: number;
  /** Pa */
  youngsModulus: number;
  poissonsRatio: number;
  /** Pa */
  yieldStrength: number;
}

/** The open part document: create, name, save to and load from JSON. */
export interface DocumentAPI {
  /** Start a new, empty part. Discards the current document without prompting. */
  'new'(): void;
  /** The document name shown in the title bar. */
  getName(): string;
  /** Rename the document (not undoable). Throws INVALID_ARGUMENT for an empty name. */
  setName(name: string): void;
  /** true when there are unsaved changes. */
  isModified(): boolean;
  /** Serialize to the .casiproj JSON format. */
  toJSON(): string;
  /** Replace the current document with .casiproj JSON text or a parsed object. Throws INVALID_DOCUMENT. */
  load(project: string | object): void;
}

/** 2D sketches on the Front, Top or Right plane; features are built from them. */
export interface SketchesAPI {
  /**
   * Create a sketch on a standard plane.
   * @example api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] })
   */
  create(spec: SketchSpec): SketchRef;
  /** A copy of the sketch's entities (internal format: arc angles in radians). */
  getEntities(sketchId: string): SketchEntity[];
  /**
   * Trim entity `entityId` at point `at`: the part between the nearest crossings
   * around it is removed (an entity that crosses nothing is deleted; a circle needs
   * two crossings and becomes an arc). Returns the sketch's new entities. Since 1.5.
   */
  trim(sketchId: string, entityId: string, at: Point2): SketchEntity[];
  /** Lengthen the end of line `entityId` nearest `near` to the first entity in its way. Since 1.5. */
  extend(sketchId: string, entityId: string, near: Point2): SketchEntity[];
  /**
   * Offset `entityId` by `distance` mm towards `side`. Lines and arcs offset their
   * whole connected chain (a rectangle, a slot) with the corners re-joined. Since 1.5.
   */
  offset(sketchId: string, entityId: string, distance: number, side: Point2): SketchEntity[];
  /** Add mirrored copies of `entityIds` about the line `axisId`. Since 1.5. */
  mirror(sketchId: string, axisId: string, entityIds: string[]): SketchEntity[];
  /**
   * Add a relation or driving dimension and solve the sketch; returns its id. Since 1.11.
   * Relations: horizontal, vertical, parallel, perpendicular, equal, coincident, concentric,
   * tangent, fix. Dimensions: { type: 'dimension', entity1Id, entity2Id?, point1?, point2?, value }
   * (a line's length, a circle's or arc's radius, or the distance between points / lines).
   * Throws OPERATION_FAILED when it cannot be met or is already implied; nothing changes then.
   * @example api.sketches.constrain(s.sketchId, { type: 'dimension', entity1Id: lineId, value: 60 })
   */
  constrain(sketchId: string, constraint: Record<string, unknown>): string;
  /** The sketch's relations and dimensions. Since 1.11. */
  constraints(sketchId: string): Array<Record<string, unknown>>;
  /** Change a dimension (mm) and solve again. Since 1.11. */
  setDimension(sketchId: string, constraintId: string, value: number): void;
  /** Delete a relation or dimension. Since 1.11. */
  removeConstraint(sketchId: string, constraintId: string): void;
  /** How defined the sketch is: 'fully' | 'under' | 'over', with degrees of freedom. Since 1.11. */
  status(sketchId: string): { state: string; dof: number; message: string };
}

/** The feature tree: create, inspect, edit, suppress and roll back features. */
export interface FeaturesAPI {
  /** Every feature in tree order (sketches included). */
  list(): FeatureInfo[];
  /** Throws NOT_FOUND. */
  get(id: string): FeatureInfo;
  /** Extrude a sketch as a boss or cut. Returns the new feature id. */
  extrude(spec: ExtrudeSpec): string;
  /** Revolve a sketch. Returns the new feature id. */
  revolve(spec: RevolveSpec): string;
  /**
   * Add a fillet feature. Not applied: the mesh kernel cannot round edges, so the
   * rebuild reports a warning and the model is unchanged.
   */
  fillet(spec: FilletSpec): string;
  /** Add a chamfer feature. Not applied (see fillet). */
  chamfer(spec: ChamferSpec): string;
  /** Add a shell feature. Not applied: the mesh kernel cannot hollow a solid (see fillet). */
  shell(spec: ShellSpec): string;
  /**
   * Add a hole (Hole Wizard). Returns the new feature id. Since 1.8.
   * @example api.features.hole({ position: { x: 0, y: 0, z: 10 }, axis: { x: 0, y: 0, z: -1 }, depth: 10, type: 'counterbore', standard: { size: 'M8' } })
   */
  hole(spec: HoleSpec): string;
  /**
   * Add a reference plane: a standard plane moved `offset` mm along its normal and
   * tilted `angle`° about its X axis. Sketch on it with sketches.create({ plane: id }). Since 1.9.
   */
  referencePlane(spec: { base?: SketchPlane; offset?: number; angle?: number; name?: string }): string;
  /** Add a reference axis parallel to model X, Y or Z through `point` (or the reference point `through`). Since 1.10. */
  referenceAxis(spec: { direction: 'X' | 'Y' | 'Z'; point?: { x: number; y: number; z: number }; through?: string; name?: string }): string;
  /** Add a reference point. Since 1.10. */
  referencePoint(spec: { x: number; y: number; z: number; name?: string }): string;
  /** Change parameters (e.g. { depth: 40 }); id, type, sketchId and dependency links cannot change. */
  update(id: string, changes: FeatureChanges): void;
  /** Delete a feature; features that depend on it lose their parent. Throws NOT_FOUND. */
  remove(id: string): void;
  /** Suppression cascades to dependent features. */
  setSuppressed(id: string, suppressed: boolean): void;
  /** Evaluate features 0..index only; null rolls forward to the end. */
  rollbackTo(index: number | null): void;
}

/** The solid built from the feature tree: rebuild it and measure it. Queries rebuild first when needed. */
export interface ModelAPI {
  /** Rebuild now and report the result (normally automatic after every change). */
  rebuild(): RebuildResult;
  /** Errors from the last rebuild. */
  errors(): RebuildError[];
  /** true when the features produce a solid. */
  hasBody(): boolean;
  /** Mass properties with the active material; null when there is no body. */
  massProperties(): MassProperties | null;
  /** Axis-aligned bounds in mm; null when there is no body. */
  boundingBox(): BoundingBox | null;
  /**
   * Distance between two points (mm) with its x/y/z parts. Give the face normals
   * too and it adds the angle between the faces and, for parallel faces, the gap
   * between them (as the Measure tool does). Since 1.6.
   * @example api.model.measure({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 12 }, { normalA: { x: 0, y: 0, z: -1 }, normalB: { x: 0, y: 0, z: 1 } }).gap // 12
   */
  measure(a: Point3D, b: Point3D, options?: { normalA?: Point3D; normalB?: Point3D }): Measurement;
}

/** A point or direction in model space (mm). */
export interface Point3D { x: number; y: number; z: number }

/** The material library and the part's material (used for mass and FEA). */
export interface MaterialsAPI {
  /** Every material with its physical properties. */
  list(): MaterialInfo[];
  /** Key of the part's material, e.g. 'Steel_1020'. */
  getActive(): string;
  /** Throws NOT_FOUND for an unknown key. */
  setActive(key: string): void;
}

/** Undo and redo of document changes (the same history as the toolbar). */
export interface HistoryAPI {
  /** true when there is a change to undo. */
  canUndo(): boolean;
  /** true when there is an undone change to redo. */
  canRedo(): boolean;
  /** false when there was nothing to undo. */
  undo(): boolean;
  /** false when there was nothing to redo. */
  redo(): boolean;
}

export interface ApiUnits {
  readonly system: 'MMGS';
  readonly length: 'mm';
  readonly angle: 'deg';
  readonly mass: 'kg';
  readonly density: 'kg/m^3';
}

/** A command as listed by `api.commands.list()`. */
export type { CommandInfo };

/**
 * Named commands: everything the ribbon, status bar and keyboard do
 * (`file.save`, `feature.extrudeCut`, `sketch.new` { plane }, `view.top`…).
 * Commands that open dialogs or files need the running app.
 */
export interface CommandsAPI {
  /** Every command: id, label, category, shortcuts, whether it needs the UI. */
  list(): CommandInfo[];
  /** true when a command with this id exists. */
  has(id: string): boolean;
  /** Run a command. Errors: NOT_FOUND (unknown id), INVALID_ARGUMENT, OPERATION_FAILED (incl. needs the UI). */
  execute(id: string, args?: unknown): unknown;
}

/** The part of a command registry the API uses. */
export interface ApiCommandRegistry {
  list(): CommandInfo[];
  has(id: string): boolean;
  execute(id: string, args?: unknown): unknown;
  onExecute?(listener: (execution: CommandExecution) => void): () => void;
}

/** Events and their payloads (all plain data). Since 1.2. */
export interface CasiWorksEventMap {
  /** A rebuild finished (after every model change). */
  rebuild: { ok: boolean; bodyCount: number; errors: RebuildError[] };
  featureAdded: { feature: FeatureInfo };
  featureRemoved: { id: string; name: string };
  /** Parameters, name, suppression or dependency links changed. */
  featureChanged: { feature: FeatureInfo };
  selectionChanged: { ids: string[] };
  /** The whole document was replaced (new, open, example); no feature events are sent for it. */
  documentChanged: { name: string; featureCount: number };
  /** A command ran (ribbon, keyboard, script). */
  commandExecuted: CommandExecution;
}
export type CasiWorksEventName = keyof CasiWorksEventMap;
export type CasiWorksEventHandler<K extends CasiWorksEventName> = (event: CasiWorksEventMap[K]) => void;
export type { CommandExecution };

/**
 * Macros: record the model-changing commands run from the UI or scripts,
 * replay them, or turn them into a script. Since 1.3.
 */
export interface MacrosAPI {
  /** Start recording (OPERATION_FAILED if already recording or unavailable). */
  startRecording(name?: string): void;
  /** Stop recording and return the macro (plain JSON data). */
  stopRecording(): Macro;
  /** true while a recording is in progress (from the UI or the API). */
  isRecording(): boolean;
  /** Replay a macro object or its JSON text; ids it creates are mapped to new ones. */
  run(macro: Macro | string): { steps: number; ids: Record<string, string> };
  /** The macro as a JavaScript module that replays it through this API. */
  toScript(macro: Macro | string): string;
}
export type { Macro };

/** The part of a macro recorder the API uses. */
export interface ApiMacroRecorder {
  readonly isRecording: boolean;
  start(name?: string): void;
  stop(): Macro;
  run(macro: unknown): { steps: number; ids: Record<string, string> };
}

/** A loaded plugin (add-in). */
export interface ApiPluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** URL, file name or 'code'. */
  source: string;
  /** Ids of the commands it registered. */
  commands: string[];
}

/**
 * Plugins (add-ins): modules that add commands and Add-ins ribbon buttons
 * through this API. A plugin runs with the same rights as the app. Since 1.4.
 */
export interface PluginsAPI {
  /** Loaded plugins. */
  list(): ApiPluginInfo[];
  /**
   * Load a plugin from a module URL or a plugin object.
   * Errors: INVALID_ARGUMENT (not a valid plugin), OPERATION_FAILED (incompatible, conflict, failed to start).
   * @example await api.plugins.load('/plugins/washer.js')
   */
  load(source: string | object): Promise<ApiPluginInfo>;
  /** Unload a plugin: its commands, buttons and event listeners are removed. Throws NOT_FOUND. */
  unload(id: string): void;
}

/** The part of a plugin manager the API uses. */
export interface ApiPluginManager {
  list(): ApiPluginInfo[];
  load(plugin: unknown, source?: string): Promise<ApiPluginInfo>;
  loadFromUrl(url: string): Promise<ApiPluginInfo>;
  unload(id: string): void;
}

export interface CasiWorksAPIOptions {
  /** Registry behind `api.commands` (without one, the namespace is empty). */
  commands?: ApiCommandRegistry;
  /** Recorder behind `api.macros` (without one, recording is unavailable). */
  macros?: ApiMacroRecorder;
  /** Manager behind `api.plugins` (without one, plugins are unavailable). */
  plugins?: ApiPluginManager;
}

/** A global variable as given to equations.set. */
export interface VariableSpec { name: string; expression: string }

/** Variables with their values (as the active configuration sees them) and the feature sizes they drive. */
export interface EquationsInfo {
  /** Active configuration, or null for Default. */
  configuration: string | null;
  variables: Array<{ name: string; expression: string; override?: string; value: number | null; error?: string }>;
  links: LinkedParameter[];
}

/** Global variables and the feature sizes they drive (Tools ▸ Equations). Since 1.5. */
export interface EquationsAPI {
  /** Variables, values and links. */
  list(): EquationsInfo;
  /**
   * Replace all variables; returns their values. Throws INVALID_ARGUMENT naming each
   * problem (syntax, unknown name, cycle, duplicate or built-in name).
   * @example api.equations.set([{ name: 'wall', expression: '3' }, { name: 'depth', expression: 'wall * 8' }])
   */
  set(variables: VariableSpec[]): Record<string, number>;
  /** Evaluate an expression with the current variables, e.g. 'wall * 2 + 1'. */
  evaluate(expression: string): number;
  /**
   * Link a feature parameter to an expression (null unlinks and keeps the number).
   * Grouped parameters use a dot: 'position.x'.
   * @example api.equations.link(holeId, 'diameter', 'wall * 2')
   */
  link(featureId: string, parameter: string, expression: string | null): void;
}

/** A configuration as given to configurations.set: variable expressions that replace the defaults. */
export interface ConfigurationSpec { name: string; values: Record<string, string> }

/** One configuration with every variable's value in it. */
export interface ConfigurationInfo {
  name: string;
  values: Record<string, string>;
  variables: Record<string, number>;
  active: boolean;
}

/** Versions of the part from variable values (design table). "Default" is the plain variables. Since 1.5. */
export interface ConfigurationsAPI {
  /** Default first, then each configuration, with its variable values. */
  list(): ConfigurationInfo[];
  /** Name of the active configuration ('Default' when none). */
  active(): string;
  /** Replace all configurations. Throws INVALID_ARGUMENT for duplicates, "Default", unknown variables or failing values. */
  set(configurations: ConfigurationSpec[]): void;
  /** Switch configuration ('Default' or null for the plain values); linked sizes update. Throws NOT_FOUND. */
  activate(name: string | null): void;
}

/** Shapes the assembly can insert. */
export type ComponentShape = 'box' | 'cylinder' | 'flange' | 'pin';

/** An assembly component. */
export interface ComponentInfo {
  id: string;
  name: string;
  shape: ComponentShape;
  dimensions: { width?: number; height?: number; depth?: number; radius?: number };
  /** Own material key, or null when it follows the part material. */
  material: string | null;
  fixed: boolean;
  position: { x: number; y: number; z: number };
}

/** A mate between two components. */
export interface MateSpec {
  type: MateType;
  component1: string;
  component2: string;
  /** Face or axis references; default per mate type (e.g. concentric: 'y' / 'y'). */
  ref1?: string;
  ref2?: string;
  /** mm (distance mates). */
  offset?: number;
}

/** The assembly: components, mates, materials and the bill of materials. Since 1.5. */
export interface AssemblyAPI {
  /** Every component. */
  list(): ComponentInfo[];
  /**
   * Insert a component; returns its id. The first is fixed.
   * @example api.assembly.insert({ name: 'Pin_Shaft', shape: 'pin' })
   */
  insert(spec: { name: string; shape: ComponentShape; dimensions?: ComponentInfo['dimensions'] }): string;
  /** Add a mate between two components (then call solve). */
  mate(spec: MateSpec): void;
  /** Solve all mates; converged is false when they conflict. */
  solve(): { converged: boolean; message: string };
  /** Give components their own material key, or null to follow the part material. */
  setMaterial(componentIds: string[], material: string | null): void;
  /** The bill of materials (identical parts grouped, masses in kg, volumes in mm³). */
  bom(): Bom;
  /** Show the exploded view (display only). */
  explode(options?: { distance?: number; leaderLines?: boolean }): void;
  /** End the exploded view. */
  collapse(): void;
  /** Remove all components and mates. */
  clear(): void;
}

/** What the drawing sheet shows. */
export interface DrawingOptionsInfo {
  subject: 'part' | 'assembly';
  sheetSize: 'A4_LANDSCAPE' | 'A4_PORTRAIT' | 'A3_LANDSCAPE' | 'ANSI_B';
  hiddenLines: boolean;
  dimensions: boolean;
  gdt: boolean;
}

/** The 2D drawing sheet (part, or assembly with parts list and balloons) as SVG or DXF text. Works headless. Since 1.5. */
export interface DrawingsAPI {
  /** The current options. */
  getOptions(): DrawingOptionsInfo;
  /** Change only the options given; returns them all. */
  setOptions(options: Partial<DrawingOptionsInfo>): DrawingOptionsInfo;
  /** The sheet as SVG. Throws NOT_FOUND when there is nothing to draw. */
  svg(): string;
  /** The sheet as DXF R12. Throws NOT_FOUND when there is nothing to draw. */
  dxf(): string;
  /**
   * The sheet as a one-page vector PDF, as a binary string (one character per
   * byte). In Node: fs.writeFileSync('sheet.pdf', api.drawings.pdf(), 'latin1'). Since 1.7.
   */
  pdf(): string;
}

/** The CasiWorks public API. */
export interface CasiWorksAPI {
  /** Semantic version of this API, e.g. '1.3.0'. */
  readonly version: string;
  /** Units used by every input and result. */
  readonly units: ApiUnits;
  /** The open part document. */
  readonly document: DocumentAPI;
  /** 2D sketches. */
  readonly sketches: SketchesAPI;
  /** The feature tree. */
  readonly features: FeaturesAPI;
  /** The built solid and its measurements. */
  readonly model: ModelAPI;
  /** Materials. */
  readonly materials: MaterialsAPI;
  /** Undo / redo. */
  readonly history: HistoryAPI;
  /** Named commands (everything the ribbon and keyboard do). Since 1.1. */
  readonly commands: CommandsAPI;
  /**
   * Listen for an event; returns a function that stops listening. Since 1.2.
   * @example const stop = api.on('featureAdded', (e) => console.log(e.feature.name));
   */
  on<K extends CasiWorksEventName>(event: K, handler: CasiWorksEventHandler<K>): () => void;
  /** Stop a listener added with `on`. Since 1.2. */
  off<K extends CasiWorksEventName>(event: K, handler: CasiWorksEventHandler<K>): void;
  /** Record, replay and export macros. Since 1.3. */
  readonly macros: MacrosAPI;
  /** Load and unload plugins (add-ins). Since 1.4. */
  readonly plugins: PluginsAPI;
  /** Global variables and equations. Since 1.5. */
  readonly equations: EquationsAPI;
  /** Configurations (design table). Since 1.5. */
  readonly configurations: ConfigurationsAPI;
  /** Assembly components, mates, materials and BOM. Since 1.5. */
  readonly assembly: AssemblyAPI;
  /** The 2D drawing sheet as SVG / DXF. Since 1.5. */
  readonly drawings: DrawingsAPI;
}

/** Error thrown by every API call that rejects its input or cannot complete. */
export class CasiWorksAPIError extends Error {
  readonly code: CasiWorksAPIErrorCode;

  constructor(code: CasiWorksAPIErrorCode, message: string) {
    super(message);
    this.name = 'CasiWorksAPIError';
    this.code = code;
  }
}

// =====================================================================
// Store contract: the slice of the CAD store the API uses. Kept as a
// structural interface so the API stays decoupled from the UI store (e.g. a
// headless server); cadStore.ts checks at compile time that the store satisfies it.
// =====================================================================

/** Omit that distributes over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A feature as passed to the store's addFeature (links are derived by the store). */
type NewFeature = FeatureData;
/** A feature spec before the API assigns its id. */
type FeatureSpec = DistributiveOmit<FeatureData, 'id'>;

export interface ApiStoreState extends RebuildState {
  rebuildCount: number;
  documentRevision: number;
  selectedEntities: Array<{ id: string }>;
  bodies: Array<{ geometry: BufferGeometry | null; visible?: boolean }>;
  needsRebuild: boolean;
  rebuildErrors: RebuildError[];
  activeMaterial: string;
  documentName: string;
  isModified: boolean;
  statusMessage: string;
  undoStack: unknown[];
  redoStack: unknown[];
  newProject(): void;
  setDocumentName(name: string): void;
  saveProject(): string;
  loadProject(project: object): void;
  createSketchFeature(spec: { id: string; sketchId: string; plane: SketchPlane; entities: SketchEntity[]; name?: string }): void;
  addFeature(feature: NewFeature): void;
  updateFeature(id: string, changes: FeatureChanges): void;
  removeFeature(id: string): void;
  toggleFeatureSuppressed(id: string): void;
  setRollbackIndex(index: number): void;
  setMaterial(key: string): void;
  undo(): void;
  redo(): void;
  // Since 1.5
  sketchEntities: Record<string, SketchEntity[]>;
  setSketchEntities(sketchId: string, entities: SketchEntity[]): void;
  sketchConstraints: Record<string, unknown[]>;
  applySketchConstraints(sketchId: string, constraints: never[], label?: string): string | null;
  variables: GlobalVariable[];
  configurations: Configuration[];
  activeConfiguration: string | null;
  setVariables(variables: GlobalVariable[]): void;
  setConfigurations(configurations: Configuration[]): void;
  activateConfiguration(name: string | null): void;
  assemblyComponents: Array<DrawingComponent & BomComponent & {
    isFixed: boolean;
    position: { x: number; y: number; z: number };
  }>;
  insertAssemblyPart(name: string, shape?: ComponentShape, dims?: ComponentInfo['dimensions']): void;
  addAssemblyMate(type: MateType, comp1Id: string, ref1: string, comp2Id: string, ref2: string, offset?: number): void;
  solveAssembly(): void;
  setComponentMaterial(componentIds: string[], material: string | null): void;
  setExplodedView(settings: { distance: number; leaderLines: boolean } | null): void;
  clearAssembly(): void;
  drawingOptions: DrawingOptionsInfo;
  setDrawingOptions(options: Partial<DrawingOptionsInfo>): void;
}

export interface ApiStore {
  getState(): ApiStoreState;
  subscribe(listener: (state: ApiStoreState, previous: ApiStoreState) => void): () => void;
}

// =====================================================================
// Validation helpers
// =====================================================================

const PLANES: readonly SketchPlane[] = ['Front', 'Top', 'Right'];
const EXTRUDE_END_CONDITIONS: readonly ExtrudeEndCondition[] = ['blind', 'midplane', 'throughall'];

function fail(code: CasiWorksAPIErrorCode, message: string): never {
  throw new CasiWorksAPIError(code, message);
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', `${what} must be an object`);
  return value as Record<string, unknown>;
}

interface NumberRule { positive?: boolean; min?: number; max?: number }

function requireNumber(value: unknown, what: string, { positive = false, min = -Infinity, max = Infinity }: NumberRule = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_ARGUMENT', `${what} must be a finite number`);
  if (positive && value <= 0) fail('INVALID_ARGUMENT', `${what} must be greater than 0`);
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${what} must be between ${min} and ${max}`);
  return value;
}

function requirePoint(p: unknown, what: string): Point2 {
  const obj = requireObject(p, what);
  return { x: requireNumber(obj.x, `${what}.x`), y: requireNumber(obj.y, `${what}.y`) };
}

function optionalName(name: unknown, what = 'name'): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || name.trim() === '') fail('INVALID_ARGUMENT', `${what} must be a non-empty string`);
  return name.trim();
}

/** Deep copy into plain JSON data. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const DEG = Math.PI / 180;

/**
 * Convert API sketch entities into internal sketch entities. Inputs are
 * validated at runtime as well, because JavaScript callers bypass the types.
 */
function toInternalEntities(entities: unknown): SketchEntity[] {
  if (!Array.isArray(entities) || entities.length === 0) fail('INVALID_ARGUMENT', 'entities must be a non-empty array');
  const out: SketchEntity[] = [];
  entities.forEach((raw: unknown, i: number) => {
    const at = `entities[${i}]`;
    const e = requireObject(raw, at);
    const construction = e.construction === true;
    switch (e.type) {
      case 'line':
        out.push({ id: generateId('ent'), type: SKETCH_ENTITY_TYPES.LINE, p1: requirePoint(e.p1, `${at}.p1`), p2: requirePoint(e.p2, `${at}.p2`), construction });
        break;
      case 'circle':
        out.push({ id: generateId('ent'), type: SKETCH_ENTITY_TYPES.CIRCLE, center: requirePoint(e.center, `${at}.center`), radius: requireNumber(e.radius, `${at}.radius`, { positive: true }), construction });
        break;
      case 'arc':
        out.push({
          id: generateId('ent'),
          type: SKETCH_ENTITY_TYPES.ARC,
          center: requirePoint(e.center, `${at}.center`),
          radius: requireNumber(e.radius, `${at}.radius`, { positive: true }),
          startAngle: requireNumber(e.startAngle, `${at}.startAngle`) * DEG,
          endAngle: requireNumber(e.endAngle, `${at}.endAngle`) * DEG,
          construction,
        });
        break;
      case 'rectangle': {
        const a = requirePoint(e.corner1, `${at}.corner1`);
        const b = requirePoint(e.corner2, `${at}.corner2`);
        if (a.x === b.x || a.y === b.y) fail('INVALID_ARGUMENT', `${at} rectangle must have non-zero width and height`);
        const corners: Point2[] = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
        corners.forEach((p, k) => out.push({
          id: generateId('ent'),
          type: SKETCH_ENTITY_TYPES.LINE,
          p1: { ...p },
          p2: { ...corners[(k + 1) % 4] },
          construction,
        }));
        break;
      }
      default:
        fail('INVALID_ARGUMENT', `${at}.type must be one of line, circle, arc, rectangle (got ${JSON.stringify(e.type)})`);
    }
  });
  return out;
}

/** Plain, stable view of a feature for API callers. */
function toFeatureInfo(f: Feature, index: number): FeatureInfo {
  const { id, name, type, suppressed, parentIds, childIds, ...rest } = f;
  const parameters: Record<string, unknown> = { ...rest };
  // Bookkeeping fields that are not part of the public contract
  delete parameters.timestamp;
  delete parameters.visible;
  delete parameters.sketchId;
  return clone({
    id,
    name,
    type,
    index,
    sketchId: 'sketchId' in f ? f.sketchId : null,
    suppressed: !!suppressed,
    parentIds: parentIds || [],
    childIds: childIds || [],
    parameters,
  });
}

// =====================================================================
// Factory
// =====================================================================

/** Create the public API bound to a CasiWorks store (useCADStore). */
export function createCasiWorksAPI(store: ApiStore, options: CasiWorksAPIOptions = {}): CasiWorksAPI {
  const get = () => store.getState();

  const findFeature = (id: unknown): { feature: Feature; index: number } => {
    const idx = get().features.findIndex(f => f.id === id);
    if (idx === -1) fail('NOT_FOUND', `No feature with id ${JSON.stringify(id)}`);
    return { feature: get().features[idx], index: idx };
  };

  const requireSketch = (sketchId: unknown): string => {
    if (typeof sketchId !== 'string') fail('INVALID_ARGUMENT', 'sketchId must be a string');
    const exists = get().features.some(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId);
    if (!exists) fail('NOT_FOUND', `No sketch with id ${JSON.stringify(sketchId)}`);
    return sketchId;
  };

  const ensureRebuilt = () => {
    if (get().needsRebuild) rebuildModel(store);
  };

  const currentGeometry = (): BufferGeometry | null => {
    ensureRebuilt();
    return get().bodies.find(b => b.visible !== false && b.geometry)?.geometry ?? null;
  };

  /** A sketch plane argument: a standard plane, a reference plane id, or a plane frame. */
  const resolveSketchPlane = (plane: unknown): { plane: SketchPlane; planeRef?: string; frame?: PlaneFrame } => {
    const value = plane ?? 'Front';
    if (typeof value === 'string') {
      if (PLANES.includes(value as SketchPlane)) return { plane: value as SketchPlane };
      const ref = get().features.find(f => f.id === value && f.type === FEATURE_TYPES.REFERENCE_PLANE);
      if (ref) return { plane: 'Front', planeRef: ref.id };
      return fail('INVALID_ARGUMENT', `plane must be ${PLANES.join(', ')}, a reference plane id or { origin, xAxis, normal }`);
    }
    const o = requireObject(value, 'plane');
    const v = (x: unknown, what: string) => {
      const p = requireObject(x, what);
      return { x: requireNumber(p.x, `${what}.x`), y: requireNumber(p.y, `${what}.y`), z: requireNumber(p.z, `${what}.z`) };
    };
    const frame = { origin: v(o.origin, 'plane.origin'), xAxis: v(o.xAxis, 'plane.xAxis'), normal: v(o.normal, 'plane.normal') };
    const n = frame.normal, x = frame.xAxis;
    const cross = Math.hypot(n.y * x.z - n.z * x.y, n.z * x.x - n.x * x.z, n.x * x.y - n.y * x.x);
    if (Math.hypot(n.x, n.y, n.z) < 1e-9 || cross < 1e-9) fail('INVALID_ARGUMENT', 'plane.normal must be non-zero and plane.xAxis not parallel to it');
    return { plane: 'Front', frame };
  };

  /** Add a feature through the store and return its id. */
  const addFeature = (spec: FeatureSpec): string => {
    const id = generateId('feat');
    get().addFeature({ ...spec, id });
    return id;
  };

  const document: DocumentAPI = Object.freeze({
    new() {
      get().newProject();
    },
    getName() {
      return get().documentName;
    },
    setName(name: string) {
      get().setDocumentName(optionalName(name) ?? fail('INVALID_ARGUMENT', 'name is required'));
    },
    isModified() {
      return !!get().isModified;
    },
    toJSON() {
      return get().saveProject();
    },
    load(project: string | object) {
      let data: unknown = project;
      if (typeof project === 'string') {
        try {
          data = JSON.parse(project);
        } catch (e) {
          fail('INVALID_DOCUMENT', `Project is not valid JSON: ${(e as Error).message}`);
        }
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_DOCUMENT', 'Project must be a JSON object');
      const features = (data as { features?: unknown }).features;
      if (features !== undefined && !Array.isArray(features)) fail('INVALID_DOCUMENT', 'Project "features" must be an array');
      get().loadProject(data);
      if (/^Error loading project/.test(get().statusMessage)) fail('INVALID_DOCUMENT', get().statusMessage);
    },
  });

  // ------------------------------------------------------------------ sketch editing (since 1.5)
  const editSketch = (sketchId: string, edit: (entities: SketchEntity[], id: string) => EditResult): SketchEntity[] => {
    const id = requireSketch(sketchId);
    const r = edit(get().sketchEntities[id] ?? [], id);
    if ('error' in r) fail('INVALID_ARGUMENT', r.error);
    get().setSketchEntities(id, r.entities);
    return clone(get().sketchEntities[id] ?? []);
  };
  const point = (p: unknown, what: string): Point2 => {
    const o = requireObject(p, what);
    return { x: requireNumber(o.x, `${what}.x`), y: requireNumber(o.y, `${what}.y`) };
  };
  const requireEntity = (sketchId: string, entityId: unknown): string => {
    if (typeof entityId !== 'string' || !(get().sketchEntities[sketchId] ?? []).some(e => e.id === entityId)) {
      fail('NOT_FOUND', `No entity ${JSON.stringify(entityId)} in sketch ${sketchId}`);
    }
    return entityId as string;
  };
  const sketchEdits = {
    trim: (sketchId: string, entityId: string, at: Point2) =>
      editSketch(sketchId, (ents, id) => trimEntity(ents, requireEntity(id, entityId), point(at, 'at'))),
    extend: (sketchId: string, entityId: string, near: Point2) =>
      editSketch(sketchId, (ents, id) => extendLine(ents, requireEntity(id, entityId), point(near, 'near'))),
    offset: (sketchId: string, entityId: string, distance: number, side: Point2) =>
      editSketch(sketchId, (ents, id) => offsetEntity(ents, requireEntity(id, entityId), requireNumber(distance, 'distance', { positive: true }), point(side, 'side'))),
    mirror: (sketchId: string, axisId: string, entityIds: string[]) => {
      if (!Array.isArray(entityIds)) fail('INVALID_ARGUMENT', 'entityIds must be a list');
      return editSketch(sketchId, (ents, id) => mirrorEntities(ents, requireEntity(id, axisId), entityIds.map(e => requireEntity(id, e))));
    },
  };

  const sketchConstraintList = (id: string) => (get().sketchConstraints[id] ?? []) as unknown as Array<Record<string, unknown> & { id: string; type: string; value?: number; diameter?: boolean }>;
  const applyConstraints = (id: string, list: unknown[], label: string) => {
    const error = get().applySketchConstraints(id, list as never, label);
    if (error) fail('OPERATION_FAILED', error);
  };
  const sketches: SketchesAPI = Object.freeze({
    ...sketchEdits,
    constrain(sketchId: string, constraint: Record<string, unknown>) {
      const id = requireSketch(sketchId);
      const c = requireObject(constraint, 'constraint');
      const kinds = ['horizontal', 'vertical', 'parallel', 'perpendicular', 'equal', 'coincident', 'concentric', 'tangent', 'fix', 'dimension', 'angle', 'midpoint', 'symmetric', 'colinear'];
      if (typeof c.type !== 'string' || !kinds.includes(c.type)) fail('INVALID_ARGUMENT', `type must be one of ${kinds.join(', ')}`);
      for (const k of ['entity1Id', 'entity2Id']) if (c[k] !== undefined) requireEntity(id, c[k]);
      if (c.entity1Id === undefined) fail('INVALID_ARGUMENT', 'entity1Id is required');
      if (c.type === 'dimension') requireNumber(c.value, 'value', { positive: true });
      const newId = generateId(c.type === 'dimension' ? 'dim' : 'rel');
      applyConstraints(id, [...sketchConstraintList(id), { ...c, id: newId }], `${c.type} added`);
      return newId;
    },
    constraints: (sketchId: string) => clone(sketchConstraintList(requireSketch(sketchId))),
    setDimension(sketchId: string, constraintId: string, value: number) {
      const id = requireSketch(sketchId);
      const list = sketchConstraintList(id);
      const c = list.find(x => x.id === constraintId && x.type === 'dimension') ?? fail('NOT_FOUND', `No dimension ${JSON.stringify(constraintId)}`);
      const v = requireNumber(value, 'value', { positive: true });
      applyConstraints(id, list.map(x => (x.id === c.id ? { ...x, value: x.diameter ? v / 2 : v } : x)), `Dimension ${v} mm`);
    },
    removeConstraint(sketchId: string, constraintId: string) {
      const id = requireSketch(sketchId);
      const list = sketchConstraintList(id);
      if (!list.some(x => x.id === constraintId)) fail('NOT_FOUND', `No relation or dimension ${JSON.stringify(constraintId)}`);
      applyConstraints(id, list.filter(x => x.id !== constraintId), 'Removed');
    },
    status(sketchId: string) {
      const id = requireSketch(sketchId);
      const r = solveSketch(get().sketchEntities[id] ?? [], sketchConstraintList(id) as never);
      return { state: r.state, dof: r.result.dof, message: r.message };
    },
    create(spec: SketchSpec) {
      const s = requireObject(spec, 'spec');
      const where = resolveSketchPlane(s.plane);
      const entities = toInternalEntities(s.entities);
      const featureId = generateId('feat_sketch');
      const sketchId = generateId('sketch');
      get().createSketchFeature({ id: featureId, sketchId, ...where, entities, name: optionalName(s.name) });
      return { featureId, sketchId };
    },
    getEntities(sketchId: string) {
      requireSketch(sketchId);
      return clone(get().sketchEntities[sketchId] || []);
    },
  });

  const features: FeaturesAPI = Object.freeze({
    list() {
      return get().features.map((f, i) => toFeatureInfo(f, i));
    },
    get(id: string) {
      const { feature, index } = findFeature(id);
      return toFeatureInfo(feature, index);
    },
    extrude(spec: ExtrudeSpec) {
      const s = requireObject(spec, 'spec');
      const sketchId = requireSketch(s.sketchId);
      const depth = requireNumber(s.depth, 'depth', { positive: true });
      const endCondition = (s.endCondition ?? 'blind') as ExtrudeEndCondition;
      if (!EXTRUDE_END_CONDITIONS.includes(endCondition)) fail('INVALID_ARGUMENT', `endCondition must be one of ${EXTRUDE_END_CONDITIONS.join(', ')}`);
      const cut = s.cut === true;
      return addFeature({
        type: cut ? FEATURE_TYPES.EXTRUDE_CUT : FEATURE_TYPES.EXTRUDE_BOSS,
        name: optionalName(s.name) ?? (cut ? 'Cut-Extrude' : 'Boss-Extrude'),
        sketchId,
        depth,
        direction: endCondition,
        flip: s.flip === true,
      });
    },
    revolve(spec: RevolveSpec) {
      const s = requireObject(spec, 'spec');
      const sketchId = requireSketch(s.sketchId);
      const angle = requireNumber(s.angle ?? 360, 'angle', { positive: true, max: 360 });
      const cut = s.cut === true;
      const axis: Record<string, string> = {};
      if (s.axis === 'x' || s.axis === 'y') axis.axis = s.axis;
      else if (s.axis !== undefined) {
        const a = requireObject(s.axis, 'axis');
        if (typeof a.line === 'string') {
          const line = (get().sketchEntities[sketchId] ?? []).find(e => e.id === a.line);
          if (!line || line.type !== 'line') fail('NOT_FOUND', `No line ${JSON.stringify(a.line)} in sketch ${sketchId}`);
          axis.axisLine = a.line;
        } else if (typeof a.axis === 'string') {
          if (!get().features.some(f => f.id === a.axis && f.type === FEATURE_TYPES.REFERENCE_AXIS)) fail('NOT_FOUND', `No reference axis ${JSON.stringify(a.axis)}`);
          axis.axisRef = a.axis;
        } else fail('INVALID_ARGUMENT', "axis must be 'x', 'y', { line } or { axis }");
      }
      return addFeature({
        type: cut ? FEATURE_TYPES.REVOLVE_CUT : FEATURE_TYPES.REVOLVE_BOSS,
        name: optionalName(s.name) ?? (cut ? 'Cut-Revolve' : 'Revolve'),
        sketchId,
        angle,
        ...axis,
      } as unknown as FeatureSpec);
    },
    fillet(spec: FilletSpec) {
      const s = requireObject(spec, 'spec');
      return addFeature({ type: FEATURE_TYPES.FILLET, name: optionalName(s.name) ?? 'Fillet', radius: requireNumber(s.radius, 'radius', { positive: true }) });
    },
    chamfer(spec: ChamferSpec) {
      const s = requireObject(spec, 'spec');
      return addFeature({ type: FEATURE_TYPES.CHAMFER, name: optionalName(s.name) ?? 'Chamfer', distance: requireNumber(s.distance, 'distance', { positive: true }) });
    },
    shell(spec: ShellSpec) {
      const s = requireObject(spec, 'spec');
      return addFeature({ type: FEATURE_TYPES.SHELL, name: optionalName(s.name) ?? 'Shell', thickness: requireNumber(s.thickness, 'thickness', { positive: true }) });
    },
    referencePlane(spec: { base?: SketchPlane; offset?: number; angle?: number; name?: string }) {
      const s = requireObject(spec ?? {}, 'spec');
      const base = (s.base ?? 'Front') as SketchPlane;
      if (!PLANES.includes(base)) fail('INVALID_ARGUMENT', `base must be one of ${PLANES.join(', ')}`);
      const offset = s.offset === undefined ? 0 : requireNumber(s.offset, 'offset');
      const angle = s.angle === undefined ? 0 : requireNumber(s.angle, 'angle');
      if (Math.abs(angle) >= 90) fail('INVALID_ARGUMENT', 'angle must be between -90 and 90 degrees');
      const count = get().features.filter(f => f.type === FEATURE_TYPES.REFERENCE_PLANE).length;
      return addFeature({ type: FEATURE_TYPES.REFERENCE_PLANE, name: optionalName(s.name) ?? `Plane${count + 1}`, base, offset, angle } as unknown as FeatureSpec);
    },
    referenceAxis(spec: { direction: 'X' | 'Y' | 'Z'; point?: { x: number; y: number; z: number }; through?: string; name?: string }) {
      const s = requireObject(spec, 'spec');
      if (s.direction !== 'X' && s.direction !== 'Y' && s.direction !== 'Z') fail('INVALID_ARGUMENT', "direction must be 'X', 'Y' or 'Z'");
      let throughRef: string | undefined;
      if (s.through !== undefined) {
        const ref = get().features.find(f => f.id === s.through && f.type === FEATURE_TYPES.REFERENCE_POINT);
        if (!ref) fail('NOT_FOUND', `No reference point ${JSON.stringify(s.through)}`);
        throughRef = ref.id;
      }
      const p = s.point === undefined ? { x: 0, y: 0, z: 0 } : requireObject(s.point, 'point');
      const point = { x: requireNumber(p.x ?? 0, 'point.x'), y: requireNumber(p.y ?? 0, 'point.y'), z: requireNumber(p.z ?? 0, 'point.z') };
      const count = get().features.filter(f => f.type === FEATURE_TYPES.REFERENCE_AXIS).length;
      return addFeature({ type: FEATURE_TYPES.REFERENCE_AXIS, name: optionalName(s.name) ?? `Axis${count + 1}`, direction: s.direction, point, ...(throughRef ? { throughRef } : {}) } as unknown as FeatureSpec);
    },
    referencePoint(spec: { x: number; y: number; z: number; name?: string }) {
      const s = requireObject(spec, 'spec');
      const point = { x: requireNumber(s.x, 'x'), y: requireNumber(s.y, 'y'), z: requireNumber(s.z, 'z') };
      const count = get().features.filter(f => f.type === FEATURE_TYPES.REFERENCE_POINT).length;
      return addFeature({ type: FEATURE_TYPES.REFERENCE_POINT, name: optionalName(s.name) ?? `Point${count + 1}`, point } as unknown as FeatureSpec);
    },
    hole(spec: HoleSpec) {
      const s = requireObject(spec, 'spec');
      const vec = (v: unknown, what: string) => {
        const o = requireObject(v, what);
        return { x: requireNumber(o.x, `${what}.x`), y: requireNumber(o.y, `${what}.y`), z: requireNumber(o.z, `${what}.z`) };
      };
      const kinds: HoleKind[] = ['simple', 'counterbore', 'countersink', 'tapped'];
      const holeType = (s.type ?? 'simple') as HoleKind;
      if (!kinds.includes(holeType)) fail('INVALID_ARGUMENT', `type must be one of ${kinds.join(', ')}`);
      const depth = requireNumber(s.depth, 'depth', { positive: true });
      const position = vec(s.position, 'position');
      const axis = s.axis === undefined ? { x: 0, y: 0, z: 1 } : vec(s.axis, 'axis');
      if (Math.hypot(axis.x, axis.y, axis.z) < 1e-9) fail('INVALID_ARGUMENT', 'axis must not be zero');
      const base = { type: FEATURE_TYPES.HOLE, holeType, depth, position, axis };
      if (s.standard !== undefined) {
        const st = requireObject(s.standard, 'standard');
        if (!METRIC_SIZES.includes(st.size as MetricSize)) fail('INVALID_ARGUMENT', `standard.size must be one of ${METRIC_SIZES.join(', ')}`);
        const fit = (st.fit ?? 'normal') as ClearanceFit;
        if (!CLEARANCE_FITS.includes(fit)) fail('INVALID_ARGUMENT', `standard.fit must be one of ${CLEARANCE_FITS.join(', ')}`);
        const std = standardHole(holeType, st.size as MetricSize, fit);
        return addFeature({
          ...base, name: optionalName(s.name) ?? std.label, diameter: std.diameter, standard: { size: st.size as string, fit },
          ...(std.cbDiameter ? { cbDiameter: std.cbDiameter, cbDepth: std.cbDepth } : {}),
          ...(std.csDiameter ? { csDiameter: std.csDiameter, csAngle: std.csAngle } : {}),
          ...(std.thread ? { thread: std.thread } : {}),
        } as unknown as FeatureSpec);
      }
      const diameter = requireNumber(s.diameter, 'diameter', { positive: true });
      const opt = (k: string) => (s[k] === undefined ? {} : { [k]: requireNumber(s[k], k, { positive: true }) });
      return addFeature({
        ...base, name: optionalName(s.name) ?? 'Hole', diameter,
        ...(holeType === 'counterbore' ? { ...opt('cbDiameter'), ...opt('cbDepth') } : {}),
        ...(holeType === 'countersink' ? { ...opt('csDiameter'), ...opt('csAngle') } : {}),
      } as unknown as FeatureSpec);
    },
    update(id: string, changes: FeatureChanges) {
      const { feature } = findFeature(id);
      const c = requireObject(changes, 'changes');
      for (const key of ['id', 'type', 'parentIds', 'childIds', 'sketchId']) {
        if (key in c) fail('INVALID_ARGUMENT', `"${key}" cannot be changed`);
      }
      const clean: FeatureChanges = {};
      for (const [key, value] of Object.entries(c)) {
        if (key === 'name') clean.name = optionalName(value) ?? fail('INVALID_ARGUMENT', 'name must be a non-empty string');
        else if (typeof value === 'number') clean[key] = requireNumber(value, key);
        else if (typeof value === 'string' || typeof value === 'boolean') clean[key] = value;
        else fail('INVALID_ARGUMENT', `"${key}" must be a number, string or boolean`);
      }
      if ('depth' in clean) requireNumber(clean.depth, 'depth', { positive: true });
      get().updateFeature(feature.id, clean);
    },
    remove(id: string) {
      const { feature } = findFeature(id);
      get().removeFeature(feature.id);
    },
    setSuppressed(id: string, suppressed: boolean) {
      const { feature } = findFeature(id);
      if (typeof suppressed !== 'boolean') fail('INVALID_ARGUMENT', 'suppressed must be a boolean');
      if (!!feature.suppressed !== suppressed) get().toggleFeatureSuppressed(feature.id);
    },
    rollbackTo(index: number | null) {
      const count = get().features.length;
      if (index === null) {
        get().setRollbackIndex(-1);
        return;
      }
      if (!Number.isInteger(index) || index < 0 || index >= count) fail('INVALID_ARGUMENT', `index must be an integer from 0 to ${count - 1}, or null`);
      get().setRollbackIndex(index);
    },
  });

  const model: ModelAPI = Object.freeze({
    rebuild() {
      return clone(rebuildModel(store));
    },
    errors() {
      ensureRebuilt();
      return clone(get().rebuildErrors || []);
    },
    hasBody() {
      return currentGeometry() !== null;
    },
    massProperties() {
      const geometry = currentGeometry();
      if (!geometry) return null;
      const material = materialLibrary.getMaterial(get().activeMaterial);
      return clone(geometryEngine.computeMassProperties(geometry, material) as MassProperties);
    },
    boundingBox() {
      const geometry = currentGeometry();
      if (!geometry) return null;
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box) return null;
      const { min, max } = box;
      return {
        min: { x: min.x, y: min.y, z: min.z },
        max: { x: max.x, y: max.y, z: max.z },
        size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      };
    },
    measure(a: Point3D, b: Point3D, options: { normalA?: Point3D; normalB?: Point3D } = {}) {
      const p = (v: unknown, what: string): Point3D => {
        const o = requireObject(v, what);
        return { x: requireNumber(o.x, `${what}.x`), y: requireNumber(o.y, `${what}.y`), z: requireNumber(o.z, `${what}.z`) };
      };
      const o = options && typeof options === 'object' ? options : {};
      return measurePicks(
        { point: p(a, 'a'), normal: o.normalA ? p(o.normalA, 'normalA') : null, kind: 'face' },
        { point: p(b, 'b'), normal: o.normalB ? p(o.normalB, 'normalB') : null, kind: 'face' },
      );
    },
  });

  const materials: MaterialsAPI = Object.freeze({
    list() {
      return materialLibrary.getAllMaterials().map(({ key, name, density, youngsModulus, poissonsRatio, yieldStrength }) =>
        ({ key, name, density, youngsModulus, poissonsRatio, yieldStrength }));
    },
    getActive() {
      return get().activeMaterial;
    },
    setActive(key: string) {
      if (typeof key !== 'string' || !Object.hasOwn(materialLibrary.materials, key)) fail('NOT_FOUND', `No material with key ${JSON.stringify(key)}`);
      get().setMaterial(key);
    },
  });

  const history: HistoryAPI = Object.freeze({
    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,
    undo() {
      if (!history.canUndo()) return false;
      get().undo();
      return true;
    },
    redo() {
      if (!history.canRedo()) return false;
      get().redo();
      return true;
    },
  });

  const registry = options.commands;
  const commandErrorCodes: Record<string, CasiWorksAPIErrorCode> = {
    UNKNOWN_COMMAND: 'NOT_FOUND',
    INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  };
  const commands: CommandsAPI = Object.freeze({
    list: () => registry?.list() ?? [],
    has: (id: string) => registry?.has(id) ?? false,
    execute(id: string, args?: unknown) {
      if (typeof id !== 'string') fail('INVALID_ARGUMENT', 'Command id must be a string');
      if (!registry?.has(id)) fail('NOT_FOUND', `Unknown command ${JSON.stringify(id)}`);
      try {
        return registry.execute(id, args);
      } catch (err) {
        if (err instanceof CasiWorksAPIError) throw err;
        const code = (err as { code?: string } | null)?.code;
        fail(commandErrorCodes[code ?? ''] ?? 'OPERATION_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ---------------------------------------------------------------- events
  const EVENT_NAMES: readonly CasiWorksEventName[] = ['rebuild', 'featureAdded', 'featureRemoved', 'featureChanged', 'selectionChanged', 'documentChanged', 'commandExecuted'];
  const handlers = new Map<CasiWorksEventName, Set<(e: never) => void>>();
  let stopWatching: (() => void) | null = null;

  const emit = <K extends CasiWorksEventName>(event: K, payload: CasiWorksEventMap[K]) => {
    for (const h of [...(handlers.get(event) ?? [])]) {
      try { (h as CasiWorksEventHandler<K>)(payload); } catch (err) { console.error(`[CasiWorks] "${event}" listener failed:`, err); }
    }
  };
  const listening = (event: CasiWorksEventName) => (handlers.get(event)?.size ?? 0) > 0;

  const onStoreChange = (state: ApiStoreState, prev: ApiStoreState) => {
    if (state.documentRevision !== prev.documentRevision) {
      emit('documentChanged', { name: state.documentName, featureCount: state.features.length });
    } else if (state.features !== prev.features) {
      const before = new Map(prev.features.map(f => [f.id, f]));
      const after = new Set(state.features.map(f => f.id));
      for (const f of prev.features) if (!after.has(f.id)) emit('featureRemoved', { id: f.id, name: f.name });
      state.features.forEach((f, i) => {
        const old = before.get(f.id);
        if (!old) emit('featureAdded', { feature: toFeatureInfo(f, i) });
        // Undo restores copies: compare content when the object changed
        else if (old !== f && listening('featureChanged') && JSON.stringify(old) !== JSON.stringify(f)) emit('featureChanged', { feature: toFeatureInfo(f, i) });
      });
    }
    if (state.selectedEntities !== prev.selectedEntities) {
      const ids = state.selectedEntities.map(e => e.id);
      const old = prev.selectedEntities.map(e => e.id);
      if (ids.length !== old.length || ids.some((id, i) => id !== old[i])) emit('selectionChanged', { ids });
    }
    if (state.rebuildCount !== prev.rebuildCount) {
      const errors = clone(state.rebuildErrors);
      emit('rebuild', { ok: errors.length === 0, bodyCount: state.bodies.filter(b => b.geometry).length, errors });
    }
  };

  const updateWatching = () => {
    const any = EVENT_NAMES.some(listening);
    if (any && !stopWatching) {
      const stopStore = store.subscribe(onStoreChange);
      const stopCommands = registry?.onExecute?.(e => emit('commandExecuted', clone(e))) ?? (() => {});
      stopWatching = () => { stopStore(); stopCommands(); };
    } else if (!any && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
  };

  const off = <K extends CasiWorksEventName>(event: K, handler: CasiWorksEventHandler<K>) => {
    handlers.get(event)?.delete(handler as (e: never) => void);
    updateWatching();
  };
  const on = <K extends CasiWorksEventName>(event: K, handler: CasiWorksEventHandler<K>) => {
    if (!EVENT_NAMES.includes(event)) fail('INVALID_ARGUMENT', `Unknown event ${JSON.stringify(event)} (events: ${EVENT_NAMES.join(', ')})`);
    if (typeof handler !== 'function') fail('INVALID_ARGUMENT', 'handler must be a function');
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler as (e: never) => void);
    updateWatching();
    return () => off(event, handler);
  };

  // ---------------------------------------------------------------- macros
  const recorder = options.macros;
  const macroCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof CasiWorksAPIError) throw err;
      const code = (err as { code?: string } | null)?.code;
      return fail(code === 'INVALID_ARGUMENT' ? 'INVALID_ARGUMENT' : 'OPERATION_FAILED', err instanceof Error ? err.message : String(err));
    }
  };
  const needRecorder = (): ApiMacroRecorder => recorder ?? fail('OPERATION_FAILED', 'Macros need a command registry (use createHeadlessAPI or the app)');
  const macros: MacrosAPI = Object.freeze({
    startRecording: (name?: string) => macroCall(() => needRecorder().start(name)),
    stopRecording: () => macroCall(() => clone(needRecorder().stop())),
    isRecording: () => recorder?.isRecording ?? false,
    run: (macro: Macro | string) => macroCall(() => needRecorder().run(macro)),
    toScript: (macro: Macro | string) => macroCall(() => macroToScript(parseMacro(macro))),
  });

  // ---------------------------------------------------------------- plugins
  const pluginError = (err: unknown): never => {
    if (err instanceof CasiWorksAPIError) throw err;
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    return fail(code === 'INVALID_PLUGIN' ? 'INVALID_ARGUMENT' : code === 'NOT_FOUND' ? 'NOT_FOUND' : 'OPERATION_FAILED', message);
  };
  const needPlugins = (): ApiPluginManager => options.plugins ?? fail('OPERATION_FAILED', 'Plugins are not available here');
  const plugins: PluginsAPI = Object.freeze({
    list: () => clone(options.plugins?.list() ?? []),
    async load(source: string | object) {
      const manager = needPlugins();
      try {
        return clone(await (typeof source === 'string' ? manager.loadFromUrl(source) : manager.load(source)));
      } catch (err) {
        return pluginError(err);
      }
    },
    unload(id: string) {
      try {
        needPlugins().unload(id);
      } catch (err) {
        pluginError(err);
      }
    },
  });


  // ------------------------------------------------------------------ since 1.5
  const activeVariables = () => {
    const st = get();
    return effectiveVariables(st.variables, st.configurations.find(c => c.name === st.activeConfiguration));
  };
  const variableValues = () => evaluateVariables(activeVariables()).values;

  const equations: EquationsAPI = Object.freeze({
    list() {
      const active = activeVariables();
      const { values, errors } = evaluateVariables(active);
      return clone({
        configuration: get().activeConfiguration,
        variables: get().variables.map((v, i) => ({
          ...v,
          ...(active[i].expression !== v.expression ? { override: active[i].expression } : {}),
          value: values[v.name] ?? null,
          ...(errors[v.name] ? { error: errors[v.name] } : {}),
        })),
        links: evaluateLinks(get().features, values).links,
      });
    },
    set(variables: VariableSpec[]) {
      if (!Array.isArray(variables) || !variables.every(v => v && typeof v.name === 'string' && typeof v.expression === 'string')) {
        fail('INVALID_ARGUMENT', 'variables must be a list of { name, expression }');
      }
      const { values, errors } = evaluateVariables(variables);
      const bad = Object.entries(errors);
      if (bad.length) fail('INVALID_ARGUMENT', bad.map(([n, m]) => `${n}: ${m}`).join('; '));
      const configProblems = configurationProblems(variables, get().configurations).filter(p => !/no variable/.test(p));
      if (configProblems.length) fail('INVALID_ARGUMENT', `With these variables a configuration fails: ${configProblems.join('; ')}`);
      get().setVariables(variables);
      return clone(values);
    },
    evaluate(expression: string) {
      try {
        return evaluateExpression(expression, variableValues());
      } catch (e) {
        return fail('INVALID_ARGUMENT', (e as Error).message);
      }
    },
    link(featureId: string, parameter: string, expression: string | null) {
      const { feature } = findFeature(featureId);
      if (typeof parameter !== 'string' || !parameter) fail('INVALID_ARGUMENT', 'parameter is required');
      const top = parameter.split('.')[0];
      const reserved = ['id', 'type', 'name', 'sketchId', 'parentIds', 'childIds', 'expressions'];
      if (!(top in feature) || reserved.includes(top)) fail('INVALID_ARGUMENT', `${feature.name} has no parameter "${parameter}"`);
      const expressions = { ...((feature as { expressions?: Record<string, string> }).expressions ?? {}) };
      if (expression === null) {
        delete expressions[parameter];
      } else {
        if (typeof expression !== 'string') fail('INVALID_ARGUMENT', 'expression must be text or null');
        try {
          evaluateExpression(expression, variableValues());
        } catch (e) {
          fail('INVALID_ARGUMENT', `${parameter} = ${expression}: ${(e as Error).message}`);
        }
        expressions[parameter] = expression;
      }
      get().updateFeature(feature.id, { expressions } as unknown as FeatureChanges);
    },
  });

  const configurations: ConfigurationsAPI = Object.freeze({
    list() {
      const st = get();
      const vals = (c: Configuration | null) => evaluateVariables(effectiveVariables(st.variables, c)).values;
      return clone([
        { name: 'Default', values: {}, variables: vals(null), active: st.activeConfiguration === null },
        ...st.configurations.map(c => ({ name: c.name, values: { ...c.values }, variables: vals(c), active: st.activeConfiguration === c.name })),
      ]);
    },
    active: () => get().activeConfiguration ?? 'Default',
    set(list: ConfigurationSpec[]) {
      const valid = Array.isArray(list) && list.every(c => c && typeof c.name === 'string' && c.values && typeof c.values === 'object'
        && Object.values(c.values).every(v => typeof v === 'string'));
      if (!valid) fail('INVALID_ARGUMENT', 'configurations must be a list of { name, values: { variable: expression } }');
      const problems = configurationProblems(get().variables, list);
      if (problems.length) fail('INVALID_ARGUMENT', problems.join('; '));
      get().setConfigurations(list);
    },
    activate(name: string | null) {
      const target = name === null || name === 'Default' ? null : name;
      if (target !== null && !get().configurations.some(c => c.name === target)) {
        fail('NOT_FOUND', `No configuration ${JSON.stringify(name)}; one of Default, ${get().configurations.map(c => c.name).join(', ') || '(none defined)'}`);
      }
      get().activateConfiguration(target);
    },
  });

  const SHAPES: readonly ComponentShape[] = ['box', 'cylinder', 'flange', 'pin'];
  const MATES = Object.values(MATE_TYPES) as MateType[];
  const requireComponent = (id: unknown): string => {
    if (typeof id !== 'string' || !get().assemblyComponents.some(c => c.id === id)) fail('NOT_FOUND', `No component ${JSON.stringify(id)}`);
    return id as string;
  };
  const assembly: AssemblyAPI = Object.freeze({
    list() {
      return clone(get().assemblyComponents.map(c => ({
        id: c.id,
        name: c.name,
        shape: (c.geometryType ?? 'box') as ComponentShape,
        dimensions: { ...(c.dimensions ?? {}) },
        material: c.material ?? null,
        fixed: !!c.isFixed,
        position: { x: c.position.x, y: c.position.y, z: c.position.z },
      })));
    },
    insert(spec: { name: string; shape: ComponentShape; dimensions?: ComponentInfo['dimensions'] }) {
      const o = requireObject(spec, 'spec');
      const name = optionalName(o.name) ?? fail('INVALID_ARGUMENT', 'name is required');
      if (!SHAPES.includes(o.shape as ComponentShape)) fail('INVALID_ARGUMENT', `shape must be one of ${SHAPES.join(', ')}`);
      const dims = (o.dimensions ?? {}) as ComponentInfo['dimensions'];
      for (const [k, v] of Object.entries(requireObject(dims, 'dimensions'))) requireNumber(v, `dimensions.${k}`, { positive: true });
      get().insertAssemblyPart(name, o.shape as ComponentShape, dims);
      const all = get().assemblyComponents;
      return all[all.length - 1].id;
    },
    mate(spec: MateSpec) {
      const o = requireObject(spec, 'spec');
      if (!MATES.includes(o.type as MateType)) fail('INVALID_ARGUMENT', `type must be one of ${MATES.join(', ')}`);
      const d = MATE_DEFAULTS[o.type as MateType] ?? { ref1: 'top', ref2: 'bottom', offset: 0 };
      const offset = o.offset === undefined ? d.offset : requireNumber(o.offset, 'offset');
      get().addAssemblyMate(
        o.type as MateType,
        requireComponent(o.component1), typeof o.ref1 === 'string' ? o.ref1 : d.ref1,
        requireComponent(o.component2), typeof o.ref2 === 'string' ? o.ref2 : d.ref2,
        offset,
      );
    },
    solve() {
      get().solveAssembly();
      const message = get().statusMessage;
      return { converged: message.startsWith('Assembly solved'), message };
    },
    setMaterial(componentIds: string[], material: string | null) {
      if (!Array.isArray(componentIds) || componentIds.length === 0) fail('INVALID_ARGUMENT', 'componentIds must be a non-empty list');
      componentIds.forEach(requireComponent);
      if (material !== null && !(material in MATERIALS)) fail('NOT_FOUND', `Unknown material ${JSON.stringify(material)}`);
      get().setComponentMaterial(componentIds, material);
    },
    bom: () => clone(buildBom(get().assemblyComponents, get().activeMaterial)),
    explode(options: { distance?: number; leaderLines?: boolean } = {}) {
      const distance = options.distance === undefined ? 40 : requireNumber(options.distance, 'distance', { positive: true });
      if (distance > 1000) fail('INVALID_ARGUMENT', 'distance must be at most 1000 mm');
      if (get().assemblyComponents.length < 2) fail('OPERATION_FAILED', 'Insert at least two components to explode');
      get().setExplodedView({ distance, leaderLines: options.leaderLines ?? true });
    },
    collapse: () => get().setExplodedView(null),
    clear: () => get().clearAssembly(),
  });

  const SIZES = ['A4_LANDSCAPE', 'A4_PORTRAIT', 'A3_LANDSCAPE', 'ANSI_B'];
  const sheetText = (format: 'svg' | 'dxf' | 'pdf'): string => {
    ensureRebuilt();
    const st = get();
    const file = drawingFile(st as unknown as DrawingSource, format);
    return file?.text ?? fail('NOT_FOUND', st.drawingOptions.subject === 'assembly' ? 'The assembly is empty' : 'There is no solid body to draw');
  };
  const drawings: DrawingsAPI = Object.freeze({
    getOptions: () => clone(get().drawingOptions),
    setOptions(options: Partial<DrawingOptionsInfo>) {
      const o = requireObject(options, 'options');
      const next: Partial<DrawingOptionsInfo> = {};
      if (o.subject !== undefined) {
        if (o.subject !== 'part' && o.subject !== 'assembly') fail('INVALID_ARGUMENT', "subject must be 'part' or 'assembly'");
        next.subject = o.subject;
      }
      if (o.sheetSize !== undefined) {
        if (!SIZES.includes(o.sheetSize as string)) fail('INVALID_ARGUMENT', `sheetSize must be one of ${SIZES.join(', ')}`);
        next.sheetSize = o.sheetSize as DrawingOptionsInfo['sheetSize'];
      }
      for (const k of ['hiddenLines', 'dimensions', 'gdt'] as const) {
        if (o[k] === undefined) continue;
        if (typeof o[k] !== 'boolean') fail('INVALID_ARGUMENT', `${k} must be true or false`);
        next[k] = o[k] as boolean;
      }
      get().setDrawingOptions(next);
      return clone(get().drawingOptions);
    },
    svg: () => sheetText('svg'),
    dxf: () => sheetText('dxf'),
    pdf: () => sheetText('pdf'),
  });

  return Object.freeze({
    on,
    off,
    macros,
    plugins,
    equations,
    configurations,
    assembly,
    drawings,
    version: API_VERSION,
    units: Object.freeze({ system: 'MMGS', length: 'mm', angle: 'deg', mass: 'kg', density: 'kg/m^3' } as const),
    document,
    sketches,
    features,
    model,
    materials,
    history,
    commands,
  });
}

export default createCasiWorksAPI;
