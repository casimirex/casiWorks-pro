// CasiWorks Pro - Interference detection: which assembly components overlap, and by how much
//
// Components are checked pair by pair at their assembled positions (the exploded
// view is display only). Pairs whose bounding boxes do not overlap are skipped;
// the others are intersected as solids and the shared volume measured. Parts that
// only touch share no volume and are not reported.
import type * as THREE from 'three';
import { geometryEngine } from '../kernel/GeometryEngine.ts';

export interface InterferenceComponent {
  id: string;
  name: string;
  /** World-space geometry (as placed in the assembly). */
  geometry: THREE.BufferGeometry;
}

export interface Interference {
  a: string;
  b: string;
  aName: string;
  bName: string;
  /** Shared volume, mm³. */
  volume: number;
  /** The shared volume as a solid (for display). */
  geometry: THREE.BufferGeometry;
}

/** Overlap smaller than this (mm³) counts as touching. */
export const MIN_INTERFERENCE = 0.01;

const box = (g: THREE.BufferGeometry) => {
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox!;
};

/** Every overlapping pair, largest overlap first. */
export function findInterferences(components: InterferenceComponent[], minVolume = MIN_INTERFERENCE): Interference[] {
  const out: Interference[] = [];
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i], b = components[j];
      const ba = box(a.geometry), bb = box(b.geometry);
      // Boxes that only touch or are apart cannot share volume
      if (ba.max.x <= bb.min.x + 1e-9 || bb.max.x <= ba.min.x + 1e-9
        || ba.max.y <= bb.min.y + 1e-9 || bb.max.y <= ba.min.y + 1e-9
        || ba.max.z <= bb.min.z + 1e-9 || bb.max.z <= ba.min.z + 1e-9) continue;
      let shared: THREE.BufferGeometry;
      try {
        shared = geometryEngine.booleanIntersect(a.geometry, b.geometry);
      } catch {
        continue;
      }
      const volume = geometryEngine.computeMassProperties(shared)?.volume ?? 0;
      if (volume > minVolume) out.push({ a: a.id, b: b.id, aName: a.name, bName: b.name, volume, geometry: shared });
      else shared.dispose();
    }
  }
  return out.sort((p, q) => q.volume - p.volume);
}
