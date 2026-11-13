// CasiWorks Pro - Model rebuild: evaluate the feature tree into bodies.
// Used by the UI (App) and by the public API, so the model can be rebuilt
// without React (scripts, tests, a future headless server).
import { featureEngine } from './FeatureEngine.js';

/**
 * Rebuild the model held in the store and publish the resulting bodies.
 * @param {object} store - the zustand store (useCADStore)
 * @returns {{ ok: boolean, bodyCount: number, errors: Array<{featureId, featureName, error}> }}
 */
export function rebuildModel(store) {
  const state = store.getState();
  try {
    const result = featureEngine.rebuild(state.features, state.sketchEntities, state.rollbackIndex);
    const errors = result?.errors || [];

    // Free GPU buffers of the bodies being replaced
    state.bodies.forEach(b => b.geometry?.dispose?.());
    state.setBodies((result?.bodies || []).map((geometry, idx) => ({
      id: `body_${idx}`,
      geometry,
      visible: true,
    })));
    state.markRebuilt(errors);
    state.setStatus(errors.length > 0 ? `Rebuilt with ${errors.length} warning(s)` : 'Model rebuild complete');
    return { ok: errors.length === 0, bodyCount: result?.bodies?.length || 0, errors };
  } catch (err) {
    console.error('Rebuild failed:', err);
    const errors = [{ featureId: null, featureName: null, error: err.message }];
    state.markRebuilt(errors);
    state.setStatus('Rebuild error: ' + err.message);
    return { ok: false, bodyCount: 0, errors };
  }
}
