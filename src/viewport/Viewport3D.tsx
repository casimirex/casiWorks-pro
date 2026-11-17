// CasiWorks Pro - 3D Viewport Component
import { useRef, useState, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import type { ElementRef } from 'react';
import { Canvas, useThree, extend } from '@react-three/fiber';
import type { Object3DNode, ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore.ts';
import { TOOLS, VIEW_ORIENTATIONS } from '../utils/constants.ts';
import type { ToolId } from '../utils/constants.ts';
import type { PlaneFrame, Point2, ReferenceFeature, SketchEntity, SketchEntityMap, SketchPlaneRef } from '../types/cad.ts';
import { getSketchPlaneMatrix, isPlaneFrame, referencePlaneFrame, sketchToWorld } from '../utils/math.ts';
import { entityPolyline } from '../kernel/profile.ts';
import type { ProfileEntity } from '../kernel/profile.ts';
import { viewportPicker } from './ViewportPicker.ts';
import { EDIT_TOOLS, NEW_EDIT_SESSION, TOOL_CLICKS, editClick, editPreview, editStage, entitiesFor, previewFor, toolHint } from './sketchTools.ts';
import type { EditSession, SketchClick } from './sketchTools.ts';
import { runCommand } from '../commands/index.ts';
import { modelEdgesGeometry } from '../drawings/DrawingEngine.ts';
import { DIRECTION_VECTORS, arrowAnchors, faceRect } from '../simulation/studySetup.ts';
import type { StudySetup } from '../simulation/studySetup.ts';
import { sketchEngine } from '../kernel/SketchEngine.ts';
import { materialLibrary } from '../kernel/MaterialLibrary.ts';
import { assemblyManager } from '../assembly/AssemblyManager.ts';
import type { LeaderLine } from '../assembly/AssemblyManager.ts';
import { formatMm, measure, snapPick } from '../kernel/measure.ts';
import type { MeasurePick } from '../kernel/measure.ts';
import { plotPositionOf, probeAt } from '../simulation/resultPlot.ts';
import type { FeaProbe, ResultPlot } from '../simulation/resultPlot.ts';

// <line> is the SVG element in JSX typings; register three's Line under its own tag
extend({ ThreeLine: THREE.Line });
declare module '@react-three/fiber' {
  interface ThreeElements {
    threeLine: Object3DNode<THREE.Line, typeof THREE.Line>;
  }
}

/**
 * Standard reference planes (Front, Top, Right)
 */
/** A square of a plane frame (reference planes, the plane of a sketch on a face). */
function FramePlane({ frame, size, color, opacity, label }: { frame: PlaneFrame; size: number; color: string; opacity: number; label?: string }) {
  const matrix = useMemo(() => getSketchPlaneMatrix(frame), [frame]);
  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      <mesh>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[new THREE.PlaneGeometry(size, size)]} />
        <lineBasicMaterial color={color} />
      </lineSegments>
      {label && (
        <Html position={[-size / 2, size / 2, 0]} zIndexRange={[10, 0]}>
          <div className="plane-label">{label}</div>
        </Html>
      )}
    </group>
  );
}

function ReferencePlanes({ showPlanes, activePlane: active }: { showPlanes: boolean; activePlane: SketchPlaneRef }) {
  const activePlane = typeof active === 'string' ? active : '';
  if (!showPlanes) return null;

  const planeSize = 80;

  return (
    <group name="ReferencePlanes">
      {/* Front Plane (XY) */}
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[planeSize, planeSize]} />
        <meshBasicMaterial
          color={activePlane === 'Front' ? '#ff9800' : '#4fc3f7'}
          transparent
          opacity={activePlane === 'Front' ? 0.35 : 0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Top Plane (XZ) */}
      <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[planeSize, planeSize]} />
        <meshBasicMaterial
          color={activePlane === 'Top' ? '#ff9800' : '#81c784'}
          transparent
          opacity={activePlane === 'Top' ? 0.35 : 0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Right Plane (YZ) */}
      <mesh position={[0, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[planeSize, planeSize]} />
        <meshBasicMaterial
          color={activePlane === 'Right' ? '#ff9800' : '#ba68c8'}
          transparent
          opacity={activePlane === 'Right' ? 0.35 : 0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/**
 * Coordinate Axes / Origin Display
 */
function OriginDisplay({ showOrigin, showAxes }: { showOrigin: boolean; showAxes: boolean }) {
  if (!showOrigin && !showAxes) return null;

  return (
    <group position={[0, 0, 0]}>
      {showOrigin && (
        <mesh>
          <sphereGeometry args={[0.8, 16, 16]} />
          <meshBasicMaterial color="#ff4444" />
        </mesh>
      )}
      {showAxes && (
        <primitive object={new THREE.AxesHelper(15)} />
      )}
    </group>
  );
}

/**
 * Render a single CAD body with engineering-style shading and crisp edge lines
 */
/** Anything the viewport can draw as a solid: a model body or an assembly component. */
interface DisplayBody {
  id: string;
  geometry: THREE.BufferGeometry | null;
}

interface CADBodyMeshProps {
  body: DisplayBody;
  isSelected: boolean;
  /** False while sketching: clicks place sketch points instead of selecting. */
  selectable: boolean;
  onSelect(body: DisplayBody): void;
  shadedMode: boolean;
  wireframeMode: boolean;
  edgeDisplay: boolean;
  materialKey: string;
  /** While measuring, clicks become picks instead of selections. */
  onMeasure?: (pick: MeasurePick) => void;
}

/** How close (as a share of the camera distance, ≈ 10 px) a click must be to a corner to snap to it. */
const MEASURE_SNAP = 0.012;

/** The Measure pick for a click on a mesh: the clicked triangle's nearest corner, or the exact point. */
function pickFromEvent(e: ThreeEvent<MouseEvent>): MeasurePick | null {
  const face = e.face;
  const mesh = e.object as THREE.Mesh;
  if (!face || !mesh.geometry) return null;
  const pos = mesh.geometry.getAttribute('position');
  const corners = [face.a, face.b, face.c].map(i => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld));
  const normal = face.normal.clone().transformDirection(mesh.matrixWorld);
  return snapPick(e.point, corners, normal, e.distance * MEASURE_SNAP);
}

function CADBodyMesh({ body, isSelected, selectable, onSelect, wireframeMode, edgeDisplay, materialKey, onMeasure }: CADBodyMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  const material = useMemo(() => {
    if (!body || !body.geometry) return null;
    try {
      const base = materialLibrary.getThreeMaterial(materialKey || 'Steel_1020', wireframeMode);
      const mat = base ? base.clone() : new THREE.MeshStandardMaterial({ color: '#cccccc' });
      if (isSelected) {
        mat.emissive = new THREE.Color('#004488');
        mat.emissiveIntensity = 0.5;
      }
      return mat;
    } catch {
      return new THREE.MeshStandardMaterial({ color: '#cccccc' });
    }
  }, [body, materialKey, wireframeMode, isSelected]);

  // Generate edge geometry defensively
  const bodyGeometry = body?.geometry;
  const edgesGeometry = useMemo(() => {
    if (!bodyGeometry) return null;
    try {
      const pos = bodyGeometry.getAttribute ? bodyGeometry.getAttribute('position') : bodyGeometry.attributes?.position;
      if (!pos || pos.count < 3) return null;
      return modelEdgesGeometry(bodyGeometry, 25);
    } catch {
      return null;
    }
  }, [bodyGeometry]);

  // Release GPU resources owned by this component when they are replaced or unmounted
  useEffect(() => () => material?.dispose?.(), [material]);
  useEffect(() => () => edgesGeometry?.dispose?.(), [edgesGeometry]);

  if (!body || !body.geometry || !material) return null;

  return (
    <group>
      <mesh
        ref={meshRef}
        geometry={body.geometry}
        material={material}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (!selectable) return;
          e.stopPropagation();
          if (onMeasure) {
            const pick = pickFromEvent(e);
            if (pick) onMeasure(pick);
            return;
          }
          if (body && onSelect) onSelect(body);
        }}
        castShadow
        receiveShadow
      />
      {edgeDisplay && edgesGeometry && (
        <lineSegments geometry={edgesGeometry}>
          <lineBasicMaterial color={isSelected ? '#00bfff' : '#1e1e1e'} linewidth={1.5} />
        </lineSegments>
      )}
    </group>
  );
}

/** Measure marks in the model: the picks (corners as cubes, face points as dots), the line and its length. */
function MeasureMarks({ picks }: { picks: MeasurePick[] }) {
  const line = useMemo(() => (picks.length === 2
    ? new THREE.BufferGeometry().setFromPoints(picks.map(p => new THREE.Vector3(p.point.x, p.point.y, p.point.z)))
    : null), [picks]);
  useEffect(() => () => line?.dispose(), [line]);
  const m = picks.length === 2 ? measure(picks[0], picks[1]) : null;
  const mid = picks.length === 2
    ? [(picks[0].point.x + picks[1].point.x) / 2, (picks[0].point.y + picks[1].point.y) / 2, (picks[0].point.z + picks[1].point.z) / 2] as [number, number, number]
    : null;
  return (
    <group name="MeasureMarks">
      {picks.map((p, i) => (
        <mesh key={i} position={[p.point.x, p.point.y, p.point.z]} renderOrder={SKETCH_ON_TOP}>
          {p.kind === 'vertex' ? <boxGeometry args={[1.4, 1.4, 1.4]} /> : <sphereGeometry args={[0.8, 12, 12]} />}
          <meshBasicMaterial color={i === 0 ? '#4ade80' : '#f472b6'} depthTest={false} />
        </mesh>
      ))}
      {line && (
        <threeLine geometry={line} renderOrder={SKETCH_ON_TOP} onUpdate={(l: THREE.Line) => l.computeLineDistances()}>
          <lineDashedMaterial color="#fde047" dashSize={2} gapSize={1} depthTest={false} />
        </threeLine>
      )}
      {m && mid && (
        <Html position={mid} center zIndexRange={[20, 0]}>
          <div className="measure-label">{formatMm(m.gap ?? m.distance)} mm{m.gap !== null ? ' ⟂' : ''}</div>
        </Html>
      )}
    </group>
  );
}

/** FEA probes on the result plot: a dot and a numbered label with the values at that node. */
function FeaProbeMarks({ plot, probes }: { plot: ResultPlot; probes: FeaProbe[] }) {
  return (
    <group name="FeaProbes">
      {probes.map((p, i) => {
        const at = plotPositionOf(plot, p.node);
        if (!at) return null;
        return (
          <group key={p.node} position={at}>
            <mesh renderOrder={SKETCH_ON_TOP}>
              <sphereGeometry args={[0.7, 10, 10]} />
              <meshBasicMaterial color="#ffffff" depthTest={false} />
            </mesh>
            <Html center={false} style={{ transform: 'translate(6px, -50%)' }} zIndexRange={[20, 0]}>
              <div className="fea-probe-label">
                <b>{i + 1}</b> {p.vonMisesMPa.toFixed(1)} MPa · {p.displacementMM.toPrecision(3)} mm
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** The Measure results card over the viewport. */
function MeasurePanel({ picks }: { picks: MeasurePick[] }) {
  const m = picks.length === 2 ? measure(picks[0], picks[1]) : null;
  const pt = (p: MeasurePick) => `${formatMm(p.point.x)}, ${formatMm(p.point.y)}, ${formatMm(p.point.z)}${p.kind === 'vertex' ? ' (corner)' : ''}`;
  return (
    <div className="measure-panel" role="status">
      <div className="measure-head">
        <span>Measure</span>
        <button className="icon-btn" onClick={() => runCommand('edit.cancel')} title="Finish measuring (Esc)" aria-label="Finish measuring">✕</button>
      </div>
      {picks.length === 0 && <div className="measure-hint">Click a point on the model. Corners snap.</div>}
      {picks.map((p, i) => <div key={i} className="measure-row"><span style={{ color: i === 0 ? '#4ade80' : '#f472b6' }}>{i === 0 ? 'A' : 'B'}</span><span>{pt(p)}</span></div>)}
      {picks.length === 1 && <div className="measure-hint">Click the second point.</div>}
      {m && (
        <div className="measure-results">
          <div className="measure-row big"><span>Distance</span><span className="measure-distance">{formatMm(m.distance)} mm</span></div>
          <div className="measure-row"><span>dX · dY · dZ</span><span>{formatMm(m.dx)} · {formatMm(m.dy)} · {formatMm(m.dz)}</span></div>
          {m.angle !== null && <div className="measure-row"><span>Angle between faces</span><span className="measure-angle">{formatMm(m.angle)}°</span></div>}
          {m.gap !== null && <div className="measure-row big"><span>Parallel faces, gap</span><span className="measure-gap">{formatMm(m.gap)} mm</span></div>}
          <div className="measure-hint">Click again to start a new measurement.</div>
        </div>
      )}
    </div>
  );
}

/**
 * Sketch Canvas Overlay inside 3D Viewport
 */
/** FEA study setup on the model: the fixed face in green, load arrows in red. */
function FeaSetupMarkers({ setup, geometry }: { setup: StudySetup; geometry: THREE.BufferGeometry }) {
  const markers = useMemo(() => {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const diag = box.getSize(new THREE.Vector3()).length() || 1;
    const fixed = faceRect(box, setup.fixedFace);
    // PlaneGeometry lies in XY; turn it to face along the face normal, just outside the part.
    // size = extents along the two other axes in x, y, z order; after rotateY a plane's
    // width runs along Z, so an x face is built as (z extent, y extent).
    const normal = new THREE.Vector3(...fixed.normal);
    const k = Math.abs(normal.x) > 0 ? 'x' : Math.abs(normal.y) > 0 ? 'y' : 'z';
    const plane = k === 'x' ? new THREE.PlaneGeometry(fixed.size[1], fixed.size[0]) : new THREE.PlaneGeometry(fixed.size[0], fixed.size[1]);
    if (k === 'x') plane.rotateY(Math.PI / 2);
    else if (k === 'y') plane.rotateX(Math.PI / 2);
    plane.translate(...(new THREE.Vector3(...fixed.center).addScaledVector(normal, diag * 0.002).toArray() as [number, number, number]));

    const dir = new THREE.Vector3(...DIRECTION_VECTORS[setup.loadDirection]);
    const len = diag * 0.18;
    const arrows = arrowAnchors(box, setup.loadFace, 3).map(p => {
      // Arrow ends on the face, pointing the way the load acts
      const tip = new THREE.Vector3(...p);
      return new THREE.ArrowHelper(dir, tip.clone().addScaledVector(dir, -len), len, 0xef4444, len * 0.3, len * 0.15);
    });
    return { plane, arrows };
  }, [setup, geometry]);
  useEffect(() => () => {
    markers.plane.dispose();
    markers.arrows.forEach(a => a.dispose());
  }, [markers]);

  return (
    <group name="FeaSetupMarkers">
      <mesh geometry={markers.plane} renderOrder={5}>
        <meshBasicMaterial color="#22c55e" transparent opacity={0.45} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {markers.arrows.map((a, i) => <primitive key={i} object={a} />)}
    </group>
  );
}

/** How close (screen pixels) a click must be to a sketch entity to pick it. */
const PICK_PIXELS = 8;

/** The sketch being edited is drawn over the model, like other CAD systems do. */
const SKETCH_ON_TOP = 10;

/** One sketch entity drawn in the viewport: a polyline, or a dot for points. */
function SketchEntityLine({ entity, toWorld, color: override }: { entity: SketchEntity; toWorld(p: Point2): [number, number, number]; color?: string }) {
  const color = override ?? (entity.construction ? '#888888' : '#00e5ff');
  const geometry = useMemo(() => {
    const poly = entityPolyline(entity as ProfileEntity);
    if (!poly) return null;
    const pts = poly.points.map(p => new THREE.Vector3(...toWorld(p)));
    if (poly.closed && pts.length > 0) pts.push(pts[0].clone());
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [entity, toWorld]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (entity.type === 'point') {
    return (
      <mesh position={toWorld(entity)} renderOrder={SKETCH_ON_TOP}>
        <sphereGeometry args={[0.5, 10, 10]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
    );
  }
  if (!geometry) return null;
  return (
    // Construction geometry is dashed (dashes need per-vertex line distances)
    <threeLine geometry={geometry} renderOrder={SKETCH_ON_TOP} onUpdate={(line: THREE.Line) => line.computeLineDistances()}>
      {entity.construction
        ? <lineDashedMaterial color={color} dashSize={2} gapSize={1} depthTest={false} />
        : <lineBasicMaterial color={color} linewidth={2} depthTest={false} />}
    </threeLine>
  );
}

/** Keeps the default camera's projection in step with the Persp/Ortho toggle, preserving the view. */
function ProjectionSwitch({ perspective }: { perspective: boolean }) {
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
  const set = useThree(s => s.set);
  const controls = useThree(s => s.controls) as unknown as { target: THREE.Vector3; update(): void } | null;

  useLayoutEffect(() => {
    const isPerspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    if (isPerspective === perspective) return;
    const target = controls?.target?.clone() ?? new THREE.Vector3();
    const halfFov = (FOV / 2) * Math.PI / 180;
    let next: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (perspective) {
      // Stand back far enough to see the height the orthographic view showed
      const ortho = camera as THREE.OrthographicCamera;
      const visibleHeight = (ortho.top - ortho.bottom) / ortho.zoom;
      next = new THREE.PerspectiveCamera(FOV, size.width / size.height, 0.1, 5000);
      const offset = camera.position.clone().sub(target).setLength(visibleHeight / (2 * Math.tan(halfFov)));
      next.position.copy(target).add(offset);
    } else {
      // Zoom so the model appears the same size as in perspective at the target
      const visibleHeight = 2 * camera.position.distanceTo(target) * Math.tan(halfFov);
      next = new THREE.OrthographicCamera(-size.width / 2, size.width / 2, size.height / 2, -size.height / 2, -5000, 5000);
      next.zoom = size.height / visibleHeight;
      next.position.copy(camera.position);
    }
    next.up.copy(camera.up);
    next.lookAt(target);
    next.updateProjectionMatrix();
    set({ camera: next });
  }, [perspective, camera, size, set, controls]);

  return null;
}

interface ActiveSketchOverlayProps {
  activeSketchId: string | null;
  activeSketchPlane: SketchPlaneRef;
  sketchEntities: SketchEntityMap;
  currentPoints: Point2[];
  /** Geometry the next click would create (drawn in the preview colour). */
  previewEntities: SketchEntity[];
  /** Entities an editing tool points at (drawn highlighted). */
  highlightIds: string[];
  activeTool: ToolId;
}

function ActiveSketchOverlay({ activeSketchId, activeSketchPlane, sketchEntities, currentPoints, previewEntities, highlightIds }: ActiveSketchOverlayProps) {
  const entities = (activeSketchId && sketchEntities[activeSketchId]) || [];

  // Sketch point → world point, exactly as the kernel maps the sketch plane
  const transformPoint = useCallback((pt: Point2 | null | undefined): [number, number, number] => {
    if (!pt) return [0, 0, 0];
    return sketchToWorld(pt, activeSketchPlane).toArray() as [number, number, number];
  }, [activeSketchPlane]);

  return (
    <group name="ActiveSketchOverlay">
      {/* Existing entities, sampled the same way the kernel samples profiles */}
      {entities.map((ent) => <SketchEntityLine key={ent.id} entity={ent} toWorld={transformPoint} color={highlightIds.includes(ent.id) ? '#ffd54f' : undefined} />)}

      {/* What the next click creates */}
      {previewEntities.map((ent) => <SketchEntityLine key={`preview-${ent.id}`} entity={ent} toWorld={transformPoint} color="#ff9800" />)}

      {/* Rubber-band preview line/points during drawing */}
      {currentPoints.length > 0 && (
        <group name="CurrentSketchPreview">
          {currentPoints.map((pt, i) => (
            <mesh key={i} position={transformPoint(pt)} renderOrder={SKETCH_ON_TOP}>
              <sphereGeometry args={[0.6, 12, 12]} />
              <meshBasicMaterial color="#ff9800" depthTest={false} />
            </mesh>
          ))}
          {currentPoints.length >= 2 && (
            <threeLine
              renderOrder={SKETCH_ON_TOP}
              geometry={new THREE.BufferGeometry().setFromPoints(
                currentPoints.map(p => new THREE.Vector3(...transformPoint(p)))
              )}
            >
              <lineBasicMaterial color="#ff9800" linewidth={2} depthTest={false} />
            </threeLine>
          )}
        </group>
      )}
    </group>
  );
}

/**
 * Viewport Interaction Handler (Desktop & Mobile Touch)
 * Prevents two-finger pinch/pan from conflicting with single-touch rotate or falsely placing sketch entities
 */
interface ViewportControllerProps {
  onPointerMoveInSketch(click: SketchClick): void;
  onSketchClick(click: SketchClick): void;
}

function ViewportController({ onPointerMoveInSketch, onSketchClick }: ViewportControllerProps) {
  const { camera, gl } = useThree();
  const isSketchActive = useCADStore(s => s.isSketchActive);
  const activeSketchPlane = useCADStore(s => s.activeSketchPlane);
  const snapEnabled = useCADStore(s => s.snapEnabled);

  useEffect(() => {
    const dom = gl.domElement;
    const activePointers = new Set<number>();
    let isMultiTouch = false;
    let lastMultiTouchTime = 0;

    // The sketch point under the pointer: snapped for drawing, exact for picking,
    // with the pick tolerance as the sketch distance of PICK_PIXELS on screen
    const toSketchClick = (px: number, py: number, rect: DOMRect): SketchClick | null => {
      const raw = viewportPicker.screenToSketchPlane(px, py, camera, activeSketchPlane);
      if (!raw) return null;
      const aside = viewportPicker.screenToSketchPlane(px + (2 * PICK_PIXELS) / rect.width, py, camera, activeSketchPlane);
      const tol = aside ? Math.hypot(aside.x - raw.x, aside.y - raw.y) : 1;
      return { pt: snapEnabled ? sketchEngine.snapToGrid(raw, 5) : raw, raw, tol };
    };

    // Pointer events always carry client coordinates
    const getCoords = (e: PointerEvent) => ({ clientX: e.clientX, clientY: e.clientY });

    const handlePointerDown = (e: PointerEvent) => {
      activePointers.add(e.pointerId);
      if (activePointers.size >= 2) {
        isMultiTouch = true;
        lastMultiTouchTime = Date.now();
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      // If user is currently doing a two-finger pinch/pan, don't update sketch hover preview
      if (isMultiTouch || activePointers.size >= 2) return;

      const { clientX, clientY } = getCoords(e);
      const rect = dom.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * 2 - 1;
      const py = -(((clientY - rect.top) / rect.height) * 2 - 1);

      if (isSketchActive) {
        const click = toSketchClick(px, py, rect);
        if (click) onPointerMoveInSketch(click);
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);

      const wasPinchPan = isMultiTouch || (Date.now() - lastMultiTouchTime < 400);
      if (activePointers.size === 0) {
        isMultiTouch = false;
      }

      // If this pointerup was the release of a two-finger pinch/pan gesture, do NOT trigger sketch click!
      if (wasPinchPan || !isSketchActive) {
        return;
      }

      const { clientX, clientY } = getCoords(e);
      const rect = dom.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * 2 - 1;
      const py = -(((clientY - rect.top) / rect.height) * 2 - 1);

      const click = toSketchClick(px, py, rect);
      if (click) onSketchClick(click);
    };

    const handlePointerCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) {
        isMultiTouch = false;
      }
    };

    dom.addEventListener('pointerdown', handlePointerDown);
    dom.addEventListener('pointermove', handlePointerMove);
    dom.addEventListener('pointerup', handlePointerUp);
    dom.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      dom.removeEventListener('pointerdown', handlePointerDown);
      dom.removeEventListener('pointermove', handlePointerMove);
      dom.removeEventListener('pointerup', handlePointerUp);
      dom.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [camera, gl, isSketchActive, activeSketchPlane, snapEnabled, onPointerMoveInSketch, onSketchClick]);

  return null;
}

/**
 * Orientation ViewCube HUD overlay (Responsive & Collapsible on Mobile)
 */
function OrientationCubeHUD() {
  const [expanded, setExpanded] = useState(window.innerWidth > 768);

  return (
    <div className="viewcube-container" style={{
      position: 'absolute',
      top: 12,
      right: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      background: 'rgba(30,30,30,0.88)',
      padding: 6,
      borderRadius: 6,
      border: '1px solid #444',
      zIndex: 10,
      backdropFilter: 'blur(4px)',
    }}>
      <div
        style={{ fontSize: 11, fontWeight: 'bold', color: '#aaa', textAlign: 'center', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '2px 4px' }}
        onClick={() => setExpanded(!expanded)}
        title="Toggle views"
      >
        <span>VIEW</span>
        <span style={{ fontSize: 9 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
          <button className="view-btn" onClick={() => runCommand('view.top')}>Top</button>
          <button className="view-btn" onClick={() => runCommand('view.isometric')}>Iso</button>
          <button className="view-btn" onClick={() => runCommand('view.bottom')}>Btm</button>
          <button className="view-btn" onClick={() => runCommand('view.front')}>Frnt</button>
          <button className="view-btn" onClick={() => runCommand('view.right')}>Rght</button>
          <button className="view-btn" onClick={() => runCommand('view.left')}>Left</button>
        </div>
      )}
    </div>
  );
}

const FOV = 45;

const ORIGIN = new THREE.Vector3();

/** Dashed lines from each exploded component's real position to where it is drawn. */
function ExplodeLeaderLines({ lines }: { lines: LeaderLine[] }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(lines.flatMap(l => [l.start, l.end]));
    return g;
  }, [lines]);
  const segments = useRef<THREE.LineSegments>(null);
  // Dashes need per-vertex distances along each segment
  useLayoutEffect(() => { segments.current?.computeLineDistances(); }, [geometry]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments ref={segments} geometry={geometry} renderOrder={2} userData={{ explodeLeaderLines: lines.length }}>
      <lineDashedMaterial color="#fbbf24" dashSize={3} gapSize={2} depthTest={false} transparent opacity={0.9} />
    </lineSegments>
  );
}

/**
 * Main 3D Viewport Component
 */
export default function Viewport3D() {
  const bodies = useCADStore(s => s.bodies);
  const feaPlot = useCADStore(s => s.feaPlot);
  const feaProbes = useCADStore(s => s.feaProbes);
  const addFeaProbe = useCADStore(s => s.addFeaProbe);
  const feaSetupMarkers = useCADStore(s => s.feaSetupMarkers);
  const assemblyComponents = useCADStore(s => s.assemblyComponents);
  const mates = useCADStore(s => s.mates);
  const explodedView = useCADStore(s => s.explodedView);
  const selectedEntities = useCADStore(s => s.selectedEntities);
  const setSelection = useCADStore(s => s.setSelection);
  const activeMaterial = useCADStore(s => s.activeMaterial);
  const measurePicks = useCADStore(s => s.measurePicks);
  const addMeasurePick = useCADStore(s => s.addMeasurePick);

  const showGrid = useCADStore(s => s.showGrid);
  const showOrigin = useCADStore(s => s.showOrigin);
  const showAxes = useCADStore(s => s.showAxes);
  const showPlanes = useCADStore(s => s.showPlanes);
  const viewFrame = useCADStore(s => s.viewFrame);
  const features = useCADStore(s => s.features);
  const referencePlanes = useMemo(() => features.filter(f => f.type === 'reference_plane' && !f.suppressed).map(f => {
    const r = f as ReferenceFeature;
    return { id: f.id, name: f.name, frame: referencePlaneFrame(r.base ?? 'Front', r.offset ?? 0, r.angle ?? 0) };
  }), [features]);
  const startSketchOnFace = useCallback((pick: MeasurePick) => {
    if (pick.normal) runCommand('sketch.onFace', { point: pick.point, normal: pick.normal });
  }, []);
  const shadedMode = useCADStore(s => s.shadedMode);
  const edgeDisplay = useCADStore(s => s.edgeDisplay);
  const wireframeMode = useCADStore(s => s.wireframeMode);
  const perspectiveView = useCADStore(s => s.perspectiveView);
  const viewOrientation = useCADStore(s => s.viewOrientation);
  const viewRequest = useCADStore(s => s.viewRequest);

  const isSketchActive = useCADStore(s => s.isSketchActive);
  const activeSketchId = useCADStore(s => s.activeSketchId);
  const activeSketchPlane = useCADStore(s => s.activeSketchPlane);
  const sketchEntities = useCADStore(s => s.sketchEntities);
  const activeTool = useCADStore(s => s.activeTool);
  const addSketchEntity = useCADStore(s => s.addSketchEntity);

  const [mouse, setMouse] = useState<SketchClick | null>(null);
  const mouseSketchPt = mouse?.pt ?? null;
  const [sketchClickPts, setSketchClickPts] = useState<Point2[]>([]);
  const [editSession, setEditSession] = useState<EditSession>(NEW_EDIT_SESSION);
  const replaceActiveSketchEntities = useCADStore(s => s.replaceActiveSketchEntities);
  const offsetDistance = useCADStore(s => s.sketchOffsetDistance);
  const constructionMode = useCADStore(s => s.constructionMode);
  const isEditTool = EDIT_TOOLS.includes(activeTool);
  const activeEntities = useMemo(() => (activeSketchId && sketchEntities[activeSketchId]) || [], [activeSketchId, sketchEntities]);
  // Set when a click reported its result, so the next-step hint does not hide it
  const keepStatusRef = useRef(false);

  const controlsRef = useRef<ElementRef<typeof OrbitControls>>(null);

  // Aim the camera on every view request (also when the same view is asked for again)
  useEffect(() => {
    if (!controlsRef.current) return;
    const camera = controlsRef.current.object;
    if (camera && viewFrame) {
      // Straight at a plane that is not a standard one, sketch Y up, centred on its origin
      const m = getSketchPlaneMatrix(viewFrame);
      const o = new THREE.Vector3().applyMatrix4(m);
      const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(m);
      camera.position.copy(o).addScaledVector(n, 200);
      camera.up.copy(up);
      camera.lookAt(o);
      controlsRef.current.target.copy(o);
      controlsRef.current.update();
      return;
    }
    const info = VIEW_ORIENTATIONS[viewOrientation] || VIEW_ORIENTATIONS.isometric;
    if (camera && info) {
      camera.position.set(...(info.position as [number, number, number]));
      camera.up.set(...(info.up as [number, number, number]));
      camera.lookAt(0, 0, 0);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [viewOrientation, viewRequest, viewFrame]);

  // Sketch drawing logic
  const polygonSides = useCADStore(s => s.sketchPolygonSides);
  const setStatus = useCADStore(s => s.setStatus);

  // A new tool starts with no clicks
  useEffect(() => { setSketchClickPts([]); setEditSession(NEW_EDIT_SESSION); }, [activeTool, activeSketchId]);

  // Tell the user what the next click does
  const stage = isEditTool ? editStage(activeTool, editSession) : sketchClickPts.length;
  useEffect(() => {
    if (!isSketchActive) return;
    if (keepStatusRef.current) { keepStatusRef.current = false; return; }
    const hint = toolHint(activeTool, stage);
    if (hint) setStatus(hint);
  }, [isSketchActive, activeTool, stage, setStatus]);

  // Each drawing tool collects its clicks, then creates its geometry (sketchTools.ts)
  const handleSketchClick = useCallback(({ pt, raw, tol }: SketchClick) => {
    if (isEditTool) {
      const r = editClick(activeTool, editSession, { pt, raw, tol }, activeEntities, { offsetDistance, construction: constructionMode });
      if (r.status) keepStatusRef.current = editStage(activeTool, r.session) !== editStage(activeTool, editSession);
      if (r.entities) replaceActiveSketchEntities(r.entities, r.status);
      else if (r.status) setStatus(r.status);
      setEditSession(r.session);
      return;
    }
    const need = TOOL_CLICKS[activeTool];
    if (!need) return;
    const pts = [...sketchClickPts, pt];
    if (pts.length < need) {
      setSketchClickPts(pts);
      return;
    }
    const created = entitiesFor(activeTool, pts, { polygonSides });
    created?.forEach(e => addSketchEntity(e));
    // Lines chain from the last point; other tools start over
    setSketchClickPts(activeTool === TOOLS.SKETCH_LINE && created ? [pt] : []);
  }, [activeTool, sketchClickPts, addSketchEntity, polygonSides, isEditTool, editSession, activeEntities, offsetDistance, constructionMode, replaceActiveSketchEntities, setStatus]);

  const preview = useMemo(
    () => (isEditTool
      ? editPreview(activeTool, editSession, mouse, activeEntities, { offsetDistance })
      : { ...previewFor(activeTool, sketchClickPts, mouseSketchPt, { polygonSides }), highlight: [] as string[] }),
    [activeTool, sketchClickPts, mouseSketchPt, polygonSides, isEditTool, editSession, mouse, activeEntities, offsetDistance],
  );

  // Exploded view: where each component is drawn, recomputed when the assembly changes
  const exploded = useMemo(
    () => (explodedView && assemblyComponents.length > 1
      ? assemblyManager.createExplodedView({ distance: explodedView.distance, leaderLines: explodedView.leaderLines })
      : null),
    // The layout reads the assembly manager, which the store mirrors: its component
    // and mate arrays are replaced whenever the manager changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [explodedView, assemblyComponents, mates],
  );
  const explodeOffsets = useMemo(() => new Map(
    (exploded?.components ?? []).map(c => [c.id, c.position.clone().sub(c.originalPosition)] as const),
  ), [exploded]);

  return (
    <div className="viewport-container" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <Canvas
        shadows
        // Kept so a picture of the view can be taken (FEA report)
        gl={{ preserveDrawingBuffer: true }}
        camera={{ position: [80, 80, 80], fov: FOV, near: 0.1, far: 5000 }}
        style={{ background: 'radial-gradient(ellipse at 50% 45%, #2a2e38 0%, #16171c 70%, #0d0e11 100%)' }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[100, 150, 100]} intensity={1.2} castShadow />
        <directionalLight position={[-100, 80, -100]} intensity={0.5} />
        <hemisphereLight color="#ffffff" groundColor="#333333" intensity={0.4} />

        <ProjectionSwitch perspective={perspectiveView} />
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.05}
          maxDistance={2000}
          minDistance={1}
          enableRotate={!isSketchActive}
          touches={{
            // No one-finger gesture while sketching (taps place points)
            ONE: isSketchActive ? (null as unknown as THREE.TOUCH) : THREE.TOUCH.ROTATE,
            TWO: THREE.TOUCH.DOLLY_PAN,
          }}
        />

        {showGrid && (
          <gridHelper args={[200, 20, '#555555', '#333333']} position={[0, -0.01, 0]} />
        )}

        <OriginDisplay showOrigin={showOrigin} showAxes={showAxes} />
        <ReferencePlanes showPlanes={showPlanes} activePlane={activeSketchPlane} />
        {showPlanes && referencePlanes.map(rp => (
          <FramePlane key={rp.id} frame={rp.frame} size={70} color="#fbbf24" opacity={0.07} label={rp.name} />
        ))}
        {isSketchActive && isPlaneFrame(activeSketchPlane) && (
          <FramePlane frame={activeSketchPlane} size={90} color="#ff9800" opacity={0.18} />
        )}

        {/* FEA result plot replaces the bodies while it is shown */}
        {feaPlot && (
          <mesh
            geometry={feaPlot.geometry}
            name="FEAResultPlot"
            onClick={(e: ThreeEvent<MouseEvent>) => {
              // Probe: the values at the clicked triangle's nearest corner node
              if (!e.face) return;
              e.stopPropagation();
              const pos = feaPlot.geometry.getAttribute('position');
              const nearest = [e.face.a, e.face.b, e.face.c]
                .map(v => ({ v, d: new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v)).distanceTo(e.point) }))
                .sort((a, b) => a.d - b.d)[0].v;
              const probe = probeAt(feaPlot, nearest);
              if (probe) addFeaProbe(probe);
            }}
          >
            <meshLambertMaterial vertexColors side={THREE.DoubleSide} />
          </mesh>
        )}
        {feaPlot && feaProbes.length > 0 && <FeaProbeMarks plot={feaPlot} probes={feaProbes} />}

        {feaSetupMarkers && bodies[0]?.geometry && <FeaSetupMarkers setup={feaSetupMarkers} geometry={bodies[0].geometry} />}

        {/* Bodies */}
        {!feaPlot && bodies.map((body) => (
          <CADBodyMesh
            key={body.id}
            body={body}
            isSelected={selectedEntities.some(e => e.id === body.id)}
            selectable={!isSketchActive}
            onSelect={(b) => setSelection({ id: b.id })}
            shadedMode={shadedMode}
            wireframeMode={wireframeMode}
            edgeDisplay={edgeDisplay}
            materialKey={activeMaterial}
            onMeasure={activeTool === TOOLS.MEASURE ? addMeasurePick : activeTool === TOOLS.SKETCH_ON_FACE ? startSketchOnFace : undefined}
          />
        ))}

        {/* Assembly Components (drawn moved apart while the exploded view is on) */}
        {assemblyComponents && assemblyComponents.map((comp) => (
          <group key={comp.id} position={explodeOffsets.get(comp.id) ?? ORIGIN}>
            <CADBodyMesh
              body={comp}
              isSelected={selectedEntities.some(e => e.id === comp.id)}
              selectable={!isSketchActive}
              onSelect={(b) => setSelection({ id: b.id })}
              shadedMode={shadedMode}
              wireframeMode={wireframeMode}
              edgeDisplay={edgeDisplay}
              materialKey={comp.material ?? activeMaterial}
              onMeasure={activeTool === TOOLS.MEASURE ? addMeasurePick : activeTool === TOOLS.SKETCH_ON_FACE ? startSketchOnFace : undefined}
            />
          </group>
        ))}
        {exploded && exploded.leaderLines.length > 0 && <ExplodeLeaderLines lines={exploded.leaderLines} />}

        {activeTool === TOOLS.MEASURE && measurePicks.length > 0 && <MeasureMarks picks={measurePicks} />}

        {/* Active Sketch Overlay */}
        {isSketchActive && (
          <ActiveSketchOverlay
            activeSketchId={activeSketchId}
            activeSketchPlane={activeSketchPlane}
            sketchEntities={sketchEntities}
            currentPoints={preview.band.length || isEditTool ? preview.band : sketchClickPts}
            previewEntities={preview.entities}
            highlightIds={preview.highlight}
            activeTool={activeTool}
          />
        )}

        <ViewportController
          onPointerMoveInSketch={setMouse}
          onSketchClick={handleSketchClick}
        />
      </Canvas>

      <OrientationCubeHUD />
      {activeTool === TOOLS.MEASURE && <MeasurePanel picks={measurePicks} />}
    </div>
  );
}
