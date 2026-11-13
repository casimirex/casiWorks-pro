// CasiWorks Pro - Main Application Layout (Responsive Desktop & Mobile)
import { useState } from 'react';
import CommandManager from './CommandManager.tsx';
import FeatureTree from './FeatureTree.tsx';
import PropertyPanel from './PropertyPanel.tsx';
import StatusBar from './StatusBar.tsx';
import Viewport3D from '../../viewport/Viewport3D.tsx';
import ErrorBoundary from '../common/ErrorBoundary.tsx';
import { useCADStore } from '../../store/cadStore.ts';

interface MainLayoutProps {
  onExportClick(): void;
  onMaterialClick(): void;
  onMassPropsClick(): void;
}

export default function MainLayout({ onExportClick, onMaterialClick, onMassPropsClick }: MainLayoutProps) {
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const closePropertyPanel = useCADStore(s => s.closePropertyPanel);

  return (
    <div className="app-container">
      <CommandManager
        onExportClick={onExportClick}
        onMaterialClick={onMaterialClick}
        onMassPropsClick={onMassPropsClick}
        onToggleTree={() => setMobileTreeOpen(prev => !prev)}
      />

      <div className="workspace-middle">
        {/* Mobile backdrop for FeatureTree drawer */}
        {mobileTreeOpen && (
          <div
            className="mobile-backdrop"
            onClick={() => setMobileTreeOpen(false)}
            title="Tap to close"
          />
        )}

        {/* Feature Tree Drawer */}
        <ErrorBoundary name="Feature tree" panel>
          <FeatureTree
            onMaterialClick={onMaterialClick}
            isOpen={mobileTreeOpen}
            onClose={() => setMobileTreeOpen(false)}
          />
        </ErrorBoundary>

        {/* 3D Viewport Area */}
        <div className="viewport-wrapper" style={{ flex: 1, position: 'relative', height: '100%', overflow: 'hidden' }}>
          <ErrorBoundary name="3D viewport">
            <Viewport3D />
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
