// CasiWorks Pro - 3D Viewport Component
import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import type { ElementRef } from 'react';
import { Canvas, useThree, extend } from '@react-three/fiber';
import type { Object3DNode, ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useCADStore } from '../store/cadStore.ts';
import { TOOLS, SKETCH_ENTITY_TYPES, VIEW_ORIENTATIONS } from '../utils/constants.ts';
import type { ToolId, ViewOrientation } from '../utils/constants.ts';
import type { Point2, SketchEntityMap } from '../types/cad.ts';
import { viewportPicker } from './ViewportPicker.ts';
import { sketchEngine } from '../kernel/SketchEngine.ts';
import { materialLibrary } from '../kernel/MaterialLibrary.ts';

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
function ReferencePlanes({ showPlanes, activePlane }: { showPlanes: boolean; activePlane: string }) {
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
  onSelect(body: DisplayBody): void;
  shadedMode: boolean;
  wireframeMode: boolean;
  edgeDisplay: boolean;
  materialKey: string;
}

function CADBodyMesh({ body, isSelected, onSelect, wireframeMode, edgeDisplay, materialKey }: CADBodyMeshProps) {
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
      return new THREE.EdgesGeometry(bodyGeometry, 25);
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
          e.stopPropagation();
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

/**
 * Sketch Canvas Overlay inside 3D Viewport
 */
interface ActiveSketchOverlayProps {
  activeSketchId: string | null;
  activeSketchPlane: string;
  sketchEntities: SketchEntityMap;
  currentPoints: Point2[];
  activeTool: ToolId;
}

function ActiveSketchOverlay({ activeSketchId, activeSketchPlane, sketchEntities, currentPoints }: ActiveSketchOverlayProps) {
  const entities = (activeSketchId && sketchEntities[activeSketchId]) || [];

  // Transform 2D sketch points to 3D based on sketch plane
  const transformPoint = useCallback((pt: Point2 | null | undefined): [number, number, number] => {
    if (!pt) return [0, 0, 0];
    if (activeSketchPlane === 'Top' || activeSketchPlane === 'XZ') {
      return [pt.x, 0, -pt.y];
    } else if (activeSketchPlane === 'Right' || activeSketchPlane === 'YZ') {
      return [0, pt.y, pt.x];
    }
    return [pt.x, pt.y, 0]; // Front / XY
  }, [activeSketchPlane]);

  return (
    <group name="ActiveSketchOverlay">
      {/* Existing Entities */}
      {entities.map((ent) => {
        if (ent.type === SKETCH_ENTITY_TYPES.LINE && ent.p1 && ent.p2) {
          const p1 = transformPoint(ent.p1);
          const p2 = transformPoint(ent.p2);
          const geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(...p1),
            new THREE.Vector3(...p2),
          ]);
          return (
            <threeLine key={ent.id} geometry={geom}>
              <lineBasicMaterial color={ent.construction ? '#888888' : '#00e5ff'} linewidth={2} />
            </threeLine>
          );
        } else if (ent.type === SKETCH_ENTITY_TYPES.CIRCLE && ent.center) {
          const segments = 64;
          const pts: THREE.Vector3[] = [];
          for (let i = 0; i <= segments; i++) {
            const angle = (i * Math.PI * 2) / segments;
            const pt2D = {
              x: ent.center.x + ent.radius * Math.cos(angle),
              y: ent.center.y + ent.radius * Math.sin(angle),
            };
            pts.push(new THREE.Vector3(...transformPoint(pt2D)));
          }
          const geom = new THREE.BufferGeometry().setFromPoints(pts);
          return (
            <threeLine key={ent.id} geometry={geom}>
              <lineBasicMaterial color={ent.construction ? '#888888' : '#00e5ff'} linewidth={2} />
            </threeLine>
          );
        }
        return null;
      })}

      {/* Rubber-band preview line/points during drawing */}
      {currentPoints.length > 0 && (
        <group name="CurrentSketchPreview">
          {currentPoints.map((pt, i) => (
            <mesh key={i} position={transformPoint(pt)}>
              <sphereGeometry args={[0.6, 12, 12]} />
              <meshBasicMaterial color="#ff9800" />
            </mesh>
          ))}
          {currentPoints.length >= 2 && (
            <threeLine
              geometry={new THREE.BufferGeometry().setFromPoints(
                currentPoints.map(p => new THREE.Vector3(...transformPoint(p)))
              )}
            >
              <lineBasicMaterial color="#ff9800" linewidth={2} />
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
  onPointerMoveInSketch(pt: Point2): void;
  onSketchClick(pt: Point2): void;
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
        const pt = viewportPicker.screenToSketchPlane(px, py, camera, activeSketchPlane);
        if (pt) {
          const finalPt = snapEnabled ? sketchEngine.snapToGrid(pt, 5) : pt;
          onPointerMoveInSketch(finalPt);
        }
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

      const pt = viewportPicker.screenToSketchPlane(px, py, camera, activeSketchPlane);
      if (pt) {
        const finalPt = snapEnabled ? sketchEngine.snapToGrid(pt, 5) : pt;
        onSketchClick(finalPt);
      }
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
function OrientationCubeHUD({ setViewOrientation }: { setViewOrientation(view: ViewOrientation): void }) {
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
          <button className="view-btn" onClick={() => setViewOrientation('top')}>Top</button>
          <button className="view-btn" onClick={() => setViewOrientation('isometric')}>Iso</button>
          <button className="view-btn" onClick={() => setViewOrientation('bottom')}>Btm</button>
          <button className="view-btn" onClick={() => setViewOrientation('front')}>Frnt</button>
          <button className="view-btn" onClick={() => setViewOrientation('right')}>Rght</button>
          <button className="view-btn" onClick={() => setViewOrientation('left')}>Left</button>
        </div>
      )}
    </div>
  );
}

/**
 * Main 3D Viewport Component
 */
export default function Viewport3D() {
  const bodies = useCADStore(s => s.bodies);
  const assemblyComponents = useCADStore(s => s.assemblyComponents);
  const selectedEntities = useCADStore(s => s.selectedEntities);
  const setSelection = useCADStore(s => s.setSelection);
  const activeMaterial = useCADStore(s => s.activeMaterial);

  const showGrid = useCADStore(s => s.showGrid);
  const showOrigin = useCADStore(s => s.showOrigin);
  const showAxes = useCADStore(s => s.showAxes);
  const showPlanes = useCADStore(s => s.showPlanes);
  const shadedMode = useCADStore(s => s.shadedMode);
  const edgeDisplay = useCADStore(s => s.edgeDisplay);
  const wireframeMode = useCADStore(s => s.wireframeMode);
  const perspectiveView = useCADStore(s => s.perspectiveView);
  const viewOrientation = useCADStore(s => s.viewOrientation);
  const setViewOrientation = useCADStore(s => s.setViewOrientation);

  const isSketchActive = useCADStore(s => s.isSketchActive);
  const activeSketchId = useCADStore(s => s.activeSketchId);
  const activeSketchPlane = useCADStore(s => s.activeSketchPlane);
  const sketchEntities = useCADStore(s => s.sketchEntities);
  const activeTool = useCADStore(s => s.activeTool);
  const addSketchEntity = useCADStore(s => s.addSketchEntity);

  const [mouseSketchPt, setMouseSketchPt] = useState<Point2 | null>(null);
  const [sketchClickPts, setSketchClickPts] = useState<Point2[]>([]);

  const controlsRef = useRef<ElementRef<typeof OrbitControls>>(null);

  // Switch camera when viewOrientation changes
  useEffect(() => {
    if (!controlsRef.current) return;
    const info = VIEW_ORIENTATIONS[viewOrientation] || VIEW_ORIENTATIONS.isometric;
    const camera = controlsRef.current.object;
    if (camera && info) {
      camera.position.set(...(info.position as [number, number, number]));
      camera.up.set(...(info.up as [number, number, number]));
      camera.lookAt(0, 0, 0);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [viewOrientation]);

  // Sketch drawing logic
  const handleSketchClick = useCallback((pt: Point2) => {
    if (activeTool === TOOLS.SKETCH_LINE) {
      if (sketchClickPts.length === 0) {
        setSketchClickPts([pt]);
      } else {
        const p1 = sketchClickPts[0];
        const p2 = pt;
        addSketchEntity(sketchEngine.createLine(p1, p2));
        setSketchClickPts([p2]); // Continue chain
      }
    } else if (activeTool === TOOLS.SKETCH_RECT) {
      if (sketchClickPts.length === 0) {
        setSketchClickPts([pt]);
      } else {
        const p1 = sketchClickPts[0];
        const lines = sketchEngine.createRectangle(p1, pt);
        lines.forEach(l => addSketchEntity(l));
        setSketchClickPts([]);
      }
    } else if (activeTool === TOOLS.SKETCH_CIRCLE) {
      if (sketchClickPts.length === 0) {
        setSketchClickPts([pt]);
      } else {
        const center = sketchClickPts[0];
        const radius = Math.hypot(pt.x - center.x, pt.y - center.y);
        addSketchEntity(sketchEngine.createCircle(center, radius));
        setSketchClickPts([]);
      }
    } else if (activeTool === TOOLS.SKETCH_POINT) {
      addSketchEntity(sketchEngine.createPoint(pt));
    }
  }, [activeTool, sketchClickPts, addSketchEntity]);

  const currentPreviewPoints = useMemo(() => {
    if (sketchClickPts.length > 0 && mouseSketchPt) {
      return [...sketchClickPts, mouseSketchPt];
    }
    return sketchClickPts;
  }, [sketchClickPts, mouseSketchPt]);

  return (
    <div className="viewport-container" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <Canvas
        shadows
        camera={{ position: [80, 80, 80], fov: 45, near: 0.1, far: 5000 }}
        style={{ background: 'radial-gradient(ellipse at 50% 45%, #2a2e38 0%, #16171c 70%, #0d0e11 100%)' }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[100, 150, 100]} intensity={1.2} castShadow />
        <directionalLight position={[-100, 80, -100]} intensity={0.5} />
        <hemisphereLight color="#ffffff" groundColor="#333333" intensity={0.4} />

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

        {/* Bodies */}
        {bodies.map((body) => (
          <CADBodyMesh
            key={body.id}
            body={body}
            isSelected={selectedEntities.some(e => e.id === body.id)}
            onSelect={(b) => setSelection({ id: b.id })}
            shadedMode={shadedMode}
            wireframeMode={wireframeMode}
            edgeDisplay={edgeDisplay}
            materialKey={activeMaterial}
          />
        ))}

        {/* Assembly Components */}
        {assemblyComponents && assemblyComponents.map((comp) => (
          <CADBodyMesh
            key={comp.id}
            body={comp}
            isSelected={selectedEntities.some(e => e.id === comp.id)}
            onSelect={(b) => setSelection({ id: b.id })}
            shadedMode={shadedMode}
            wireframeMode={wireframeMode}
            edgeDisplay={edgeDisplay}
            materialKey={activeMaterial}
          />
        ))}

        {/* Active Sketch Overlay */}
        {isSketchActive && (
          <ActiveSketchOverlay
            activeSketchId={activeSketchId}
            activeSketchPlane={activeSketchPlane}
            sketchEntities={sketchEntities}
            currentPoints={currentPreviewPoints}
            activeTool={activeTool}
          />
        )}

        <ViewportController
          onPointerMoveInSketch={setMouseSketchPt}
          onSketchClick={handleSketchClick}
        />
      </Canvas>

      <OrientationCubeHUD setViewOrientation={setViewOrientation} />
    </div>
  );
}
