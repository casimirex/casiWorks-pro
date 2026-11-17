// CasiWorks Pro - Core Geometry Engine (triangle-mesh kernel)
// Profile operations (extrude, revolve, sweep, loft), finishing operations,
// patterns, mirror, CSG booleans and mass properties.

import * as THREE from 'three';
import { EPSILON, getSketchPlaneMatrix, safeNormalize } from '../utils/math.ts';
import { csgUnion, csgSubtract, csgIntersect } from './csg.ts';
import { profileLoops, shapesFromLoops } from './profile.ts';
import type { ProfileEntity } from './profile.ts';

export type { ProfileEntity };
import type { InertiaTensor, MassProperties, PlaneFrame, Point2 } from '../types/cad.ts';

export type PlaneName = 'Front' | 'Top' | 'Right' | 'XY' | 'XZ' | 'YZ' | PlaneFrame;

export interface ExtrudeOptions {
  symmetric?: boolean;
  endCondition?: 'blind' | 'through' | 'upTo' | 'midplane';
  steps?: number;
  /** Extrude in the opposite direction (−normal of the sketch plane). */
  flip?: boolean;
  plane?: PlaneName;
}

export interface RevolveOptions {
  segments?: number;
  offset?: number;
  /** Sketch plane of the profile: the solid is oriented like an extrude from that plane. */
  plane?: PlaneName;
}
export interface SweepOptions { steps?: number; closed?: boolean; twist?: number }
export interface LoftOptions {
  steps?: number;
  /** Z height of each profile; defaults to evenly spaced from 0 to `height`. */
  heights?: number[] | null;
  /** Total loft height when `heights` is not given (default 100). */
  height?: number;
}
export interface HoleOptions { cbDiameter?: number; cbDepth?: number; csAngle?: number; csDiameter?: number; segments?: number }
export interface ShapeOptions { thin?: boolean; wallThickness?: number }
export type HoleType = 'through' | 'blind' | 'counterbore' | 'countersink' | 'simple';


// ============================================================================
// GeometryEngine Class
// ============================================================================

class GeometryEngine {
  tolerance = 1e-6;

  // ==========================================================================
  // Profile-Based Operations
  // ==========================================================================

  /**
   * Extrude a 2D Three.js Shape into 3D geometry.
   * @param {THREE.Shape} shape - The 2D profile to extrude
   * @param {number} depth - Extrusion depth
   * @param {THREE.Vector3} direction - Extrusion direction (default: Z-up)
   * @param {Object} options - { symmetric, endCondition, draft, draftAngle }
   * @returns {THREE.BufferGeometry}
   */
  /**
   * Extrude one or more 2D shapes (with holes) along the sketch-plane normal.
   * Blind: 0..depth. Midplane: −depth/2..depth/2. Through: 500 mm. Flip: −depth..0.
   */
  extrudeProfile(
    shape: THREE.Shape | THREE.Shape[],
    depth: number,
    direction: PlaneName | THREE.Vector3 | null = null,
    options: ExtrudeOptions = {},
  ): THREE.BufferGeometry {
    const { symmetric = false, endCondition = 'blind', steps = 1, flip = false, plane = 'Front' } = options;

    const isMidplane = symmetric || endCondition === 'midplane';
    const actualDepth = endCondition === 'through' ? 500 : depth;

    // Extrude each region separately and union them: regions may overlap, and
    // concatenating overlapping solids would make a non-manifold mesh
    const shapes = Array.isArray(shape) ? shape : [shape];
    let geometry: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shapes[0] ?? new THREE.Shape(), { steps, depth: actualDepth, bevelEnabled: false });
    for (const region of shapes.slice(1)) {
      const part = new THREE.ExtrudeGeometry(region, { steps, depth: actualDepth, bevelEnabled: false });
      geometry = this.booleanUnion(geometry, part) ?? geometry;
      part.dispose();
    }

    if (isMidplane) {
      geometry.translate(0, 0, -actualDepth / 2);
    } else if (flip) {
      // Same solid on the other side of the sketch plane. A translation keeps the
      // winding valid (mirroring z would turn the solid inside out).
      geometry.translate(0, 0, -actualDepth);
    }

    // Orient to the sketch plane
    const planeName = typeof direction === 'string' ? direction : (direction instanceof THREE.Vector3 ? null : plane);
    if (planeName) {
      this._orientToPlane(geometry, planeName);
    } else if (direction instanceof THREE.Vector3) {
      const defaultDir = new THREE.Vector3(0, 0, 1);
      const dir = direction.clone().normalize();
      if (dir.distanceTo(defaultDir) > EPSILON) {
        geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(defaultDir, dir));
      }
    }

    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }

  /**
   * Revolve a 2D profile around an axis.
   * @param {THREE.Shape} shape - The 2D profile to revolve
   * @param {THREE.Vector3} axis - Rotation axis (default: Y)
   * @param {number} angle - Revolution angle in radians (default: 2π)
   * @param {Object} options - { segments, offset }
   * @returns {THREE.BufferGeometry}
   */
  /** Map sketch coordinates (x, y, normal z) of a sketch plane to world coordinates. */
  _orientToPlane(geometry: THREE.BufferGeometry, plane: PlaneName): void {
    // The same mapping the sketcher and the viewport use (any plane frame too)
    const m = getSketchPlaneMatrix(plane);
    if (!m.equals(new THREE.Matrix4())) geometry.applyMatrix4(m);
  }

  /**
   * Revolve a profile about the sketch Y axis (sketch X = radius), right-handed,
   * starting at the sketch itself, then align the Y axis with `axis` (or orient
   * the result to `options.plane`). Partial revolves are capped, so the result
   * is always a closed, outward-facing solid.
   */
  revolveProfile(shape: THREE.Shape, axis: THREE.Vector3 | null = null, angle = Math.PI * 2, options: RevolveOptions = {}): THREE.BufferGeometry {
    const { segments = 64, offset = 0 } = options;

    let profile = shape.getPoints(50).map(p => new THREE.Vector2(Math.abs(p.x) + offset, p.y));
    if (profile.length > 1 && profile[0].distanceTo(profile[profile.length - 1]) < 1e-9) profile.pop();
    // A counter-clockwise profile (in radius/height) gives outward-facing lathe triangles
    if (THREE.ShapeUtils.isClockWise(profile)) profile = profile.reverse();

    const sweep = Math.min(Math.abs(angle), Math.PI * 2);
    const isFull = sweep >= Math.PI * 2 - 1e-9;
    // Close the profile loop so the lathe surface has no seam gap
    const lathe = new THREE.LatheGeometry([...profile, profile[0].clone()], segments, 0, sweep);

    let geometry: THREE.BufferGeometry = lathe;
    if (!isFull) {
      geometry = this._mergeGeometries([lathe, this._revolveCap(profile, 0, -1), this._revolveCap(profile, sweep, 1)]);
      lathe.dispose();
    }

    // LatheGeometry starts at +Z (angle 0); the profile itself lies along +X
    geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));

    if (options.plane) {
      this._orientToPlane(geometry, options.plane);
    } else if (axis) {
      const defaultAxis = new THREE.Vector3(0, 1, 0);
      const targetAxis = axis.clone().normalize();
      if (targetAxis.distanceTo(defaultAxis) > EPSILON) {
        geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(defaultAxis, targetAxis));
      }
    }

    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }

  /**
   * Planar cap of a partial revolve at angle `phi`; `side` −1 faces back along
   * the sweep (start cap), +1 forward (end cap). LatheGeometry maps (r, y) at
   * phi to (r·sin phi, y, r·cos phi).
   */
  _revolveCap(profile: THREE.Vector2[], phi: number, side: 1 | -1): THREE.BufferGeometry {
    const to3 = (p: THREE.Vector2) => new THREE.Vector3(p.x * Math.sin(phi), p.y, p.x * Math.cos(phi));
    const outward = new THREE.Vector3(Math.cos(phi), 0, -Math.sin(phi)).multiplyScalar(side);
    const positions: number[] = [];
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(profile, [])) {
      const a = to3(profile[i]);
      let b = to3(profile[j]);
      let c = to3(profile[k]);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (n.dot(outward) < 0) [b, c] = [c, b];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    const cap = new THREE.BufferGeometry();
    cap.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return cap;
  }

  /**
   * Sweep a 2D profile along a 3D path curve.
   * @param {THREE.Shape} shape - The cross-section profile
   * @param {THREE.Curve} path - The sweep path (e.g., CatmullRomCurve3)
   * @param {Object} options - { steps, closed, twist }
   * @returns {THREE.BufferGeometry}
   */
  sweepProfile(shape: THREE.Shape, path: THREE.Curve<THREE.Vector3>, options: SweepOptions = {}): THREE.BufferGeometry {
    const {
      steps = 100,
      twist = 0,
    } = options;

    const extrudeSettings = {
      steps: steps,
      bevelEnabled: false,
      extrudePath: path,
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);

    // Apply twist if specified
    if (twist !== 0) {
      const posAttr = geometry.getAttribute('position');

      for (let i = 0; i < posAttr.count; i++) {
        const vertex = new THREE.Vector3(
          posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)
        );

        // Find the closest point on the path to determine the twist angle
        // Use an approximate method: project onto path
        const closestParam = this._findClosestParamOnPath(vertex, path, steps);
        const twistAngle = closestParam * twist;

        // Get the tangent at this point
        const tangent = path.getTangentAt(closestParam).normalize();
        const pointOnPath = path.getPointAt(closestParam);

        // Rotate vertex around the tangent at the path point
        const offset = vertex.clone().sub(pointOnPath);
        const rotMatrix = new THREE.Matrix4().makeRotationAxis(tangent, twistAngle);
        offset.applyMatrix4(rotMatrix);
        vertex.copy(pointOnPath).add(offset);

        posAttr.setXYZ(i, vertex.x, vertex.y, vertex.z);
      }
      posAttr.needsUpdate = true;
    }

    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }

  /**
   * Loft between closed cross-sections stacked along Z. Each profile is made
   * counter-clockwise, resampled by arc length to the same point count and
   * aligned to start at the same angle; the side wall is closed around the
   * seam and both ends are capped, so the result is a closed solid.
   */
  loftProfiles(shapes: THREE.Shape[], options: LoftOptions = {}): THREE.BufferGeometry {
    const { steps = 32, heights = null, height = 100 } = options;
    if (shapes.length < 2) throw new Error('Loft requires at least 2 cross-section shapes');

    const N = 64;
    const profiles = shapes.map(shape => {
      let loop = shape.getPoints(N);
      if (loop.length > 1 && loop[0].distanceTo(loop[loop.length - 1]) < 1e-9) loop.pop();
      if (THREE.ShapeUtils.isClockWise(loop)) loop = loop.reverse();
      // Start at the point whose direction from the centroid is closest to +X
      const c = loop.reduce((acc, p) => acc.add(p), new THREE.Vector2()).divideScalar(loop.length);
      let startIdx = 0;
      let best = Infinity;
      loop.forEach((p, i) => {
        const ang = Math.abs(Math.atan2(p.y - c.y, p.x - c.x));
        if (ang < best) { best = ang; startIdx = i; }
      });
      loop = [...loop.slice(startIdx), ...loop.slice(0, startIdx)];
      return this._resamplePoints([...loop, loop[0].clone()], N + 1).slice(0, N);
    });

    const zHeights = heights && heights.length === profiles.length
      ? heights
      : profiles.map((_, i) => (i / (profiles.length - 1)) * height);

    // Interpolated rings
    const totalSteps = (profiles.length - 1) * steps;
    const rings: THREE.Vector3[][] = [];
    for (let s = 0; s <= totalSteps; s++) {
      const globalT = (s / totalSteps) * (profiles.length - 1);
      const idx = Math.min(Math.floor(globalT), profiles.length - 2);
      const t = globalT - idx;
      const z = zHeights[idx] + (zHeights[idx + 1] - zHeights[idx]) * t;
      rings.push(profiles[idx].map((p, i) => {
        const q = profiles[idx + 1][i];
        return new THREE.Vector3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, z);
      }));
    }

    const positions: number[] = [];
    const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);

    // Side wall, wrapping around the seam
    for (let s = 0; s < rings.length - 1; s++) {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        tri(rings[s][i], rings[s][j], rings[s + 1][j]);
        tri(rings[s][i], rings[s + 1][j], rings[s + 1][i]);
      }
    }

    // End caps facing −Z (bottom) and +Z (top)
    const cap = (ring: THREE.Vector3[], outward: number) => {
      const flat = ring.map(v => new THREE.Vector2(v.x, v.y));
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(flat, [])) {
        const [a, b, c] = [ring[i], ring[j], ring[k]];
        const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (nz * outward >= 0) tri(a, b, c);
        else tri(a, c, b);
      }
    };
    cap(rings[0], -1);
    cap(rings[rings.length - 1], 1);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }

  // ==========================================================================
  // Modification Operations
  // ==========================================================================

  /**
   * Create a hole in geometry.
   * @param {THREE.BufferGeometry} geometry - Target geometry
   * @param {THREE.Vector3} position - Hole center position
   * @param {THREE.Vector3} direction - Hole direction
   * @param {number} diameter - Hole diameter
   * @param {number} depth - Hole depth (0 for through)
   * @param {string} holeType - 'through', 'blind', 'counterbore', 'countersink'
   * @param {Object} options - { cbDiameter, cbDepth, csAngle }
   * @returns {THREE.BufferGeometry}
   */
  createHole(geometry: THREE.BufferGeometry, position: THREE.Vector3, direction: THREE.Vector3, diameter: number, depth: number, holeType: HoleType = 'through', options: HoleOptions = {}): THREE.BufferGeometry | null {
    const {
      cbDiameter = diameter * 1.8,
      cbDepth = diameter * 0.5,
      csAngle = 82,
      csDiameter,
      segments = 32,
    } = options;

    const radius = diameter / 2;
    const dir = safeNormalize(direction, new THREE.Vector3(0, 0, 1));

    // Create the hole cylinder tool
    let holeGeometry: THREE.BufferGeometry;

    switch (holeType) {
      case 'through': {
        holeGeometry = new THREE.CylinderGeometry(radius, radius, 1000, segments);
        break;
      }
      case 'blind': {
        const cylinderGeom = new THREE.CylinderGeometry(radius, radius, depth, segments);
        const tipHeight = radius * Math.tan((Math.PI - (118 * Math.PI / 180)) / 2);
        const coneGeom = new THREE.ConeGeometry(radius, tipHeight, segments);
        coneGeom.rotateX(Math.PI); // apex down: the drill point continues past the hole bottom
        coneGeom.translate(0, -(depth / 2 + tipHeight / 2), 0);

        holeGeometry = csgUnion(cylinderGeom, coneGeom);
        cylinderGeom.dispose();
        coneGeom.dispose();
        break;
      }
      case 'counterbore': {
        const mainCylinder = new THREE.CylinderGeometry(radius, radius, depth || 1000, segments);
        const cbRadius = cbDiameter / 2;
        const cbCylinder = new THREE.CylinderGeometry(cbRadius, cbRadius, cbDepth, segments);
        cbCylinder.translate(0, (depth || 500) / 2 - cbDepth / 2, 0);

        holeGeometry = csgUnion(mainCylinder, cbCylinder);
        mainCylinder.dispose();
        cbCylinder.dispose();
        break;
      }
      case 'countersink': {
        const mainCyl = new THREE.CylinderGeometry(radius, radius, depth || 1000, segments);
        const csAngleRad = csAngle * Math.PI / 180;
        const csRadius = csDiameter && csDiameter > diameter ? csDiameter / 2 : radius * 1.6;
        const csHeight = (csRadius - radius) / Math.tan(csAngleRad / 2);
        const csCone = new THREE.CylinderGeometry(radius, csRadius, csHeight, segments);
        csCone.translate(0, (depth || 500) / 2 - csHeight / 2, 0);

        holeGeometry = csgUnion(mainCyl, csCone);
        mainCyl.dispose();
        csCone.dispose();
        break;
      }
      default:
        holeGeometry = new THREE.CylinderGeometry(radius, radius, depth || 1000, segments);
    }

    const defaultAxis = new THREE.Vector3(0, 1, 0);
    if (dir.distanceTo(defaultAxis) > EPSILON) {
      const quaternion = new THREE.Quaternion().setFromUnitVectors(defaultAxis, dir);
      holeGeometry.applyQuaternion(quaternion);
    }

    holeGeometry.translate(position.x, position.y, position.z);

    const result = this.booleanSubtract(geometry, holeGeometry);
    holeGeometry.dispose();
    return result;
  }

  /**
   * Create a linear pattern of geometry.
   * @param {THREE.BufferGeometry} geometry - Source geometry
   * @param {THREE.Vector3} direction - Pattern direction
   * @param {number} count - Number of instances (including original)
   * @param {number} spacing - Distance between instances
   * @returns {THREE.BufferGeometry}
   */
  linearPattern(geometry: THREE.BufferGeometry, direction: THREE.Vector3, count: number, spacing: number): THREE.BufferGeometry {
    const dir = safeNormalize(direction, new THREE.Vector3(1, 0, 0));
    let result = geometry.clone();
    for (let i = 1; i < count; i++) {
      const instance = geometry.clone();
      const offset = dir.clone().multiplyScalar(spacing * i);
      instance.translate(offset.x, offset.y, offset.z);
      // Union (not concatenation) so overlapping instances are not counted twice
      result = this.booleanUnion(result, instance) ?? result;
      instance.dispose();
    }
    return result;
  }

  /**
   * Create a circular pattern of geometry around an axis.
   * @param {THREE.BufferGeometry} geometry - Source geometry
   * @param {THREE.Vector3} axis - Rotation axis (passes through origin)
   * @param {number} count - Number of instances (including original)
   * @param {number} angle - Total angle in radians (default: 2π)
   * @returns {THREE.BufferGeometry}
   */
  circularPattern(geometry: THREE.BufferGeometry, axis: THREE.Vector3, count: number, angle = Math.PI * 2): THREE.BufferGeometry {
    const normalizedAxis = safeNormalize(axis, new THREE.Vector3(0, 1, 0));
    // A full circle spaces instances by angle/count; a partial arc puts the
    // first instance at 0 and the last at `angle`.
    const isFullCircle = Math.abs(angle) >= Math.PI * 2 - 1e-9;
    const angleStep = isFullCircle ? angle / Math.max(1, count) : angle / Math.max(1, count - 1);
    let result = geometry.clone();
    for (let i = 1; i < count; i++) {
      const instance = geometry.clone();
      instance.applyMatrix4(new THREE.Matrix4().makeRotationAxis(normalizedAxis, angleStep * i));
      result = this.booleanUnion(result, instance) ?? result;
      instance.dispose();
    }
    return result;
  }

  /**
   * Mirror geometry across a plane.
   * @param {THREE.BufferGeometry} geometry - Source geometry
   * @param {string|THREE.Plane} plane - Mirror plane ('XY', 'XZ', 'YZ' or THREE.Plane)
   * @returns {THREE.BufferGeometry}
   */
  mirrorGeometry(geometry: THREE.BufferGeometry, plane: string | THREE.Plane): THREE.BufferGeometry {
    const mirrorMatrix = new THREE.Matrix4();

    if (typeof plane === 'string') {
      // Sketch-plane names map to the coordinate planes (Front = XY, Top = XZ, Right = YZ)
      switch (plane) {
        case 'XZ':
        case 'Top':
          mirrorMatrix.makeScale(1, -1, 1);
          break;
        case 'XY':
        case 'Front':
          mirrorMatrix.makeScale(1, 1, -1);
          break;
        case 'YZ':
        case 'Right':
        default:
          mirrorMatrix.makeScale(-1, 1, 1);
      }
    } else {
      const n = plane.normal;
      mirrorMatrix.set(
        1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, -2 * n.x * plane.constant,
        -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, -2 * n.y * plane.constant,
        -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, -2 * n.z * plane.constant,
        0, 0, 0, 1
      );
    }

    const mirrored = geometry.clone();
    mirrored.applyMatrix4(mirrorMatrix);

    const indexAttr = mirrored.index;
    if (indexAttr) {
      const indices = Array.from(indexAttr.array);
      for (let i = 0; i < indices.length; i += 3) {
        const temp = indices[i + 1];
        indices[i + 1] = indices[i + 2];
        indices[i + 2] = temp;
      }
      mirrored.setIndex(indices);
    } else {
      const posAttr = mirrored.getAttribute('position');
      for (let i = 0; i < posAttr.count; i += 3) {
        const x1 = posAttr.getX(i + 1), y1 = posAttr.getY(i + 1), z1 = posAttr.getZ(i + 1);
        const x2 = posAttr.getX(i + 2), y2 = posAttr.getY(i + 2), z2 = posAttr.getZ(i + 2);
        posAttr.setXYZ(i + 1, x2, y2, z2);
        posAttr.setXYZ(i + 2, x1, y1, z1);
      }
    }

    mirrored.computeVertexNormals();

    // Union so a body touching or crossing the mirror plane is not doubled
    const result = this.booleanUnion(geometry, mirrored) ?? geometry.clone();
    mirrored.dispose();
    return result;
  }

  // ==========================================================================
  // Boolean (CSG) Operations
  // ==========================================================================

  /**
   * Boolean union: A ∪ B
   * @param {THREE.BufferGeometry} geomA
   * @param {THREE.BufferGeometry} geomB
   * @returns {THREE.BufferGeometry}
   */
  booleanUnion(geomA: THREE.BufferGeometry | null, geomB: THREE.BufferGeometry | null): THREE.BufferGeometry | null {
    if (!geomA) return geomB ? geomB.clone() : null;
    if (!geomB) return geomA ? geomA.clone() : null;

    geomA.computeBoundingBox();
    geomB.computeBoundingBox();
    if (geomA.boundingBox && geomB.boundingBox && !geomA.boundingBox.intersectsBox(geomB.boundingBox)) {
      return this._mergeGeometries([geomA, geomB]);
    }

    return csgUnion(geomA, geomB);
  }

  /**
   * Boolean subtraction: A - B
   * @param {THREE.BufferGeometry} geomA
   * @param {THREE.BufferGeometry} geomB
   * @returns {THREE.BufferGeometry}
   */
  booleanSubtract(geomA: THREE.BufferGeometry | null, geomB: THREE.BufferGeometry | null): THREE.BufferGeometry | null {
    if (!geomA) return null;
    if (!geomB) return geomA.clone();

    geomA.computeBoundingBox();
    geomB.computeBoundingBox();
    if (geomA.boundingBox && geomB.boundingBox && !geomA.boundingBox.intersectsBox(geomB.boundingBox)) {
      return geomA.clone();
    }

    return csgSubtract(geomA, geomB);
  }

  /**
   * Boolean intersection: A ∩ B
   * @param {THREE.BufferGeometry} geomA
   * @param {THREE.BufferGeometry} geomB
   * @returns {THREE.BufferGeometry}
   */
  booleanIntersect(geomA: THREE.BufferGeometry | null, geomB: THREE.BufferGeometry | null): THREE.BufferGeometry {
    if (!geomA || !geomB) return new THREE.BufferGeometry();

    geomA.computeBoundingBox();
    geomB.computeBoundingBox();
    if (geomA.boundingBox && geomB.boundingBox && !geomA.boundingBox.intersectsBox(geomB.boundingBox)) {
      return new THREE.BufferGeometry();
    }

    return csgIntersect(geomA, geomB);
  }

  // ==========================================================================
  // Mass Properties
  // ==========================================================================

  /**
   * Compute mass properties of a closed triangle mesh.
   *
   * Exact for the mesh: each triangle forms a tetrahedron with the origin and
   * the signed tetrahedron integrals are summed (divergence theorem), so the
   * result is independent of winding direction.
   *
   * Units: model lengths are millimetres and density is kg/m³.
   * @param {THREE.BufferGeometry} geometry
   * @param {Object} material - { density } in kg/m³
   * @returns {{
   *   volume: number,            // mm³
   *   surfaceArea: number,       // mm²
   *   mass: number,              // kg
   *   density: number,           // kg/m³
   *   centerOfMass: {x,y,z},     // mm
   *   momentOfInertia: {Ixx,Iyy,Izz,Ixy,Ixz,Iyz},          // kg·mm², about the center of mass
   *   momentOfInertiaAtOrigin: {Ixx,Iyy,Izz,Ixy,Ixz,Iyz},  // kg·mm², about the model origin
   *   boundingBox: {min,max,size},                          // mm
   *   units: {length, mass, density, inertia}
   * }}
   * Products of inertia are reported as Ixy = ∫ x·y dm (the tensor off-diagonal is −Ixy).
   */
  computeMassProperties(geometry: THREE.BufferGeometry | null, material: { density?: number } = { density: 7900 }): MassProperties | null {
    if (!geometry) return null;
    const posAttr = geometry.getAttribute('position');
    const indexAttr = geometry.index;
    if (!posAttr) return null;

    let signedVolume = 0;
    let surfaceArea = 0;
    // First moments ∫x dV, ∫y dV, ∫z dV
    let mx = 0, my = 0, mz = 0;
    // Second moments ∫xx, ∫yy, ∫zz, ∫xy, ∫xz, ∫yz dV
    let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const cross = new THREE.Vector3();

    const processTriangle = (i0: number, i1: number, i2: number) => {
      a.fromBufferAttribute(posAttr, i0);
      b.fromBufferAttribute(posAttr, i1);
      c.fromBufferAttribute(posAttr, i2);

      surfaceArea += cross.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).length() / 2;

      // det = a · (b × c) = 6 × signed volume of tetrahedron (origin, a, b, c)
      const det = a.dot(cross.crossVectors(b, c));
      if (!Number.isFinite(det) || det === 0) return;
      signedVolume += det / 6;

      const sx = a.x + b.x + c.x;
      const sy = a.y + b.y + c.y;
      const sz = a.z + b.z + c.z;
      // ∫ x dV over the tetrahedron = det/24 · (a + b + c)
      mx += det * sx / 24;
      my += det * sy / 24;
      mz += det * sz / 24;
      // ∫ xi xj dV = det/120 · (Σk vk_i vk_j + s_i s_j)
      const k = det / 120;
      cxx += k * (a.x * a.x + b.x * b.x + c.x * c.x + sx * sx);
      cyy += k * (a.y * a.y + b.y * b.y + c.y * c.y + sy * sy);
      czz += k * (a.z * a.z + b.z * b.z + c.z * c.z + sz * sz);
      cxy += k * (a.x * a.y + b.x * b.y + c.x * c.y + sx * sy);
      cxz += k * (a.x * a.z + b.x * b.z + c.x * c.z + sx * sz);
      cyz += k * (a.y * a.z + b.y * b.z + c.y * c.z + sy * sz);
    };

    if (indexAttr) {
      for (let i = 0; i + 2 < indexAttr.count; i += 3) {
        processTriangle(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
      }
    } else {
      for (let i = 0; i + 2 < posAttr.count; i += 3) {
        processTriangle(i, i + 1, i + 2);
      }
    }

    // Inward-facing winding gives negative signed integrals; flip everything consistently
    const sign = signedVolume < 0 ? -1 : 1;
    const finite = (v: number) => (Number.isFinite(v) ? v : 0);
    const volume = finite(Math.abs(signedVolume));
    surfaceArea = finite(surfaceArea);

    const centerOfMass = volume > EPSILON
      ? { x: finite(sign * mx / volume), y: finite(sign * my / volume), z: finite(sign * mz / volume) }
      : { x: 0, y: 0, z: 0 };

    const density = material?.density || 7900; // kg/m³
    const rho = density * 1e-9;                // kg/mm³
    const mass = volume * rho;                 // kg

    const tensor = (xx: number, yy: number, zz: number, xy: number, xz: number, yz: number): InertiaTensor => ({
      Ixx: finite(rho * (yy + zz)),
      Iyy: finite(rho * (xx + zz)),
      Izz: finite(rho * (xx + yy)),
      Ixy: finite(rho * xy),
      Ixz: finite(rho * xz),
      Iyz: finite(rho * yz),
    });
    const [Cxx, Cyy, Czz, Cxy, Cxz, Cyz] = [cxx, cyy, czz, cxy, cxz, cyz].map(v => sign * v);
    const momentOfInertiaAtOrigin = tensor(Cxx, Cyy, Czz, Cxy, Cxz, Cyz);
    // Parallel-axis shift to the center of mass
    const { x: gx, y: gy, z: gz } = centerOfMass;
    const momentOfInertia = tensor(
      Cxx - volume * gx * gx, Cyy - volume * gy * gy, Czz - volume * gz * gz,
      Cxy - volume * gx * gy, Cxz - volume * gx * gz, Cyz - volume * gy * gz,
    );

    // Bounding box
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox || new THREE.Box3();
    const minX = isFinite(bbox.min.x) ? bbox.min.x : 0;
    const minY = isFinite(bbox.min.y) ? bbox.min.y : 0;
    const minZ = isFinite(bbox.min.z) ? bbox.min.z : 0;
    const maxX = isFinite(bbox.max.x) ? bbox.max.x : 0;
    const maxY = isFinite(bbox.max.y) ? bbox.max.y : 0;
    const maxZ = isFinite(bbox.max.z) ? bbox.max.z : 0;
    const boundingBox = {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
      size: {
        x: maxX - minX,
        y: maxY - minY,
        z: maxZ - minZ,
      },
    };

    return {
      volume,
      surfaceArea,
      mass,
      density,
      centerOfMass,
      momentOfInertia,
      momentOfInertiaAtOrigin,
      boundingBox,
      units: { length: 'mm', mass: 'kg', density: 'kg/m^3', inertia: 'kg*mm^2' },
    };
  }

  // ==========================================================================
  // Sketch to Shape Conversion
  // ==========================================================================

  /**
   * Convert sketch entities (lines, arcs, circles) into a Three.js Shape
   * suitable for extrusion or other profile-based operations.
   * @param {Object[]} entities - Array of sketch entity objects
   * @returns {THREE.Shape}
   */
  /**
   * Expand open line segments into a closed thin-wall profile shape
   */
  createThinProfileShape(entities: ProfileEntity[], wallThickness = 2.0): THREE.Shape {
    const nonConstruction = entities.filter(e => !e.construction);
    if (nonConstruction.length === 0) return new THREE.Shape();

    const half = Math.max(0.1, wallThickness / 2);
    const shape = new THREE.Shape();

    const pts: Point2[] = [];
    nonConstruction.forEach(ent => {
      if (ent.p1 && ent.p2) {
        if (pts.length === 0) pts.push(ent.p1);
        pts.push(ent.p2);
      }
    });

    if (pts.length < 2) return new THREE.Shape();

    const leftPts = [];
    const rightPts = [];

    for (let i = 0; i < pts.length; i++) {
      let dx, dy;
      if (i === 0) {
        dx = pts[1].x - pts[0].x;
        dy = pts[1].y - pts[0].y;
      } else if (i === pts.length - 1) {
        dx = pts[i].x - pts[i - 1].x;
        dy = pts[i].y - pts[i - 1].y;
      } else {
        dx = pts[i + 1].x - pts[i - 1].x;
        dy = pts[i + 1].y - pts[i - 1].y;
      }
      const len = Math.hypot(dx, dy) || 1e-6;
      const nx = -dy / len;
      const ny = dx / len;

      leftPts.push({ x: pts[i].x + nx * half, y: pts[i].y + ny * half });
      rightPts.push({ x: pts[i].x - nx * half, y: pts[i].y - ny * half });
    }

    shape.moveTo(leftPts[0].x, leftPts[0].y);
    for (let i = 1; i < leftPts.length; i++) {
      shape.lineTo(leftPts[i].x, leftPts[i].y);
    }
    for (let i = rightPts.length - 1; i >= 0; i--) {
      shape.lineTo(rightPts[i].x, rightPts[i].y);
    }
    shape.closePath();
    return shape;
  }

  /**
   * All solid regions of a sketch as shapes with holes (largest first).
   * Construction geometry is ignored; loops nest by containment.
   */
  shapesFromSketchEntities(entities: ProfileEntity[] | null | undefined, options: ShapeOptions = {}): THREE.Shape[] {
    if (!entities || entities.length === 0) return [];
    if (options.thin) return [this.createThinProfileShape(entities, options.wallThickness || 2.0)];
    return shapesFromLoops(profileLoops(entities));
  }

  /** The largest solid region of a sketch (use shapesFromSketchEntities for all regions). */
  shapeFromSketchEntities(entities: ProfileEntity[] | null | undefined, options: ShapeOptions = {}): THREE.Shape {
    return this.shapesFromSketchEntities(entities, options)[0] ?? new THREE.Shape();
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /** Find closest parameter on a path for twist calculation */
  _findClosestParamOnPath(point: THREE.Vector3, path: THREE.Curve<THREE.Vector3>, steps: number): number {
    let bestT = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pathPoint = path.getPointAt(t);
      const dist = point.distanceTo(pathPoint);
      if (dist < bestDist) {
        bestDist = dist;
        bestT = t;
      }
    }
    return bestT;
  }

  /** Resample a set of 2D points to have exactly 'count' points */
  _resamplePoints(points: THREE.Vector2[], count: number): THREE.Vector2[] {
    const resampled = [];
    const totalLength = this._polylineLength(points);
    if (totalLength < EPSILON) return points;

    const segmentLength = totalLength / (count - 1);
    let accumulated = 0;
    let pointIdx = 0;

    resampled.push(points[0].clone());

    for (let i = 1; i < count - 1; i++) {
      const targetDist = segmentLength * i;
      while (pointIdx < points.length - 1 && accumulated + points[pointIdx].distanceTo(points[pointIdx + 1]) < targetDist) {
        accumulated += points[pointIdx].distanceTo(points[pointIdx + 1]);
        pointIdx++;
      }
      if (pointIdx >= points.length - 1) {
        resampled.push(points[points.length - 1].clone());
        continue;
      }
      const segLen = points[pointIdx].distanceTo(points[pointIdx + 1]);
      const t = segLen > EPSILON ? (targetDist - accumulated) / segLen : 0;
      resampled.push(new THREE.Vector2(
        points[pointIdx].x + (points[pointIdx + 1].x - points[pointIdx].x) * t,
        points[pointIdx].y + (points[pointIdx + 1].y - points[pointIdx].y) * t
      ));
    }

    resampled.push(points[points.length - 1].clone());
    return resampled;
  }

  /** Compute total length of a polyline */
  _polylineLength(points: THREE.Vector2[]): number {
    let len = 0;
    for (let i = 0; i < points.length - 1; i++) {
      len += points[i].distanceTo(points[i + 1]);
    }
    return len;
  }

  /** Merge multiple geometries into one */
  _mergeGeometries(geometries: Array<THREE.BufferGeometry | null>): THREE.BufferGeometry {
    if (geometries.length === 0) return new THREE.BufferGeometry();
    if (geometries.length === 1) return geometries[0]?.clone() ?? new THREE.BufferGeometry();

    const positions: number[] = [];
    const normals: number[] = [];

    for (const geom of geometries) {
      if (!geom) continue;
      // Ensure the geometry is non-indexed or handle both
      const isIndexed = !!geom.index;
      const nonIndexed = isIndexed ? geom.toNonIndexed() : geom;
      nonIndexed.computeVertexNormals();

      const posAttr = nonIndexed.getAttribute('position');
      const normAttr = nonIndexed.getAttribute('normal');

      if (posAttr) {
        for (let i = 0; i < posAttr.count; i++) {
          positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
          if (normAttr) {
            normals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
          }
        }
      }

      if (isIndexed && nonIndexed !== geom && typeof nonIndexed.dispose === 'function') {
        nonIndexed.dispose();
      }
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length > 0) {
      merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    }
    merged.computeVertexNormals();
    merged.computeBoundingBox();
    return merged;
  }

}

// Export singleton instance
export const geometryEngine = new GeometryEngine();
export default GeometryEngine;
