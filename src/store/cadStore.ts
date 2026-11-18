// CasiWorks Pro - Central state store (zustand + immer)
//
// Holds the document (features, sketches, material), UI state, undo/redo and
// the assembly. All edits go through these actions, so the UI and the public
// API (src/api) share one source of truth.
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Draft } from 'immer';
import * as THREE from 'three';
import { generateId, referencePlaneFrame } from '../utils/math.ts';
import { TOOLS, APP_MODES, DEFAULT_SETTINGS, FEATURE_TYPES, MATERIALS } from '../utils/constants.ts';
import type { AppMode, AppSettings, MateType, ToolId, ViewOrientation } from '../utils/constants.ts';
import { sanitizeDimensions } from '../drawings/associative.ts';
import type { DrawingDimension } from '../drawings/associative.ts';
import { assemblyManager } from '../assembly/AssemblyManager.ts';
import type { AssemblyComponent, MateOptions, MateRef } from '../assembly/AssemblyManager.ts';
import { safeDeepClone } from '../utils/clone.ts';
import { effectiveVariables, evaluateExpression, evaluateLinks, evaluateVariables } from '../features/equations.ts';
import type { MeasurePick } from '../kernel/measure.ts';
import { liveConstraints, solveSketch } from '../kernel/sketchSolve.ts';
import type { RelationKind } from '../kernel/sketchSolve.ts';
import type { SketchConstraint } from '../kernel/ConstraintSolver.ts';
import type { FeaProbe } from '../simulation/resultPlot.ts';
import type { Interference } from '../assembly/interference.ts';
import { analyzeDof } from '../assembly/dof.ts';
import type { DofReport } from '../assembly/dof.ts';
import { partShape } from '../assembly/partGeometry.ts';
import { remapRef } from '../assembly/facePick.ts';
import type { PickedFace } from '../assembly/facePick.ts';
import type { PartShape } from '../assembly/partGeometry.ts';
import type { Configuration, GlobalVariable } from '../features/equations.ts';
import type {
  ExampleModel,
  Feature,
  FeatureData,
  ProjectFile,
  RebuildError,
  SketchEntity,
  SketchEntityMap,
  SketchPlane,
  SketchPlaneRef,
  PlaneFrame,
  SketchFeature,
  ReferenceFeature,
} from '../types/cad.ts';
import type { Body, RebuildState } from '../features/rebuildModel.ts';
import type { ApiStoreState } from '../api/CasiWorksAPI.ts';
import type { ResultPlot } from '../simulation/resultPlot.ts';
import type { StudySetup } from '../simulation/studySetup.ts';

const MAX_UNDO_HISTORY = 40;

// =====================================================================
// Types
// =====================================================================

/** Built-in assembly primitives (until real part documents can be inserted, roadmap 4.2). */
export type PrimitiveShape = 'box' | 'cylinder' | 'flange' | 'pin';

export interface PrimitiveDims {
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
}

/** A part document or an assembly document. */
export type DocumentType = 'part' | 'assembly';

/**
 * Where a component's shape comes from when it is a part document (not a built-in shape).
 * The component holds a reference; `snapshot` is the part's content when it was last
 * resolved, used only when the part cannot be reached (then `linked` is 'cached').
 */
export interface PartSource {
  /** The part document's id (the same in its file, the workspace and the library copy of it). */
  documentId: string;
  /** The part's name when last resolved. */
  name: string;
  /** The library document it comes from; version null follows the newest version. */
  library?: { documentId: string; version: number | null };
  snapshot: string;
  /** partFingerprint of the snapshot. */
  fingerprint: string;
  /** How the shape was last resolved: an open document, the library, or only the cached copy. */
  linked: 'workspace' | 'library' | 'cached';
}

/** One step of an exploded view: these components move this far along this direction. */
export interface ExplodeStep {
  id: string;
  componentIds: string[];
  /** Unit direction in model coordinates. */
  direction: { x: number; y: number; z: number };
  /** mm */
  distance: number;
}

/** An assembly component as held by the store (primitive metadata added for save/load). */
export type StoreAssemblyComponent = AssemblyComponent & {
  geometryType?: PrimitiveShape;
  dimensions?: PrimitiveDims;
  /** Set when the component is a part document rather than a built-in shape. */
  source?: PartSource;
  /** Material key (MATERIALS); unset means the document material. */
  material?: string;
};

export type AssemblyMate = ReturnType<typeof assemblyManager.addMate>;

/** Sheet sizes the drawing sheet offers (keys of SHEET_SIZES in drawings/DrawingEngine.ts). */
export type DrawingSheetSize = 'A4_LANDSCAPE' | 'A4_PORTRAIT' | 'A3_LANDSCAPE' | 'ANSI_B';

/** What the 2D drawing sheet shows and exports. Shared by the Drawing tab and the sheet window. */
export interface DrawingOptions {
  /** What the sheet shows: the part (first body), or the assembly with its parts list and balloons. */
  subject: 'part' | 'assembly';
  sheetSize: DrawingSheetSize;
  /** Hidden line removal: drop edges that are behind faces. */
  hiddenLines: boolean;
  /** Dimensions: overall sizes, hole callouts and the dimensions placed on the sheet. */
  dimensions: boolean;
  /** Datum symbol and feature control frame. */
  gdt: boolean;
}

/** Exploded-view display settings. Display only: components keep their real positions. */
export interface ExplodedViewSettings {
  /** Base explosion step (mm); later components move further. */
  distance: number;
  /** Draw a dashed line from each component's real position to its exploded one. */
  leaderLines: boolean;
  /** How far through the explode steps (0 collapsed … 1 fully exploded); only with steps. Default 1. */
  progress?: number;
}

/** A component as written to a project file. */
interface SerializedComponent {
  id: string;
  name: string;
  isFixed: boolean;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
  geometryType: PrimitiveShape;
  dimensions: PrimitiveDims;
  material?: string;
  source?: Omit<PartSource, 'linked'>;
}

/** Something selected in the viewport or tree. */
export type SelectedEntity = { id: string } & Record<string, unknown>;

/** What the property panel is editing (feature type plus context such as featureId). */
export type PropertyPanelContent = { type: string } & Record<string, unknown>;

/** Document snapshot stored on the undo/redo stacks. */
interface DocumentSnapshot {
  features: Feature[];
  sketchEntities: SketchEntityMap;
  sketchConstraints: Record<string, unknown[]>;
  sketchDimensions: Record<string, unknown[]>;
  rollbackIndex: number;
  activeMaterial: string;
  variables: GlobalVariable[];
  configurations: Configuration[];
  activeConfiguration: string | null;
  drawingDimensions?: DrawingDimension[];
}

interface UndoEntry {
  actionName?: string;
  snapshot: DocumentSnapshot;
}

/**
 * A document in the local library: `opened` is the version whose content this
 * is; `version` is the newest version when it was opened or saved, which the
 * next save builds on (a save refused if someone saved after it).
 */
export interface LibraryRef {
  documentId: string;
  name: string;
  /** The newest version when opened or saved (the base the next save builds on). */
  version: number;
  /** The version that was opened (or saved). */
  opened: number;
  /** Lifecycle state when last seen ('draft' | 'in_review' | 'released' | 'obsolete'). */
  state?: string;
}

export interface CADState {
  appMode: AppMode;

  // Document
  /** Identifies the document (kept in its file), so assemblies can reference parts. */
  documentId: string;
  documentType: DocumentType;
  documentName: string;
  isModified: boolean;
  /** The library document and version this was opened from or last saved as (local server), if any. */
  libraryRef: LibraryRef | null;

  // Tools and selection
  activeTool: ToolId;
  selectedEntities: SelectedEntity[];

  // Feature tree (rollbackIndex -1 = end of tree)
  features: Feature[];
  activeFeatureIndex: number;
  rollbackIndex: number;

  // Sketching
  isSketchActive: boolean;
  activeSketchId: string | null;
  /** Sides of the sketch polygon tool. */
  sketchPolygonSides: number;
  /** Distance (mm) the sketch Offset tool uses. */
  sketchOffsetDistance: number;
  /** The relation the sketch Relation tool adds. */
  sketchRelationKind: RelationKind;
  /** The document as it was when the current sketch session began (for discard and undo). */
  sketchSession: DocumentSnapshot | null;
  /** The plane of the sketch being edited: a standard plane or any plane frame. */
  activeSketchPlane: SketchPlaneRef;
  /** The reference plane feature the active sketch lies on, if any. */
  activeSketchPlaneRef: string | null;
  /** Set when the view looks straight at a plane that is not a standard one (sketch on a face or reference plane). */
  viewFrame: PlaneFrame | null;
  sketchEntities: SketchEntityMap;
  sketchConstraints: Record<string, unknown[]>;
  sketchDimensions: Record<string, unknown[]>;
  snapEnabled: boolean;
  constructionMode: boolean;

  // Model
  bodies: Body[];
  /** FEA result plot shown on the model instead of the bodies (null: show the bodies). */
  feaPlot: ResultPlot | null;
  /** FEA study setup to mark on the model (fixed face, load arrows); null hides the markers. */
  /** The study shown on the model while the FEA panel is open (fixedOnly: a modal study, no load). */
  feaSetupMarkers: (StudySetup & { fixedOnly?: boolean }) | null;
  activeMaterial: string;

  // View
  viewOrientation: ViewOrientation;
  /** Bumped on every view request, so asking for the current view again re-aims the camera. */
  viewRequest: number;
  showOrigin: boolean;
  showPlanes: boolean;
  showGrid: boolean;
  showAxes: boolean;
  shadedMode: boolean;
  edgeDisplay: boolean;
  wireframeMode: boolean;
  perspectiveView: boolean;
  sectionViewActive: boolean;

  // Panels and status
  propertyPanelOpen: boolean;
  propertyPanelContent: PropertyPanelContent | null;
  activeCommandTab: string;
  statusMessage: string;
  settings: AppSettings;

  // Undo / redo
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // Assembly
  assemblyComponents: StoreAssemblyComponent[];
  mates: AssemblyMate[];
  /** Set while the assembly is shown exploded; null when collapsed. */
  explodedView: ExplodedViewSettings | null;
  /** Faces picked with the Mate tool (at most two). Not saved. */
  matePicks: Array<{ componentId: string; face: PickedFace }>;
  /** The explode steps (saved with the document); empty uses the automatic explode. */
  explodeSteps: ExplodeStep[];
  /** Degrees of freedom after the last assembly change (null for an empty assembly). */
  assemblyDof: DofReport | null;
  /**
   * The last interference check: the overlaps (with their solids, for display) and
   * the component list it was made for. It is out of date when the assembly changes.
   */
  interference: { results: Interference[]; components: unknown[] } | null;
  /** FEA result probes (values at picked mesh nodes); shown while the result plot is. Not saved. */
  feaProbes: FeaProbe[];
  /** The active sketch's solve state: fully / under / over defined, for the status bar and colours. */
  sketchSolveState: { state: 'fully' | 'under' | 'over' | 'failed'; message: string; dof: number } | null;
  /** Points picked with the Measure tool (at most two; a third click starts again). Not saved. */
  measurePicks: MeasurePick[];
  /** Global variables (equations), saved with the project. */
  variables: GlobalVariable[];
  /** Named variants that override variable values (design table). */
  configurations: Configuration[];
  /** The configuration in use; null is Default (the plain variable values). */
  activeConfiguration: string | null;
  /** Drawing sheet display options (a session preference, not saved in the project). */
  drawingOptions: DrawingOptions;
  /** Dimensions placed on the drawing sheet, attached to the model (saved with the document). */
  drawingDimensions: DrawingDimension[];

  // Rebuild
  needsRebuild: boolean;
  /** Incremented after every completed rebuild (for change listeners). */
  rebuildCount: number;
  /** Incremented when the whole document is replaced: new, open, example (for change listeners). */
  documentRevision: number;
  rebuildErrors: RebuildError[];
}

export interface CADActions {
  /** Push the current document onto the undo stack (call inside a set() producer). */
  _captureUndoSnapshot(state: Draft<CADStore>, actionName?: string): void;

  // Tools and selection
  setActiveTool(tool: ToolId): void;
  cancelTool(): void;
  setSelection(entities: SelectedEntity | SelectedEntity[]): void;
  addToSelection(entity: SelectedEntity): void;
  removeFromSelection(entityId: string): void;
  clearSelection(): void;

  // Features
  addFeature(feature: FeatureData): void;
  updateFeature(featureId: string, updates: Record<string, unknown>): void;
  removeFeature(featureId: string): void;
  toggleFeatureVisibility(featureId: string): void;
  toggleFeatureSuppressed(featureId: string): void;
  setRollbackIndex(index: number): void;
  setActiveFeature(index: number): void;

  // Sketches
  /** Start a sketch on a standard plane, a plane frame (e.g. a face), or a reference plane feature (`planeRef`). */
  startSketch(plane?: SketchPlaneRef, planeRef?: string | null): void;
  endSketch(confirm?: boolean): void;
  addSketchEntity(entity: SketchEntity): void;
  removeSketchEntity(entityId: string): void;
  /**
   * Set a sketch's relations and dimensions and solve it. Nothing changes when they
   * cannot all be met; the reason is returned (null on success). The active sketch's
   * changes belong to its session (Discard undoes them); other sketches get an undo step.
   */
  applySketchConstraints(sketchId: string, constraints: SketchConstraint[], label?: string): string | null;
  /** Re-solve the active sketch and refresh sketchSolveState (e.g. after drawing). */
  refreshSketchSolve(): void;
  createSketchFeature(spec: { id: string; sketchId: string; plane?: SketchPlane; frame?: PlaneFrame; planeRef?: string; entities?: SketchEntity[]; name?: string }): void;
  /** Replace a sketch's geometry (one undoable step). */
  setSketchEntities(sketchId: string, entities: SketchEntity[]): void;
  toggleConstructionMode(): void;
  editSketch(featureId: string): void;

  // Model, material, view
  setBodies(bodies: Body[]): void;
  setFeaPlot(plot: ResultPlot | null): void;
  setFeaSetupMarkers(setup: (StudySetup & { fixedOnly?: boolean }) | null): void;
  setSketchPolygonSides(sides: number): void;
  setSketchOffsetDistance(distance: number): void;
  setSketchRelationKind(kind: RelationKind): void;
  /** Replace the geometry of the sketch being edited (trim, extend, offset, mirror); part of the sketch session. */
  replaceActiveSketchEntities(entities: SketchEntity[], message?: string): void;
  setMaterial(materialKey: string): void;
  setViewOrientation(orientation: ViewOrientation): void;
  toggleGrid(): void;
  toggleSnap(): void;
  toggleOrigin(): void;
  togglePlanes(): void;
  toggleAxes(): void;
  toggleShaded(): void;
  toggleEdges(): void;
  toggleWireframe(): void;
  togglePerspective(): void;
  toggleSectionView(): void;

  // Panels and status
  openPropertyPanel(content: PropertyPanelContent): void;
  closePropertyPanel(): void;
  setCommandTab(tab: string): void;
  setStatus(message: string): void;
  /** Note the library document and version now open (null: not from the library); a save also clears the modified mark. */
  setLibraryRef(ref: LibraryRef | null, saved?: boolean): void;

  // Undo / redo / rebuild
  undo(): void;
  redo(): void;
  markRebuilt(errors?: RebuildError[]): void;
  rebuild(): void;

  // Assembly
  insertAssemblyPart(name: string, shapeType?: PrimitiveShape, dims?: PrimitiveDims): void;
  /** Insert a part document as a component (by reference); returns the component id. */
  insertPartComponent(shape: PartShape, source: Omit<PartSource, 'fingerprint'>, name?: string): string;
  /** Give referenced components their part's current shape (placement and mates kept), then solve. */
  updatePartComponents(updates: Array<{ componentId: string; shape: PartShape | null; source: PartSource }>): void;
  removeAssemblyComponent(componentId: string): void;
  /** Set a distance (mm) or angle (degrees) mate's value and solve: motion along the mates. */
  driveMate(mateId: string, value: number): { converged: boolean; error: number };
  setExplodeSteps(steps: ExplodeStep[]): void;
  /** Add a face picked with the Mate tool; the second opens the mate panel. */
  addMatePick(pick: { componentId: string; face: PickedFace }): void;
  clearMatePicks(): void;
  /** A part document or an empty assembly document. */
  setDocumentType(type: DocumentType): void;
  addAssemblyMate(type: MateType, comp1Id: string, ref1: MateRef, comp2Id: string, ref2: MateRef, offset?: number, extra?: MateOptions): void;
  removeAssemblyMate(mateId: string): void;
  solveAssembly(): void;
  clearAssembly(): void;
  /** Give components their own material (a MATERIALS key), or null to use the document material again. */
  setComponentMaterial(componentIds: string[], material: string | null): void;
  setExplodedView(settings: ExplodedViewSettings | null): void;
  setDrawingOptions(options: Partial<DrawingOptions>): void;
  addDrawingDimension(dimension: DrawingDimension): void;
  /** False when there is no dimension with that id. */
  removeDrawingDimension(id: string): boolean;
  /** Replace the global variables and update every parameter linked to them (one undo step). */
  setVariables(variables: GlobalVariable[]): void;
  /** Add an FEA probe (a node already probed is not added twice; at most 12, oldest dropped). */
  setInterference(results: Interference[] | null): void;
  addFeaProbe(probe: FeaProbe): void;
  clearFeaProbes(): void;
  /** Add a Measure pick; after two, the next one starts a new measurement. */
  addMeasurePick(pick: MeasurePick): void;
  clearMeasure(): void;
  /** Replace the configurations (one undo step); the active one stays active if it still exists. */
  setConfigurations(configurations: Configuration[]): void;
  /** Switch to a configuration (null = Default); linked sizes update and the part rebuilds. */
  activateConfiguration(name: string | null): void;

  // Documents
  saveProject(): string;
  /** Load a .casiproj document (JSON text or parsed object). Invalid input leaves the document unchanged. */
  loadProject(project: string | object): void;
  loadExampleModel(example: ExampleModel): void;
  newProject(): void;
  setDocumentName(name: string): void;
}

export type CADStore = CADState & CADActions;

// =====================================================================
// Pure helpers
// =====================================================================

const sketchIdOf = (f: FeatureData): string | undefined => ('sketchId' in f ? f.sketchId : undefined);

/**
 * Bring sketch entities loaded from older files to the canonical format.
 * Points used to be stored as { p1: {x, y} } by the viewport; the canonical
 * point format is flat { x, y } (what DXF import/export read and write).
 */
export function normalizeSketchEntities(sketchEntities: Record<string, unknown> | null | undefined): SketchEntityMap {
  const map = (sketchEntities || {}) as Record<string, unknown>;
  for (const entities of Object.values(map)) {
    if (!Array.isArray(entities)) continue;
    for (const e of entities as Array<Record<string, unknown> | null>) {
      const p1 = e?.p1 as { x: number; y: number } | undefined;
      if (e && e.type === 'point' && e.x === undefined && p1) {
        e.x = p1.x;
        e.y = p1.y;
        delete e.p1;
      }
    }
  }
  return map as SketchEntityMap;
}

/**
 * Normalize the feature dependency graph in place.
 * Features from examples, older project files, or the starter part may lack
 * parentIds/childIds. Missing parentIds are derived from sketchId/toolFeatureId,
 * and childIds are always rebuilt from parentIds so the two never drift apart.
 */
export function ensureFeatureGraph(features: FeatureData[]): Feature[] {
  const byId = new Map(features.map(f => [f.id, f]));
  for (const f of features) {
    if (!Array.isArray(f.parentIds)) {
      const parents: string[] = [];
      const sketchId = sketchIdOf(f);
      if (f.type !== FEATURE_TYPES.SKETCH && sketchId) {
        const sketch = features.find(s => s.type === FEATURE_TYPES.SKETCH && s.sketchId === sketchId);
        if (sketch) parents.push(sketch.id);
      }
      if (f.type === FEATURE_TYPES.BOOLEAN && f.toolFeatureId && byId.has(f.toolFeatureId)) parents.push(f.toolFeatureId);
      f.parentIds = parents;
    }
    f.childIds = [];
  }
  const linked = features as Feature[];
  for (const f of linked) {
    for (const pid of f.parentIds) {
      const p = byId.get(pid) as Feature | undefined;
      if (p && !p.childIds.includes(f.id)) p.childIds.push(f.id);
    }
  }
  return linked;
}

/** Geometry for a built-in assembly primitive. */
function primitiveGeometry(shape: PrimitiveShape, dims: PrimitiveDims): THREE.BufferGeometry {
  switch (shape) {
    case 'cylinder': {
      const r = dims.radius || 10;
      return new THREE.CylinderGeometry(r, r, dims.height || 30, 32);
    }
    case 'flange':
      return new THREE.CylinderGeometry(25, 25, 8, 32);
    case 'pin':
      return new THREE.CylinderGeometry(6, 6, 40, 32);
    case 'box':
    default:
      return new THREE.BoxGeometry(dims.width || 30, dims.height || 20, dims.depth || 30);
  }
}

function snapshotOf(state: Draft<CADStore>): DocumentSnapshot {
  return {
    features: safeDeepClone(state.features as Feature[]),
    sketchEntities: safeDeepClone(state.sketchEntities as SketchEntityMap),
    sketchConstraints: safeDeepClone(state.sketchConstraints as Record<string, unknown[]>),
    sketchDimensions: safeDeepClone(state.sketchDimensions as Record<string, unknown[]>),
    rollbackIndex: state.rollbackIndex,
    activeMaterial: state.activeMaterial,
    variables: safeDeepClone(state.variables as GlobalVariable[]),
    configurations: safeDeepClone(state.configurations as Configuration[]),
    activeConfiguration: state.activeConfiguration,
    drawingDimensions: safeDeepClone(state.drawingDimensions as DrawingDimension[]),
  };
}

function restoreSnapshot(state: Draft<CADStore>, s: DocumentSnapshot): void {
  state.features = (s.features || []) as Draft<Feature>[];
  state.sketchEntities = (s.sketchEntities || {}) as Draft<SketchEntityMap>;
  state.sketchConstraints = s.sketchConstraints || {};
  state.sketchDimensions = s.sketchDimensions || {};
  state.rollbackIndex = s.rollbackIndex ?? -1;
  state.activeMaterial = s.activeMaterial || 'Steel_1020';
  state.variables = s.variables ?? [];
  state.configurations = (s.configurations ?? []) as Draft<Configuration>[];
  state.activeConfiguration = s.activeConfiguration ?? null;
  state.drawingDimensions = s.drawingDimensions ?? [];
  state.needsRebuild = true;
}

/** Point the camera straight at a sketch plane (standard views for standard planes). */
function lookAtSketchPlane(state: Draft<CADStore>, plane: SketchPlaneRef): void {
  if (typeof plane === 'string') {
    state.viewFrame = null;
    state.viewOrientation = plane === 'Top' ? 'top' : plane === 'Right' ? 'right' : 'front';
  } else {
    state.viewFrame = safeDeepClone(plane) as Draft<PlaneFrame>;
  }
  state.viewRequest += 1;
}

/**
 * Write the values of equation-driven parameters into their features.
 * Links that do not evaluate keep the last good number (the Equations dialog shows why).
 */
function applyEquations(state: Draft<CADStore>): void {
  const hasDimLinks = Object.values(state.sketchConstraints).some(list => (list as Array<{ expression?: string }>).some(c => c.expression));
  if (state.variables.length === 0 && !hasDimLinks && !state.features.some(f => f.expressions && Object.keys(f.expressions).length)) return;
  const config = state.configurations.find(c => c.name === state.activeConfiguration) as Configuration | undefined;
  const { values } = evaluateVariables(effectiveVariables(state.variables as GlobalVariable[], config));
  if (hasDimLinks) applyDimensionEquations(state, values);
  const { updates } = evaluateLinks(state.features as Feature[], values);
  for (const f of state.features) {
    const u = updates[f.id];
    if (!u) continue;
    for (const [k, v] of Object.entries(u)) {
      // "position.x" reaches into a grouped parameter
      const path = k.split('.');
      let target = f as unknown as Record<string, unknown>;
      for (const part of path.slice(0, -1)) {
        const next = target[part];
        if (!next || typeof next !== 'object') { target = {}; break; }
        target = next as Record<string, unknown>;
      }
      const last = path[path.length - 1];
      if (target[last] !== v && last in target) {
        target[last] = v;
        state.needsRebuild = true;
      }
    }
  }
}

/**
 * Sketch dimensions linked to expressions: new values, then each changed sketch
 * is solved again. A sketch that cannot be solved keeps its geometry and values.
 */
function applyDimensionEquations(state: Draft<CADStore>, values: Record<string, number>): void {
  for (const [sketchId, list] of Object.entries(state.sketchConstraints)) {
    const constraints = list as Array<SketchConstraint & { expression?: string; diameter?: boolean }>;
    let changed = false;
    const next = constraints.map(c => {
      if (c.type !== 'dimension' || !c.expression) return c;
      let v: number;
      try { v = evaluateExpression(c.expression, values); } catch { return c; }
      if (!(v > 0)) return c;
      const stored = c.diameter ? v / 2 : v;
      if (Math.abs((c.value ?? 0) - stored) < 1e-12) return c;
      changed = true;
      return { ...c, value: stored };
    });
    if (!changed) continue;
    const solved = solveSketch(JSON.parse(JSON.stringify(state.sketchEntities[sketchId] ?? [])), JSON.parse(JSON.stringify(next)));
    if (!solved.ok) continue;
    state.sketchEntities[sketchId] = solved.entities as Draft<SketchEntity>[];
    state.sketchConstraints[sketchId] = JSON.parse(JSON.stringify(next));
    state.needsRebuild = true;
  }
}

/** Insert a feature after the rollback bar (if rolled back) or at the end. Returns its index. */
function insertFeature(state: Draft<CADStore>, feature: Feature): number {
  const isRolledBack = state.rollbackIndex >= 0 && state.rollbackIndex < state.features.length - 1;
  const index = isRolledBack ? state.rollbackIndex + 1 : state.features.length;
  state.features.splice(index, 0, feature as Draft<Feature>);
  state.rollbackIndex = index;
  return index;
}

/** The degrees of freedom of the assembly singleton (null when empty; skipped for very large assemblies). */
function dofNow(): DofReport | null {
  const comps = assemblyManager.components;
  if (comps.length === 0 || comps.filter(c => !c.isFixed).length > 40) return null;
  try { return analyzeDof(comps, assemblyManager.mates); } catch { return null; }
}

/** Copy the assembly singleton into the store and refresh its degrees of freedom. */
function syncAssembly(state: Draft<CADStore>): void {
  state.assemblyComponents = [...assemblyManager.components] as Draft<StoreAssemblyComponent>[];
  state.mates = [...assemblyManager.mates] as Draft<AssemblyMate>[];
  state.assemblyDof = dofNow() as Draft<DofReport> | null;
}

/** The status line after a solve. */
function solveMessage(res: { converged: boolean; error: number }): string {
  return res.converged
    ? `Assembly solved (residual: ${(res.error ?? 0).toFixed(5)})`
    : `Mates not satisfied — they may conflict (largest error: ${(res.error ?? 0).toFixed(3)})`;
}

/** A placeholder shape for a referenced part that cannot be rebuilt (so the assembly still opens). */
function missingPartGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(20, 20, 20);
}

function initialState(): CADState {
  return {
    appMode: APP_MODES.PART,
    documentId: generateId('doc'),
    documentType: 'part',
    documentName: 'Untitled Part',
    isModified: false,
    libraryRef: null,
    activeTool: TOOLS.SELECT,
    selectedEntities: [],
    features: [],
    activeFeatureIndex: -1,
    rollbackIndex: -1,
    isSketchActive: false,
    activeSketchId: null,
    sketchPolygonSides: 6,
    sketchOffsetDistance: 5,
    sketchRelationKind: 'horizontal',
    sketchSession: null,
    activeSketchPlane: 'Front',
    activeSketchPlaneRef: null,
    viewFrame: null,
    sketchEntities: {},
    sketchConstraints: {},
    sketchDimensions: {},
    snapEnabled: true,
    constructionMode: false,
    bodies: [],
    feaPlot: null,
    feaSetupMarkers: null,
    activeMaterial: 'Steel_1020',
    viewOrientation: 'isometric',
    viewRequest: 0,
    showOrigin: true,
    showPlanes: true,
    showGrid: true,
    showAxes: true,
    shadedMode: true,
    edgeDisplay: true,
    wireframeMode: false,
    perspectiveView: true,
    sectionViewActive: false,
    propertyPanelOpen: false,
    propertyPanelContent: null,
    activeCommandTab: 'Features',
    statusMessage: 'Ready',
    settings: { ...DEFAULT_SETTINGS },
    undoStack: [],
    redoStack: [],
    assemblyComponents: [],
    mates: [],
    explodedView: null,
    explodeSteps: [],
    matePicks: [],
    assemblyDof: null,
    measurePicks: [],
    interference: null,
    sketchSolveState: null,
    feaProbes: [],
    variables: [],
    configurations: [],
    activeConfiguration: null,
    drawingOptions: { subject: 'part', sheetSize: 'A4_LANDSCAPE', hiddenLines: true, dimensions: true, gdt: true },
    drawingDimensions: [],
    needsRebuild: false,
    rebuildCount: 0,
    documentRevision: 0,
    rebuildErrors: [],
  };
}

// =====================================================================
// Store
// =====================================================================

export const useCADStore = create<CADStore>()(
  immer((set, get) => ({
    ...initialState(),

    _captureUndoSnapshot: (state, actionName = 'Action') => {
      state.undoStack.push({ actionName, snapshot: snapshotOf(state) as Draft<DocumentSnapshot> });
      if (state.undoStack.length > MAX_UNDO_HISTORY) state.undoStack.shift();
      state.redoStack = [];
      state.isModified = true;
    },

    // ==================== TOOLS AND SELECTION ====================
    setActiveTool: (tool) => set(state => {
      if (state.activeTool !== tool) { state.measurePicks = []; state.matePicks = []; }
      state.activeTool = tool;
      state.statusMessage = tool === TOOLS.ASSEMBLY_MATE
        ? 'Mate: pick a face on the first component'
        : `Tool: ${tool.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`;
    }),

    cancelTool: () => set(state => {
      state.activeTool = TOOLS.SELECT;
      state.measurePicks = [];
      state.matePicks = [];
      state.propertyPanelOpen = false;
      state.propertyPanelContent = null;
      state.statusMessage = 'Ready';
    }),

    setSelection: (entities) => set(state => {
      state.selectedEntities = Array.isArray(entities) ? entities : [entities];
    }),

    addToSelection: (entity) => set(state => {
      if (!state.selectedEntities.some(e => e.id === entity.id)) state.selectedEntities.push(entity);
    }),

    removeFromSelection: (entityId) => set(state => {
      state.selectedEntities = state.selectedEntities.filter(e => e.id !== entityId);
    }),

    clearSelection: () => set(state => {
      state.selectedEntities = [];
    }),

    // ==================== FEATURES ====================
    addFeature: (feature) => set(state => {
      get()._captureUndoSnapshot(state, `Add ${feature.name || feature.type}`);
      ensureFeatureGraph(state.features as FeatureData[]);

      // The parent is the sketch feature, never another consumer of the same sketch
      const parentIds: string[] = [];
      const sketchId = sketchIdOf(feature);
      if (sketchId) {
        const parentSketch = state.features.find(f =>
          f.type === FEATURE_TYPES.SKETCH && (f.sketchId === sketchId || f.id === sketchId));
        if (parentSketch) parentIds.push(parentSketch.id);
      }
      if (feature.type === FEATURE_TYPES.BOOLEAN && feature.toolFeatureId) parentIds.push(feature.toolFeatureId);

      const newFeature = {
        timestamp: Date.now(),
        visible: true,
        suppressed: false,
        ...feature,
        id: feature.id || generateId('feat'),
        parentIds,
        childIds: [],
      } as Feature;

      for (const pid of parentIds) {
        const p = state.features.find(f => f.id === pid);
        if (p && !p.childIds.includes(newFeature.id)) p.childIds.push(newFeature.id);
      }

      state.activeFeatureIndex = insertFeature(state, newFeature);
      applyEquations(state);
      state.needsRebuild = true;
      state.statusMessage = `Added ${newFeature.name}`;
    }),

    updateFeature: (featureId, updates) => set(state => {
      const feature = state.features.find(f => f.id === featureId);
      if (!feature) return;
      get()._captureUndoSnapshot(state, `Update ${feature.name}`);
      Object.assign(feature, updates);
      applyEquations(state);
      state.needsRebuild = true;
      state.statusMessage = `Updated ${feature.name}`;
    }),

    removeFeature: (featureId) => set(state => {
      const index = state.features.findIndex(f => f.id === featureId);
      if (index === -1) return;
      get()._captureUndoSnapshot(state, `Delete ${state.features[index].name}`);
      ensureFeatureGraph(state.features as FeatureData[]);

      const feat = state.features[index];
      for (const pid of feat.parentIds) {
        const p = state.features.find(f => f.id === pid);
        if (p) p.childIds = p.childIds.filter(cid => cid !== featureId);
      }

      // Deleting a sketch also deletes its geometry
      if (feat.type === FEATURE_TYPES.SKETCH) {
        delete state.sketchEntities[feat.sketchId];
        delete state.sketchConstraints[feat.sketchId];
        delete state.sketchDimensions[feat.sketchId];
      }

      state.features.splice(index, 1);
      if (state.rollbackIndex >= state.features.length) state.rollbackIndex = state.features.length - 1;
      state.needsRebuild = true;
      state.statusMessage = 'Feature deleted';
    }),

    toggleFeatureVisibility: (featureId) => set(state => {
      const feat = state.features.find(f => f.id === featureId);
      if (feat) feat.visible = !feat.visible;
    }),

    // Suppression cascades down to dependents; unsuppression cascades up to parents
    toggleFeatureSuppressed: (featureId) => set(state => {
      const feat = state.features.find(f => f.id === featureId);
      if (!feat) return;

      get()._captureUndoSnapshot(state, `Toggle Suppress ${feat.name}`);
      ensureFeatureGraph(state.features as FeatureData[]);
      const willSuppress = !feat.suppressed;
      feat.suppressed = willSuppress;

      const queue = [...(willSuppress ? feat.childIds : feat.parentIds)];
      while (queue.length > 0) {
        const nextId = queue.shift();
        const next = state.features.find(f => f.id === nextId);
        if (!next) continue;
        next.suppressed = willSuppress;
        queue.push(...(willSuppress ? next.childIds : next.parentIds));
      }

      state.needsRebuild = true;
      state.statusMessage = willSuppress ? `Suppressed ${feat.name}` : `Unsuppressed ${feat.name}`;
    }),

    setRollbackIndex: (index) => set(state => {
      const clamped = Math.max(-1, Math.min(state.features.length - 1, index));
      state.rollbackIndex = clamped;
      state.needsRebuild = true;
      state.statusMessage = clamped === -1 || clamped === state.features.length - 1
        ? 'Rollback bar at end of tree'
        : `Rolled back to feature ${clamped + 1}`;
    }),

    setActiveFeature: (index) => set(state => {
      state.activeFeatureIndex = index;
    }),

    // ==================== SKETCHES ====================
    startSketch: (plane = 'Front', planeRef = null) => set(state => {
      state.sketchSession = snapshotOf(state) as Draft<DocumentSnapshot>;
      const sketchId = generateId('sketch');
      state.isSketchActive = true;
      state.activeSketchId = sketchId;
      state.activeSketchPlane = plane as Draft<SketchPlaneRef>;
      state.activeSketchPlaneRef = planeRef;
      state.sketchEntities[sketchId] = [];
      state.sketchConstraints[sketchId] = [];
      state.sketchDimensions[sketchId] = [];
      state.activeTool = TOOLS.SKETCH_LINE;
      state.activeCommandTab = 'Sketch';
      // Look straight at the sketch plane, as CAD systems do
      lookAtSketchPlane(state, plane);
      const refName = planeRef ? state.features.find(f => f.id === planeRef)?.name : null;
      state.statusMessage = `Sketching on ${refName ?? (typeof plane === 'string' ? `${plane} plane` : 'the picked face')} (Select tools or draw)`;
    }),

    endSketch: (confirm = true) => set(state => {
      const sketchId = state.activeSketchId;
      if (!sketchId) return;

      const exists = state.features.some(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId);
      // Sketch edits are applied live; the session snapshot is the document before them
      const session = state.sketchSession as DocumentSnapshot | null;
      if (confirm && (state.sketchEntities[sketchId]?.length ?? 0) > 0) {
        get()._captureUndoSnapshot(state, exists ? 'Edit Sketch' : 'Create Sketch');
        if (session) state.undoStack[state.undoStack.length - 1].snapshot = session as Draft<DocumentSnapshot>;
        if (!exists) {
          insertFeature(state, {
            id: generateId('feat_sketch'),
            type: FEATURE_TYPES.SKETCH,
            name: `Sketch${state.features.filter(f => f.type === FEATURE_TYPES.SKETCH).length + 1}`,
            sketchId,
            // A sketch on a reference plane or a face keeps that plane
            plane: typeof state.activeSketchPlane === 'string' ? state.activeSketchPlane : 'Front',
            ...(state.activeSketchPlaneRef
              ? { planeRef: state.activeSketchPlaneRef }
              : typeof state.activeSketchPlane === 'string' ? {} : { frame: safeDeepClone(state.activeSketchPlane as PlaneFrame) }),
            visible: true,
            suppressed: false,
            parentIds: state.activeSketchPlaneRef ? [state.activeSketchPlaneRef] : [],
            childIds: [],
          });
          if (state.activeSketchPlaneRef) {
            const ref = state.features.find(f => f.id === state.activeSketchPlaneRef);
            const created = state.features.find(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId);
            if (ref && created && !ref.childIds.includes(created.id)) ref.childIds.push(created.id);
          }
        }
      } else if (!confirm) {
        if (exists && session) {
          // Discarding edits to an existing sketch restores it (it used to delete its geometry)
          state.sketchEntities[sketchId] = (session.sketchEntities[sketchId] ?? []) as Draft<SketchEntity>[];
          state.sketchConstraints[sketchId] = (session.sketchConstraints[sketchId] ?? []) as Draft<unknown>[];
          state.sketchDimensions[sketchId] = (session.sketchDimensions[sketchId] ?? []) as Draft<unknown>[];
        } else if (!exists) {
          delete state.sketchEntities[sketchId];
          delete state.sketchConstraints[sketchId];
          delete state.sketchDimensions[sketchId];
        }
      }
      state.sketchSession = null;

      state.isSketchActive = false;
      state.activeSketchId = null;
      state.sketchSolveState = null;
      state.constructionMode = false;
      state.activeTool = TOOLS.SELECT;
      state.activeCommandTab = 'Features';
      state.statusMessage = 'Sketch closed. Ready to Extrude/Revolve.';
      state.needsRebuild = true;
    }),

    addSketchEntity: (entity) => set(state => {
      const sketchId = state.activeSketchId;
      if (!sketchId) return;
      (state.sketchEntities[sketchId] ??= []).push({
        construction: state.constructionMode,
        ...entity,
        id: entity.id || generateId('ent'),
      });
      state.isModified = true;
    }),

    removeSketchEntity: (entityId) => set(state => {
      const sketchId = state.activeSketchId;
      if (!sketchId || !state.sketchEntities[sketchId]) return;
      state.sketchEntities[sketchId] = state.sketchEntities[sketchId].filter(e => e.id !== entityId);
    }),

    applySketchConstraints: (sketchId, constraints, label) => {
      const st = get();
      const entities = (st.sketchEntities[sketchId] ?? []) as SketchEntity[];
      const live = liveConstraints(entities, constraints);
      const solved = solveSketch(entities, live);
      if (!solved.ok) return solved.message;
      // A relation or dimension the others already imply would only make the sketch over defined
      if (solved.state === 'over' && solveSketch(entities, (st.sketchConstraints[sketchId] ?? []) as SketchConstraint[]).state !== 'over') {
        return `It is already fixed by the other relations and dimensions${solved.result.redundant ? ` (${solved.result.redundant.message})` : ''}`;
      }
      const active = st.activeSketchId === sketchId;
      set(state => {
        if (!active) get()._captureUndoSnapshot(state, label ?? 'Edit Sketch Relations');
        state.sketchEntities[sketchId] = solved.entities as Draft<SketchEntity>[];
        state.sketchConstraints[sketchId] = safeDeepClone(live) as Draft<unknown>[];
        state.isModified = true;
        if (active) state.sketchSolveState = { state: solved.state, message: solved.message, dof: solved.result.dof };
        else state.needsRebuild = true;
        state.statusMessage = label ? `${label}: ${solved.message}` : solved.message;
      });
      return null;
    },

    refreshSketchSolve: () => {
      const st = get();
      const sketchId = st.activeSketchId;
      if (!sketchId) { set(state => { state.sketchSolveState = null; }); return; }
      const entities = (st.sketchEntities[sketchId] ?? []) as SketchEntity[];
      const constraints = liveConstraints(entities, (st.sketchConstraints[sketchId] ?? []) as SketchConstraint[]);
      const solved = solveSketch(entities, constraints);
      set(state => {
        // Drop relations whose entities were deleted or trimmed away
        state.sketchConstraints[sketchId] = safeDeepClone(constraints) as Draft<unknown>[];
        state.sketchSolveState = { state: solved.state, message: solved.message, dof: solved.result.dof };
      });
    },

    setSketchEntities: (sketchId, entities) => set(state => {
      if (!state.features.some(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId)) return;
      get()._captureUndoSnapshot(state, 'Edit Sketch');
      state.sketchEntities[sketchId] = safeDeepClone(entities) as Draft<SketchEntity>[];
      state.needsRebuild = true;
    }),

    createSketchFeature: ({ id, sketchId, plane = 'Front', frame, planeRef, entities = [], name }) => set(state => {
      get()._captureUndoSnapshot(state, `Create ${name || 'Sketch'}`);
      state.sketchEntities[sketchId] = entities as Draft<SketchEntity>[];
      state.sketchConstraints[sketchId] ??= [];
      state.sketchDimensions[sketchId] ??= [];
      const featureName = name || `Sketch${state.features.filter(f => f.type === FEATURE_TYPES.SKETCH).length + 1}`;
      insertFeature(state, {
        id,
        type: FEATURE_TYPES.SKETCH,
        name: featureName,
        sketchId,
        plane,
        ...(planeRef ? { planeRef } : frame ? { frame: safeDeepClone(frame) } : {}),
        visible: true,
        suppressed: false,
        parentIds: planeRef ? [planeRef] : [],
        childIds: [],
      });
      if (planeRef) {
        const ref = state.features.find(f => f.id === planeRef);
        if (ref && !ref.childIds.includes(id)) ref.childIds.push(id);
      }
      state.needsRebuild = true;
      state.statusMessage = `Created ${featureName}`;
    }),

    toggleConstructionMode: () => set(state => {
      state.constructionMode = !state.constructionMode;
    }),

    editSketch: (featureId) => set(state => {
      const feature = state.features.find(f => f.id === featureId);
      if (feature?.type !== FEATURE_TYPES.SKETCH) return;
      state.sketchSession = snapshotOf(state) as Draft<DocumentSnapshot>;
      state.isSketchActive = true;
      state.activeSketchId = feature.sketchId;
      const sk = feature as SketchFeature;
      state.activeSketchPlaneRef = sk.planeRef ?? null;
      const refPlane = sk.planeRef ? state.features.find(f => f.id === sk.planeRef) as ReferenceFeature | undefined : undefined;
      state.activeSketchPlane = (refPlane
        ? referencePlaneFrame(refPlane.base ?? 'Front', refPlane.offset ?? 0, refPlane.angle ?? 0)
        : sk.frame ?? (feature.plane || 'Front')) as Draft<SketchPlaneRef>;
      lookAtSketchPlane(state, state.activeSketchPlane as SketchPlaneRef);
      state.activeCommandTab = 'Sketch';
      state.statusMessage = `Editing ${feature.name}`;
    }),

    // ==================== MODEL, MATERIAL, VIEW ====================
    setSketchRelationKind: (kind) => set(state => {
      state.sketchRelationKind = kind;
    }),

    setSketchOffsetDistance: (distance) => set(state => {
      state.sketchOffsetDistance = distance;
    }),

    replaceActiveSketchEntities: (entities, message) => set(state => {
      const sketchId = state.activeSketchId;
      if (!sketchId) return;
      state.sketchEntities[sketchId] = safeDeepClone(entities) as Draft<SketchEntity>[];
      state.isModified = true;
      if (message) state.statusMessage = message;
    }),

    setSketchPolygonSides: (sides) => set(state => {
      state.sketchPolygonSides = Math.min(64, Math.max(3, Math.round(sides) || 6));
    }),

    setFeaSetupMarkers: (setup) => set(state => {
      state.feaSetupMarkers = setup;
    }),

    setFeaPlot: (plot) => set(state => {
      state.feaPlot = plot as Draft<ResultPlot> | null;
    }),

    setBodies: (bodies) => set(state => {
      state.bodies = bodies as Draft<Body>[];
    }),

    setMaterial: (materialKey) => set(state => {
      state.activeMaterial = materialKey;
      state.isModified = true;
    }),

    setViewOrientation: (orientation) => set(state => {
      state.viewOrientation = orientation;
      state.viewFrame = null;
      state.viewRequest += 1;
    }),

    toggleGrid: () => set(state => { state.showGrid = !state.showGrid; }),
    toggleSnap: () => set(state => {
      state.snapEnabled = !state.snapEnabled;
      state.statusMessage = state.snapEnabled ? 'Sketch points snap to the 5 mm grid' : 'Grid snap off: sketch points go exactly where you click';
    }),
    toggleOrigin: () => set(state => { state.showOrigin = !state.showOrigin; }),
    togglePlanes: () => set(state => { state.showPlanes = !state.showPlanes; }),
    toggleAxes: () => set(state => { state.showAxes = !state.showAxes; }),
    toggleShaded: () => set(state => { state.shadedMode = !state.shadedMode; }),
    toggleEdges: () => set(state => { state.edgeDisplay = !state.edgeDisplay; }),
    toggleWireframe: () => set(state => { state.wireframeMode = !state.wireframeMode; }),
    togglePerspective: () => set(state => { state.perspectiveView = !state.perspectiveView; }),
    toggleSectionView: () => set(state => { state.sectionViewActive = !state.sectionViewActive; }),

    // ==================== PANELS AND STATUS ====================
    openPropertyPanel: (content) => set(state => {
      state.propertyPanelOpen = true;
      state.propertyPanelContent = content;
    }),

    closePropertyPanel: () => set(state => {
      state.propertyPanelOpen = false;
      state.propertyPanelContent = null;
    }),

    setCommandTab: (tab) => set(state => {
      state.activeCommandTab = tab;
    }),

    setStatus: (message) => set(state => {
      state.statusMessage = message;
    }),

    // ==================== UNDO / REDO / REBUILD ====================
    undo: () => set(state => {
      const prev = state.undoStack.pop();
      if (!prev) return;
      state.redoStack.push({ actionName: prev.actionName, snapshot: snapshotOf(state) as Draft<DocumentSnapshot> });
      restoreSnapshot(state, prev.snapshot as DocumentSnapshot);
      state.statusMessage = `Undo: ${prev.actionName || 'Action'}`;
    }),

    redo: () => set(state => {
      const next = state.redoStack.pop();
      if (!next) return;
      state.undoStack.push({ actionName: next.actionName, snapshot: snapshotOf(state) as Draft<DocumentSnapshot> });
      restoreSnapshot(state, next.snapshot as DocumentSnapshot);
      state.statusMessage = `Redo: ${next.actionName || 'Action'}`;
    }),

    markRebuilt: (errors = []) => set(state => {
      state.needsRebuild = false;
      state.rebuildErrors = errors;
      state.rebuildCount += 1;
    }),

    rebuild: () => set(state => {
      state.needsRebuild = true;
      state.statusMessage = 'Rebuilding geometry...';
    }),

    // ==================== ASSEMBLY ====================
    insertAssemblyPart: (name, shapeType = 'box', dims = {}) => set(state => {
      const comp = assemblyManager.insertComponent(
        name || `Part_${state.assemblyComponents.length + 1}`,
        primitiveGeometry(shapeType, dims),
      ) as StoreAssemblyComponent;
      comp.geometryType = shapeType;
      comp.dimensions = { ...dims };
      if (state.assemblyComponents.length > 0) {
        // Offset subsequent components so they don't overlap initially
        comp.position.x = state.assemblyComponents.length * 35;
        comp.updateMatrix();
      }
      syncAssembly(state);
      state.isModified = true;
      state.statusMessage = `Inserted "${comp.name}" into assembly`;
    }),

    insertPartComponent: (shape, source, name) => {
      let id = '';
      set(state => {
        const count = assemblyManager.components.filter(c => (c as StoreAssemblyComponent).source?.documentId === source.documentId).length;
        const comp = assemblyManager.insertComponent(name || (count ? `${shape.name}<${count + 1}>` : shape.name), shape.geometry) as StoreAssemblyComponent;
        comp.source = { ...source, fingerprint: shape.fingerprint };
        comp.material = shape.material in MATERIALS ? shape.material : undefined;
        if (!comp.material) delete comp.material;
        if (assemblyManager.components.length > 1) {
          // Beside the others, so it can be seen and picked
          const box = new THREE.Box3();
          for (const c of assemblyManager.components) if (c !== comp) box.union(c.geometry.boundingBox ?? new THREE.Box3());
          const size = comp.localBox().getSize(new THREE.Vector3());
          comp.position.x = (box.isEmpty() ? 0 : box.max.x) + size.x / 2 + 20 - comp.localBox().getCenter(new THREE.Vector3()).x;
          comp.updateMatrix();
        }
        id = comp.id;
        syncAssembly(state);
        state.isModified = true;
        state.statusMessage = `Inserted "${comp.name}" (${source.linked === 'library' ? 'from the library' : 'linked to the part'})`;
      });
      return id;
    },

    updatePartComponents: (updates) => set(state => {
      let changed = 0;
      for (const u of updates) {
        const comp = assemblyManager.components.find(c => c.id === u.componentId) as StoreAssemblyComponent | undefined;
        if (!comp) continue;
        if (u.shape && u.shape.fingerprint !== comp.source?.fingerprint) {
          comp.baseGeometry = u.shape.geometry;
          changed++;
          // Faces picked on the old shape: find them again on the new one
          assemblyManager.mates = assemblyManager.mates.map(m => {
            const fix = (ref: MateRef) => (ref && typeof ref === 'object' ? remapRef(ref as Parameters<typeof remapRef>[0], comp.baseGeometry) ?? ref : ref);
            if (m.comp1Id !== comp.id && m.comp2Id !== comp.id) return m;
            return {
              ...m,
              ...(m.comp1Id === comp.id ? { ref1: fix(m.ref1) } : {}),
              ...(m.comp2Id === comp.id ? { ref2: fix(m.ref2) } : {}),
            };
          });
        }
        comp.source = { ...u.source, ...(u.shape ? { fingerprint: u.shape.fingerprint } : {}) };
        comp.updateMatrix();
      }
      if (changed) {
        const res = assemblyManager.solve();
        state.isModified = true;
        state.statusMessage = `Updated ${changed} component${changed === 1 ? '' : 's'} from ${changed === 1 ? 'its part' : 'their parts'} · ${solveMessage(res)}`;
      }
      syncAssembly(state);
    }),

    removeAssemblyComponent: (componentId) => set(state => {
      const comp = assemblyManager.components.find(c => c.id === componentId);
      if (!comp) return;
      const wasFixed = comp.isFixed;
      assemblyManager.removeComponent(componentId);
      // Keep one component fixed so the assembly does not float
      if (wasFixed && assemblyManager.components.length && !assemblyManager.components.some(c => c.isFixed)) assemblyManager.components[0].isFixed = true;
      state.explodeSteps = state.explodeSteps
        .map(s => ({ ...s, componentIds: s.componentIds.filter(id => id !== componentId) }))
        .filter(s => s.componentIds.length > 0);
      syncAssembly(state);
      state.isModified = true;
      state.statusMessage = `Removed "${comp.name}" and its mates`;
    }),

    driveMate: (mateId, value) => {
      const i = assemblyManager.mates.findIndex(m => m.id === mateId);
      if (i < 0) throw new Error(`No mate ${JSON.stringify(mateId)}`);
      // The store keeps (frozen) copies of the mates: replace this one rather than change it
      const mate = String(assemblyManager.mates[i].type) === 'angle'
        ? { ...assemblyManager.mates[i], angle: value }
        : { ...assemblyManager.mates[i], offset: value };
      assemblyManager.mates[i] = mate;
      const res = assemblyManager.solve();
      set(state => {
        syncAssembly(state);
        state.isModified = true;
        state.statusMessage = `${mate.type === 'angle' ? `${value.toFixed(1)}°` : `${value.toFixed(2)} mm`} · ${solveMessage(res)}`;
      });
      return { converged: res.converged, error: res.error };
    },

    addMatePick: (pick) => set(state => {
      const picks = state.matePicks.length >= 2 ? [] : [...state.matePicks];
      // A second face on the same component replaces the first
      if (picks.length === 1 && picks[0].componentId === pick.componentId) picks.pop();
      picks.push(pick);
      state.matePicks = picks as Draft<typeof state.matePicks>;
      const comp = assemblyManager.components.find(c => c.id === pick.componentId);
      const what = pick.face.kind === 'plane' ? 'flat face' : `cylinder Ø${(pick.face.radius * 2).toFixed(2)} mm`;
      if (picks.length === 1) {
        state.statusMessage = `${comp?.name ?? 'Component'}: ${what}. Pick a face on another component`;
      } else {
        state.statusMessage = `${comp?.name ?? 'Component'}: ${what}. Choose the mate`;
        state.propertyPanelOpen = true;
        state.propertyPanelContent = { type: 'mate_faces' };
      }
    }),

    clearMatePicks: () => set(state => {
      state.matePicks = [];
    }),

    setExplodeSteps: (steps) => set(state => {
      const ids = new Set(assemblyManager.components.map(c => c.id));
      state.explodeSteps = steps
        .map(s => ({ ...s, componentIds: s.componentIds.filter(id => ids.has(id)) }))
        .filter(s => s.componentIds.length > 0) as Draft<ExplodeStep>[];
      state.isModified = true;
    }),

    setDocumentType: (type) => set(state => {
      state.documentType = type;
      if (type === 'assembly') {
        state.features = [];
        state.sketchEntities = {};
        state.sketchConstraints = {};
        state.sketchDimensions = {};
        state.rollbackIndex = -1;
        state.activeFeatureIndex = -1;
        state.needsRebuild = true;
        state.activeCommandTab = 'Assembly';
        state.drawingOptions.subject = 'assembly';
      } else {
        state.activeCommandTab = 'Features';
        state.drawingOptions.subject = 'part';
      }
    }),

    addAssemblyMate: (type, comp1Id, ref1, comp2Id, ref2, offset = 0, extra = {}) => set(state => {
      // Options go to addMate so they are in place before it solves
      try {
        assemblyManager.addMate(type, comp1Id, ref1, comp2Id, ref2, offset, extra);
      } catch (err) {
        state.statusMessage = `Mate not added: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
      syncAssembly(state);
      state.isModified = true;
      state.statusMessage = `Added ${type} mate · ${state.assemblyDof?.status === 'over-defined' ? 'over defined: the mates conflict' : state.assemblyDof ? `${state.assemblyDof.dof} degree${state.assemblyDof.dof === 1 ? '' : 's'} of freedom left` : 'solved'}`;
    }),

    removeAssemblyMate: (mateId) => set(state => {
      assemblyManager.removeMate(mateId);
      syncAssembly(state);
      state.isModified = true;
      state.statusMessage = 'Removed mate';
    }),

    solveAssembly: () => set(state => {
      const res = assemblyManager.solve();
      syncAssembly(state);
      state.statusMessage = solveMessage(res);
    }),

    setComponentMaterial: (componentIds, material) => set(state => {
      const ids = new Set(componentIds);
      const changed = assemblyManager.components.filter(c => ids.has(c.id)) as StoreAssemblyComponent[];
      if (changed.length === 0) return;
      for (const c of changed) {
        if (material) c.material = material; else delete c.material;
      }
      state.assemblyComponents = [...assemblyManager.components] as Draft<StoreAssemblyComponent>[];
      state.isModified = true;
      const what = changed.length === 1 ? `"${changed[0].name}"` : `${changed.length} components`;
      state.statusMessage = material ? `${what}: ${MATERIALS[material]?.name ?? material}` : `${what}: part material`;
    }),

    clearAssembly: () => set(state => {
      assemblyManager.components = [];
      assemblyManager.mates = [];
      state.assemblyComponents = [];
      state.mates = [];
      state.explodedView = null;
      state.explodeSteps = [];
      state.assemblyDof = null;
      state.isModified = true;
      state.statusMessage = 'Cleared assembly';
    }),

    setExplodedView: (settings) => set(state => {
      state.explodedView = settings ? { ...settings } : null;
      state.statusMessage = !settings ? 'Exploded view collapsed'
        : state.explodeSteps.length ? `Exploded view: ${state.explodeSteps.length} step${state.explodeSteps.length === 1 ? '' : 's'}${(settings.progress ?? 1) < 1 ? ` (${Math.round((settings.progress ?? 1) * 100)}%)` : ''}`
          : `Exploded view: ${settings.distance} mm step${settings.leaderLines ? ', with leader lines' : ''}`;
    }),

    setInterference: (results) => set(state => {
      for (const r of (state.interference?.results ?? []) as Interference[]) r.geometry.dispose();
      state.interference = results ? { results: results as Draft<Interference>[], components: state.assemblyComponents as unknown[] } : null;
    }),

    addFeaProbe: (probe) => set(state => {
      if (state.feaProbes.some(p => p.node === probe.node)) return;
      state.feaProbes = [...state.feaProbes, probe].slice(-12);
      state.statusMessage = `Probe ${state.feaProbes.length}: ${probe.vonMisesMPa.toFixed(1)} MPa, ${probe.displacementMM.toPrecision(3)} mm`;
    }),

    clearFeaProbes: () => set(state => {
      state.feaProbes = [];
    }),

    addMeasurePick: (pick) => set(state => {
      const picks = state.measurePicks.length >= 2 ? [] : [...state.measurePicks];
      picks.push(pick);
      state.measurePicks = picks;
      state.statusMessage = picks.length === 1 ? 'Measure: click the second point' : 'Measure: click to start a new measurement (Esc to finish)';
    }),

    clearMeasure: () => set(state => {
      state.measurePicks = [];
    }),

    setVariables: (variables) => set(state => {
      get()._captureUndoSnapshot(state, 'Edit Equations');
      state.variables = variables.map(v => ({ name: v.name, expression: v.expression }));
      applyEquations(state);
      state.isModified = true;
      state.statusMessage = `Equations updated (${variables.length} variable${variables.length === 1 ? '' : 's'})`;
    }),

    setConfigurations: (configurations) => set(state => {
      get()._captureUndoSnapshot(state, 'Edit Configurations');
      state.configurations = configurations.map(c => ({ name: c.name.trim(), values: { ...c.values } }));
      if (state.activeConfiguration && !state.configurations.some(c => c.name === state.activeConfiguration)) state.activeConfiguration = null;
      applyEquations(state);
      state.isModified = true;
      state.statusMessage = `Configurations updated (${configurations.length})`;
    }),

    activateConfiguration: (name) => set(state => {
      if (name !== null && !state.configurations.some(c => c.name === name)) return;
      if (state.activeConfiguration === name) return;
      get()._captureUndoSnapshot(state, `Configuration: ${name ?? 'Default'}`);
      state.activeConfiguration = name;
      applyEquations(state);
      state.isModified = true;
      state.statusMessage = `Configuration: ${name ?? 'Default'}`;
    }),

    addDrawingDimension: (dimension) => set(state => {
      get()._captureUndoSnapshot(state, 'Add Drawing Dimension');
      state.drawingDimensions.push(safeDeepClone(dimension) as Draft<DrawingDimension>);
      state.isModified = true;
    }),

    removeDrawingDimension: (id) => {
      if (!get().drawingDimensions.some(d => d.id === id)) return false;
      set(state => {
        get()._captureUndoSnapshot(state, 'Delete Drawing Dimension');
        state.drawingDimensions = state.drawingDimensions.filter(d => d.id !== id);
        state.isModified = true;
      });
      return true;
    },

    setDrawingOptions: (options) => set(state => {
      Object.assign(state.drawingOptions, options);
    }),

    // ==================== DOCUMENTS ====================
    setLibraryRef: (ref, saved = false) => set(state => {
      state.libraryRef = ref ? { ...ref } : null;
      if (saved) state.isModified = false;
    }),

    saveProject: () => {
      const state = get();
      const assemblyComponents: SerializedComponent[] = state.assemblyComponents.map(comp => ({
        id: comp.id,
        name: comp.name,
        isFixed: comp.isFixed,
        position: { x: comp.position.x, y: comp.position.y, z: comp.position.z },
        quaternion: { x: comp.quaternion.x, y: comp.quaternion.y, z: comp.quaternion.z, w: comp.quaternion.w },
        scale: { x: comp.scale.x, y: comp.scale.y, z: comp.scale.z },
        geometryType: comp.geometryType || 'box',
        dimensions: comp.dimensions || {},
        ...(comp.material ? { material: comp.material } : {}),
        ...(comp.source ? { source: (({ linked: _linked, ...rest }) => rest)(comp.source) } : {}),
      }));

      const project: ProjectFile = {
        version: '2.0.0',
        documentId: state.documentId,
        documentType: state.documentType,
        documentName: state.documentName,
        appMode: state.appMode,
        features: state.features,
        sketchEntities: state.sketchEntities,
        sketchConstraints: state.sketchConstraints,
        sketchDimensions: state.sketchDimensions,
        rollbackIndex: state.rollbackIndex,
        activeMaterial: state.activeMaterial,
        ...(state.variables.length ? { variables: state.variables } : {}),
        ...(state.configurations.length ? { configurations: state.configurations, activeConfiguration: state.activeConfiguration } : {}),
        settings: state.settings,
        assemblyComponents,
        mates: state.mates,
        ...(state.explodeSteps.length ? { explodeSteps: state.explodeSteps } : {}),
        ...(state.drawingDimensions.length ? { drawingDimensions: state.drawingDimensions } : {}),
        timestamp: Date.now(),
      };
      return JSON.stringify(project, null, 2);
    },

    loadProject: (input) => set(state => {
      try {
        const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input;
        // Validate before touching state so a bad file never leaves a half-loaded document
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Not a valid CasiWorks project file');
        }
        const project = parsed as Partial<Omit<ProjectFile, 'assemblyComponents'>> & { assemblyComponents?: unknown };
        if (project.features !== undefined && !Array.isArray(project.features)) {
          throw new Error('Not a valid CasiWorks project file');
        }

        const features = ensureFeatureGraph(project.features || []);
        state.documentId = typeof project.documentId === 'string' && project.documentId ? project.documentId : generateId('doc');
        const components0 = Array.isArray(project.assemblyComponents) ? project.assemblyComponents : [];
        // Older files have no type: an assembly when it holds components and no features
        state.documentType = project.documentType === 'assembly' || project.documentType === 'part'
          ? project.documentType
          : components0.length > 0 && features.length === 0 ? 'assembly' : 'part';
        state.drawingOptions.subject = state.documentType === 'assembly' ? 'assembly' : 'part';
        state.documentName = project.documentName || 'Imported Part';
        state.appMode = project.appMode || APP_MODES.PART;
        state.features = features as Draft<Feature>[];
        state.sketchEntities = normalizeSketchEntities(project.sketchEntities) as Draft<SketchEntityMap>;
        state.sketchConstraints = project.sketchConstraints || {};
        state.sketchDimensions = project.sketchDimensions || {};
        state.rollbackIndex = Number.isInteger(project.rollbackIndex) ? project.rollbackIndex! : features.length - 1;
        state.activeMaterial = project.activeMaterial || 'Steel_1020';
        state.settings = { ...DEFAULT_SETTINGS, ...(project.settings || {}) };
        state.variables = Array.isArray(project.variables)
          ? project.variables.filter(v => v && typeof v.name === 'string' && typeof v.expression === 'string').map(v => ({ name: v.name, expression: v.expression }))
          : [];
        state.configurations = Array.isArray(project.configurations)
          ? project.configurations
            .filter(c => c && typeof c.name === 'string' && c.values && typeof c.values === 'object')
            .map(c => ({ name: c.name, values: Object.fromEntries(Object.entries(c.values).filter(([, e]) => typeof e === 'string')) as Record<string, string> }))
          : [];
        state.activeConfiguration = state.configurations.some(c => c.name === project.activeConfiguration) ? project.activeConfiguration! : null;
        applyEquations(state);

        // Restore assembly components
        const components = Array.isArray(project.assemblyComponents) ? project.assemblyComponents as SerializedComponent[] : [];
        assemblyManager.components = [];
        assemblyManager.mates = [];
        if (components.length > 0) {
          for (const c of components) {
            const dims = c.dimensions || {};
            const shape = c.geometryType || 'box';
            // A part reference starts from its cached copy; the workspace or library brings the live part after loading
            let geometry: THREE.BufferGeometry;
            let partOk = true;
            if (c.source && typeof c.source.snapshot === 'string') {
              try { geometry = partShape(c.source.snapshot).geometry; } catch { geometry = missingPartGeometry(); partOk = false; }
            } else {
              geometry = primitiveGeometry(shape, dims);
            }
            const comp = assemblyManager.insertComponent(c.name, geometry, c.isFixed) as StoreAssemblyComponent;
            comp.id = c.id;
            if (c.source && typeof c.source.snapshot === 'string') {
              comp.source = { ...c.source, linked: 'cached' };
              if (!partOk) comp.source.fingerprint = 'missing';
            } else {
              comp.geometryType = shape;
              comp.dimensions = dims;
            }
            if (typeof c.material === 'string' && c.material in MATERIALS) comp.material = c.material;
            if (c.position) comp.position.set(c.position.x, c.position.y, c.position.z);
            if (c.quaternion) comp.quaternion.set(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w);
            if (c.scale) comp.scale.set(c.scale.x, c.scale.y, c.scale.z);
            comp.updateMatrix();
          }
        }

        state.explodedView = null;
        // Restore assembly mates
        if (Array.isArray(project.mates)) assemblyManager.mates = [...project.mates] as AssemblyMate[];
        state.explodeSteps = (Array.isArray(project.explodeSteps) ? project.explodeSteps : []) as Draft<ExplodeStep>[];
        state.drawingDimensions = sanitizeDimensions(project.drawingDimensions) as Draft<DrawingDimension>[];
        syncAssembly(state);
        state.interference = null;

        state.undoStack = [];
        state.redoStack = [];
        state.needsRebuild = true;
        state.isModified = false;
        state.libraryRef = null; // a file; the library sets its own reference after loading
        state.statusMessage = `Loaded: ${state.documentName}`;
        state.documentRevision += 1;
      } catch (e) {
        state.statusMessage = 'Error loading project: ' + (e instanceof Error ? e.message : String(e));
      }
    }),

    loadExampleModel: (example) => set(state => {
      get()._captureUndoSnapshot(state, `Load Example: ${example.documentName}`);
      state.documentName = example.documentName || 'Example Part';
      state.activeMaterial = example.activeMaterial || 'Steel_1020';
      state.features = ensureFeatureGraph(safeDeepClone(example.features || [])) as Draft<Feature>[];
      state.sketchEntities = safeDeepClone(example.sketchEntities || {}) as Draft<SketchEntityMap>;
      state.sketchConstraints = {};
      state.sketchDimensions = {};
      state.drawingDimensions = [];
      state.rollbackIndex = -1;
      state.activeFeatureIndex = state.features.length > 0 ? 0 : -1;
      state.isSketchActive = false;
      state.activeSketchId = null;
      state.needsRebuild = true;
      state.statusMessage = `Loaded example: ${example.documentName}`;
      state.documentRevision += 1;
    }),

    newProject: () => set(state => {
      // Reset the assembly singleton too, otherwise old components resurface on the next insert
      assemblyManager.components = [];
      assemblyManager.mates = [];
      const { documentRevision, rebuildCount } = state;
      const drawingOptions = { ...state.drawingOptions };
      Object.assign(state, initialState());
      // Counters keep counting across documents; the drawing preferences stay
      state.documentRevision = documentRevision + 1;
      state.rebuildCount = rebuildCount;
      state.drawingOptions = drawingOptions;
    }),

    setDocumentName: (name) => set(state => {
      state.documentName = name;
    }),
  })),
);

// =====================================================================
// Compile-time contract checks: the store must satisfy every interface other
// modules declare for the slice of it they use. A type error here means a
// contract and the store have drifted apart.
// =====================================================================
type Satisfies<T, Contract> = T extends Contract ? true : false;
type Assert<T extends true> = T;
export type _StoreContracts = [
  Assert<Satisfies<CADStore, ApiStoreState>>,
  Assert<Satisfies<CADStore, RebuildState>>,
];
