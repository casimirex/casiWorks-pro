// CasiWorks Pro - Core Geometry Engine (triangle-mesh kernel)
// Profile operations (extrude, revolve, sweep, loft), finishing operations,
// patterns, mirror, CSG booleans and mass properties.

import * as THREE from 'three';
import { EPSILON } from '../utils/math.ts';
import { safeNormalize } from './Topology.js';
import { csgUnion, csgSubtract, csgIntersect } from './csg.ts';
import type { InertiaTensor, MassProperties, Point2 } from '../types/cad.ts';

/**
 * Sketch entity as read by the profile builder. Besides the canonical fields it
 * accepts legacy aliases (start/end, x1..y2, cx/cy/r, corner1/corner2, rx/ry).
 */
export interface ProfileEntity {
  id?: string;
  type: string;
  construction?: boolean;
  p1?: Point2;
  p2?: Point2;
  start?: Point2;
  end?: Point2;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  center?: Point2;
  cx?: number;
  cy?: number;
  radius?: number;
  r?: number;
  /** Radians. */
  startAngle?: number;
  /** Radians. */
  endAngle?: number;
  corner1?: Point2;
  corner2?: Point2;
  controlPoints?: Point2[];
  radiusX?: number;
  radiusY?: number;
  rx?: number;
  ry?: number;
}

export type PlaneName = 'Front' | 'Top' | 'Right' | 'XY' | 'XZ' | 'YZ';

export interface ExtrudeOptions {
  symmetric?: boolean;
  endCondition?: 'blind' | 'through' | 'upTo' | 'midplane';
  draft?: boolean;
  /** Degrees. */
  draftAngle?: number;
  steps?: number;
  bevelEnabled?: boolean;
  bevelThickness?: number;
  bevelSize?: number;
  bevelSegments?: number;
  flip?: boolean;
  plane?: PlaneName;
}

export interface RevolveOptions { segments?: number; offset?: number }
export interface SweepOptions { steps?: number; closed?: boolean; twist?: number }
export interface LoftOptions { steps?: number; closed?: boolean; heights?: number[] | null }
export interface HoleOptions { cbDiameter?: number; cbDepth?: number; csAngle?: number; segments?: number }
export interface ShapeOptions { thin?: boolean; wallThickness?: number }
export type HoleType = 'through' | 'blind' | 'counterbore' | 'countersink' | 'simple';

type Edge = [number, number];
type Triangle = [number, number, number];

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
  extrudeProfile(shape: THREE.Shape, depth: number, direction: PlaneName | THREE.Vector3 | null = null, options: ExtrudeOptions = {}): THREE.BufferGeometry {
    const {
      symmetric = false,
      endCondition = 'blind', // 'blind', 'through', 'upTo', 'midplane'
      draft = false,
      draftAngle = 0,
      steps = 1,
      bevelEnabled = false,
      bevelThickness = 0,
      bevelSize = 0,
      bevelSegments = 1,
      flip = false,
      plane = 'Front',
    } = options;

    const isMidplane = symmetric || endCondition === 'midplane';
    let actualDepth = depth;
    if (endCondition === 'through') {
      actualDepth = 500;
    }

    const extrudeSettings = {
      steps: steps,
      depth: actualDepth,
      bevelEnabled: bevelEnabled || draft,
      bevelThickness: draft ? Math.tan(draftAngle * Math.PI / 180) * actualDepth : bevelThickness,
      bevelSize: draft ? Math.tan(draftAngle * Math.PI / 180) * actualDepth : bevelSize,
      bevelSegments: bevelSegments,
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);

    // Symmetric / Mid-plane: center around sketch plane
    if (isMidplane) {
      geometry.translate(0, 0, -actualDepth / 2);
    }

    // Direction flip
    if (flip) {
      geometry.translate(0, 0, isMidplane ? 0 : -actualDepth);
      const pos = geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, -pos.getZ(i));
      }
      geometry.computeVertexNormals();
    }

    // Transform by sketch plane orientation if specified
    const planeName = typeof direction === 'string' ? direction : plane;
    if (planeName) {
      if (planeName === 'Top' || planeName === 'XZ') {
        geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      } else if (planeName === 'Right' || planeName === 'YZ') {
        geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
      }
    } else if (direction instanceof THREE.Vector3) {
      const defaultDir = new THREE.Vector3(0, 0, 1);
      const dir = direction.clone().normalize();
      if (dir.distanceTo(defaultDir) > EPSILON) {
        const quaternion = new THREE.Quaternion().setFromUnitVectors(defaultDir, dir);
        geometry.applyQuaternion(quaternion);
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
  revolveProfile(shape: THREE.Shape, axis: THREE.Vector3 | null = null, angle = Math.PI * 2, options: RevolveOptions = {}): THREE.BufferGeometry {
    const {
      segments = 64,
      offset = 0,
    } = options;

    // Extract points from the shape for LatheGeometry
    const points = shape.getPoints(50);

    // Offset points from axis if needed
    const lathePoints = points.map(p =>
      new THREE.Vector2(Math.abs(p.x) + offset, p.y)
    );

    // LatheGeometry revolves around the Y-axis
    const geometry = new THREE.LatheGeometry(lathePoints, segments, 0, angle);

    // Rotate to align with the specified axis if not Y
    if (axis) {
      const defaultAxis = new THREE.Vector3(0, 1, 0);
      const targetAxis = axis.clone().normalize();
      if (targetAxis.distanceTo(defaultAxis) > EPSILON) {
        const quaternion = new THREE.Quaternion().setFromUnitVectors(defaultAxis, targetAxis);
        geometry.applyQuaternion(quaternion);
      }
    }

    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
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
   * Create geometry by interpolating between multiple cross-section shapes.
   * @param {THREE.Shape[]} shapes - Array of cross-section profiles
   * @param {Object} options - { steps, closed }
   * @returns {THREE.BufferGeometry}
   */
  loftProfiles(shapes: THREE.Shape[], options: LoftOptions = {}): THREE.BufferGeometry {
    const {
      steps = 32,
      closed = false,
      heights = null, // Array of Z-heights for each cross-section
    } = options;

    if (shapes.length < 2) {
      throw new Error('Loft requires at least 2 cross-section shapes');
    }

    // Extract points from each shape
    const pointsPerShape = 64;
    const profiles = shapes.map(s => s.getPoints(pointsPerShape));

    // Ensure all profiles have the same number of points by resampling
    const maxPoints = Math.max(...profiles.map(p => p.length));
    const normalizedProfiles = profiles.map(profile => {
      if (profile.length === maxPoints) return profile;
      return this._resamplePoints(profile, maxPoints);
    });

    // Compute heights for each profile if not provided
    const zHeights = heights || normalizedProfiles.map((_, i) =>
      i / (normalizedProfiles.length - 1) * 100
    );

    // Build geometry by interpolating between profiles
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices = [];

    const numProfiles = normalizedProfiles.length;
    const totalSteps = (numProfiles - 1) * steps;

    // Generate interpolated profiles at each step
    const interpolatedProfiles = [];
    for (let s = 0; s <= totalSteps; s++) {
      const t = s / totalSteps;
      const globalT = t * (numProfiles - 1);
      const profileIdx = Math.min(Math.floor(globalT), numProfiles - 2);
      const localT = globalT - profileIdx;

      const profile = normalizedProfiles[profileIdx].map((p, i) => {
        const nextP = normalizedProfiles[profileIdx + 1][i];
        const x = p.x + (nextP.x - p.x) * localT;
        const y = p.y + (nextP.y - p.y) * localT;
        const z = zHeights[profileIdx] + (zHeights[profileIdx + 1] - zHeights[profileIdx]) * localT;
        return new THREE.Vector3(x, y, z);
      });
      interpolatedProfiles.push(profile);
    }

    // Build mesh from interpolated profiles
    const numPoints = maxPoints;
    for (let s = 0; s < interpolatedProfiles.length; s++) {
      for (let p = 0; p < numPoints; p++) {
        const v = interpolatedProfiles[s][p];
        positions.push(v.x, v.y, v.z);

        // Compute normal (approximate)
        const u0 = s / interpolatedProfiles.length;
        const v0 = p / numPoints;
        uvs.push(u0, v0);
      }
    }

    // Compute normals and build faces
    for (let s = 0; s < interpolatedProfiles.length - 1; s++) {
      for (let p = 0; p < numPoints - 1; p++) {
        const a = s * numPoints + p;
        const b = s * numPoints + (p + 1);
        const c = (s + 1) * numPoints + (p + 1);
        const d = (s + 1) * numPoints + p;

        indices.push(a, b, d);
        indices.push(b, c, d);
      }
      // Close the loop if the profile is closed
      if (closed) {
        const a = s * numPoints + (numPoints - 1);
        const b = s * numPoints;
        const c = (s + 1) * numPoints;
        const d = (s + 1) * numPoints + (numPoints - 1);

        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return geometry;
  }

  // ==========================================================================
  // Modification Operations
  // ==========================================================================

  /**
   * Apply fillet (rounding) to specified edges of a geometry.
   * Identifies edge vertices and inserts smoothed arc segments.
   * @param {THREE.BufferGeometry} geometry - Input geometry
   * @param {number[]} edgeIndices - Indices of edges to fillet
   * @param {number} radius - Fillet radius
   * @returns {THREE.BufferGeometry}
   */
  applyFillet(geometry: THREE.BufferGeometry | null, edgeIndices: number[], radius: number): THREE.BufferGeometry {
    if (!geometry) return new THREE.BufferGeometry();
    if (typeof radius !== 'number' || isNaN(radius) || radius <= 0) return geometry.clone();

    // Extract edge information from the geometry
    const edges = this._extractEdges(geometry);
    const posAttr = geometry.getAttribute('position');
    if (!posAttr || posAttr.count === 0) return geometry.clone();

    const vertices = [];
    for (let i = 0; i < posAttr.count; i++) {
      vertices.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
    }

    const filletSegments = 8;
    const indexAttr = geometry.index;
    const triangles: Triangle[] = [];
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i += 3) {
        triangles.push([indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2)]);
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 3) {
        triangles.push([i, i + 1, i + 2]);
      }
    }

    // Build adjacency: for each edge, find the two adjacent face normals
    const edgeMap = new Map<string, number[]>();
    for (let triIdx = 0; triIdx < triangles.length; triIdx++) {
      const tri = triangles[triIdx];
      for (let j = 0; j < 3; j++) {
        const a = tri[j];
        const b = tri[(j + 1) % 3];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        const adjacent = edgeMap.get(key);
        if (adjacent) adjacent.push(triIdx);
        else edgeMap.set(key, [triIdx]);
      }
    }

    // For targeted edges, create fillet geometry
    const targetEdges = (edgeIndices && edgeIndices.length > 0)
      ? edgeIndices.map(i => edges[Math.min(i, edges.length - 1)])
      : edges;

    // Collect fillet surfaces for each sharp edge
    const filletGeometries = [];
    for (const edge of targetEdges) {
      if (!edge) continue;
      const key = Math.min(edge[0], edge[1]) + '_' + Math.max(edge[0], edge[1]);
      const adjacentTris = edgeMap.get(key);
      if (!adjacentTris || adjacentTris.length !== 2) continue;

      // Get normals of the two adjacent faces
      const n1 = this._computeTriangleNormal(triangles[adjacentTris[0]], vertices);
      const n2 = this._computeTriangleNormal(triangles[adjacentTris[1]], vertices);

      // Compute the dihedral angle
      const dotProduct = Math.max(-1, Math.min(1, n1.dot(n2)));
      if (dotProduct > 0.95 || dotProduct < -0.95) continue; // Nearly flat or opposite, skip

      // Edge direction
      const edgeStart = vertices[edge[0]].clone();
      const edgeEnd = vertices[edge[1]].clone();
      const edgeLength = edgeStart.distanceTo(edgeEnd);
      if (edgeLength < 1e-4) continue;

      // Ensure radius does not exceed adjacent edge lengths
      const maxSafeRadius = edgeLength * 0.45;
      const safeRadius = Math.min(radius, maxSafeRadius);
      if (safeRadius < 1e-4) continue;

      // Create fillet arc perpendicular to the edge
      const arcPoints = this._computeFilletArc(edgeStart, edgeEnd, n1, n2, safeRadius, filletSegments);

      // Build a tube-like fillet strip along the edge
      if (arcPoints.length > 0) {
        const filletGeom = this._buildFilletStrip(edgeStart, edgeEnd, arcPoints, filletSegments);
        if (filletGeom) filletGeometries.push(filletGeom);
      }
    }

    // Merge fillet geometry with the original
    if (filletGeometries.length === 0) return geometry.clone();

    const mergedGeometries = [geometry, ...filletGeometries];
    const result = this._mergeGeometries(mergedGeometries);
    for (const fg of filletGeometries) {
      fg.dispose();
    }
    return result;
  }

  /**
   * Apply chamfer (flat bevel) to specified edges.
   * @param {THREE.BufferGeometry} geometry - Input geometry
   * @param {number[]} edgeIndices - Indices of edges to chamfer
   * @param {number} distance - Chamfer distance
   * @returns {THREE.BufferGeometry}
   */
  applyChamfer(geometry: THREE.BufferGeometry | null, edgeIndices: number[], distance: number): THREE.BufferGeometry {
    if (!geometry) return new THREE.BufferGeometry();
    if (typeof distance !== 'number' || isNaN(distance) || distance <= 0) return geometry.clone();

    const edges = this._extractEdges(geometry);
    const posAttr = geometry.getAttribute('position');
    if (!posAttr || posAttr.count === 0) return geometry.clone();

    const vertices = [];
    for (let i = 0; i < posAttr.count; i++) {
      vertices.push(new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
    }

    const indexAttr = geometry.index;
    const triangles: Triangle[] = [];
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i += 3) {
        triangles.push([indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2)]);
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 3) {
        triangles.push([i, i + 1, i + 2]);
      }
    }

    // Build edge adjacency
    const edgeMap = new Map<string, number[]>();
    for (let triIdx = 0; triIdx < triangles.length; triIdx++) {
      const tri = triangles[triIdx];
      for (let j = 0; j < 3; j++) {
        const a = tri[j];
        const b = tri[(j + 1) % 3];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        const adjacent = edgeMap.get(key);
        if (adjacent) adjacent.push(triIdx);
        else edgeMap.set(key, [triIdx]);
      }
    }

    const targetEdges = (edgeIndices && edgeIndices.length > 0)
      ? edgeIndices.map(i => edges[Math.min(i, edges.length - 1)])
      : edges;

    const chamferGeometries = [];
    for (const edge of targetEdges) {
      if (!edge) continue;
      const key = Math.min(edge[0], edge[1]) + '_' + Math.max(edge[0], edge[1]);
      const adjacentTris = edgeMap.get(key);
      if (!adjacentTris || adjacentTris.length !== 2) continue;

      const n1 = this._computeTriangleNormal(triangles[adjacentTris[0]], vertices);
      const n2 = this._computeTriangleNormal(triangles[adjacentTris[1]], vertices);

      const dot = Math.max(-1, Math.min(1, n1.dot(n2)));
      if (dot > 0.95 || dot < -0.95) continue;

      const edgeStart = vertices[edge[0]].clone();
      const edgeEnd = vertices[edge[1]].clone();
      const edgeLength = edgeStart.distanceTo(edgeEnd);
      if (edgeLength < 1e-4) continue;

      const maxSafeDist = edgeLength * 0.45;
      const safeDistance = Math.min(distance, maxSafeDist);
      if (safeDistance < 1e-4) continue;

      // Create chamfer (single flat face between the two beveled positions)
      const chamferGeom = this._buildChamferStrip(edgeStart, edgeEnd, n1, n2, safeDistance);
      if (chamferGeom) chamferGeometries.push(chamferGeom);
    }

    if (chamferGeometries.length === 0) return geometry.clone();
    const result = this._mergeGeometries([geometry, ...chamferGeometries]);
    for (const cg of chamferGeometries) {
      cg.dispose();
    }
    return result;
  }

  /**
   * Create a shell by offsetting all faces inward, hollowing the solid.
   * @param {THREE.BufferGeometry} geometry - Input solid geometry
   * @param {number} thickness - Shell wall thickness
   * @param {number[]} excludeFaces - Face indices to leave open
   * @returns {THREE.BufferGeometry}
   */
  applyShell(geometry: THREE.BufferGeometry | null, thickness: number, excludeFaces: number[] = []): THREE.BufferGeometry {
    if (!geometry) return new THREE.BufferGeometry();
    if (typeof thickness !== 'number' || isNaN(thickness) || thickness <= 0) return geometry.clone();

    // Guard against self-intersecting inner offset walls by clamping against solid dimensions
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox || new THREE.Box3();
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const minDim = Math.min(size.x, size.y, size.z);
    const maxSafeThickness = minDim > 0 ? minDim * 0.45 : 10;
    const safeThickness = Math.min(thickness, maxSafeThickness);
    if (safeThickness < 1e-4) return geometry.clone();

    geometry.computeVertexNormals();

    const posAttr = geometry.getAttribute('position');
    const normAttr = geometry.getAttribute('normal');
    const indexAttr = geometry.index;

    const vertexCount = posAttr.count;

    // Build outer shell (original geometry)
    const outerPositions = [];
    const outerNormals = [];
    for (let i = 0; i < vertexCount; i++) {
      outerPositions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      outerNormals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
    }

    // Build inner shell (offset inward along vertex normals)
    const innerPositions = [];
    const innerNormals = [];
    for (let i = 0; i < vertexCount; i++) {
      const nx = normAttr.getX(i);
      const ny = normAttr.getY(i);
      const nz = normAttr.getZ(i);
      innerPositions.push(
        posAttr.getX(i) - nx * safeThickness,
        posAttr.getY(i) - ny * safeThickness,
        posAttr.getZ(i) - nz * safeThickness
      );
      // Flip normals for inner shell
      innerNormals.push(-nx, -ny, -nz);
    }

    // Combine positions and normals
    const allPositions = [...outerPositions, ...innerPositions];
    const allNormals = [...outerNormals, ...innerNormals];

    // Build indices
    const allIndices = [];
    const excludeSet = new Set(excludeFaces);

    if (indexAttr) {
      // Outer faces (original winding)
      for (let i = 0; i < indexAttr.count; i += 3) {
        const faceIdx = Math.floor(i / 3);
        if (excludeSet.has(faceIdx)) continue;
        allIndices.push(indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2));
      }

      // Inner faces (reversed winding, offset by vertexCount)
      for (let i = 0; i < indexAttr.count; i += 3) {
        const faceIdx = Math.floor(i / 3);
        if (excludeSet.has(faceIdx)) continue;
        allIndices.push(
          indexAttr.getX(i + 2) + vertexCount,
          indexAttr.getX(i + 1) + vertexCount,
          indexAttr.getX(i) + vertexCount
        );
      }

      // Build edge connectivity for exposed edges (excluded faces)
      if (excludeSet.size > 0) {
        // Connect outer and inner shells at excluded face boundaries
        const boundaryEdges = this._findBoundaryEdges(indexAttr, excludeSet);
        for (const [a, b] of boundaryEdges) {
          const ai = a + vertexCount;
          const bi = b + vertexCount;
          allIndices.push(a, b, bi);
          allIndices.push(a, bi, ai);
        }
      }
    } else {
      // Non-indexed geometry
      for (let i = 0; i < vertexCount; i += 3) {
        const faceIdx = Math.floor(i / 3);
        if (excludeSet.has(faceIdx)) continue;
        allIndices.push(i, i + 1, i + 2);
      }
      for (let i = 0; i < vertexCount; i += 3) {
        const faceIdx = Math.floor(i / 3);
        if (excludeSet.has(faceIdx)) continue;
        allIndices.push(i + 2 + vertexCount, i + 1 + vertexCount, i + vertexCount);
      }
    }

    const shellGeom = new THREE.BufferGeometry();
    shellGeom.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3));
    shellGeom.setAttribute('normal', new THREE.Float32BufferAttribute(allNormals, 3));
    shellGeom.setIndex(allIndices);
    shellGeom.computeVertexNormals();
    shellGeom.computeBoundingBox();
    return shellGeom;
  }

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
      segments = 32,
    } = options;

    const radius = diameter / 2;
    const dir = safeNormalize(direction, new THREE.Vector3(0, 0, 1));

    // Create the hole cylinder tool
    let holeGeometry;

    switch (holeType) {
      case 'through': {
        holeGeometry = new THREE.CylinderGeometry(radius, radius, 1000, segments);
        break;
      }
      case 'blind': {
        const cylinderGeom = new THREE.CylinderGeometry(radius, radius, depth, segments);
        const tipHeight = radius * Math.tan((Math.PI - (118 * Math.PI / 180)) / 2);
        const coneGeom = new THREE.ConeGeometry(radius, tipHeight, segments);
        coneGeom.translate(0, -(depth / 2 + tipHeight / 2), 0);

        holeGeometry = this._mergeGeometries([cylinderGeom, coneGeom]);
        cylinderGeom.dispose();
        coneGeom.dispose();
        break;
      }
      case 'counterbore': {
        const mainCylinder = new THREE.CylinderGeometry(radius, radius, depth || 1000, segments);
        const cbRadius = cbDiameter / 2;
        const cbCylinder = new THREE.CylinderGeometry(cbRadius, cbRadius, cbDepth, segments);
        cbCylinder.translate(0, (depth || 500) / 2 - cbDepth / 2, 0);

        holeGeometry = this._mergeGeometries([mainCylinder, cbCylinder]);
        mainCylinder.dispose();
        cbCylinder.dispose();
        break;
      }
      case 'countersink': {
        const mainCyl = new THREE.CylinderGeometry(radius, radius, depth || 1000, segments);
        const csAngleRad = csAngle * Math.PI / 180;
        const csRadius = radius * 1.6;
        const csHeight = (csRadius - radius) / Math.tan(csAngleRad / 2);
        const csCone = new THREE.CylinderGeometry(radius, csRadius, csHeight, segments);
        csCone.translate(0, (depth || 500) / 2 - csHeight / 2, 0);

        holeGeometry = this._mergeGeometries([mainCyl, csCone]);
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
    const geometries = [geometry];
    const clonesToDispose = [];

    for (let i = 1; i < count; i++) {
      const clone = geometry.clone();
      const offset = dir.clone().multiplyScalar(spacing * i);
      clone.translate(offset.x, offset.y, offset.z);
      geometries.push(clone);
      clonesToDispose.push(clone);
    }

    const result = this._mergeGeometries(geometries);
    for (const c of clonesToDispose) {
      c.dispose();
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
    const geometries = [geometry];
    const clonesToDispose = [];
    const angleStep = angle / Math.max(1, count);

    for (let i = 1; i < count; i++) {
      const clone = geometry.clone();
      const rotationMatrix = new THREE.Matrix4().makeRotationAxis(normalizedAxis, angleStep * i);
      clone.applyMatrix4(rotationMatrix);
      geometries.push(clone);
      clonesToDispose.push(clone);
    }

    const result = this._mergeGeometries(geometries);
    for (const c of clonesToDispose) {
      c.dispose();
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
      switch (plane) {
        case 'YZ':
          mirrorMatrix.makeScale(-1, 1, 1);
          break;
        case 'XZ':
          mirrorMatrix.makeScale(1, -1, 1);
          break;
        case 'XY':
          mirrorMatrix.makeScale(1, 1, -1);
          break;
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

    const result = this._mergeGeometries([geometry, mirrored]);
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

  shapeFromSketchEntities(entities: ProfileEntity[] | null | undefined, options: ShapeOptions = {}): THREE.Shape {
    if (!entities || entities.length === 0) return new THREE.Shape();

    // Check if Thin Feature is requested
    if (options.thin) {
      return this.createThinProfileShape(entities, options.wallThickness || 2.0);
    }

    // Separate circles from other entities
    const circles = entities.filter(e => e.type === 'circle');
    const otherEntities = entities.filter(e => e.type !== 'circle');

    // If only a single circle, return a circle shape
    if (circles.length > 0 && otherEntities.length === 0) {
      const c = circles[0];
      const shape = new THREE.Shape();
      const cx = c.center?.x || c.cx || 0;
      const cy = c.center?.y || c.cy || 0;
      const r = c.radius || c.r || 10;
      shape.absarc(cx, cy, r, 0, Math.PI * 2, false);
      return shape;
    }

    // For other entities, build ordered chains of points
    const chains = this._buildEntityChains(otherEntities);

    if (chains.length === 0) {
      // Fallback: extract all points and create a shape
      const points = this._extractPointsFromEntities(entities);
      if (points.length < 3) return new THREE.Shape();
      const shape = new THREE.Shape();
      shape.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        shape.lineTo(points[i].x, points[i].y);
      }
      shape.closePath();

      // Add circle holes
      for (const c of circles) {
        const hole = new THREE.Path();
        const cx = c.center?.x || c.cx || 0;
        const cy = c.center?.y || c.cy || 0;
        const r = c.radius || c.r || 10;
        hole.absarc(cx, cy, r, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
      return shape;
    }

    // Build shape from the first (outer) chain
    const shape = this._chainToShape(chains[0], entities);

    // Additional chains become holes
    for (let i = 1; i < chains.length; i++) {
      const holePath = this._chainToPath(chains[i], entities);
      if (holePath) shape.holes.push(holePath);
    }

    // Add standalone circles as holes
    for (const c of circles) {
      const hole = new THREE.Path();
      const cx = c.center?.x || c.cx || 0;
      const cy = c.center?.y || c.cy || 0;
      const r = c.radius || c.r || 10;
      hole.absarc(cx, cy, r, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }

    return shape;
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

  /** Extract edges from geometry as pairs of vertex indices */
  _extractEdges(geometry: THREE.BufferGeometry): Edge[] {
    const edges: Edge[] = [];
    const edgeSet = new Set();
    const indexAttr = geometry.index;
    const posAttr = geometry.getAttribute('position');

    const addEdge = (a: number, b: number) => {
      const key = Math.min(a, b) + '_' + Math.max(a, b);
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([a, b]);
      }
    };

    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i += 3) {
        const a = indexAttr.getX(i);
        const b = indexAttr.getX(i + 1);
        const c = indexAttr.getX(i + 2);
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
      }
    } else {
      for (let i = 0; i < posAttr.count; i += 3) {
        addEdge(i, i + 1);
        addEdge(i + 1, i + 2);
        addEdge(i + 2, i);
      }
    }

    return edges;
  }

  /** Compute normal of a triangle given vertex indices */
  _computeTriangleNormal(tri: Triangle, vertices: THREE.Vector3[]): THREE.Vector3 {
    const a = vertices[tri[0]];
    const b = vertices[tri[1]];
    const c = vertices[tri[2]];
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    return safeNormalize(new THREE.Vector3().crossVectors(ab, ac), new THREE.Vector3(0, 0, 1));
  }

  /** Compute fillet arc points between two face normals */
  _computeFilletArc(edgeStart: THREE.Vector3, edgeEnd: THREE.Vector3, n1: THREE.Vector3, n2: THREE.Vector3, radius: number, segments: number): THREE.Vector3[] {
    const arcPoints = [];
    const edgeDir = safeNormalize(new THREE.Vector3().subVectors(edgeEnd, edgeStart), new THREE.Vector3(0, 0, 1));

    // Bisector between the two normals
    const bisector = safeNormalize(new THREE.Vector3().addVectors(n1, n2), new THREE.Vector3(0, 1, 0));

    // Angle between normals
    const dot = Math.max(-1, Math.min(1, n1.dot(n2)));
    if (dot > 0.999 || dot < -0.999) {
      return [];
    }
    const angle = Math.acos(dot);
    const sinHalf = Math.sin(angle / 2);
    if (sinHalf < 1e-4) {
      return [];
    }

    // Center of the fillet arc (offset from edge along bisector)

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const theta = -angle / 2 + angle * t;

      // Rotate bisector around edge direction by theta
      const rotated = bisector.clone();
      const rotMatrix = new THREE.Matrix4().makeRotationAxis(edgeDir, theta);
      rotated.applyMatrix4(rotMatrix);

      arcPoints.push(rotated.multiplyScalar(radius));
    }

    return arcPoints;
  }

  /** Build a fillet strip geometry along an edge */
  _buildFilletStrip(edgeStart: THREE.Vector3, edgeEnd: THREE.Vector3, arcPoints: THREE.Vector3[], _segments: number): THREE.BufferGeometry | null {
    if (!arcPoints || arcPoints.length === 0) return new THREE.BufferGeometry();
    const positions = [];
    const edgeLength = edgeStart.distanceTo(edgeEnd);

    // Sample points along the edge
    const edgeSteps = Math.max(2, Math.ceil(edgeLength / 5));
    for (let e = 0; e <= edgeSteps; e++) {
      const t = e / edgeSteps;
      const basePoint = new THREE.Vector3().lerpVectors(edgeStart, edgeEnd, t);

      for (const arcOffset of arcPoints) {
        const p = basePoint.clone().add(arcOffset);
        positions.push(p.x, p.y, p.z);
      }
    }

    // Build indices
    const indices = [];
    const arcCount = arcPoints.length;
    for (let e = 0; e < edgeSteps; e++) {
      for (let a = 0; a < arcCount - 1; a++) {
        const i0 = e * arcCount + a;
        const i1 = e * arcCount + a + 1;
        const i2 = (e + 1) * arcCount + a;
        const i3 = (e + 1) * arcCount + a + 1;

        indices.push(i0, i1, i2);
        indices.push(i1, i3, i2);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }

  /** Build a chamfer strip (single flat face) along an edge */
  _buildChamferStrip(edgeStart: THREE.Vector3, edgeEnd: THREE.Vector3, n1: THREE.Vector3, n2: THREE.Vector3, distance: number): THREE.BufferGeometry | null {
    const positions = [];
    const edgeLength = edgeStart.distanceTo(edgeEnd);
    const edgeSteps = Math.max(2, Math.ceil(edgeLength / 5));

    for (let e = 0; e <= edgeSteps; e++) {
      const t = e / edgeSteps;
      const basePoint = new THREE.Vector3().lerpVectors(edgeStart, edgeEnd, t);

      // Two points: offset along n1 and n2 by chamfer distance
      const p1 = basePoint.clone().add(n1.clone().multiplyScalar(distance));
      const p2 = basePoint.clone().add(n2.clone().multiplyScalar(distance));
      positions.push(p1.x, p1.y, p1.z);
      positions.push(p2.x, p2.y, p2.z);
    }

    const indices = [];
    for (let e = 0; e < edgeSteps; e++) {
      const i0 = e * 2;
      const i1 = e * 2 + 1;
      const i2 = (e + 1) * 2;
      const i3 = (e + 1) * 2 + 1;
      indices.push(i0, i1, i2);
      indices.push(i1, i3, i2);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }

  /** Find boundary edges where excluded faces meet non-excluded faces */
  _findBoundaryEdges(indexAttr: THREE.BufferAttribute, excludeSet: Set<number>): Edge[] {
    const edgeCount = new Map<string, { excluded: number; included: number; edge: Edge }>();
    const edges: Edge[] = [];

    for (let i = 0; i < indexAttr.count; i += 3) {
      const faceIdx = Math.floor(i / 3);
      const isExcluded = excludeSet.has(faceIdx);

      for (let j = 0; j < 3; j++) {
        const a = indexAttr.getX(i + j);
        const b = indexAttr.getX(i + (j + 1) % 3);
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        let ec = edgeCount.get(key);
        if (!ec) {
          ec = { excluded: 0, included: 0, edge: [a, b] };
          edgeCount.set(key, ec);
        }
        if (isExcluded) ec.excluded++;
        else ec.included++;
      }
    }

    for (const info of edgeCount.values()) {
      if (info.excluded > 0 && info.included > 0) {
        edges.push(info.edge);
      }
    }

    return edges;
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

  /** Build chains of connected entities for shape creation */
  _buildEntityChains(entities: ProfileEntity[]): ProfileEntity[][] {
    if (entities.length === 0) return [];

    const chains = [];
    const used = new Set();

    // Build adjacency from entity endpoints
    const getEndpoints = (entity: ProfileEntity): Point2[] => {
      switch (entity.type) {
        case 'line':
          return [
            { x: entity.p1?.x ?? entity.start?.x ?? entity.x1 ?? 0, y: entity.p1?.y ?? entity.start?.y ?? entity.y1 ?? 0 },
            { x: entity.p2?.x ?? entity.end?.x ?? entity.x2 ?? 0, y: entity.p2?.y ?? entity.end?.y ?? entity.y2 ?? 0 },
          ];
        case 'arc':
          return [
            this._arcEndpoint(entity, 'start'),
            this._arcEndpoint(entity, 'end'),
          ];
        case 'rect':
          // Rectangle has 4 corners: treat as 4 lines
          return [
            { x: entity.x1 ?? entity.corner1?.x ?? 0, y: entity.y1 ?? entity.corner1?.y ?? 0 },
            { x: entity.x2 ?? entity.corner2?.x ?? 0, y: entity.y2 ?? entity.corner2?.y ?? 0 },
          ];
        case 'spline':
          if (entity.controlPoints && entity.controlPoints.length > 0) {
            return [entity.controlPoints[0], entity.controlPoints[entity.controlPoints.length - 1]];
          }
          return [];
        default:
          return [];
      }
    };

    // Greedily build chains
    const tolerance = 0.01;
    const pointsMatch = (a: Point2, b: Point2) =>
      Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance;

    while (used.size < entities.length) {
      // Find first unused entity
      let startIdx = -1;
      for (let i = 0; i < entities.length; i++) {
        if (!used.has(i) && entities[i].type !== 'point') {
          startIdx = i;
          break;
        }
      }
      if (startIdx === -1) break;

      const chain = [startIdx];
      used.add(startIdx);

      const endpoints = getEndpoints(entities[startIdx]);
      if (endpoints.length < 2) continue;

      let currentEnd = endpoints[1];
      let changed = true;

      // Extend chain forward
      while (changed) {
        changed = false;
        for (let i = 0; i < entities.length; i++) {
          if (used.has(i) || entities[i].type === 'point') continue;
          const eps = getEndpoints(entities[i]);
          if (eps.length < 2) continue;

          if (pointsMatch(currentEnd, eps[0])) {
            chain.push(i);
            used.add(i);
            currentEnd = eps[1];
            changed = true;
            break;
          } else if (pointsMatch(currentEnd, eps[1])) {
            chain.push(i);
            used.add(i);
            currentEnd = eps[0];
            changed = true;
            break;
          }
        }
      }

      chains.push(chain.map(i => entities[i]));
    }

    return chains;
  }

  /** Convert a chain of entities to a THREE.Shape */
  _chainToShape(chain: ProfileEntity[], _allEntities: ProfileEntity[]): THREE.Shape {
    const shape = new THREE.Shape();
    const points = this._extractPointsFromEntities(chain);

    if (points.length < 2) return shape;

    shape.moveTo(points[0].x, points[0].y);

    for (let i = 0; i < chain.length; i++) {
      const entity = chain[i];
      switch (entity.type) {
        case 'line':
          shape.lineTo(
            entity.p2?.x ?? entity.end?.x ?? entity.x2 ?? 0,
            entity.p2?.y ?? entity.end?.y ?? entity.y2 ?? 0
          );
          break;
        case 'arc': {
          const cx = entity.center?.x ?? entity.cx ?? 0;
          const cy = entity.center?.y ?? entity.cy ?? 0;
          const r = entity.radius ?? entity.r ?? 10;
          const startAngle = entity.startAngle ?? 0;
          const endAngle = entity.endAngle ?? Math.PI * 2;
          shape.absarc(cx, cy, r, startAngle, endAngle, false);
          break;
        }
        case 'rect': {
          const x1 = entity.x1 ?? entity.corner1?.x ?? 0;
          const y1 = entity.y1 ?? entity.corner1?.y ?? 0;
          const x2 = entity.x2 ?? entity.corner2?.x ?? 0;
          const y2 = entity.y2 ?? entity.corner2?.y ?? 0;
          shape.lineTo(x2, y1);
          shape.lineTo(x2, y2);
          shape.lineTo(x1, y2);
          shape.lineTo(x1, y1);
          break;
        }
        case 'spline': {
          if (entity.controlPoints && entity.controlPoints.length > 0) {
            const splinePoints = entity.controlPoints.map(p =>
              new THREE.Vector2(p.x, p.y)
            );
            shape.splineThru(splinePoints.slice(1));
          }
          break;
        }
        case 'ellipse': {
          const cx = entity.center?.x ?? entity.cx ?? 0;
          const cy = entity.center?.y ?? entity.cy ?? 0;
          const rx = entity.radiusX ?? entity.rx ?? 10;
          const ry = entity.radiusY ?? entity.ry ?? 5;
          shape.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false, 0);
          break;
        }
        default: {
          // Generic: use extracted points
          const ep = this._extractPointsFromEntity(entity);
          for (const p of ep) {
            shape.lineTo(p.x, p.y);
          }
        }
      }
    }

    shape.closePath();
    return shape;
  }

  /** Convert a chain of entities to a THREE.Path (for holes) */
  _chainToPath(chain: ProfileEntity[], _allEntities: ProfileEntity[]): THREE.Path | null {
    const path = new THREE.Path();
    const points = this._extractPointsFromEntities(chain);
    if (points.length < 2) return null;

    path.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      path.lineTo(points[i].x, points[i].y);
    }
    path.closePath();
    return path;
  }

  /** Extract all endpoints from a list of entities */
  _extractPointsFromEntities(entities: ProfileEntity[]): Point2[] {
    const points = [];
    const tolerance = 0.01;

    for (const entity of entities) {
      const eps = this._extractPointsFromEntity(entity);
      for (const p of eps) {
        // Only add if not duplicate of last point
        if (points.length === 0 ||
          Math.abs(p.x - points[points.length - 1].x) > tolerance ||
          Math.abs(p.y - points[points.length - 1].y) > tolerance) {
          points.push(p);
        }
      }
    }

    return points;
  }

  /** Extract points from a single entity */
  _extractPointsFromEntity(entity: ProfileEntity): Point2[] {
    switch (entity.type) {
      case 'line':
        return [
          { x: entity.p1?.x ?? entity.start?.x ?? entity.x1 ?? 0, y: entity.p1?.y ?? entity.start?.y ?? entity.y1 ?? 0 },
          { x: entity.p2?.x ?? entity.end?.x ?? entity.x2 ?? 0, y: entity.p2?.y ?? entity.end?.y ?? entity.y2 ?? 0 },
        ];
      case 'arc': {
        const cx = entity.center?.x ?? entity.cx ?? 0;
        const cy = entity.center?.y ?? entity.cy ?? 0;
        const r = entity.radius ?? entity.r ?? 10;
        const sa = entity.startAngle ?? 0;
        const ea = entity.endAngle ?? Math.PI * 2;
        const points = [];
        const steps = 32;
        for (let i = 0; i <= steps; i++) {
          const angle = sa + (ea - sa) * (i / steps);
          points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
        }
        return points;
      }
      case 'circle': {
        const cx = entity.center?.x ?? entity.cx ?? 0;
        const cy = entity.center?.y ?? entity.cy ?? 0;
        const r = entity.radius ?? entity.r ?? 10;
        const points = [];
        const steps = 64;
        for (let i = 0; i <= steps; i++) {
          const angle = (Math.PI * 2 * i) / steps;
          points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
        }
        return points;
      }
      case 'rect': {
        const x1 = entity.x1 ?? entity.corner1?.x ?? 0;
        const y1 = entity.y1 ?? entity.corner1?.y ?? 0;
        const x2 = entity.x2 ?? entity.corner2?.x ?? 0;
        const y2 = entity.y2 ?? entity.corner2?.y ?? 0;
        return [
          { x: x1, y: y1 },
          { x: x2, y: y1 },
          { x: x2, y: y2 },
          { x: x1, y: y2 },
        ];
      }
      case 'spline': {
        if (entity.controlPoints) {
          return entity.controlPoints.map(p => ({ x: p.x, y: p.y }));
        }
        return [];
      }
      case 'ellipse': {
        const cx = entity.center?.x ?? entity.cx ?? 0;
        const cy = entity.center?.y ?? entity.cy ?? 0;
        const rx = entity.radiusX ?? entity.rx ?? 10;
        const ry = entity.radiusY ?? entity.ry ?? 5;
        const points = [];
        const steps = 64;
        for (let i = 0; i <= steps; i++) {
          const angle = (Math.PI * 2 * i) / steps;
          points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
        }
        return points;
      }
      default:
        return [];
    }
  }

  /** Get endpoint of an arc */
  _arcEndpoint(arc: ProfileEntity, which: 'start' | 'end'): Point2 {
    const cx = arc.center?.x ?? arc.cx ?? 0;
    const cy = arc.center?.y ?? arc.cy ?? 0;
    const r = arc.radius ?? arc.r ?? 10;
    const angle = which === 'start'
      ? (arc.startAngle ?? 0)
      : (arc.endAngle ?? Math.PI * 2);
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }
}

// Export singleton instance
export const geometryEngine = new GeometryEngine();
export default GeometryEngine;
