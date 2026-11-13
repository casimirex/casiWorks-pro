// CasiWorks Pro - Main Application Root
import React, { useEffect, useState } from 'react';
import MainLayout from './components/layout/MainLayout';
import ExportDialog from './components/dialogs/ExportDialog';
import MaterialDialog from './components/dialogs/MaterialDialog';
import MassPropsDialog from './components/dialogs/MassPropsDialog';
import ResultsViewer from './simulation/ResultsViewer';
import { useCADStore, ensureFeatureGraph } from './store/cadStore';
import { setupKeyboardShortcuts } from './utils/shortcuts';
import { featureEngine } from './features/FeatureEngine';
import { FEATURE_TYPES, SKETCH_ENTITY_TYPES } from './utils/constants';

export default function App() {
  const needsRebuild = useCADStore(s => s.needsRebuild);
  const rollbackIndex = useCADStore(s => s.rollbackIndex);
  const markRebuilt = useCADStore(s => s.markRebuilt);
  const features = useCADStore(s => s.features);
  const sketchEntities = useCADStore(s => s.sketchEntities);
  const setBodies = useCADStore(s => s.setBodies);
  const setStatus = useCADStore(s => s.setStatus);

  // Dialog states
  const [exportOpen, setExportOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [massPropsOpen, setMassPropsOpen] = useState(false);

  // Keyboard shortcuts
  useEffect(() => {
    const cleanup = setupKeyboardShortcuts(useCADStore);
    return cleanup;
  }, []);

  // Seed a starter part once, on first launch only. "New" and deleting every
  // feature must leave an empty document, so this does not depend on features.
  useEffect(() => {
    if (useCADStore.getState().features.length === 0) {
      // 1. Initial 2D Sketch: 60 x 40 base rectangle with centered circle hole
      const initialSketchId = 'sketch_initial_01';
      useCADStore.setState((state) => {
        state.sketchEntities[initialSketchId] = [
          { id: 'l1', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -30, y: -20 }, p2: { x: 30, y: -20 }, construction: false },
          { id: 'l2', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 30, y: -20 }, p2: { x: 30, y: 20 }, construction: false },
          { id: 'l3', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: 30, y: 20 }, p2: { x: -30, y: 20 }, construction: false },
          { id: 'l4', type: SKETCH_ENTITY_TYPES.LINE, p1: { x: -30, y: 20 }, p2: { x: -30, y: -20 }, construction: false },
        ];
        state.features.push({
          id: 'feat_sketch_1',
          name: 'Sketch1',
          type: FEATURE_TYPES.SKETCH,
          sketchId: initialSketchId,
          plane: 'Front',
          visible: true,
          suppressed: false,
        });
        state.features.push({
          id: 'feat_extrude_1',
          name: 'Boss-Extrude1',
          type: FEATURE_TYPES.EXTRUDE_BOSS,
          sketchId: initialSketchId,
          depth: 25,
          visible: true,
          suppressed: false,
        });
        ensureFeatureGraph(state.features);
        state.needsRebuild = true;
        state.isModified = false;
      });
    }
  }, []);

  // Rebuild model whenever feature tree changes
  useEffect(() => {
    if (needsRebuild) {
      try {
        const result = featureEngine.rebuild(features, sketchEntities, rollbackIndex);
        if (result && result.bodies) {
          // Free GPU buffers of the bodies being replaced
          useCADStore.getState().bodies.forEach(b => b.geometry?.dispose?.());
          const bodyObjects = result.bodies.map((geom, idx) => ({
            id: `body_${idx}`,
            geometry: geom,
            visible: true,
          }));
          setBodies(bodyObjects);
        }
        markRebuilt(result?.errors || []);
        if (result?.errors && result.errors.length > 0) {
          setStatus(`Rebuilt with ${result.errors.length} warning(s)`);
        } else {
          setStatus('Model rebuild complete');
        }
      } catch (err) {
        console.error('Rebuild failed:', err);
        setStatus('Rebuild error: ' + err.message);
      }
    }
  }, [needsRebuild, features, sketchEntities, rollbackIndex, setBodies, markRebuilt, setStatus]);

  return (
    <>
      <MainLayout
        onExportClick={() => setExportOpen(true)}
        onMaterialClick={() => setMaterialOpen(true)}
        onMassPropsClick={() => setMassPropsOpen(true)}
      />

      <ExportDialog isOpen={exportOpen} onClose={() => setExportOpen(false)} />
      <MaterialDialog isOpen={materialOpen} onClose={() => setMaterialOpen(false)} />
      <MassPropsDialog isOpen={massPropsOpen} onClose={() => setMassPropsOpen(false)} />

      {/* FEA stress simulation overlay */}
      <ResultsViewer />
    </>
  );
}
