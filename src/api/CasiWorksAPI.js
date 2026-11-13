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

import { FEATURE_TYPES, SKETCH_ENTITY_TYPES } from '../utils/constants.js';
import { generateId } from '../utils/math.js';
import { materialLibrary } from '../kernel/MaterialLibrary.js';
import { geometryEngine } from '../kernel/GeometryEngine.js';
import { rebuildModel } from '../features/rebuildModel.js';

export const API_VERSION = '1.0.0';

/** Error thrown by every API call that rejects its input or cannot complete. */
export class CasiWorksAPIError extends Error {
  /**
   * @param {'INVALID_ARGUMENT'|'NOT_FOUND'|'INVALID_DOCUMENT'|'OPERATION_FAILED'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'CasiWorksAPIError';
    this.code = code;
  }
}

const PLANES = ['Front', 'Top', 'Right'];
const EXTRUDE_END_CONDITIONS = ['blind', 'midplane', 'throughall'];

// ---------------------------------------------------------------- validation
const fail = (code, message) => { throw new CasiWorksAPIError(code, message); };

function requireObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', `${what} must be an object`);
  return value;
}

function requireNumber(value, what, { positive = false, min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_ARGUMENT', `${what} must be a finite number`);
  if (positive && value <= 0) fail('INVALID_ARGUMENT', `${what} must be greater than 0`);
  if (value < min || value > max) fail('INVALID_ARGUMENT', `${what} must be between ${min} and ${max}`);
  return value;
}

function requirePoint(p, what) {
  requireObject(p, what);
  return { x: requireNumber(p.x, `${what}.x`), y: requireNumber(p.y, `${what}.y`) };
}

function optionalName(name, what = 'name') {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || name.trim() === '') fail('INVALID_ARGUMENT', `${what} must be a non-empty string`);
  return name.trim();
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Convert API sketch entities into internal sketch entities.
 * Supported: line {p1,p2}, circle {center,radius}, arc {center,radius,startAngle,endAngle} (degrees),
 * rectangle {corner1,corner2} (expanded into four lines).
 */
function toInternalEntities(entities) {
  if (!Array.isArray(entities) || entities.length === 0) fail('INVALID_ARGUMENT', 'entities must be a non-empty array');
  const out = [];
  entities.forEach((e, i) => {
    const at = `entities[${i}]`;
    requireObject(e, at);
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
          startAngle: requireNumber(e.startAngle, `${at}.startAngle`) * Math.PI / 180,
          endAngle: requireNumber(e.endAngle, `${at}.endAngle`) * Math.PI / 180,
          construction,
        });
        break;
      case 'rectangle': {
        const a = requirePoint(e.corner1, `${at}.corner1`);
        const b = requirePoint(e.corner2, `${at}.corner2`);
        if (a.x === b.x || a.y === b.y) fail('INVALID_ARGUMENT', `${at} rectangle must have non-zero width and height`);
        const corners = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
        corners.forEach((p, k) => out.push({ id: generateId('ent'), type: SKETCH_ENTITY_TYPES.LINE, p1: { ...p }, p2: { ...corners[(k + 1) % 4] }, construction }));
        break;
      }
      default:
        fail('INVALID_ARGUMENT', `${at}.type must be one of line, circle, arc, rectangle (got ${JSON.stringify(e.type)})`);
    }
  });
  return out;
}

/** Plain, stable view of a feature for API callers. */
function toFeatureInfo(f, index) {
  const { id, name, type, sketchId, suppressed, parentIds, childIds, ...rest } = f;
  // Strip bookkeeping fields that are not part of the public contract
  delete rest.timestamp;
  delete rest.visible;
  return clone({
    id,
    name,
    type,
    index,
    sketchId: sketchId ?? null,
    suppressed: !!suppressed,
    parentIds: parentIds || [],
    childIds: childIds || [],
    parameters: rest,
  });
}

/**
 * Create the public API bound to a CasiWorks store.
 * @param {object} store - the zustand store (useCADStore)
 */
export function createCasiWorksAPI(store) {
  const get = () => store.getState();

  const findFeature = (id) => {
    const idx = get().features.findIndex(f => f.id === id);
    if (idx === -1) fail('NOT_FOUND', `No feature with id ${JSON.stringify(id)}`);
    return { feature: get().features[idx], index: idx };
  };

  const requireSketch = (sketchId) => {
    if (typeof sketchId !== 'string') fail('INVALID_ARGUMENT', 'sketchId must be a string');
    const exists = get().features.some(f => f.type === FEATURE_TYPES.SKETCH && f.sketchId === sketchId);
    if (!exists) fail('NOT_FOUND', `No sketch with id ${JSON.stringify(sketchId)}`);
    return sketchId;
  };

  const ensureRebuilt = () => {
    if (get().needsRebuild) rebuildModel(store);
  };

  const currentBody = () => {
    ensureRebuilt();
    return get().bodies.find(b => b.visible !== false && b.geometry) || null;
  };

  /** Add a feature through the store and return its id. */
  const addFeature = (spec) => {
    const id = generateId('feat');
    get().addFeature({ ...spec, id });
    return id;
  };

  // ------------------------------------------------------------- document
  const document = Object.freeze({
    /** Start a new, empty part. Discards the current document without prompting. */
    new() {
      get().newProject();
    },
    /** @returns {string} */
    getName() {
      return get().documentName;
    },
    /** @param {string} name */
    setName(name) {
      get().setDocumentName(optionalName(name) ?? fail('INVALID_ARGUMENT', 'name is required'));
    },
    /** @returns {boolean} true when there are unsaved changes */
    isModified() {
      return !!get().isModified;
    },
    /** Serialize the document to the .casiproj JSON format. @returns {string} */
    toJSON() {
      return get().saveProject();
    },
    /**
     * Replace the current document with a serialized project.
     * @param {string|object} project - .casiproj JSON text or parsed object
     */
    load(project) {
      let data = project;
      if (typeof project === 'string') {
        try { data = JSON.parse(project); } catch (e) { fail('INVALID_DOCUMENT', `Project is not valid JSON: ${e.message}`); }
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_DOCUMENT', 'Project must be a JSON object');
      if (data.features !== undefined && !Array.isArray(data.features)) fail('INVALID_DOCUMENT', 'Project "features" must be an array');
      get().loadProject(data);
      if (/^Error loading project/.test(get().statusMessage)) fail('INVALID_DOCUMENT', get().statusMessage);
    },
  });

  // ------------------------------------------------------------- sketches
  const sketches = Object.freeze({
    /**
     * Create a sketch on a standard plane.
     * @param {{ plane?: 'Front'|'Top'|'Right', entities: Array, name?: string }} spec
     * @returns {{ featureId: string, sketchId: string }}
     * @example api.sketches.create({ plane: 'Front', entities: [{ type: 'rectangle', corner1: {x:-30,y:-20}, corner2: {x:30,y:20} }] })
     */
    create(spec) {
      requireObject(spec, 'spec');
      const plane = spec.plane ?? 'Front';
      if (!PLANES.includes(plane)) fail('INVALID_ARGUMENT', `plane must be one of ${PLANES.join(', ')}`);
      const entities = toInternalEntities(spec.entities);
      const featureId = generateId('feat_sketch');
      const sketchId = generateId('sketch');
      get().createSketchFeature({ id: featureId, sketchId, plane, entities, name: optionalName(spec.name) });
      return { featureId, sketchId };
    },
    /** @returns {Array} a copy of the sketch's entities */
    getEntities(sketchId) {
      requireSketch(sketchId);
      return clone(get().sketchEntities[sketchId] || []);
    },
  });

  // ------------------------------------------------------------- features
  const features = Object.freeze({
    /** @returns {Array<object>} every feature in tree order */
    list() {
      return get().features.map((f, i) => toFeatureInfo(f, i));
    },
    /** @returns {object} one feature; throws NOT_FOUND */
    get(id) {
      const { feature, index } = findFeature(id);
      return toFeatureInfo(feature, index);
    },
    /**
     * Extrude a sketch as a boss (add material) or cut (remove material).
     * @param {{ sketchId: string, depth: number, endCondition?: 'blind'|'midplane'|'throughall', cut?: boolean, flip?: boolean, name?: string }} spec
     * @returns {string} new feature id
     */
    extrude(spec) {
      requireObject(spec, 'spec');
      const sketchId = requireSketch(spec.sketchId);
      const depth = requireNumber(spec.depth, 'depth', { positive: true });
      const endCondition = spec.endCondition ?? 'blind';
      if (!EXTRUDE_END_CONDITIONS.includes(endCondition)) fail('INVALID_ARGUMENT', `endCondition must be one of ${EXTRUDE_END_CONDITIONS.join(', ')}`);
      const cut = spec.cut === true;
      return addFeature({
        type: cut ? FEATURE_TYPES.EXTRUDE_CUT : FEATURE_TYPES.EXTRUDE_BOSS,
        name: optionalName(spec.name) ?? (cut ? 'Cut-Extrude' : 'Boss-Extrude'),
        sketchId,
        depth,
        direction: endCondition,
        flip: spec.flip === true,
      });
    },
    /**
     * Revolve a sketch about its axis.
     * @param {{ sketchId: string, angle?: number, cut?: boolean, name?: string }} spec - angle in degrees (default 360)
     * @returns {string} new feature id
     */
    revolve(spec) {
      requireObject(spec, 'spec');
      const sketchId = requireSketch(spec.sketchId);
      const angle = requireNumber(spec.angle ?? 360, 'angle', { positive: true, max: 360 });
      const cut = spec.cut === true;
      return addFeature({
        type: cut ? FEATURE_TYPES.REVOLVE_CUT : FEATURE_TYPES.REVOLVE_BOSS,
        name: optionalName(spec.name) ?? (cut ? 'Cut-Revolve' : 'Revolve'),
        sketchId,
        angle,
      });
    },
    /** @param {{ radius: number, name?: string }} spec @returns {string} */
    fillet(spec) {
      requireObject(spec, 'spec');
      return addFeature({ type: FEATURE_TYPES.FILLET, name: optionalName(spec.name) ?? 'Fillet', radius: requireNumber(spec.radius, 'radius', { positive: true }) });
    },
    /** @param {{ distance: number, name?: string }} spec @returns {string} */
    chamfer(spec) {
      requireObject(spec, 'spec');
      return addFeature({ type: FEATURE_TYPES.CHAMFER, name: optionalName(spec.name) ?? 'Chamfer', distance: requireNumber(spec.distance, 'distance', { positive: true }) });
    },
    /** @param {{ thickness: number, name?: string }} spec @returns {string} */
    shell(spec) {
      requireObject(spec, 'spec');
      return addFeature({ type: FEATURE_TYPES.SHELL, name: optionalName(spec.name) ?? 'Shell', thickness: requireNumber(spec.thickness, 'thickness', { positive: true }) });
    },
    /**
     * Change feature parameters (e.g. { depth: 40 }). The id, type and
     * dependency links cannot be changed.
     */
    update(id, changes) {
      const { feature } = findFeature(id);
      requireObject(changes, 'changes');
      for (const key of ['id', 'type', 'parentIds', 'childIds', 'sketchId']) {
        if (key in changes) fail('INVALID_ARGUMENT', `"${key}" cannot be changed`);
      }
      const clean = {};
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'name') clean.name = optionalName(value);
        else if (typeof value === 'number') clean[key] = requireNumber(value, key);
        else if (['string', 'boolean'].includes(typeof value)) clean[key] = value;
        else fail('INVALID_ARGUMENT', `"${key}" must be a number, string or boolean`);
      }
      if ('depth' in clean) requireNumber(clean.depth, 'depth', { positive: true });
      get().updateFeature(feature.id, clean);
    },
    /** Delete a feature. */
    remove(id) {
      const { feature } = findFeature(id);
      get().removeFeature(feature.id);
    },
    /** Suppress or unsuppress a feature (suppression cascades to dependent features). */
    setSuppressed(id, suppressed) {
      const { feature } = findFeature(id);
      if (typeof suppressed !== 'boolean') fail('INVALID_ARGUMENT', 'suppressed must be a boolean');
      if (!!feature.suppressed !== suppressed) get().toggleFeatureSuppressed(feature.id);
    },
    /**
     * Move the rollback bar. Pass null to roll forward to the end of the tree.
     * @param {number|null} index - evaluate features 0..index only
     */
    rollbackTo(index) {
      const count = get().features.length;
      if (index === null) {
        get().setRollbackIndex(-1);
        return;
      }
      if (!Number.isInteger(index) || index < 0 || index >= count) fail('INVALID_ARGUMENT', `index must be an integer from 0 to ${count - 1}, or null`);
      get().setRollbackIndex(index);
    },
  });

  // ------------------------------------------------------------- model
  const model = Object.freeze({
    /** Rebuild now. @returns {{ ok: boolean, bodyCount: number, errors: Array }} */
    rebuild() {
      return clone(rebuildModel(store));
    },
    /** @returns {Array<{featureId, featureName, error}>} errors from the last rebuild */
    errors() {
      ensureRebuilt();
      return clone(get().rebuildErrors || []);
    },
    /** @returns {boolean} true when the model has a solid body */
    hasBody() {
      return currentBody() !== null;
    },
    /**
     * Mass properties of the body using the active material.
     * @returns {object|null} null when there is no body. Units: mm, mm², mm³, kg, kg·mm².
     */
    massProperties() {
      const body = currentBody();
      if (!body) return null;
      const material = materialLibrary.getMaterial(get().activeMaterial);
      return clone(geometryEngine.computeMassProperties(body.geometry, material));
    },
    /** @returns {{min:{x,y,z}, max:{x,y,z}, size:{x,y,z}}|null} axis-aligned bounds in mm */
    boundingBox() {
      const body = currentBody();
      if (!body) return null;
      body.geometry.computeBoundingBox();
      const { min, max } = body.geometry.boundingBox;
      return {
        min: { x: min.x, y: min.y, z: min.z },
        max: { x: max.x, y: max.y, z: max.z },
        size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      };
    },
  });

  // ------------------------------------------------------------- materials
  const materials = Object.freeze({
    /** @returns {Array<{key, name, density, youngsModulus, poissonsRatio, yieldStrength}>} */
    list() {
      return materialLibrary.getAllMaterials().map(({ key, name, density, youngsModulus, poissonsRatio, yieldStrength }) =>
        ({ key, name, density, youngsModulus, poissonsRatio, yieldStrength }));
    },
    /** @returns {string} key of the active material */
    getActive() {
      return get().activeMaterial;
    },
    /** @param {string} key - a key from materials.list() */
    setActive(key) {
      if (!materialLibrary.materials[key]) fail('NOT_FOUND', `No material with key ${JSON.stringify(key)}`);
      get().setMaterial(key);
    },
  });

  // ------------------------------------------------------------- history
  const history = Object.freeze({
    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,
    /** @returns {boolean} false when there was nothing to undo */
    undo() {
      if (!history.canUndo()) return false;
      get().undo();
      return true;
    },
    /** @returns {boolean} false when there was nothing to redo */
    redo() {
      if (!history.canRedo()) return false;
      get().redo();
      return true;
    },
  });

  return Object.freeze({
    version: API_VERSION,
    units: Object.freeze({ system: 'MMGS', length: 'mm', angle: 'deg', mass: 'kg', density: 'kg/m^3' }),
    document,
    sketches,
    features,
    model,
    materials,
    history,
  });
}

export default createCasiWorksAPI;
