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

import type { BufferGeometry } from 'three';
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
} from '../types/cad.ts';

export const API_VERSION = '1.0.0';

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
  /** Default 'Front'. */
  plane?: SketchPlane;
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
}

export interface FilletSpec { radius: number; name?: string }
export interface ChamferSpec { distance: number; name?: string }
export interface ShellSpec { thickness: number; name?: string }

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

export interface DocumentAPI {
  /** Start a new, empty part. Discards the current document without prompting. */
  'new'(): void;
  getName(): string;
  setName(name: string): void;
  /** true when there are unsaved changes. */
  isModified(): boolean;
  /** Serialize to the .casiproj JSON format. */
  toJSON(): string;
  /** Replace the current document with .casiproj JSON text or a parsed object. Throws INVALID_DOCUMENT. */
  load(project: string | object): void;
}

export interface SketchesAPI {
  /**
   * Create a sketch on a standard plane.
   * @example api.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] })
   */
  create(spec: SketchSpec): SketchRef;
  /** A copy of the sketch's entities (internal format: arc angles in radians). */
  getEntities(sketchId: string): SketchEntity[];
}

export interface FeaturesAPI {
  list(): FeatureInfo[];
  /** Throws NOT_FOUND. */
  get(id: string): FeatureInfo;
  /** Extrude a sketch as a boss or cut. Returns the new feature id. */
  extrude(spec: ExtrudeSpec): string;
  /** Revolve a sketch. Returns the new feature id. */
  revolve(spec: RevolveSpec): string;
  /**
   * Add a fillet feature. Not applied yet: the rebuild reports a warning and the
   * model is unchanged until the exact geometry kernel lands (roadmap 2.6).
   */
  fillet(spec: FilletSpec): string;
  /** Add a chamfer feature. Not applied yet (see fillet). */
  chamfer(spec: ChamferSpec): string;
  /** Add a shell feature. Not applied yet: needs the exact geometry kernel (roadmap Phase 2). */
  shell(spec: ShellSpec): string;
  /** Change parameters (e.g. { depth: 40 }); id, type, sketchId and dependency links cannot change. */
  update(id: string, changes: FeatureChanges): void;
  remove(id: string): void;
  /** Suppression cascades to dependent features. */
  setSuppressed(id: string, suppressed: boolean): void;
  /** Evaluate features 0..index only; null rolls forward to the end. */
  rollbackTo(index: number | null): void;
}

export interface ModelAPI {
  rebuild(): RebuildResult;
  /** Errors from the last rebuild. */
  errors(): RebuildError[];
  hasBody(): boolean;
  /** Mass properties with the active material; null when there is no body. */
  massProperties(): MassProperties | null;
  /** Axis-aligned bounds in mm; null when there is no body. */
  boundingBox(): BoundingBox | null;
}

export interface MaterialsAPI {
  list(): MaterialInfo[];
  getActive(): string;
  /** Throws NOT_FOUND for an unknown key. */
  setActive(key: string): void;
}

export interface HistoryAPI {
  canUndo(): boolean;
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

/** The CasiWorks public API. */
export interface CasiWorksAPI {
  readonly version: string;
  readonly units: ApiUnits;
  readonly document: DocumentAPI;
  readonly sketches: SketchesAPI;
  readonly features: FeaturesAPI;
  readonly model: ModelAPI;
  readonly materials: MaterialsAPI;
  readonly history: HistoryAPI;
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
}

export interface ApiStore {
  getState(): ApiStoreState;
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
export function createCasiWorksAPI(store: ApiStore): CasiWorksAPI {
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

  const sketches: SketchesAPI = Object.freeze({
    create(spec: SketchSpec) {
      const s = requireObject(spec, 'spec');
      const plane = (s.plane ?? 'Front') as SketchPlane;
      if (!PLANES.includes(plane)) fail('INVALID_ARGUMENT', `plane must be one of ${PLANES.join(', ')}`);
      const entities = toInternalEntities(s.entities);
      const featureId = generateId('feat_sketch');
      const sketchId = generateId('sketch');
      get().createSketchFeature({ id: featureId, sketchId, plane, entities, name: optionalName(s.name) });
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
      return addFeature({
        type: cut ? FEATURE_TYPES.REVOLVE_CUT : FEATURE_TYPES.REVOLVE_BOSS,
        name: optionalName(s.name) ?? (cut ? 'Cut-Revolve' : 'Revolve'),
        sketchId,
        angle,
      });
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

  return Object.freeze({
    version: API_VERSION,
    units: Object.freeze({ system: 'MMGS', length: 'mm', angle: 'deg', mass: 'kg', density: 'kg/m^3' } as const),
    document,
    sketches,
    features,
    model,
    materials,
    history,
  });
}

export default createCasiWorksAPI;
