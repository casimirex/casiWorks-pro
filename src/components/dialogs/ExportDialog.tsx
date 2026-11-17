// CasiWorks Pro - Export Dialog
import { useState } from 'react';
import { X, Download } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { exportEngine } from '../../kernel/ExportEngine.ts';
import { useDialog } from '../common/useDialog.ts';

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}

export default function ExportDialog({ isOpen, onClose }: DialogProps) {
  const bodies = useCADStore(s => s.bodies);
  const documentName = useCADStore(s => s.documentName);

  const [format, setFormat] = useState('stl_binary');

  const dialog = useDialog(isOpen, onClose, 'Export CAD Model');
  if (!isOpen) return null;

  const handleExport = () => {
    const filenameBase = documentName.replace(/\s+/g, '_');

    // Get active or first body geometry
    const primaryGeometry = bodies.length > 0 ? bodies[0].geometry : null;

    if (!primaryGeometry) {
      alert('No 3D solid bodies to export! Create an extrude or feature first.');
      return;
    }

    if (format === 'stl_binary') {
      const blob = exportEngine.exportSTL(primaryGeometry, true);
      exportEngine.downloadFile(blob, `${filenameBase}.stl`, 'application/sla');
    } else if (format === 'stl_ascii') {
      const blob = exportEngine.exportSTL(primaryGeometry, false);
      exportEngine.downloadFile(blob, `${filenameBase}_ascii.stl`, 'text/plain');
    } else if (format === 'obj') {
      const blob = exportEngine.exportOBJ(primaryGeometry, filenameBase);
      exportEngine.downloadFile(blob, `${filenameBase}.obj`, 'text/plain');
    } else if (format === 'step') {
      const blob = exportEngine.exportSTEP(primaryGeometry, filenameBase);
      exportEngine.downloadFile(blob, `${filenameBase}.stp`, 'application/step');
    } else if (format === 'iges') {
      const blob = exportEngine.exportIGES(primaryGeometry, filenameBase);
      exportEngine.downloadFile(blob, `${filenameBase}.igs`, 'model/iges');
    } else if (format === 'dxf') {
      // The model's triangles as 3DFACE entities, as the option describes
      const blob = exportEngine.exportDXF(primaryGeometry);
      exportEngine.downloadFile(blob, `${filenameBase}.dxf`, 'application/dxf');
    }

    onClose();
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()} {...dialog}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={16} color="#4fc3f7" />
            <span>Export CAD Model</span>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="dialog-body">
          <p style={{ color: '#aaa', fontSize: 12 }}>
            Choose an engineering export format for 3D printing, CNC machining, or downstream CAD software.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="format" checked={format === 'stl_binary'} onChange={() => setFormat('stl_binary')} />
              <span><strong>STL (Binary)</strong> — Recommended for 3D printing (.stl)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="format" checked={format === 'stl_ascii'} onChange={() => setFormat('stl_ascii')} />
              <span><strong>STL (ASCII)</strong> — Text-based STL format (.stl)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="format" checked={format === 'step'} onChange={() => setFormat('step')} />
              <span><strong>STEP AP214</strong> — ISO 10303 faceted solid, opens in all major CAD tools (.stp)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="format" checked={format === 'iges'} onChange={() => setFormat('iges')} />
              <span><strong>IGES 5.3</strong> — Faceted solid (manifold solid B-rep, type 186) (.igs)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="format" checked={format === 'obj'} onChange={() => setFormat('obj')} />
              <span><strong>Wavefront OBJ</strong> — Mesh format for rendering & animation (.obj)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="radio" name="format" checked={format === 'dxf'} onChange={() => setFormat('dxf')} />
              <span><strong>DXF (AutoCAD R12)</strong> — Triangulated 3D faces (3DFACE) of the model (.dxf)</span>
            </label>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleExport}>
            <Download size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} /> Export File
          </button>
        </div>
      </div>
    </div>
  );
}
