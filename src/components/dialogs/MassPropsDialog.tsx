// CasiWorks Pro - Mass Properties Dialog
import { useMemo, useState } from 'react';
import { X, Scale } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { materialLibrary } from '../../kernel/MaterialLibrary.ts';
import { geometryEngine } from '../../kernel/GeometryEngine.ts';
import { featureFrame, massPropertiesIn } from '../../features/coordinateSystems.ts';

/** Two decimals, without a minus sign on zero. */
const mm = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
const formatInertia = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v.toPrecision(6) : '—');

interface DialogProps {
  isOpen: boolean;
  onClose(): void;
}

export default function MassPropsDialog({ isOpen, onClose }: DialogProps) {
  const bodies = useCADStore(s => s.bodies);
  const activeMaterial = useCADStore(s => s.activeMaterial);

  const features = useCADStore(s => s.features);
  // Report in the model frame, or in a coordinate system
  const [csId, setCsId] = useState('');
  const systems = features.filter(f => f.type === 'coordinate_system' && !f.suppressed);
  const system = systems.find(f => f.id === csId);
  const frame = useMemo(() => (system ? featureFrame(system, features) : null), [system, features]);

  const matData = materialLibrary.getMaterial(activeMaterial);

  const massProps = useMemo(() => {
    if (bodies.length === 0 || !bodies[0].geometry) {
      return null;
    }
    const mp = geometryEngine.computeMassProperties(bodies[0].geometry, matData);
    return mp && frame ? massPropertiesIn(mp, frame) : mp;
  }, [bodies, matData, frame]);

  if (!isOpen) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-box" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Scale size={16} color="#4fc3f7" />
            <span>Mass Properties: {matData.name}</span>
          </div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="dialog-body">
          {massProps ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
              <div style={{ background: '#1c1c1f', padding: 8, borderRadius: 4 }}>
                <strong>Material:</strong> {matData.name} (Density: {matData.density} kg/m³)
              </div>
              {systems.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  Report relative to:
                  <select className="mass-props-cs" value={system ? csId : ''} onChange={(e) => setCsId(e.target.value)}
                    style={{ background: '#111', color: '#fff', border: '1px solid #444', borderRadius: 3, padding: '2px 4px' }}>
                    <option value="">Model origin</option>
                    {systems.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </label>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: '#252529', padding: 8, borderRadius: 4 }}>
                  <div style={{ color: '#aaa' }}>Total Mass</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#4fc3f7', marginTop: 4 }}>
                    {(massProps.mass * 1000).toFixed(2)} g
                    <span style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>({massProps.mass.toFixed(4)} kg)</span>
                  </div>
                </div>

                <div style={{ background: '#252529', padding: 8, borderRadius: 4 }}>
                  <div style={{ color: '#aaa' }}>Volume</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#81c784', marginTop: 4 }}>
                    {(massProps.volume / 1000).toFixed(2)} cm³
                  </div>
                </div>

                <div style={{ background: '#252529', padding: 8, borderRadius: 4 }}>
                  <div style={{ color: '#aaa' }}>Surface Area</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#ffb74d', marginTop: 4 }}>
                    {(massProps.surfaceArea / 100).toFixed(2)} cm²
                  </div>
                </div>

                <div style={{ background: '#252529', padding: 8, borderRadius: 4 }}>
                  <div style={{ color: '#aaa' }}>Center of Mass (X, Y, Z){system ? ` in ${system.name}` : ''}</div>
                  <div className="mass-props-com" style={{ fontSize: 13, fontWeight: 600, color: '#ce93d8', marginTop: 4 }}>
                    ({mm(massProps.centerOfMass.x)}, {mm(massProps.centerOfMass.y)}, {mm(massProps.centerOfMass.z)}) mm
                  </div>
                </div>
              </div>

              <div style={{ background: '#1c1c1f', padding: 8, borderRadius: 4, fontFamily: 'monospace', fontSize: 11 }}>
                <div style={{ color: '#aaa', marginBottom: 4 }}>Moments of Inertia at center of mass{system ? `, along ${system.name}'s axes` : ''} (kg · mm²):</div>
                <div>Ixx: {formatInertia(massProps.momentOfInertia?.Ixx)}</div>
                <div>Iyy: {formatInertia(massProps.momentOfInertia?.Iyy)}</div>
                <div>Izz: {formatInertia(massProps.momentOfInertia?.Izz)}</div>
                <div style={{ color: '#aaa', margin: '6px 0 4px' }}>About the {system ? `${system.name} origin` : 'model origin'} (kg · mm²):</div>
                <div className="mass-props-origin">Ixx: {formatInertia(massProps.momentOfInertiaAtOrigin?.Ixx)}  Iyy: {formatInertia(massProps.momentOfInertiaAtOrigin?.Iyy)}  Izz: {formatInertia(massProps.momentOfInertiaAtOrigin?.Izz)}</div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: 24, color: '#888' }}>
              No 3D solid bodies currently active in model.
            </div>
          )}
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
