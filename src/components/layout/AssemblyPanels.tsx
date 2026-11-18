// CasiWorks Pro - Assembly panels: mate two picked faces, drive a mate (motion), explode steps
import { unitsFor, useUnits } from '../common/useUnits.ts';
import type { Units } from '../common/useUnits.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, Play, Square, Trash2, Plus, Wand2 } from 'lucide-react';
import { useCADStore } from '../../store/cadStore.ts';
import { runCommand } from '../../commands/index.ts';
import { matesFor } from '../../assembly/facePick.ts';
import type { PickedFace } from '../../assembly/facePick.ts';
import { assemblyManager } from '../../assembly/AssemblyManager.ts';
import NumericInput from '../common/NumericInput.tsx';

const MATE_LABEL: Record<string, string> = {
  coincident: 'Coincident (faces touch)',
  distance: 'Distance (faces apart)',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  angle: 'Angle',
  concentric: 'Concentric (same axis)',
  tangent: 'Tangent (cylinder on face)',
};

const faceText = (f: PickedFace, u: Units = unitsFor('MMGS')) => (f.kind === 'plane' ? `flat face, ${u.area(f.area)}` : `cylinder Ø${u.len(f.radius * 2, { fixed: true })}`);

/** Shared frame: OK / Cancel header, a title, and the body. */
function PanelFrame({ title, onOk, onCancel, okLabel = 'OK', okDisabled, children }: {
  title: string; onOk(): void; onCancel(): void; okLabel?: string; okDisabled?: boolean; children: React.ReactNode;
}) {
  return (
    <aside className="property-panel" aria-label={title}>
      <div className="property-actions-header">
        <button className="action-btn-green" onClick={onOk} disabled={okDisabled} title="Apply (Enter)">
          <Check size={16} strokeWidth={2.5} /> <span>{okLabel}</span>
        </button>
        <div className="property-header-title" title={title}><span className="property-panel-title">{title}</span></div>
        <button className="action-btn-red" onClick={onCancel} title="Cancel (Esc)">
          <X size={16} strokeWidth={2.5} /> <span>Cancel</span>
        </button>
      </div>
      <div className="panel-content property-scroll-area">{children}</div>
    </aside>
  );
}

/** Choose the mate between the two faces picked with the Mate tool. */
export function MateFacesPanel() {
  const units = useUnits();
  const picks = useCADStore(s => s.matePicks);
  const components = useCADStore(s => s.assemblyComponents);
  const closePropertyPanel = useCADStore(s => s.closePropertyPanel);
  const clearMatePicks = useCADStore(s => s.clearMatePicks);
  const options = useMemo(() => (picks.length === 2 ? matesFor(picks[0].face, picks[1].face) : []), [picks]);
  const [type, setType] = useState(options[0] ?? 'coincident');
  const [offset, setOffset] = useState(10);
  const [angle, setAngle] = useState(90);
  useEffect(() => { setType(options[0] ?? 'coincident'); }, [options]);
  const nameOf = (id: string) => components.find(c => c.id === id)?.name ?? id;

  const add = () => runCommand('assembly.addFaceMate', { type, ...(type === 'distance' ? { offset } : {}), ...(type === 'angle' ? { angle } : {}) });
  const cancel = () => { clearMatePicks(); closePropertyPanel(); };

  return (
    <PanelFrame title="Mate" onOk={add} onCancel={cancel} okLabel="Add mate" okDisabled={picks.length < 2}>
      <div className="property-card">
        <div className="property-card-header">Picked faces</div>
        <div className="property-card-body">
          {picks.map((p, i) => (
            <div key={i} className="property-row mate-pick" style={{ fontSize: 12 }}>
              <span className="property-label">{i + 1}. {nameOf(p.componentId)}</span>
              <span style={{ color: '#22d3ee' }}>{faceText(p.face, units)}</span>
            </div>
          ))}
          {picks.length < 2 && <div style={{ fontSize: 11, color: '#94a3b8' }}>Pick a face on another component.</div>}
        </div>
      </div>
      {picks.length === 2 && (
        <div className="property-card">
          <div className="property-card-header">Mate</div>
          <div className="property-card-body">
            <div role="radiogroup" aria-label="Mate type" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {options.map(o => (
                <label key={o} className="mate-type-option" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                  <input type="radio" name="mate-type" value={o} checked={type === o} onChange={() => setType(o)} />
                  {MATE_LABEL[o] ?? o}
                </label>
              ))}
            </div>
            {type === 'distance' && (
              <div className="property-row" style={{ marginTop: 8 }}>
                <span className="property-label">Distance</span>
                <NumericInput value={offset} onChange={setOffset} min={-1000} max={1000} step={1} unit="mm" label="Mate distance" />
              </div>
            )}
            {type === 'angle' && (
              <div className="property-row" style={{ marginTop: 8 }}>
                <span className="property-label">Angle</span>
                <NumericInput value={angle} onChange={setAngle} min={-360} max={360} step={5} unit="°" label="Mate angle" />
              </div>
            )}
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8 }}>
              The Mate tool stays on: pick the next two faces, or press Esc when done.
            </div>
          </div>
        </div>
      )}
    </PanelFrame>
  );
}

/** Drive a distance or angle mate: a slider, and Play from one value to another. */
export function MotionPanel() {
  const mates = useCADStore(s => s.mates);
  const components = useCADStore(s => s.assemblyComponents);
  const closePropertyPanel = useCADStore(s => s.closePropertyPanel);
  const drivable = mates.filter(m => m.type === 'angle' || m.type === 'distance');
  const [mateId, setMateId] = useState(drivable[0]?.id ?? '');
  const mate = drivable.find(m => m.id === mateId) ?? drivable[0];
  const isAngle = mate?.type === 'angle';
  const current = mate ? (isAngle ? mate.angle : mate.offset) : 0;
  const [from, setFrom] = useState(current);
  const [to, setTo] = useState(isAngle ? current + 90 : current + 20);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const nameOf = (id: string) => components.find(c => c.id === id)?.name ?? id;

  useEffect(() => {
    if (!mate) return;
    const v = isAngle ? mate.angle : mate.offset;
    setFrom(v);
    setTo(isAngle ? v + 90 : v + 20);
    // A different mate chosen: start from where it is
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mate?.id]);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const drive = (value: number) => { if (mate) runCommand('assembly.drive', { mate: mate.id, value }); };
  const play = () => {
    if (!mate) return;
    if (playing) { if (raf.current) cancelAnimationFrame(raf.current); setPlaying(false); return; }
    setPlaying(true);
    const start = performance.now(), ms = 2500;
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      // Ease in and out
      drive(from + (to - from) * (0.5 - Math.cos(Math.PI * k) / 2));
      if (k < 1) raf.current = requestAnimationFrame(frame); else setPlaying(false);
    };
    raf.current = requestAnimationFrame(frame);
  };

  const lo = Math.min(from, to), hi = Math.max(from, to);
  return (
    <PanelFrame title="Motion" onOk={closePropertyPanel} onCancel={closePropertyPanel} okLabel="Done">
      <div className="property-card">
        <div className="property-card-header">Drive a mate</div>
        <div className="property-card-body">
          {drivable.length === 0 ? (
            <div className="motion-none" style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1.5 }}>
              Motion moves parts along their mates by changing a distance or angle mate. Add one first: with the Mate tool, pick two flat faces and choose Distance or Angle.
            </div>
          ) : (
            <>
              <label className="property-label" htmlFor="motion-mate">Mate</label>
              <select id="motion-mate" className="property-select motion-mate" value={mate?.id} onChange={(e) => setMateId(e.target.value)}>
                {drivable.map(m => <option key={m.id} value={m.id}>{m.type === 'angle' ? 'Angle' : 'Distance'}: {nameOf(m.comp1Id)} – {nameOf(m.comp2Id)}</option>)}
              </select>
              <div className="property-row" style={{ marginTop: 8 }}>
                <span className="property-label">Now</span>
                <span className="motion-value" style={{ fontWeight: 600, color: '#38bdf8', fontVariantNumeric: 'tabular-nums' }}>{current.toFixed(isAngle ? 1 : 2)} {isAngle ? '°' : 'mm'}</span>
              </div>
              <input type="range" aria-label="Mate value" className="motion-slider" min={lo} max={hi === lo ? lo + 1 : hi} step={isAngle ? 1 : 0.5}
                value={Math.max(lo, Math.min(hi, current))} onChange={(e) => drive(parseFloat(e.target.value))}
                style={{ width: '100%', margin: '8px 0', accentColor: '#38bdf8' }} />
              <div className="property-row">
                <span className="property-label">From</span>
                <NumericInput value={from} onChange={setFrom} min={-3600} max={3600} step={isAngle ? 5 : 1} unit={isAngle ? '°' : 'mm'} label="Motion from" />
              </div>
              <div className="property-row">
                <span className="property-label">To</span>
                <NumericInput value={to} onChange={setTo} min={-3600} max={3600} step={isAngle ? 5 : 1} unit={isAngle ? '°' : 'mm'} label="Motion to" />
              </div>
              <button className="segment-btn motion-play" style={{ width: '100%', marginTop: 8, display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }} onClick={play}>
                {playing ? <><Square size={13} /> Stop</> : <><Play size={13} /> Play {from}→{to}</>}
              </button>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>
                Every frame changes the mate and solves the assembly, so everything mated to the moving part follows.
              </div>
            </>
          )}
        </div>
      </div>
    </PanelFrame>
  );
}

const DIRECTIONS: Array<[string, { x: number; y: number; z: number }]> = [
  ['+X', { x: 1, y: 0, z: 0 }], ['-X', { x: -1, y: 0, z: 0 }],
  ['+Y', { x: 0, y: 1, z: 0 }], ['-Y', { x: 0, y: -1, z: 0 }],
  ['+Z', { x: 0, y: 0, z: 1 }], ['-Z', { x: 0, y: 0, z: -1 }],
];
const dirName = (d: { x: number; y: number; z: number }) =>
  DIRECTIONS.find(([, v]) => Math.abs(v.x - d.x) + Math.abs(v.y - d.y) + Math.abs(v.z - d.z) < 1e-6)?.[0]
  ?? `(${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)})`;

/** Explode steps inside the exploded view panel: list, add from the selection, play. */
export function ExplodeStepsCard() {
  const units = useUnits();
  const steps = useCADStore(s => s.explodeSteps);
  const components = useCADStore(s => s.assemblyComponents);
  const selected = useCADStore(s => s.selectedEntities);
  const explodedView = useCADStore(s => s.explodedView);
  const [dir, setDir] = useState('+Y');
  const [distance, setDistance] = useState(40);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  const ids = new Set(components.map(c => c.id));
  const chosen = selected.map(e => e.id).filter(id => ids.has(id));
  const nameOf = (id: string) => components.find(c => c.id === id)?.name ?? id;
  const asSpec = (list: typeof steps) => list.map(s => ({ components: s.componentIds, direction: s.direction, distance: s.distance }));
  const progress = explodedView?.progress ?? 1;

  const show = (p: number) => runCommand('assembly.explode', { distance: explodedView?.distance ?? 40, leaderLines: explodedView?.leaderLines ?? true, progress: p });
  const addStep = () => {
    if (!chosen.length) return;
    runCommand('assembly.setExplodeSteps', { steps: [...asSpec(steps), { components: chosen, direction: dir, distance }] });
    show(1);
  };
  const removeStep = (i: number) => runCommand('assembly.setExplodeSteps', { steps: asSpec(steps.filter((_, j) => j !== i)) });
  const autoSteps = () => {
    // The automatic explode, one step per moved component, as a starting point to edit
    const auto = assemblyManager.createExplodedView({ distance: explodedView?.distance ?? 40, leaderLines: false });
    const made = auto.components.filter(c => c.distance > 0).map(c => ({ components: [c.id], direction: { x: c.explosionAxis.x, y: c.explosionAxis.y, z: c.explosionAxis.z }, distance: c.distance }));
    if (made.length) { runCommand('assembly.setExplodeSteps', { steps: made }); show(1); }
  };
  const play = () => {
    if (playing) { if (raf.current) cancelAnimationFrame(raf.current); setPlaying(false); return; }
    setPlaying(true);
    const start = performance.now(), ms = 1200 * Math.max(1, steps.length);
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      show(k);
      if (k < 1) raf.current = requestAnimationFrame(frame); else setPlaying(false);
    };
    raf.current = requestAnimationFrame(frame);
  };

  return (
    <div className="property-card explode-steps">
      <div className="property-card-header">Explode steps</div>
      <div className="property-card-body">
        {steps.length === 0 && (
          <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
            No steps: the slider above spreads the parts out automatically. Make steps to choose which parts move, where, and in what order.
          </div>
        )}
        <ol className="explode-step-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {steps.map((s, i) => (
            <li key={s.id} className="explode-step" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
              <span style={{ color: '#38bdf8', fontWeight: 700, minWidth: 18 }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.componentIds.map(nameOf).join(', ')}>
                {s.componentIds.map(nameOf).join(', ')} · {dirName(s.direction)} {units.len(s.distance)}
              </span>
              <button className="icon-btn" onClick={() => removeStep(i)} title={`Delete step ${i + 1}`} aria-label={`Delete step ${i + 1}`}><Trash2 size={12} /></button>
            </li>
          ))}
        </ol>
        <div style={{ borderTop: '1px solid #333', marginTop: 8, paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: chosen.length ? '#cbd5e1' : '#94a3b8', marginBottom: 6 }}>
            {chosen.length ? `Selected: ${chosen.map(nameOf).join(', ')}` : 'Select the parts to move (click them in the view or the tree; Ctrl adds).'}
          </div>
          <div className="property-row">
            <span className="property-label">Direction</span>
            <select aria-label="Explode direction" className="property-select explode-direction" style={{ width: 70 }} value={dir} onChange={(e) => setDir(e.target.value)}>
              {DIRECTIONS.map(([n]) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="property-row">
            <span className="property-label">Distance</span>
            <NumericInput value={distance} onChange={setDistance} min={1} max={2000} step={5} unit="mm" label="Explode step distance" />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="segment-btn explode-add-step" style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }} disabled={!chosen.length} onClick={addStep}>
              <Plus size={12} /> Add step
            </button>
            <button className="segment-btn explode-auto-steps" style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }} onClick={autoSteps} title="Make steps from the automatic explode">
              <Wand2 size={12} /> From auto
            </button>
          </div>
        </div>
        {steps.length > 0 && (
          <div style={{ borderTop: '1px solid #333', marginTop: 8, paddingTop: 8 }}>
            <div className="property-row">
              <span className="property-label">Show</span>
              <span style={{ fontSize: 11, color: '#38bdf8', fontVariantNumeric: 'tabular-nums' }}>{Math.round(progress * 100)}%</span>
            </div>
            <input type="range" aria-label="Explode progress" className="explode-progress" min={0} max={1} step={0.01} value={progress}
              onChange={(e) => show(parseFloat(e.target.value))} style={{ width: '100%', accentColor: '#38bdf8' }} />
            <button className="segment-btn explode-play" style={{ width: '100%', marginTop: 6, display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }} onClick={play}>
              {playing ? <><Square size={13} /> Stop</> : <><Play size={13} /> Play the steps</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
