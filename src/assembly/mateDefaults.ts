// CasiWorks Pro - Default face references and offsets for each mate type (shared by commands and the API)
import type { MateType } from '../utils/constants.ts';

export const MATE_DEFAULTS: Record<MateType, { ref1: string; ref2: string; offset: number; swap?: boolean }> = {
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
