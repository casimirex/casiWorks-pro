/**
 * CasiWorks Pro - Safe Deep Clone Utility
 * - Handles circular references cleanly via WeakMap
 * - Strips and prevents leaking Three.js prototypes (Object3D, BufferGeometry, Material, Texture)
 * - Safely converts Three.js math classes (Vector2, Vector3, Vector4, Euler, Quaternion, Color) to plain objects
 * - Clones Arrays, Sets, Maps, Dates, RegExps, and plain objects
 * - Skips DOM elements, functions, symbols
 */

/** Duck-typed markers three.js puts on its class instances. */
interface ThreeMarkers {
  isObject3D?: boolean;
  isBufferGeometry?: boolean;
  isMaterial?: boolean;
  isTexture?: boolean;
  isVector2?: boolean;
  isVector3?: boolean;
  isEuler?: boolean;
  isQuaternion?: boolean;
  isColor?: boolean;
  x?: number;
  y?: number;
  z?: number;
  w?: number;
  r?: number;
  g?: number;
  b?: number;
}

export interface PlainVector { x?: number; y?: number; z?: number; w?: number }
export interface PlainColor { r?: number; g?: number; b?: number }

/**
 * Deep-clone a value into plain, serializable data.
 * Three.js scene objects, geometries, materials and textures become `undefined`
 * (dropped from objects, `null` inside arrays); functions, symbols and DOM nodes are skipped.
 */
export function safeDeepClone<T>(val: T, seen?: WeakMap<object, unknown>): T;
export function safeDeepClone(val: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }

  if (seen.has(val)) {
    return seen.get(val);
  }

  const three = val as ThreeMarkers;

  // Prevent leaking heavy Three.js prototypes / GPU resources into store snapshots
  if (three.isObject3D || three.isBufferGeometry || three.isMaterial || three.isTexture) {
    return undefined;
  }

  // Safely flatten Three.js math classes to plain serializable objects
  if (three.isVector3 || three.isVector2) {
    const copy: PlainVector = { x: three.x, y: three.y };
    if (three.z !== undefined) copy.z = three.z;
    return copy;
  }
  if (three.isEuler || three.isQuaternion) {
    const copy: PlainVector = { x: three.x, y: three.y, z: three.z };
    if (three.w !== undefined) copy.w = three.w;
    return copy;
  }
  if (three.isColor) {
    const color: PlainColor = { r: three.r, g: three.g, b: three.b };
    return color;
  }

  if (val instanceof Date) {
    return new Date(val.getTime());
  }

  if (val instanceof RegExp) {
    return new RegExp(val.source, val.flags);
  }

  if (Array.isArray(val)) {
    const arrCopy: unknown[] = [];
    seen.set(val, arrCopy);
    for (const item of val) {
      const cloned = safeDeepClone(item, seen);
      arrCopy.push(cloned !== undefined ? cloned : null);
    }
    return arrCopy;
  }

  if (val instanceof Set) {
    const setCopy = new Set<unknown>();
    seen.set(val, setCopy);
    for (const item of val) {
      const cloned = safeDeepClone(item, seen);
      if (cloned !== undefined) setCopy.add(cloned);
    }
    return setCopy;
  }

  if (val instanceof Map) {
    const mapCopy = new Map<unknown, unknown>();
    seen.set(val, mapCopy);
    for (const [k, v] of val.entries()) {
      mapCopy.set(safeDeepClone(k, seen), safeDeepClone(v, seen));
    }
    return mapCopy;
  }

  // Plain object
  const objCopy: Record<string, unknown> = {};
  seen.set(val, objCopy);
  for (const [key, value] of Object.entries(val)) {
    // Skip functions, symbols, and DOM elements
    if (typeof value === 'function' || typeof value === 'symbol' || (value && (value as { nodeType?: number }).nodeType)) {
      continue;
    }
    const cloned = safeDeepClone(value, seen);
    if (cloned !== undefined) {
      objCopy[key] = cloned;
    }
  }
  return objCopy;
}

export default safeDeepClone;
