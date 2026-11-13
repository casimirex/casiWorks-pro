// CasiWorks Pro - Constructive Solid Geometry on triangle meshes (BSP trees)
//
// Classic BSP-tree CSG (after Evan Wallace's csg.js): each solid becomes a set
// of convex polygons organised in a BSP tree; union / subtract / intersect clip
// the two trees against each other. Works on closed, consistently wound meshes.
import * as THREE from 'three';
import { EPSILON } from '../utils/math.ts';
import { safeNormalize, sanitizePoint } from './Topology.js';

/** Classification tolerance for points against a splitting plane (mm). */
const CSG_EPSILON = 1e-4;

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

/** Polygon vertex: position + normal. */
export class CSGVertex {
  pos: THREE.Vector3;
  normal: THREE.Vector3;

  constructor(pos: THREE.Vector3, normal: THREE.Vector3) {
    this.pos = sanitizePoint(pos);
    this.normal = safeNormalize(normal, new THREE.Vector3(0, 0, 1));
  }

  clone(): CSGVertex {
    return new CSGVertex(this.pos, this.normal);
  }

  flip(): void {
    this.normal.negate();
  }

  interpolate(other: CSGVertex, t: number): CSGVertex {
    const clampedT = Number.isNaN(t) ? 0 : Math.max(0, Math.min(1, t));
    const p = this.pos.clone().lerp(other.pos, clampedT);
    const n = this.normal.clone().lerp(other.normal, clampedT);
    return new CSGVertex(p, safeNormalize(n, this.normal));
  }
}

/** Plane `normal · p = w`. */
export class CSGPlane {
  normal: THREE.Vector3;
  w: number;

  constructor(normal: THREE.Vector3, w: number) {
    this.normal = safeNormalize(normal, new THREE.Vector3(0, 0, 1));
    this.w = Number.isFinite(w) ? w : 0;
  }

  /** Best-fit plane through a polygon (Newell's method; robust for near-degenerate polygons). */
  static fromVertices(vertices: CSGVertex[]): CSGPlane {
    if (!vertices || vertices.length < 3) return new CSGPlane(new THREE.Vector3(0, 0, 1), 0);
    const normal = new THREE.Vector3();
    const center = new THREE.Vector3();
    for (let i = 0; i < vertices.length; i++) {
      const curr = vertices[i].pos;
      const next = vertices[(i + 1) % vertices.length].pos;
      normal.x += (curr.y - next.y) * (curr.z + next.z);
      normal.y += (curr.z - next.z) * (curr.x + next.x);
      normal.z += (curr.x - next.x) * (curr.y + next.y);
      center.add(curr);
    }
    center.divideScalar(vertices.length);
    const norm = safeNormalize(normal, new THREE.Vector3(0, 0, 1));
    return new CSGPlane(norm, norm.dot(center));
  }

  clone(): CSGPlane {
    return new CSGPlane(this.normal.clone(), this.w);
  }

  flip(): void {
    this.normal.negate();
    this.w = -this.w;
  }

  /**
   * Classify `polygon` against this plane and push it (or its split pieces) into
   * the coplanar-front, coplanar-back, front or back list.
   */
  splitPolygon(
    polygon: CSGPolygon,
    coplanarFront: CSGPolygon[],
    coplanarBack: CSGPolygon[],
    front: CSGPolygon[],
    back: CSGPolygon[],
  ): void {
    let polygonType = 0;
    const types: number[] = [];

    for (const vertex of polygon.vertices) {
      const t = this.normal.dot(vertex.pos) - this.w;
      const type = t < -CSG_EPSILON ? BACK : (t > CSG_EPSILON ? FRONT : COPLANAR);
      polygonType |= type;
      types.push(type);
    }

    switch (polygonType) {
      case COPLANAR:
        (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
        break;
      case FRONT:
        front.push(polygon);
        break;
      case BACK:
        back.push(polygon);
        break;
      case SPANNING: {
        const f: CSGVertex[] = [];
        const b: CSGVertex[] = [];
        for (let i = 0; i < polygon.vertices.length; i++) {
          const j = (i + 1) % polygon.vertices.length;
          const ti = types[i];
          const tj = types[j];
          const vi = polygon.vertices[i];
          const vj = polygon.vertices[j];

          if (ti !== BACK) f.push(vi);
          if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);

          if ((ti | tj) === SPANNING) {
            const denom = this.normal.dot(new THREE.Vector3().subVectors(vj.pos, vi.pos));
            const t = Math.abs(denom) > 1e-9 ? (this.w - this.normal.dot(vi.pos)) / denom : 0;
            const v = vi.interpolate(vj, Number.isNaN(t) ? 0 : Math.max(0, Math.min(1, t)));
            f.push(v);
            b.push(v.clone());
          }
        }
        if (f.length >= 3) {
          const polyF = new CSGPolygon(f, polygon.shared);
          if (polyF.computeArea() > 1e-9) front.push(polyF);
        }
        if (b.length >= 3) {
          const polyB = new CSGPolygon(b, polygon.shared);
          if (polyB.computeArea() > 1e-9) back.push(polyB);
        }
        break;
      }
    }
  }
}

/** Convex planar polygon. */
export class CSGPolygon {
  vertices: CSGVertex[];
  shared: unknown;
  plane: CSGPlane;

  constructor(vertices: CSGVertex[], shared: unknown = null) {
    // Drop consecutive duplicate vertices (keep the original list if that would degenerate it)
    const cleaned: CSGVertex[] = [];
    for (const v of vertices) {
      if (!cleaned.length || v.pos.distanceTo(cleaned[cleaned.length - 1].pos) > 1e-6) cleaned.push(v);
    }
    if (cleaned.length > 1 && cleaned[0].pos.distanceTo(cleaned[cleaned.length - 1].pos) <= 1e-6) cleaned.pop();
    this.vertices = cleaned.length >= 3 ? cleaned : vertices;
    this.shared = shared;
    this.plane = CSGPlane.fromVertices(this.vertices);
  }

  computeArea(): number {
    if (this.vertices.length < 3) return 0;
    const areaVec = new THREE.Vector3();
    for (let i = 0; i < this.vertices.length; i++) {
      areaVec.add(new THREE.Vector3().crossVectors(this.vertices[i].pos, this.vertices[(i + 1) % this.vertices.length].pos));
    }
    const a = areaVec.dot(this.plane.normal) * 0.5;
    return Number.isNaN(a) ? 0 : Math.abs(a);
  }

  clone(): CSGPolygon {
    return new CSGPolygon(this.vertices.map(v => v.clone()), this.shared);
  }

  flip(): void {
    this.vertices.reverse().forEach(v => v.flip());
    this.plane.flip();
  }
}

/** BSP tree node. */
export class CSGNode {
  plane: CSGPlane | null = null;
  front: CSGNode | null = null;
  back: CSGNode | null = null;
  polygons: CSGPolygon[] = [];

  constructor(polygons?: CSGPolygon[]) {
    if (polygons && polygons.length > 0) this.build(polygons);
  }

  clone(): CSGNode {
    const node = new CSGNode();
    node.plane = this.plane ? this.plane.clone() : null;
    node.front = this.front ? this.front.clone() : null;
    node.back = this.back ? this.back.clone() : null;
    node.polygons = this.polygons.map(p => p.clone());
    return node;
  }

  /** Convert solid space to empty space and vice versa. */
  invert(): void {
    for (const polygon of this.polygons) polygon.flip();
    this.plane?.flip();
    this.front?.invert();
    this.back?.invert();
    [this.front, this.back] = [this.back, this.front];
  }

  /** Remove the parts of `polygons` that lie inside this tree. */
  clipPolygons(polygons: CSGPolygon[]): CSGPolygon[] {
    if (!this.plane) return polygons.slice();
    let front: CSGPolygon[] = [];
    let back: CSGPolygon[] = [];
    for (const polygon of polygons) this.plane.splitPolygon(polygon, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }

  /** Remove the parts of this tree's polygons that lie inside `bsp`. */
  clipTo(bsp: CSGNode): void {
    this.polygons = bsp.clipPolygons(this.polygons);
    this.front?.clipTo(bsp);
    this.back?.clipTo(bsp);
  }

  allPolygons(): CSGPolygon[] {
    let polygons = this.polygons.slice();
    if (this.front) polygons = polygons.concat(this.front.allPolygons());
    if (this.back) polygons = polygons.concat(this.back.allPolygons());
    return polygons;
  }

  build(polygons: CSGPolygon[]): void {
    if (polygons.length === 0) return;
    if (!this.plane) this.plane = polygons[0].plane.clone();
    const front: CSGPolygon[] = [];
    const back: CSGPolygon[] = [];
    for (const polygon of polygons) this.plane.splitPolygon(polygon, this.polygons, this.polygons, front, back);
    if (front.length > 0) (this.front ??= new CSGNode()).build(front);
    if (back.length > 0) (this.back ??= new CSGNode()).build(back);
  }
}

// =====================================================================
// Mesh conversion
// =====================================================================

/** Triangles of a BufferGeometry as CSG polygons (degenerate triangles skipped). */
export function geometryToPolygons(geometry: THREE.BufferGeometry): CSGPolygon[] {
  const polygons: CSGPolygon[] = [];
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) return polygons;
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  const indexAttr = geometry.index;
  const count = indexAttr ? indexAttr.count : posAttr.count;

  for (let i = 0; i + 2 < count; i += 3) {
    const vertices: CSGVertex[] = [];
    for (let j = 0; j < 3; j++) {
      const idx = indexAttr ? indexAttr.getX(i + j) : i + j;
      vertices.push(new CSGVertex(
        new THREE.Vector3(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx)),
        new THREE.Vector3(normals.getX(idx), normals.getY(idx), normals.getZ(idx)),
      ));
    }
    const edge1 = new THREE.Vector3().subVectors(vertices[1].pos, vertices[0].pos);
    const edge2 = new THREE.Vector3().subVectors(vertices[2].pos, vertices[0].pos);
    if (edge1.cross(edge2).lengthSq() > EPSILON) polygons.push(new CSGPolygon(vertices));
  }
  return polygons;
}

/** Fan-triangulate CSG polygons into a non-indexed BufferGeometry. */
export function polygonsToGeometry(polygons: CSGPolygon[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const polygon of polygons) {
    const [v0] = polygon.vertices;
    for (let i = 2; i < polygon.vertices.length; i++) {
      for (const v of [v0, polygon.vertices[i - 1], polygon.vertices[i]]) {
        positions.push(v.pos.x, v.pos.y, v.pos.z);
        normals.push(v.normal.x, v.normal.y, v.normal.z);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

// =====================================================================
// Boolean operations
// =====================================================================

function finish(polygons: CSGPolygon[]): THREE.BufferGeometry {
  const result = polygonsToGeometry(polygons);
  result.computeVertexNormals();
  result.computeBoundingBox();
  return result;
}

/** A ∪ B */
export function csgUnion(geomA: THREE.BufferGeometry, geomB: THREE.BufferGeometry): THREE.BufferGeometry {
  const a = new CSGNode(geometryToPolygons(geomA));
  const b = new CSGNode(geometryToPolygons(geomB));
  a.clipTo(b);
  b.clipTo(a);
  b.invert();
  b.clipTo(a);
  b.invert();
  a.build(b.allPolygons());
  return finish(a.allPolygons());
}

/** A − B */
export function csgSubtract(geomA: THREE.BufferGeometry, geomB: THREE.BufferGeometry): THREE.BufferGeometry {
  const a = new CSGNode(geometryToPolygons(geomA));
  const b = new CSGNode(geometryToPolygons(geomB));
  a.invert();
  a.clipTo(b);
  b.clipTo(a);
  b.invert();
  b.clipTo(a);
  b.invert();
  a.build(b.allPolygons());
  a.invert();
  return finish(a.allPolygons());
}

/** A ∩ B */
export function csgIntersect(geomA: THREE.BufferGeometry, geomB: THREE.BufferGeometry): THREE.BufferGeometry {
  const a = new CSGNode(geometryToPolygons(geomA));
  const b = new CSGNode(geometryToPolygons(geomB));
  a.invert();
  b.clipTo(a);
  b.invert();
  a.clipTo(b);
  b.clipTo(a);
  a.build(b.allPolygons());
  a.invert();
  return finish(a.allPolygons());
}
