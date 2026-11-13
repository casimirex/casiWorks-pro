// CasiWorks Pro - Central state store (zustand + immer)
//
// Holds the document (features, sketches, material), UI state, undo/redo and
// the assembly. All edits go through these actions, so the UI and the public
// API (src/api) share one source of truth.
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Draft } from 'immer';
import * as THREE from 'three';
import { generateId } from '../utils/math.ts';
import { TOOLS, APP_MODES, DEFAULT_SETTINGS, FEATURE_TYPES } from '../utils/constants.ts';
import type { AppMode, AppSettings, MateType, ToolId, ViewOrientation } from '../utils/constants.ts';
import { assemblyManager } from '../assembly/AssemblyManager.ts';
import type { AssemblyComponent } from '../assembly/AssemblyManager.ts';
import { safeDeepClone } from '../utils/clone.ts';
import type {
  ExampleModel,
  Feature,
  FeatureData,
  ProjectFile,
  RebuildError,
  SketchEntity,
  SketchEntityMap,
  SketchPlane,
} from '../types/cad.ts';
import type { Body, RebuildState } from '../features/rebuildModel.ts';
import type { ApiStoreState } from '../api/CasiWorksAPI.ts';
import type { ShortcutState } from '../utils/shortcuts.ts';

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

/** An assembly component as held by the store (primitive metadata added for save/load). */
export type StoreAssemblyComponent = AssemblyComponent & {
  geometryType?: PrimitiveShape;
  dimensions?: PrimitiveDims;
};

export type AssemblyMate = ReturnType<typeof assemblyManager.addMate>;

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
}

interface UndoEntry {
  actionName?: string;
  snapshot: DocumentSnapshot;
}

export interface CADState {
  appMode: AppMode;

  // Document
  documentName: string;
  isModified: boolean;

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
  activeSketchPlane: SketchPlane;
  sketchEntities: SketchEntityMap;
  sketchConstraints: Record<string, unknown[]>;
  sketchDimensions: Record<string, unknown[]>;
  snapEnabled: boolean;
  constructionMode: boolean;

  // Model
  bodies: Body[];
  activeMaterial: string;

  // View
  viewOrientation: ViewOrientation;
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

  // Rebuild
  needsRebuild: boolean;
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
  startSketch(plane?: SketchPlane): void;
  endSketch(confirm?: boolean): void;
  addSketchEntity(entity: SketchEntity): void;
  removeSketchEntity(entityId: string): void;
  addSketchConstraint(constraint: Record<string, unknown>): void;
  addSketchDimension(dimension: Record<string, unknown>): void;
  createSketchFeature(spec: { id: string; sketchId: string; plane?: SketchPlane; entities?: SketchEntity[]; name?: string }): void;
  toggleConstructionMode(): void;
  editSketch(featureId: string): void;

  // Model, material, view
  setBodies(bodies: Body[]): void;
  setMaterial(materialKey: string): void;
  setViewOrientation(orientation: ViewOrientation): void;
  toggleGrid(): void;
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

  // Undo / redo / rebuild
  undo(): void;
  redo(): void;
  markRebuilt(errors?: RebuildError[]): void;
  rebuild(): void;

  // Assembly
  insertAssemblyPart(name: string, shapeType?: PrimitiveShape, dims?: PrimitiveDims): void;
  addAssemblyMate(type: MateType, comp1Id: string, ref1: string, comp2Id: string, ref2: string, offset?: number, extra?: Record<string, unknown>): void;
  removeAssemblyMate(mateId: string): void;
  solveAssembly(): void;
  clearAssembly(): void;

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
  };
}

function restoreSnapshot(state: Draft<CADStore>, s: DocumentSnapshot): void {
  state.features = (s.features || []) as Draft<Feature>[];
  state.sketchEntities = (s.sketchEntities || {}) as Draft<SketchEntityMap>;
  state.sketchConstraints = s.sketchConstraints || {};
  state.sketchDimensions = s.sketchDimensions || {};
  state.rollbackIndex = s.rollbackIndex ?? -1;
  state.activeMaterial = s.activeMaterial || 'Steel_1020';
  state.needsRebuild = true;
}

/** Insert a feature after the rollback bar (if rolled back) or at the end. Returns its index. */
function insertFeature(state: Draft<CADStore>, feature: Feature): number {
  const isRolledBack = state.rollbackIndex >= 0 && state.rollbackIndex < state.features.length - 1;
  const index = isRolledBack ? state.rollbackIndex + 1 : state.features.length;
  state.features.splice(index, 0, feature as Draft<Feature>);
  state.rollbackIndex = index;
  return index;
}

function initialState(): CADState {
  return {
    appMode: APP_MODES.PART,
    documentName: 'Untitled Part',
    isModified: false,
    activeTool: TOOLS.SELECT,
    selectedEntities: [],
    features: [],
    activeFeatureIndex: -1,
    rollbackIndex: -1,
    isSketchActive: false,
    activeSketchId: null,
    activeSketchPlane: 'Front',
    sketchEntities: {},
    sketchConstraints: {},
    sketchDimensions: {},
    snapEnabled: true,
    constructionMode: false,
    bodies: [],
    activeMaterial: 'Steel_1020',
    viewOrientation: 'isometric',
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
    needsRebuild: false,
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
      state.activeTool = tool;
      state.statusMessage = `Tool: ${tool.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`;
    }),

    cancelTool: () => set(state => {
      state.activeTool = TOOLS.SELECT;
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
      state.needsRebuild = true;
      state.statusMessage = `Added ${newFeature.name}`;
    }),

    updateFeature: (featureId, updates) => set(state => {
      const feature = state.features.find(f => f.id === featureId);
      if (!feature) return;
      get()._captureUndoSnapshot(state, `Update ${feature.name}`);
      Object.assign(feature, updates);
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
    startSketch: (plane = 'Front') => set(state => {
      const sketchId = generateId('sketch');
      state.isSketchActive = true;
      state.activeSketchId = sketchId;
      state.activeSketchPlane = plane;
      state.sketchEntities[sketchId] = [];
      state.sketchConstraints[sketchId] = [];
      state.sketchDimensions[sketchId] = [];
      state.activeTool = TOOLS.SKETCH_LINE;
      state.activeCommandTab = 'Sketch';
      state.statusMessage = `Sketching on ${plane} plane (Select tools or draw)`;
    }),

    endSketch: (confirm = true) => set(state => {
      const sketchId = state.activeSketchId;
      if (!sketchId) return;

      if (confirm && (state.sketchEntities[sketchId]?.length ?? 0) > 0) {
        get()._captureUndoSnapshot(state, 'Create Sketch');
        const exists = state.features.some(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId);
        if (!exists) {
          insertFeature(state, {
            id: generateId('feat_sketch'),
            type: FEATURE_TYPES.SKETCH,
            name: `Sketch${state.features.filter(f => f.type === FEATURE_TYPES.SKETCH).length + 1}`,
            sketchId,
            plane: state.activeSketchPlane,
            visible: true,
            suppressed: false,
            parentIds: [],
            childIds: [],
          });
        }
      } else if (!confirm) {
        delete state.sketchEntities[sketchId];
        delete state.sketchConstraints[sketchId];
        delete state.sketchDimensions[sketchId];
      }

      state.isSketchActive = false;
      state.activeSketchId = null;
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

    addSketchConstraint: (constraint) => set(state => {
      const sketchId = state.activeSketchId;
      if (!sketchId) return;
      (state.sketchConstraints[sketchId] ??= []).push({ id: generateId('const'), ...constraint });
    }),

    addSketchDimension: (dimension) => set(state => {
      const sketchId = state.activeSketchId;
      if (!sketchId) return;
      (state.sketchDimensions[sketchId] ??= []).push({ id: generateId('dim'), ...dimension });
    }),

    createSketchFeature: ({ id, sketchId, plane = 'Front', entities = [], name }) => set(state => {
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
        visible: true,
        suppressed: false,
        parentIds: [],
        childIds: [],
      });
      state.needsRebuild = true;
      state.statusMessage = `Created ${featureName}`;
    }),

    toggleConstructionMode: () => set(state => {
      state.constructionMode = !state.constructionMode;
    }),

    editSketch: (featureId) => set(state => {
      const feature = state.features.find(f => f.id === featureId);
      if (feature?.type !== FEATURE_TYPES.SKETCH) return;
      state.isSketchActive = true;
      state.activeSketchId = feature.sketchId;
      state.activeSketchPlane = feature.plane || 'Front';
      state.activeCommandTab = 'Sketch';
      state.statusMessage = `Editing ${feature.name}`;
    }),

    // ==================== MODEL, MATERIAL, VIEW ====================
    setBodies: (bodies) => set(state => {
      state.bodies = bodies as Draft<Body>[];
    }),

    setMaterial: (materialKey) => set(state => {
      state.activeMaterial = materialKey;
      state.isModified = true;
    }),

    setViewOrientation: (orientation) => set(state => {
      state.viewOrientation = orientation;
    }),

    toggleGrid: () => set(state => { state.showGrid = !state.showGrid; }),
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
      state.assemblyComponents = [...assemblyManager.components] as Draft<StoreAssemblyComponent>[];
      state.statusMessage = `Inserted "${comp.name}" into assembly`;
    }),

    addAssemblyMate: (type, comp1Id, ref1, comp2Id, ref2, offset = 0, extra = {}) => set(state => {
      // Options go to addMate so they are in place before it solves
      assemblyManager.addMate(type, comp1Id, ref1, comp2Id, ref2, offset, extra);
      state.mates = [...assemblyManager.mates] as Draft<AssemblyMate>[];
      state.assemblyComponents = [...assemblyManager.components] as Draft<StoreAssemblyComponent>[];
      state.statusMessage = `Added ${type} mate between components`;
    }),

    removeAssemblyMate: (mateId) => set(state => {
      assemblyManager.removeMate(mateId);
      state.mates = [...assemblyManager.mates] as Draft<AssemblyMate>[];
      state.assemblyComponents = [...assemblyManager.components] as Draft<StoreAssemblyComponent>[];
      state.statusMessage = 'Removed mate';
    }),

    solveAssembly: () => set(state => {
      const res = assemblyManager.solve();
      state.assemblyComponents = [...assemblyManager.components] as Draft<StoreAssemblyComponent>[];
      state.statusMessage = `Assembly solved (residual: ${(res?.error ?? 0).toFixed(5)}mm)`;
    }),

    clearAssembly: () => set(state => {
      assemblyManager.components = [];
      assemblyManager.mates = [];
      state.assemblyComponents = [];
      state.mates = [];
      state.statusMessage = 'Cleared assembly';
    }),

    // ==================== DOCUMENTS ====================
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
      }));

      const project: ProjectFile = {
        version: '2.0.0',
        documentName: state.documentName,
        appMode: state.appMode,
        features: state.features,
        sketchEntities: state.sketchEntities,
        sketchConstraints: state.sketchConstraints,
        sketchDimensions: state.sketchDimensions,
        rollbackIndex: state.rollbackIndex,
        activeMaterial: state.activeMaterial,
        settings: state.settings,
        assemblyComponents,
        mates: state.mates,
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
        state.documentName = project.documentName || 'Imported Part';
        state.appMode = project.appMode || APP_MODES.PART;
        state.features = features as Draft<Feature>[];
        state.sketchEntities = normalizeSketchEntities(project.sketchEntities) as Draft<SketchEntityMap>;
        state.sketchConstraints = project.sketchConstraints || {};
        state.sketchDimensions = project.sketchDimensions || {};
        state.rollbackIndex = Number.isInteger(project.rollbackIndex) ? project.rollbackIndex! : features.length - 1;
        state.activeMaterial = project.activeMaterial || 'Steel_1020';
        state.settings = { ...DEFAULT_SETTINGS, ...(project.settings || {}) };

        // Restore assembly components
        const components = Array.isArray(project.assemblyComponents) ? project.assemblyComponents as SerializedComponent[] : [];
        if (components.length > 0) {
          assemblyManager.components = [];
          for (const c of components) {
            const dims = c.dimensions || {};
            const shape = c.geometryType || 'box';
            const comp = assemblyManager.insertComponent(c.name, primitiveGeometry(shape, dims), c.isFixed) as StoreAssemblyComponent;
            comp.id = c.id;
            comp.geometryType = shape;
            comp.dimensions = dims;
            if (c.position) comp.position.set(c.position.x, c.position.y, c.position.z);
            if (c.quaternion) comp.quaternion.set(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w);
            if (c.scale) comp.scale.set(c.scale.x, c.scale.y, c.scale.z);
            comp.updateMatrix();
          }
          state.assemblyComponents = [...assemblyManager.components] as Draft<StoreAssemblyComponent>[];
        }

        // Restore assembly mates
        if (Array.isArray(project.mates)) {
          assemblyManager.mates = [...project.mates] as AssemblyMate[];
          state.mates = [...project.mates] as Draft<AssemblyMate>[];
        }

        state.undoStack = [];
        state.redoStack = [];
        state.needsRebuild = true;
        state.isModified = false;
        state.statusMessage = `Loaded: ${state.documentName}`;
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
      state.rollbackIndex = -1;
      state.activeFeatureIndex = state.features.length > 0 ? 0 : -1;
      state.isSketchActive = false;
      state.activeSketchId = null;
      state.needsRebuild = true;
      state.statusMessage = `Loaded example: ${example.documentName}`;
    }),

    newProject: () => set(state => {
      // Reset the assembly singleton too, otherwise old components resurface on the next insert
      assemblyManager.components = [];
      assemblyManager.mates = [];
      Object.assign(state, initialState());
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
  Assert<Satisfies<CADStore, ShortcutState>>,
  Assert<Satisfies<CADStore, RebuildState>>,
];
