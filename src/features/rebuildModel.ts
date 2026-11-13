// CasiWorks Pro - Model rebuild: evaluate the feature tree into bodies.
// Used by the UI (App) and by the public API, so the model can be rebuilt
// without React (scripts, tests, a future headless server).
import type { BufferGeometry } from 'three';
import { featureEngine } from './FeatureEngine.js';
import type { Feature, RebuildError, SketchEntityMap } from '../types/cad.ts';

/** A solid body produced by a rebuild. */
export interface Body {
  id: string;
  geometry: BufferGeometry;
  visible: boolean;
}

/** The store slice a rebuild reads and writes (CADStore satisfies it; checked in cadStore.ts). */
export interface RebuildState {
  features: Feature[];
  sketchEntities: SketchEntityMap;
  rollbackIndex: number;
  bodies: Array<{ geometry: BufferGeometry | null }>;
  setBodies(bodies: Body[]): void;
  markRebuilt(errors: RebuildError[]): void;
  setStatus(message: string): void;
}

export interface RebuildResult {
  ok: boolean;
  bodyCount: number;
  errors: RebuildError[];
}

/** Rebuild the model held in the store and publish the resulting bodies. */
export function rebuildModel(store: { getState(): RebuildState }): RebuildResult {
  const state = store.getState();
  try {
    const result = featureEngine.rebuild(state.features, state.sketchEntities, state.rollbackIndex) as
      { bodies?: BufferGeometry[]; errors?: RebuildError[] } | null;
    const errors = result?.errors ?? [];
    const geometries = result?.bodies ?? [];

    // Free GPU buffers of the bodies being replaced
    state.bodies.forEach(b => b.geometry?.dispose());
    state.setBodies(geometries.map((geometry, idx) => ({ id: `body_${idx}`, geometry, visible: true })));
    state.markRebuilt(errors);
    state.setStatus(errors.length > 0 ? `Rebuilt with ${errors.length} warning(s)` : 'Model rebuild complete');
    return { ok: errors.length === 0, bodyCount: geometries.length, errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Rebuild failed:', err);
    const errors: RebuildError[] = [{ featureId: null, featureName: null, error: message }];
    state.markRebuilt(errors);
    state.setStatus('Rebuild error: ' + message);
    return { ok: false, bodyCount: 0, errors };
  }
}
