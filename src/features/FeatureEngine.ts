// CasiWorks Pro - Parametric feature rebuild engine (sequential evaluation with rollback)
import * as THREE from 'three';
import { FEATURE_TYPES } from '../utils/constants.ts';
import { geometryEngine } from '../kernel/GeometryEngine.ts';
import type { ProfileEntity } from '../kernel/GeometryEngine.ts';
import type {
  BooleanFeature, CircularPatternFeature, ExtrudeFeature, FeatureData, HoleFeature, LinearPatternFeature,
  LoftFeature, MirrorFeature, PlaneFrame, RebuildError, ReferenceFeature, RevolveFeature, SketchEntity, SketchEntityMap, SketchFeature, SketchPlane, SweepFeature,
} from '../types/cad.ts';
import { referencePlaneFrame } from '../utils/math.ts';

type Geometry = THREE.BufferGeometry;
/** The body being built; null until the first solid feature. */
type Body = Geometry | null;

/**
 * Fields older saved models may carry (aliases of the current ones). They are
 * still honoured so those files rebuild the same.
 */
interface LegacyFeatureFields {
  entities?: SketchEntity[];
  sketchId?: string;
  sketchRef?: string;
  distance?: number;
  symmetric?: boolean;
  thickness?: number;
  plane?: SketchPlane;
}
type AnyFeature = FeatureData & LegacyFeatureFields;

interface SketchData {
  entities: SketchEntity[];
  plane: SketchPlane | PlaneFrame;
}

export interface FeatureRebuildResult {
  bodies: Geometry[];
  errors: RebuildError[];
}

/**
 * A unit vector from optional components: the default when no component is
 * given, otherwise missing components are 0 (so {y: 1} means +Y, not (1, 1, 0)).
 */
function vectorFrom(components: Array<number | undefined>, fallback: [number, number, number], what: string): THREE.Vector3 {
  const given = components.some(c => c !== undefined && c !== null);
  const v = given ? new THREE.Vector3(...components.map(c => Number(c ?? 0)) as [number, number, number]) : new THREE.Vector3(...fallback);
  if (!(v.length() > 1e-12)) throw new Error(`${what} is a zero vector`);
  return v.normalize();
}

export class FeatureEngine {
  geometryEngine = geometryEngine;
  /** Sketches seen so far in the current rebuild, by sketch id. */
  sketchCache: Record<string, SketchData> = {};
  /** Frames of the reference planes built so far in this rebuild. */
  planeCache: Record<string, PlaneFrame> = {};
  /** Tool geometry of each solid feature in the current rebuild, by feature id. */
  featureGeometries: Record<string, Geometry> = {};

  /**
   * Rebuild the parametric model from the feature tree.
   * @param features Features in tree order (store features, or authored ones without dependency links)
   * @param sketchEntities Map of sketch id → entities
   * @param rollbackIndex If ≥ 0, only features up to this index are evaluated
   */
  rebuild(features: FeatureData[], sketchEntities: SketchEntityMap = {}, rollbackIndex: number | null = null): FeatureRebuildResult {
    this.sketchCache = {};
    this.planeCache = {};
    this.featureGeometries = {};
    let currentBody: Body = null;
    const errors: RebuildError[] = [];
    const all = features as AnyFeature[];
    // Sketch ids whose sketch feature is suppressed; consumers of these must not build.
    const suppressedSketchIds = new Set(
      all.filter(f => f.type === FEATURE_TYPES.SKETCH && f.suppressed && f.sketchId).map(f => f.sketchId)
    );

    const maxIdx = (rollbackIndex !== null && rollbackIndex !== undefined && rollbackIndex >= 0)
      ? rollbackIndex
      : all.length - 1;

    for (let i = 0; i <= maxIdx && i < all.length; i++) {
      const feature = all[i];
      if (feature.suppressed) continue;

      // Dependency check: if any parent is suppressed, skip this feature
      if (feature.parentIds && feature.parentIds.length > 0) {
        const parentSuppressed = feature.parentIds.some(pid => {
          const pf = all.find(f => f.id === pid || f.sketchId === pid);
          return pf && pf.suppressed;
        });
        if (parentSuppressed) continue;
      }
      if (feature.type !== FEATURE_TYPES.SKETCH && feature.sketchId && suppressedSketchIds.has(feature.sketchId)) continue;

      try {
        const result = this._processFeature(feature, currentBody, sketchEntities);
        if (result !== undefined) {
          currentBody = result;
        }
      } catch (err) {
        console.warn(`FeatureEngine: Error in "${feature.name}" (${feature.type}):`, err);
        errors.push({ featureId: feature.id, featureName: feature.name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Edge display and mass properties are computed on demand by the viewport and dialogs.
    return { bodies: currentBody ? [currentBody] : [], errors };
  }

  _processFeature(feature: AnyFeature, currentBody: Body, sketchEntities: SketchEntityMap): Body {
    switch (feature.type) {
      case FEATURE_TYPES.SKETCH:
        return this._processSketch(feature, currentBody, sketchEntities);
      case FEATURE_TYPES.REFERENCE_PLANE: {
        const ref = feature as ReferenceFeature;
        this.planeCache[feature.id] = referencePlaneFrame(ref.base ?? 'Front', ref.offset ?? 0, ref.angle ?? 0);
        return currentBody;
      }
      case FEATURE_TYPES.EXTRUDE_BOSS:
        return this._processExtrudeBoss(feature, currentBody, sketchEntities);
      case FEATURE_TYPES.EXTRUDE_CUT:
        return this._processExtrudeCut(feature, currentBody, sketchEntities);
      case FEATURE_TYPES.REVOLVE_BOSS:
        return this._processRevolveBoss(feature, currentBody, sketchEntities);
      case FEATURE_TYPES.REVOLVE_CUT:
        return this._processRevolveCut(feature, currentBody, sketchEntities);
      case FEATURE_TYPES.SWEEP_BOSS:
        return this._processSweep(feature, currentBody, sketchEntities, false);
      case FEATURE_TYPES.SWEEP_CUT:
        return this._processSweep(feature, currentBody, sketchEntities, true);
      case FEATURE_TYPES.LOFT_BOSS:
        return this._processLoft(feature, currentBody, sketchEntities, false);
      case FEATURE_TYPES.LOFT_CUT:
        return this._processLoft(feature, currentBody, sketchEntities, true);
      case FEATURE_TYPES.FILLET:
        return this._processFillet(feature, currentBody);
      case FEATURE_TYPES.CHAMFER:
        return this._processChamfer(feature, currentBody);
      case FEATURE_TYPES.SHELL:
        return this._processShell(feature, currentBody);
      case FEATURE_TYPES.HOLE:
        return this._processHole(feature, currentBody);
      case FEATURE_TYPES.LINEAR_PATTERN:
        return this._processLinearPattern(feature, currentBody);
      case FEATURE_TYPES.CIRCULAR_PATTERN:
        return this._processCircularPattern(feature, currentBody);
      case FEATURE_TYPES.MIRROR:
        return this._processMirror(feature, currentBody);
      case FEATURE_TYPES.BOOLEAN:
        return this._processBoolean(feature, currentBody);
      default:
        return currentBody;
    }
  }

  _processSketch(feature: AnyFeature, currentBody: Body, sketchEntities: SketchEntityMap): Body {
    const entities = feature.entities || (feature.sketchId ? sketchEntities[feature.sketchId] : undefined) || [];
    const sketch = feature as SketchFeature;
    let plane: SketchPlane | PlaneFrame = sketch.frame ?? (feature.plane || 'Front');
    if (sketch.planeRef) {
      const frame = this.planeCache[sketch.planeRef];
      if (!frame) throw new Error('The reference plane of this sketch is missing or suppressed');
      plane = frame;
    }
    this.sketchCache[feature.sketchId || feature.id] = { entities, plane };
    return currentBody;
  }

  _getSketchForFeature(feature: AnyFeature, sketchEntities: SketchEntityMap): SketchData | null {
    const sketchId = feature.sketchId || feature.sketchRef;
    if (sketchId && this.sketchCache[sketchId]) {
      return this.sketchCache[sketchId];
    }
    if (sketchId && sketchEntities[sketchId]) {
      return { entities: sketchEntities[sketchId], plane: feature.plane || 'Front' };
    }
    // Never substitute a different sketch: building from the wrong profile silently
    // produces wrong geometry. Surface it as a rebuild error instead.
    if (sketchId) throw new Error(`Referenced sketch "${sketchId}" no longer exists`);
    return null;
  }

  /** The solid an extrude feature sweeps out, or null when its sketch is empty. */
  _extrudeTool(feature: ExtrudeFeature & LegacyFeatureFields, sketchEntities: SketchEntityMap): Geometry | null {
    const sketchData = this._getSketchForFeature(feature, sketchEntities);
    if (!sketchData || !sketchData.entities || sketchData.entities.length === 0) return null;

    const depth = feature.depth ?? feature.distance ?? 25;
    const isMidplane = feature.direction === 'midplane' || feature.symmetric;
    const isThrough = feature.direction === 'throughall';
    const isThin = feature.thin || false;
    const wallThickness = feature.wallThickness || feature.thickness || 2;
    const flip = feature.flip || false;

    // Every closed region of the sketch (several circles = several bodies or holes)
    const shape = this.geometryEngine.shapesFromSketchEntities(sketchData.entities as ProfileEntity[], {
      thin: isThin,
      wallThickness,
    });

    const tool = this.geometryEngine.extrudeProfile(shape, depth, sketchData.plane, {
      symmetric: isMidplane,
      endCondition: isThrough ? 'through' : (isMidplane ? 'midplane' : 'blind'),
      flip,
      plane: sketchData.plane,
    });
    this.featureGeometries[feature.id] = tool;
    return tool;
  }

  _processExtrudeBoss(feature: ExtrudeFeature & LegacyFeatureFields, currentBody: Body, sketchEntities: SketchEntityMap): Body {
    const extruded = this._extrudeTool(feature, sketchEntities);
    if (!extruded) return currentBody;
    return this.geometryEngine.booleanUnion(currentBody, extruded);
  }

  _processExtrudeCut(feature: ExtrudeFeature & LegacyFeatureFields, currentBody: Body, sketchEntities: SketchEntityMap): Body {
    if (!currentBody) return currentBody;
    const cutGeom = this._extrudeTool(feature, sketchEntities);
    if (!cutGeom) return currentBody;
    return this.geometryEngine.booleanSubtract(currentBody, cutGeom);
  }

  /** The solid a revolve feature sweeps out, or null when its sketch is empty. */
  _revolveTool(feature: RevolveFeature & LegacyFeatureFields, sketchEntities: SketchEntityMap): Geometry | null {
    const sketchData = this._getSketchForFeature(feature, sketchEntities);
    if (!sketchData || !sketchData.entities || sketchData.entities.length === 0) return null;

    const angleRad = ((feature.angle ?? 360) * Math.PI) / 180;
    const shape = this.geometryEngine.shapeFromSketchEntities(sketchData.entities as ProfileEntity[]);
    const revolved = this.geometryEngine.revolveProfile(shape, null, angleRad, { plane: sketchData.plane });
    this.featureGeometries[feature.id] = revolved;
    return revolved;
  }

  _processRevolveBoss(feature: RevolveFeature & LegacyFeatureFields, currentBody: Body, sketchEntities: SketchEntityMap): Body {
    const revolved = this._revolveTool(feature, sketchEntities);
    if (!revolved) return currentBody;
    return this.geometryEngine.booleanUnion(currentBody, revolved);
  }

  _processRevolveCut(feature: RevolveFeature & LegacyFeatureFields, currentBody: Body, sketchEntities: SketchEntityMap): Body {
    if (!currentBody) return currentBody;
    const revolved = this._revolveTool(feature, sketchEntities);
    if (!revolved) return currentBody;
    return this.geometryEngine.booleanSubtract(currentBody, revolved);
  }

  _processSweep(feature: SweepFeature & LegacyFeatureFields, currentBody: Body, sketchEntities: SketchEntityMap, isCut = false): Body {
    const sketchData = this._getSketchForFeature(feature, sketchEntities);
    if (!sketchData) return currentBody;

    const shape = this.geometryEngine.shapeFromSketchEntities(sketchData.entities as ProfileEntity[]);
    if (!Array.isArray(feature.pathPoints) || feature.pathPoints.length < 2) {
      throw new Error('Sweep needs a path with at least 2 points');
    }
    const pts = feature.pathPoints.map(p => new THREE.Vector3(p.x, p.y, p.z));

    const path = new THREE.CatmullRomCurve3(pts);
    const swept = this.geometryEngine.sweepProfile(shape, path);

    this.featureGeometries[feature.id] = swept;
    return isCut
      ? this.geometryEngine.booleanSubtract(currentBody, swept)
      : this.geometryEngine.booleanUnion(currentBody, swept);
  }

  _processLoft(feature: LoftFeature & LegacyFeatureFields, currentBody: Body, _sketchEntities: SketchEntityMap, isCut = false): Body {
    const profiles = Array.isArray(feature.profiles) ? feature.profiles : [];
    const shapes: THREE.Shape[] = [];
    for (const pId of profiles) {
      const data = this.sketchCache[pId];
      if (data) shapes.push(this.geometryEngine.shapeFromSketchEntities(data.entities as ProfileEntity[]));
    }
    // Never substitute made-up profiles: report the problem as a rebuild error
    if (shapes.length < 2) {
      throw new Error(`Loft needs at least 2 profile sketches (found ${shapes.length})`);
    }

    const lofted = this.geometryEngine.loftProfiles(shapes, { height: feature.height || 40 });
    this.featureGeometries[feature.id] = lofted;

    return isCut
      ? this.geometryEngine.booleanSubtract(currentBody, lofted)
      : this.geometryEngine.booleanUnion(currentBody, lofted);
  }

  // Fillet, chamfer and shell need edge/face topology that the triangle-mesh
  // kernel does not have. Rather than silently doing nothing (fillet/chamfer)
  // or producing a wrong solid (shell), they report a rebuild warning and leave
  // the model unchanged until the exact kernel lands (ROADMAP Phase 2).
  _processFillet(_feature: AnyFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    throw new Error('Fillet not applied: the mesh kernel cannot round edges; round the corner in the sketch with an arc instead');
  }

  _processChamfer(_feature: AnyFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    throw new Error('Chamfer not applied: the mesh kernel cannot bevel edges; draw the bevel in the sketch instead');
  }

  _processShell(_feature: AnyFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    throw new Error('Shell not applied: the mesh kernel cannot hollow a solid; sketch the inner outline and use Extrude Cut instead');
  }

  _processHole(feature: HoleFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    const diameter = feature.diameter ?? 10;
    const depth = feature.depth ?? 30;
    const entry = feature.position ? new THREE.Vector3(feature.position.x, feature.position.y, feature.position.z) : new THREE.Vector3(0, 0, 0);
    const drill = vectorFrom(feature.axis ? [feature.axis.x, feature.axis.y, feature.axis.z] : [], [0, 0, 1], 'Hole axis');
    // The hole runs from the entry point `depth` along the drill axis. The kernel
    // centres its tool on the given point with the counterbore / countersink at
    // the +axis end and the drill point at the −axis end, so aim that axis back
    // out of the hole.
    const centre = entry.addScaledVector(drill, depth / 2);
    // A tapped hole is drilled at the tap drill size; the thread itself is not modelled
    const kind = feature.holeType === 'tapped' ? 'simple' : (feature.holeType || 'simple');
    const positive = (v: number | undefined) => (typeof v === 'number' && v > 0 ? v : undefined);
    return this.geometryEngine.createHole(currentBody, centre, drill.negate(), diameter, depth, kind, {
      cbDiameter: positive(feature.cbDiameter),
      cbDepth: positive(feature.cbDepth),
      csDiameter: positive(feature.csDiameter),
      csAngle: positive(feature.csAngle),
    });
  }

  _processLinearPattern(feature: LinearPatternFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    const dir = vectorFrom([feature.directionX, feature.directionY, feature.directionZ], [1, 0, 0], 'Pattern direction');
    const count = feature.count || 3;
    const spacing = feature.spacing || 20;
    return this.geometryEngine.linearPattern(currentBody, dir, count, spacing);
  }

  _processCircularPattern(feature: CircularPatternFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    const axis = vectorFrom([feature.axisX, feature.axisY, feature.axisZ], [0, 1, 0], 'Pattern axis');
    const count = feature.count || 4;
    const angle = (feature.angle || 360) * (Math.PI / 180);
    return this.geometryEngine.circularPattern(currentBody, axis, count, angle);
  }

  _processMirror(feature: MirrorFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    const plane = feature.plane || 'Right';
    return this.geometryEngine.mirrorGeometry(currentBody, plane);
  }

  _processBoolean(feature: BooleanFeature, currentBody: Body): Body {
    if (!currentBody) return currentBody;
    const tool = feature.toolFeatureId ? this.featureGeometries[feature.toolFeatureId] : null;
    if (!tool) return currentBody;

    switch (feature.operation) {
      case 'subtract':
      case 'cut':
        return this.geometryEngine.booleanSubtract(currentBody, tool);
      case 'intersect':
        return this.geometryEngine.booleanIntersect(currentBody, tool);
      case 'union':
      default:
        return this.geometryEngine.booleanUnion(currentBody, tool);
    }
  }
}

export const featureEngine = new FeatureEngine();
export default FeatureEngine;
