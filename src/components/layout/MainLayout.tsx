// CasiWorks Pro - Main Application Layout (Responsive Desktop & Mobile)
import CommandManager from './CommandManager.tsx';
import FeatureTree from './FeatureTree.tsx';
import PropertyPanel from './PropertyPanel.tsx';
import StatusBar from './StatusBar.tsx';
import DocumentTabs from './DocumentTabs.tsx';
import Viewport3D from '../../viewport/Viewport3D.tsx';
import ErrorBoundary from '../common/ErrorBoundary.tsx';
import ScriptConsole from '../../console/ScriptConsole.tsx';
import ResultsViewer from '../../simulation/ResultsViewer.tsx';
import { useCADStore } from '../../store/cadStore.ts';

import { runCommand } from '../../commands/index.ts';

interface MainLayoutProps {
  /** Feature tree drawer state on small screens (toggled by the view.toggleFeatureTree command). */
  treeOpen: boolean;
  onCloseTree(): void;
  /** Scripting console (view.toggleConsole). */
  consoleOpen: boolean;
  onCloseConsole(): void;
}

export default function MainLayout({ treeOpen, onCloseTree, consoleOpen, onCloseConsole }: MainLayoutProps) {
  const closePropertyPanel = useCADStore(s => s.closePropertyPanel);

  return (
    <div className="app-container">
      <CommandManager />
      <DocumentTabs />

      <div className="workspace-middle">
        {/* Mobile backdrop for FeatureTree drawer */}
        {treeOpen && (
          <div
            className="mobile-backdrop"
            onClick={onCloseTree}
            title="Tap to close"
          />
        )}

        {/* Feature Tree Drawer */}
        <ErrorBoundary name="Feature tree" panel>
          <FeatureTree
            onMaterialClick={() => runCommand('model.material')}
            isOpen={treeOpen}
            onClose={onCloseTree}
          />
        </ErrorBoundary>

        {/* 3D Viewport Area */}
        <div className="viewport-wrapper" style={{ flex: 1, position: 'relative', height: '100%', overflow: 'hidden' }}>
          <ErrorBoundary name="3D viewport">
            <Viewport3D />
          </ErrorBoundary>
          {/* FEA panel: inside the viewport, so it never covers the property panel */}
          <ErrorBoundary name="FEA panel">
            <ResultsViewer />
          </ErrorBoundary>
          <ErrorBoundary name="Console" onReset={onCloseConsole}>
            <ScriptConsole open={consoleOpen} onClose={onCloseConsole} api={window.casiworks} />
          </ErrorBoundary>
        </div>

        {/* Properties Side / Bottom Sheet */}
        <ErrorBoundary name="Property panel" panel onReset={closePropertyPanel}>
          <PropertyPanel />
        </ErrorBoundary>
      </div>

      <StatusBar />
    </div>
  );
}
