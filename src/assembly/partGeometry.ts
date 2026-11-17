// CasiWorks Pro - The shape of a part document, for use as an assembly component
//
// A component that references a part keeps only the reference; its shape is
// rebuilt here from the part's project content (features and sketches), the same
// way the part itself rebuilds. Several bodies become one mesh.
import * as THREE from 'three';
import { featureEngine } from '../features/FeatureEngine.ts';
import type { Feature, SketchEntityMap } from '../types/cad.ts';

export interface PartShape {
  geometry: THREE.BufferGeometry;
  /** The part's material key. */
  material: string;
  /** The part's document name. */
  name: string;
  /** Changes when the part's geometry inputs change (features, sketches, rollback). */
  fingerprint: string;
  /** Rebuild warnings of the part. */
  warnings: number;
}

/** A short hash of a string (FNV-1a, 32 bit), enough to notice a change. */
export function fingerprintOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface PartContent {
  documentName?: string;
  documentType?: string;
  features?: Feature[];
  sketchEntities?: SketchEntityMap;
  rollbackIndex?: number;
  activeMaterial?: string;
}

/** The fingerprint of a part's content: only what changes its shape. */
export function partFingerprint(content: string | PartContent): string {
  const p = (typeof content === 'string' ? JSON.parse(content) : content) as PartContent;
  return fingerprintOf(JSON.stringify([p.features ?? [], p.sketchEntities ?? {}, p.rollbackIndex ?? -1]));
}

/** One mesh from several bodies (positions only, as triangles). */
export function mergeBodies(bodies: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = bodies.map(b => (b.index ? b.toNonIndexed() : b).getAttribute('position'));
  const total = parts.reduce((s, p) => s + p.count * 3, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < p.count; i++) { out[at++] = p.getX(i); out[at++] = p.getY(i); out[at++] = p.getZ(i); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/**
 * Rebuild a part document's content into one mesh. Throws when the content is
 * not a part or has no solid body.
 */
export function partShape(content: string): PartShape {
  let p: PartContent;
  try {
    p = JSON.parse(content) as PartContent;
  } catch {
    throw new Error('The part document is not a valid project');
  }
  if (p.documentType === 'assembly') throw new Error(`${p.documentName ?? 'The document'} is an assembly, not a part`);
  if (!Array.isArray(p.features)) throw new Error('The part document has no features');
  const result = featureEngine.rebuild(p.features, p.sketchEntities ?? {}, Number.isInteger(p.rollbackIndex) ? p.rollbackIndex! : null) as
    { bodies?: THREE.BufferGeometry[]; errors?: unknown[] } | null;
  const bodies = (result?.bodies ?? []).filter(b => (b.getAttribute('position')?.count ?? 0) >= 3);
  if (bodies.length === 0) throw new Error(`${p.documentName ?? 'The part'} has no solid body`);
  return {
    geometry: mergeBodies(bodies),
    material: p.activeMaterial || 'Steel_1020',
    name: p.documentName || 'Part',
    fingerprint: partFingerprint(p),
    warnings: result?.errors?.length ?? 0,
  };
}
