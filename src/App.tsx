// CasiWorks Pro - Main Application Root
import { useEffect, useState } from 'react';
import MainLayout from './components/layout/MainLayout.tsx';
import ExportDialog from './components/dialogs/ExportDialog.tsx';
import MaterialDialog from './components/dialogs/MaterialDialog.tsx';
import MassPropsDialog from './components/dialogs/MassPropsDialog.tsx';
import AddinsDialog from './components/dialogs/AddinsDialog.tsx';
import ResultsViewer from './simulation/ResultsViewer.tsx';
import DrawingViewModal from './drawings/DrawingViewModal.tsx';
import { commands } from './commands/index.ts';
import { useCADStore, ensureFeatureGraph } from './store/cadStore.ts';
import { setupKeyboardShortcuts } from './utils/shortcuts.ts';
import { rebuildModel } from './features/rebuildModel.ts';
import { FEATURE_TYPES, SKETCH_ENTITY_TYPES } from './utils/constants.ts';
import type { FeatureData } from './types/cad.ts';

export default function App() {
  const needsRebuild = useCADStore(s => s.needsRebuild);

  // Dialog states
  const [exportOpen, setExportOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [massPropsOpen, setMassPropsOpen] = useState(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [addinsOpen, setAddinsOpen] = useState(false);

  // The UI that commands open dialogs in, and keyboard shortcuts that run commands
  useEffect(() => {
    commands.setUIHost({
      openDialog: (name) => {
        if (name === 'export') setExportOpen(true);
        else if (name === 'material') setMaterialOpen(true);
        else if (name === 'massProperties') setMassPropsOpen(true);
        else if (name === 'drawing') setDrawingOpen(true);
        else if (name === 'addins') setAddinsOpen(true);
      },
      toggleFeatureTree: () => setTreeOpen(open => !open),
      toggleConsole: () => setConsoleOpen(open => !open),
    });
    const removeShortcuts = setupKeyboardShortcuts(commands, (message) => useCADStore.getState().setStatus(message));
    return () => {
      removeShortcuts();
      commands.setUIHost(null);
    };
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
        const starter: FeatureData[] = [{
          id: 'feat_sketch_1',
          name: 'Sketch1',
          type: FEATURE_TYPES.SKETCH,
          sketchId: initialSketchId,
          plane: 'Front',
          visible: true,
          suppressed: false,
        }, {
          id: 'feat_extrude_1',
          name: 'Boss-Extrude1',
          type: FEATURE_TYPES.EXTRUDE_BOSS,
          sketchId: initialSketchId,
          depth: 25,
          visible: true,
          suppressed: false,
        }];
        state.features.push(...ensureFeatureGraph(starter));
        state.needsRebuild = true;
        state.isModified = false;
      });
    }
  }, []);

  // Rebuild model whenever the feature tree is marked dirty
  useEffect(() => {
    if (needsRebuild) rebuildModel(useCADStore);
  }, [needsRebuild]);

  return (
    <>
      <MainLayout treeOpen={treeOpen} onCloseTree={() => setTreeOpen(false)} consoleOpen={consoleOpen} onCloseConsole={() => setConsoleOpen(false)} />

      <ExportDialog isOpen={exportOpen} onClose={() => setExportOpen(false)} />
      <MaterialDialog isOpen={materialOpen} onClose={() => setMaterialOpen(false)} />
      <MassPropsDialog isOpen={massPropsOpen} onClose={() => setMassPropsOpen(false)} />
      <AddinsDialog isOpen={addinsOpen} onClose={() => setAddinsOpen(false)} />

      {/* FEA stress simulation overlay */}
      <ResultsViewer />
      <DrawingViewModal isOpen={drawingOpen} onClose={() => setDrawingOpen(false)} />
    </>
  );
}
