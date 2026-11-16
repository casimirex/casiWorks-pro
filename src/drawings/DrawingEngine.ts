// CasiWorks Pro - 2D Engineering Drawings Engine
// Generates standard orthographic projections (Front, Top, Right, Left, Bottom, Back, Isometric),
// Hidden Line Removal (HLR), linear and radial dimensioning, centerlines, center marks,
// Geometric Dimensioning & Tolerancing (GD&T) datum symbols and feature control frames,
// standard drawing sheets (A4, A3) with title blocks, and SVG / DXF vector exports.
import * as THREE from 'three';

export const PROJECTION_VIEWS = {
  FRONT: 'front',
  TOP: 'top',
  RIGHT: 'right',
  LEFT: 'left',
  BOTTOM: 'bottom',
  BACK: 'back',
  ISOMETRIC: 'isometric',
} as const;

export const LINE_TYPES = {
  VISIBLE: 'visible',     // Solid thick line (0.5mm)
  HIDDEN: 'hidden',       // Dashed thin line (0.25mm)
  CENTER: 'center',       // Long-short dash (0.25mm)
  DIMENSION: 'dimension', // Thin solid line (0.25mm)
  BORDER: 'border',       // Border thick line (0.7mm)
} as const;

export const GDT_SYMBOLS = {
  FLATNESS: { symbol: '⏥', name: 'Flatness' },
  STRAIGHTNESS: { symbol: '—', name: 'Straightness' },
  CIRCULARITY: { symbol: '○', name: 'Circularity' },
  CYLINDRICITY: { symbol: '⌭', name: 'Cylindricity' },
  PERPENDICULARITY: { symbol: '⟂', name: 'Perpendicularity' },
  PARALLELISM: { symbol: '∥', name: 'Parallelism' },
  ANGULARITY: { symbol: '∠', name: 'Angularity' },
  POSITION: { symbol: '⨁', name: 'Position' },
  CONCENTRICITY: { symbol: '◎', name: 'Concentricity' },
  SYMMETRY: { symbol: '⌯', name: 'Symmetry' },
  CIRCULAR_RUNOUT: { symbol: '↗', name: 'Circular Runout' },
  TOTAL_RUNOUT: { symbol: '⇗', name: 'Total Runout' },
  PROFILE_SURFACE: { symbol: '⌓', name: 'Profile of a Surface' },
  PROFILE_LINE: { symbol: '⌒', name: 'Profile of a Line' },
};

export const SHEET_SIZES = {
  A4_LANDSCAPE: { width: 297, height: 210, name: 'A4 Landscape (297 x 210 mm)' },
  A4_PORTRAIT: { width: 210, height: 297, name: 'A4 Portrait (210 x 297 mm)' },
  A3_LANDSCAPE: { width: 420, height: 297, name: 'A3 Landscape (420 x 297 mm)' },
  ANSI_B: { width: 431.8, height: 279.4, name: 'ANSI B (17 x 11 in)' },
} as const;

export type ProjectionView = (typeof PROJECTION_VIEWS)[keyof typeof PROJECTION_VIEWS];
export type LineType = (typeof LINE_TYPES)[keyof typeof LINE_TYPES];
export interface SheetSize { width: number; height: number; name: string }

export interface Point2D { x: number; y: number }
export interface DrawingLine { p1: Point2D; p2: Point2D; type?: LineType; length?: number }
export interface ViewBounds { minX: number; maxX: number; minY: number; maxY: number; width?: number; height?: number }

/** A projected view in model units (u right, v up). */
export interface ProjectedView {
  visible: DrawingLine[];
  hidden: DrawingLine[];
  bounds: Required<ViewBounds>;
  view: string;
}

/** A view placed on the sheet (sheet millimetres). */
export interface SheetView {
  label: string;
  /** Baseline of the view label (sheet y); below the view and its annotations. */
  labelY?: number;
  view: string;
  centerX: number;
  centerY: number;
  scale: number;
  /** Sheet position of view coordinate (u, v): (u·scale + offsetX, offsetY − v·scale). */
  offsetX?: number;
  offsetY?: number;
  visible: DrawingLine[];
  hidden: DrawingLine[];
  bounds: ViewBounds;
}

/** A parts list on the sheet (assembly drawings), drawn above the title block. */
export interface BomTable {
  x: number;
  y: number;
  rowHeight: number;
  columns: Array<{ title: string; width: number; align: 'left' | 'right' | 'center' }>;
  /** Body rows, top to bottom (the header row is drawn from `columns`). */
  rows: string[][];
}

/** An item balloon: a numbered circle with a leader to the part it marks. */
export interface Balloon {
  x: number;
  y: number;
  radius: number;
  label: string;
  /** Where the leader ends, on the part. */
  target: Point2D;
}

export interface LinearDimension {
  type: 'linear';
  dimLine: { p1: Point2D; p2: Point2D };
  extLine1: { p1: Point2D; p2: Point2D };
  extLine2: { p1: Point2D; p2: Point2D };
  textPos: Point2D;
  text: string;
}

export interface FeatureControlFrame {
  type: 'gdt_fcf';
  x: number;
  y: number;
  width: number;
  height: number;
  characteristic: string;
  tolerance: string;
  datums: string[];
  compartments: Array<{ label: string; width: number }>;
}

export interface DatumSymbol { type: 'gdt_datum'; x: number; y: number; letter: string; triangleSize: number; boxWidth: number; boxHeight: number }

export interface TitleBlock {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  partNumber: string;
  material: string;
  scaleText: string;
  date: string;
  revision: string;
}

export interface SheetData {
  sheetSize: SheetSize;
  scale: number;
  views: SheetView[];
  dimensions: LinearDimension[];
  gdtFrames: Array<FeatureControlFrame | DatumSymbol>;
  border?: { x: number; y: number; width: number; height: number; innerMargin: number };
  titleBlock?: TitleBlock;
  bomTable?: BomTable;
  balloons?: Balloon[];
}

export interface SheetOptions {
  sheetSize?: SheetSize;
  enableHLR?: boolean;
  title?: string;
  partNumber?: string;
  material?: string;
  /** Room kept free directly above the title block, right-aligned with it (e.g. for a parts list). */
  reserveAboveTitle?: { width: number; height: number };
}
export interface ProjectOptions { enableHLR?: boolean; creaseAngleDeg?: number }

interface CamTriangle { p1: THREE.Vector3; p2: THREE.Vector3; p3: THREE.Vector3; minX: number; maxX: number; minY: number; maxY: number }

/**
 * Robust XML string escaping for SVG export
 * Prevents XML parsing errors from unescaped &, <, >, ", '
 */
export function escapeXml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// =====================================================================
// Hidden-line pipeline helpers
// =====================================================================

interface ViewTriangle { v: [number, number, number]; normal: THREE.Vector3; front: boolean }
interface ViewMesh { verts: THREE.Vector3[]; tris: ViewTriangle[]; frontTriangles: CamTriangle[] }

/**
 * Weld coincident vertices (1e-4 mm) and transform into view coordinates
 * (x right, y up, z towards the viewer). Degenerate triangles are dropped.
 */
export function buildViewMesh(geometry: THREE.BufferGeometry, projMat: THREE.Matrix4): ViewMesh {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const verts: THREE.Vector3[] = [];
  const world: THREE.Vector3[] = [];
  const ids = new Map<string, number>();
  const q = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
  const vertexId = (i: number): number => {
    const x = q(pos.getX(i)), y = q(pos.getY(i)), z = q(pos.getZ(i));
    const key = `${x},${y},${z}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = verts.length;
      ids.set(key, id);
      world.push(new THREE.Vector3(x, y, z));
      verts.push(new THREE.Vector3(x, y, z).applyMatrix4(projMat));
    }
    return id;
  };

  const tris: ViewTriangle[] = [];
  const frontTriangles: CamTriangle[] = [];
  for (let t = 0; t + 2 < count; t += 3) {
    const v: [number, number, number] = [0, 1, 2].map(k => vertexId(index ? index.getX(t + k) : t + k)) as [number, number, number];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const [w1, w2, w3] = v.map(i => world[i]);
    const normal = new THREE.Vector3().subVectors(w2, w1).cross(new THREE.Vector3().subVectors(w3, w1));
    if (normal.lengthSq() < 1e-18) continue;
    normal.normalize();
    const [p1, p2, p3] = v.map(i => verts[i]);
    const area2D = (p2.x - p1.x) * (p3.y - p1.y) - (p3.x - p1.x) * (p2.y - p1.y);
    const front = area2D > 0;
    tris.push({ v, normal, front });
    if (front) {
      frontTriangles.push({
        p1, p2, p3,
        minX: Math.min(p1.x, p2.x, p3.x), maxX: Math.max(p1.x, p2.x, p3.x),
        minY: Math.min(p1.y, p2.y, p3.y), maxY: Math.max(p1.y, p2.y, p3.y),
      });
    }
  }
  return { verts, tris, frontTriangles };
}

/**
 * Edges a drawing shows: creases, silhouettes and open boundaries. Edges with
 * a single adjacent triangle are matched to collinear overlapping edges first
 * (T-junctions left by booleans), so they are classified like normal edges.
 * Without `silhouettes` only view-independent edges (creases, boundaries) are kept.
 */
export function extractDrawingEdges(mesh: ViewMesh, creaseAngleDeg: number, { silhouettes = true } = {}): Array<{ a: THREE.Vector3; b: THREE.Vector3 }> {
  const edgeMap = new Map<string, { a: number; b: number; faces: number[] }>();
  mesh.tris.forEach((tri, f) => {
    for (let k = 0; k < 3; k++) {
      const a = tri.v[k];
      const b = tri.v[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const e = edgeMap.get(key);
      if (e) e.faces.push(f);
      else edgeMap.set(key, { a: Math.min(a, b), b: Math.max(a, b), faces: [f] });
    }
  });

  // T-junctions (left by booleans): a single-face edge whose other side is made of
  // several shorter collinear edges. Split every single-face edge at the vertices
  // of collinear single-face edges that lie on it, then pair up the pieces, so each
  // piece is classified with the faces really on both sides.
  const V = mesh.verts;
  const box = new THREE.Box3().setFromPoints(V);
  // Booleans split edges in single precision: T-junction vertices sit up to
  // ~1e-4 of the model size off their partner line
  const tol = 1e-4 * (box.getSize(new THREE.Vector3()).length() || 1) + 1e-6;
  const singles = [...edgeMap.entries()].filter(([, e]) => e.faces.length === 1);

  // Bucket single-face edges by their infinite line (direction, closest point to the origin)
  const buckets = new Map<string, Array<{ a: number; b: number; faces: number[] }>>();
  for (const [, e] of singles) {
    const a = V[e.a];
    const d = new THREE.Vector3().subVectors(V[e.b], a);
    if (d.lengthSq() === 0) continue;
    d.normalize();
    // Orient by the dominant component (a tiny noisy component must not decide the sign)
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    if ((ax >= ay && ax >= az ? d.x : (ay >= az ? d.y : d.z)) < 0) d.negate();
    const o = a.clone().addScaledVector(d, -a.dot(d));
    const key = [d.x, d.y, d.z].map(v => Math.round(v * 50)).join(',') + '|' + [o.x, o.y, o.z].map(v => Math.round(v * 2)).join(',');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const points = [...new Set(bucket.flatMap(e => [e.a, e.b]))];
    for (const e of bucket) {
      const A = V[e.a];
      const ab = new THREE.Vector3().subVectors(V[e.b], A);
      const lenSq = ab.lengthSq();
      const inner: Array<{ id: number; t: number }> = [];
      for (const id of points) {
        if (id === e.a || id === e.b) continue;
        const t = new THREE.Vector3().subVectors(V[id], A).dot(ab) / lenSq;
        if (t > 1e-9 && t < 1 - 1e-9 && A.clone().addScaledVector(ab, t).distanceTo(V[id]) < tol) inner.push({ id, t });
      }
      if (inner.length === 0) continue;
      // Replace the edge by its pieces
      edgeMap.delete(e.a < e.b ? `${e.a}_${e.b}` : `${e.b}_${e.a}`);
      const chain = [e.a, ...inner.sort((x, y) => x.t - y.t).map(x => x.id), e.b];
      for (let k = 0; k + 1 < chain.length; k++) {
        const p = chain[k], q = chain[k + 1];
        const key = p < q ? `${p}_${q}` : `${q}_${p}`;
        const piece = edgeMap.get(key);
        if (piece) piece.faces.push(...e.faces);
        else edgeMap.set(key, { a: Math.min(p, q), b: Math.max(p, q), faces: [...e.faces] });
      }
    }
  }

  const cosCrease = Math.cos((creaseAngleDeg * Math.PI) / 180);
  const out: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  for (const e of edgeMap.values()) {
    const faces = [...new Set(e.faces)];
    let draw = faces.length === 1; // a genuine open boundary
    if (!draw) {
      const tris = faces.map(f => mesh.tris[f]);
      const anyFront = tris.some(t => t.front);
      const anyBack = tris.some(t => !t.front);
      const crease = tris.some((t, i) => tris.some((u, j) => j > i && t.normal.dot(u.normal) < cosCrease));
      draw = crease || (silhouettes && anyFront && anyBack);
    }
    if (draw) out.push({ a: V[e.a], b: V[e.b] });
  }
  return out;
}

/**
 * Line segments of a model's real edges (sharp creases and open boundaries) for
 * 3D display. Unlike THREE.EdgesGeometry it does not show the triangulation
 * fans that booleans leave on flat faces.
 */
export function modelEdgesGeometry(geometry: THREE.BufferGeometry, creaseAngleDeg = 25): THREE.BufferGeometry {
  const edges = extractDrawingEdges(buildViewMesh(geometry, new THREE.Matrix4()), creaseAngleDeg, { silhouettes: false });
  const positions = new Float32Array(edges.length * 6);
  edges.forEach(({ a, b }, i) => positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6));
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return out;
}

/** 2D grid over front-facing triangles for fast occlusion queries. */
class TriangleGrid {
  private cells = new Map<number, CamTriangle[]>();
  private x0: number;
  private y0: number;
  private cell: number;
  private n: number;

  constructor(tris: CamTriangle[], b: { minX: number; minY: number; width: number; height: number }, n: number) {
    this.n = n;
    this.cell = Math.max(b.width, b.height, 1e-6) / n;
    this.x0 = b.minX - this.cell;
    this.y0 = b.minY - this.cell;
    for (const t of tris) {
      const [i0, j0, i1, j1] = [this.ix(t.minX), this.iy(t.minY), this.ix(t.maxX), this.iy(t.maxY)];
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = i * (this.n + 3) + j;
        const list = this.cells.get(k);
        if (list) list.push(t);
        else this.cells.set(k, [t]);
      }
    }
  }

  private ix(x: number) { return Math.max(0, Math.min(this.n + 2, Math.floor((x - this.x0) / this.cell))); }
  private iy(y: number) { return Math.max(0, Math.min(this.n + 2, Math.floor((y - this.y0) / this.cell))); }

  /** True when a front-facing triangle lies in front of point p (view coordinates). */
  occludes(p: THREE.Vector3, depthTol: number): boolean {
    for (const t of this.cells.get(this.ix(p.x) * (this.n + 3) + this.iy(p.y)) ?? []) {
      if (p.x < t.minX || p.x > t.maxX || p.y < t.minY || p.y > t.maxY) continue;
      const d = (t.p2.y - t.p3.y) * (t.p1.x - t.p3.x) + (t.p3.x - t.p2.x) * (t.p1.y - t.p3.y);
      if (Math.abs(d) < 1e-14) continue;
      const l1 = ((t.p2.y - t.p3.y) * (p.x - t.p3.x) + (t.p3.x - t.p2.x) * (p.y - t.p3.y)) / d;
      const l2 = ((t.p3.y - t.p1.y) * (p.x - t.p3.x) + (t.p1.x - t.p3.x) * (p.y - t.p3.y)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const z = l1 * t.p1.z + l2 * t.p2.z + l3 * t.p3.z;
      if (z > p.z + depthTol) return true;
    }
    return false;
  }
}

/** 2D grid over line segments for "is this point on a drawn line" queries. */
class SegmentGrid {
  private cells = new Map<number, DrawingLine[]>();
  private x0: number;
  private y0: number;
  private cell: number;
  private n: number;

  constructor(lines: DrawingLine[], b: { minX: number; minY: number; width: number; height: number }, n: number) {
    this.n = n;
    this.cell = Math.max(b.width, b.height, 1e-6) / n;
    this.x0 = b.minX - this.cell;
    this.y0 = b.minY - this.cell;
    for (const l of lines) this.add(l);
  }

  add(l: DrawingLine): void {
    const [i0, i1] = [this.ix(Math.min(l.p1.x, l.p2.x)), this.ix(Math.max(l.p1.x, l.p2.x))];
    const [j0, j1] = [this.iy(Math.min(l.p1.y, l.p2.y)), this.iy(Math.max(l.p1.y, l.p2.y))];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = i * (this.n + 3) + j;
      const list = this.cells.get(k);
      if (list) list.push(l);
      else this.cells.set(k, [l]);
    }
  }

  private ix(x: number) { return Math.max(0, Math.min(this.n + 2, Math.floor((x - this.x0) / this.cell))); }
  private iy(y: number) { return Math.max(0, Math.min(this.n + 2, Math.floor((y - this.y0) / this.cell))); }

  /**
   * True when (x, y) is within `tol` of a segment running parallel to the
   * direction (dx, dy). Perpendicular lines meeting at a corner do not count,
   * so corners are not trimmed.
   */
  near(x: number, y: number, tol: number, dirX = 0, dirY = 0): boolean {
    const dirLen = Math.hypot(dirX, dirY);
    const ci = this.ix(x), cj = this.iy(y);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      for (const l of this.cells.get(i * (this.n + 3) + j) ?? []) {
        const dx = l.p2.x - l.p1.x, dy = l.p2.y - l.p1.y;
        const lenSq = dx * dx + dy * dy;
        if (dirLen > 0 && lenSq > 0 && Math.abs(dx * dirY - dy * dirX) / (Math.sqrt(lenSq) * dirLen) > 1e-3) continue;
        const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - l.p1.x) * dx + (y - l.p1.y) * dy) / lenSq)) : 0;
        if (Math.hypot(l.p1.x + t * dx - x, l.p1.y + t * dy - y) < tol) return true;
      }
    }
    return false;
  }
}

/** Group sampled states (n+1 samples at t = k/n) into runs with boundaries halfway between samples. */
function forEachRun(states: boolean[], n: number, cb: (t0: number, t1: number, state: boolean) => void): void {
  let start = 0;
  for (let k = 1; k <= n + 1; k++) {
    if (k === n + 1 || states[k] !== states[start]) {
      const t0 = start === 0 ? 0 : (start - 0.5) / n;
      const t1 = k === n + 1 ? 1 : (k - 0.5) / n;
      if (t1 > t0) cb(t0, t1, states[start]);
      start = k;
    }
  }
}

export class DrawingEngine {
  sheet: { size: SheetSize; scale: number; views: SheetView[]; dimensions: LinearDimension[]; gdtFrames: unknown[]; centerlines: unknown[]; titleBlock: Record<string, string> };

  constructor() {
    this.sheet = {
      size: SHEET_SIZES.A4_LANDSCAPE,
      scale: 1.0,
      views: [],
      dimensions: [],
      gdtFrames: [],
      centerlines: [],
      titleBlock: {
        title: 'Untitled Part',
        drawingNumber: 'DWG-001',
        revision: 'A',
        material: 'Steel 1020',
        author: 'CasiWorks Pro Engineer',
        date: new Date().toISOString().slice(0, 10),
        scaleText: '1:1',
      },
    };
  }

  /**
   * Project 3D geometry onto a 2D view with hidden line removal.
   * Edges drawn: creases (faces meeting at more than `creaseAngleDeg`),
   * silhouettes (front-facing meets back-facing) and open boundaries. Each edge
   * is split into visible and hidden runs; hidden runs lying exactly behind a
   * visible line are omitted, as on a standard drawing.
   * Output coordinates are model units, u to the right and v up.
   */
  projectGeometry(geometry: THREE.BufferGeometry | null | undefined, view: string = PROJECTION_VIEWS.FRONT, options: ProjectOptions = {}): ProjectedView {
    const empty: ProjectedView = { visible: [], hidden: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 }, view };
    const pos = geometry?.getAttribute('position');
    if (!geometry || !pos || pos.count === 0) return empty;

    geometry.computeBoundingBox();
    const bSize = new THREE.Vector3();
    (geometry.boundingBox || new THREE.Box3()).getSize(bSize);
    if (![bSize.x, bSize.y, bSize.z].every(Number.isFinite) || (bSize.x <= 1e-6 && bSize.y <= 1e-6 && bSize.z <= 1e-6)) return empty;

    const enableHLR = options.enableHLR !== undefined ? options.enableHLR : true;
    const creaseAngle = options.creaseAngleDeg || 25;
    const { projMat } = this._getProjectionMatrix(view);

    const mesh = buildViewMesh(geometry, projMat);
    const edges = extractDrawingEdges(mesh, creaseAngle);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const e of edges) {
      for (const p of [e.a, e.b]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    if (minX === Infinity) return empty;
    const bounds = { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
    const seg = (a: THREE.Vector3, b: THREE.Vector3, type: LineType): DrawingLine =>
      ({ p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y }, type, length: Math.hypot(b.x - a.x, b.y - a.y) });

    if (!enableHLR) {
      return { visible: edges.map(e => seg(e.a, e.b, LINE_TYPES.VISIBLE)), hidden: [], bounds, view };
    }

    const diag = Math.hypot(bounds.width, bounds.height) || 1;
    // Edges along the line of sight project to a point: nothing to draw
    const drawable = edges.filter(e => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) > 1e-6 * diag);
    const occluder = new TriangleGrid(mesh.frontTriangles, bounds, 64);
    const depthTol = 1e-4 * diag + 1e-6;

    // 1. Split every edge into visible / hidden runs by dense sampling
    const visibleRuns: Array<[THREE.Vector3, THREE.Vector3]> = [];
    const hiddenRuns: Array<[THREE.Vector3, THREE.Vector3]> = [];
    const stepLen = diag / 400;
    for (const e of drawable) {
      const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
      const n = Math.max(4, Math.min(256, Math.ceil(len / stepLen)));
      const states: boolean[] = [];
      for (let k = 0; k <= n; k++) {
        const t = Math.min(1 - 1e-6, Math.max(1e-6, k / n));
        states.push(!occluder.occludes(e.a.clone().lerp(e.b, t), depthTol));
      }
      forEachRun(states, n, (t0, t1, isVisible) => {
        (isVisible ? visibleRuns : hiddenRuns).push([e.a.clone().lerp(e.b, t0), e.a.clone().lerp(e.b, t1)]);
      });
    }

    // 2. Keep each run only where no accepted line already covers it. Visible
    //    runs are deduplicated among themselves (different 3D edges can project
    //    onto the same 2D line); hidden runs are also dropped behind visible lines.
    const coverTol = 1e-3 * diag;
    const accept = (runs: Array<[THREE.Vector3, THREE.Vector3]>, type: LineType, covering: SegmentGrid): DrawingLine[] => {
      const out: DrawingLine[] = [];
      for (const [a, b] of runs) {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(2, Math.min(256, Math.ceil(len / stepLen)));
        const states: boolean[] = [];
        for (let k = 0; k <= n; k++) {
          const p = a.clone().lerp(b, k / n);
          states.push(!covering.near(p.x, p.y, coverTol, b.x - a.x, b.y - a.y));
        }
        forEachRun(states, n, (t0, t1, show) => {
          if (!show) return;
          const line = seg(a.clone().lerp(b, t0), a.clone().lerp(b, t1), type);
          if ((line.length ?? 0) <= coverTol) return;
          out.push(line);
          covering.add(line);
        });
      }
      return out;
    };
    const visibleCover = new SegmentGrid([], bounds, 64);
    const visible = accept(visibleRuns, LINE_TYPES.VISIBLE, visibleCover);
    const hiddenCover = new SegmentGrid(visible, bounds, 64);
    const hidden = accept(hiddenRuns, LINE_TYPES.HIDDEN, hiddenCover);

    return { visible, hidden, bounds, view };
  }


  /**
   * Create standard engineering projection matrix for chosen view orientation
   */
  _getProjectionMatrix(view: string): { projMat: THREE.Matrix4; viewDir: THREE.Vector3 } {
    const mat = new THREE.Matrix4();
    const viewDir = new THREE.Vector3(0, 0, 1);

    switch (view) {
      case PROJECTION_VIEWS.TOP:
        // Look from +Y down onto XZ: u = x, v = -z, depth = y
        mat.set(
          1,  0,  0, 0,
          0,  0, -1, 0,
          0,  1,  0, 0,
          0,  0,  0, 1
        );
        viewDir.set(0, 1, 0);
        break;

      case PROJECTION_VIEWS.RIGHT:
        // Look from +X onto YZ: u = -z, v = y, depth = x
        mat.set(
          0,  0, -1, 0,
          0,  1,  0, 0,
          1,  0,  0, 0,
          0,  0,  0, 1
        );
        viewDir.set(1, 0, 0);
        break;

      case PROJECTION_VIEWS.LEFT:
        // Look from -X onto YZ: u = z, v = y, depth = -x
        mat.set(
          0,  0,  1, 0,
          0,  1,  0, 0,
         -1,  0,  0, 0,
          0,  0,  0, 1
        );
        viewDir.set(-1, 0, 0);
        break;

      case PROJECTION_VIEWS.BOTTOM:
        // Look from -Y onto XZ: u = x, v = z, depth = -y
        mat.set(
          1,  0,  0, 0,
          0,  0,  1, 0,
          0, -1,  0, 0,
          0,  0,  0, 1
        );
        viewDir.set(0, -1, 0);
        break;

      case PROJECTION_VIEWS.BACK:
        // Look from -Z onto XY: u = -x, v = y, depth = -z
        mat.set(
         -1,  0,  0, 0,
          0,  1,  0, 0,
          0,  0, -1, 0,
          0,  0,  0, 1
        );
        viewDir.set(0, 0, -1);
        break;

      case PROJECTION_VIEWS.ISOMETRIC: {
        // Standard 30° engineering isometric projection
        // Rotation: 45° around Y, then 35.264° (arcsin 1/sqrt(3)) around X
        // Viewed from (+1, +1, +1), like the 3D viewport: −45° about Y brings (1, 1, 1)
        // to (0, 1, √2), then asin(1/√3) about X brings it onto the line of sight
        const invSqrt3 = 1 / Math.sqrt(3);
        const rY = new THREE.Matrix4().makeRotationY(-Math.PI / 4);
        const rX = new THREE.Matrix4().makeRotationX(Math.asin(invSqrt3));
        mat.multiplyMatrices(rX, rY);
        viewDir.set(1, 1, 1).normalize();
        break;
      }

      case PROJECTION_VIEWS.FRONT:
      default:
        // Standard front view: u = x, v = y, depth = z
        mat.identity();
        viewDir.set(0, 0, 1);
        break;
    }

    return { projMat: mat, viewDir };
  }

  /** Where a model point appears in a placed view, in sheet millimetres. */
  sheetPoint(view: SheetView, p: { x: number; y: number; z: number }): Point2D {
    const { projMat } = this._getProjectionMatrix(view.view);
    const q = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(projMat);
    return { x: q.x * view.scale + (view.offsetX ?? 0), y: (view.offsetY ?? 0) - q.y * view.scale };
  }

  /**
   * Generates standard 4-view orthographic drawing (Top, Front, Right, Isometric)
   * arranged neatly on an engineering sheet.
   */
  createStandardSheet(geometry: THREE.BufferGeometry, sheetOptions: SheetOptions = {}): SheetData {
    const sheetSize = sheetOptions.sheetSize || SHEET_SIZES.A4_LANDSCAPE;
    const enableHLR = sheetOptions.enableHLR !== undefined ? sheetOptions.enableHLR : true;

    // Project 4 primary views
    const frontView = this.projectGeometry(geometry, PROJECTION_VIEWS.FRONT, { enableHLR });
    const topView = this.projectGeometry(geometry, PROJECTION_VIEWS.TOP, { enableHLR });
    const rightView = this.projectGeometry(geometry, PROJECTION_VIEWS.RIGHT, { enableHLR });
    const isoView = this.projectGeometry(geometry, PROJECTION_VIEWS.ISOMETRIC, { enableHLR });

    // ---------------------------------------------------------------- layout (mm on the sheet)
    // Third-angle arrangement: TOP above FRONT, RIGHT beside FRONT, ISO top-right.
    // Every view gets bands for its label and annotations; the title block's
    // strip at the bottom is kept clear.
    const margin = 12;
    const inner = 2; // border inner frame
    const titleBlockWidth = 90;
    const titleBlockHeight = 40;
    const availWidth = sheetSize.width - 2 * margin;
    const availHeight = sheetSize.height - 2 * margin;
    const area = {
      minX: margin + inner + 4,
      minY: margin + inner + 4,
      maxX: sheetSize.width - margin - inner - 4,
      maxY: sheetSize.height - margin - titleBlockHeight - 4,
    };
    const BAND = {
      label: 9, // label baseline below a view
      frontLeft: 26, // height dimension and its text
      frontAbove: 16, // feature control frame
      frontBelow: 34, // datum, width dimension, label
      gap: 10, // between columns and rows
      topRight: 24, // depth dimension and its text right of the top view
    };

    const size = (v: ProjectedView) => ({ w: v.bounds.width || 0, h: v.bounds.height || 0 });
    const [F, T, R, I] = [size(frontView), size(topView), size(rightView), size(isoView)];
    const col1 = Math.max(F.w, T.w); // top and front share x (model width)
    const col2 = Math.max(R.w, I.w);
    // Views keep clear of the title block and of anything reserved above it
    const reserve = sheetOptions.reserveAboveTitle;
    const titleTop = sheetSize.height - margin - titleBlockHeight - (reserve?.height ?? 0) - 4;
    const titleLeft = sheetSize.width - margin - Math.max(titleBlockWidth, reserve?.width ?? 0) - 4;
    const bottom = sheetSize.height - margin - inner - 4;

    /** Positions at scale k, and how much room is left (negative = does not fit). */
    const arrange = (k: number) => {
      const width = BAND.frontLeft + k * col1 + Math.max(BAND.topRight, BAND.gap) + k * col2;
      const row1H = Math.max(k * T.h, k * I.h) + BAND.label;
      const frontTop = BAND.frontAbove + row1H + BAND.gap; // from the top of the area
      const col1Bottom = frontTop + k * F.h + BAND.frontBelow;
      const col2Bottom = frontTop + k * R.h + BAND.label;
      const col1Right = area.minX + BAND.frontLeft + k * col1;
      // Column 2 always sits above the title block; column 1 only when it reaches it
      const col1Limit = col1Right > titleLeft ? titleTop : bottom;
      const roomX = area.maxX - area.minX - width;
      const roomY = Math.min(col1Limit - area.minY - col1Bottom, titleTop - area.minY - col2Bottom);
      return { width, row1H, frontTop, roomX, roomY };
    };
    // Largest standard scale that fits (ISO 5455); a non-standard one only for huge parts
    const STANDARD_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000];
    const fits = (k: number) => { const a = arrange(k); return a.roomX >= 0 && a.roomY >= 0; };
    let scale = STANDARD_SCALES.find(fits) ?? 0;
    if (!scale) {
      scale = 1 / 1000;
      while (!fits(scale) && scale > 1e-6) scale /= 2;
    }
    const scaleText = scale >= 1 ? `Scale: ${Math.round(scale)}:1` : `Scale: 1:${Math.round(1 / scale)}`;

    // Centre the arrangement horizontally; spread spare height above it
    const fitted = arrange(scale);
    const col1X = area.minX + Math.max(0, fitted.roomX) / 2 + BAND.frontLeft;
    const col2X = col1X + scale * col1 + Math.max(BAND.topRight, BAND.gap);
    const row1Y = area.minY + Math.max(0, fitted.roomY) / 3;
    const frontY = row1Y + fitted.frontTop;

    // Place a projected view (u right, v up) with its top-left corner at (x, y)
    // on the sheet (x right, y down)
    const placeView = (viewData: ProjectedView, x: number, y: number, label: string, labelBelow: number): SheetView => {
      const b = viewData.bounds;
      const offsetX = x - b.minX * scale;
      const offsetY = y + b.maxY * scale;
      const place = (p: Point2D): Point2D => ({ x: p.x * scale + offsetX, y: offsetY - p.y * scale });
      const transformLine = (line: DrawingLine): DrawingLine => ({ p1: place(line.p1), p2: place(line.p2), type: line.type });
      const bounds = {
        minX: b.minX * scale + offsetX,
        maxX: b.maxX * scale + offsetX,
        minY: offsetY - b.maxY * scale,
        maxY: offsetY - b.minY * scale,
      };
      return {
        label,
        labelY: bounds.maxY + labelBelow,
        view: viewData.view,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2,
        scale,
        offsetX,
        offsetY,
        visible: viewData.visible.map(transformLine),
        hidden: viewData.hidden.map(transformLine),
        bounds,
      };
    };

    const views = [
      // Top view directly above the front view (same x), front and right side by side (same y)
      placeView(topView, col1X, row1Y, 'TOP VIEW', BAND.label - 2),
      placeView(frontView, col1X, frontY, 'FRONT VIEW', BAND.frontBelow - 2),
      placeView(rightView, col2X, frontY, 'RIGHT VIEW', BAND.label - 2),
      placeView(isoView, col2X, row1Y, 'ISOMETRIC VIEW', BAND.label - 2),
    ];

    // Generate automatic overall dimensions on Front and Top views
    const dimensions = this._generateStandardDimensions(views[1], views[0], scale);

    // Add GD&T symbols & Feature Control Frames
    const gdtFrames = [
      // In the band above the front view
      this.createFeatureControlFrame(
        { x: views[1].bounds.minX, y: views[1].bounds.minY - 13 },
        { characteristic: GDT_SYMBOLS.PERPENDICULARITY.symbol, tolerance: '⌀0.05', datums: ['A'] }
      ),
      // On the bottom face of the front view, left of the width dimension text
      this.createDatumSymbol(
        { x: views[1].bounds.minX + Math.min(8, (views[1].bounds.maxX - views[1].bounds.minX) / 4), y: views[1].bounds.maxY },
        'A'
      ),
    ];

    const sheetData = {
      sheetSize,
      scale,
      views,
      dimensions,
      gdtFrames,
      border: {
        x: margin,
        y: margin,
        width: availWidth,
        height: availHeight,
        innerMargin: 2,
      },
      titleBlock: {
        x: sheetSize.width - margin - titleBlockWidth,
        y: sheetSize.height - margin - titleBlockHeight,
        width: titleBlockWidth,
        height: titleBlockHeight,
        title: sheetOptions.title || 'MECHANICAL COMPONENT',
        partNumber: sheetOptions.partNumber || 'CADW-001',
        material: sheetOptions.material || 'Steel 1020',
        scaleText,
        date: new Date().toISOString().slice(0, 10),
        revision: 'REV A',
      },
    };

    return sheetData;
  }

  /**
   * Helper: generate standard linear dimensions with witness/extension lines and arrows
   */
  _generateStandardDimensions(frontView: SheetView | undefined, topView: SheetView | undefined, scale: number): LinearDimension[] {
    const dims = [];

    if (frontView && frontView.bounds) {
      const fb = frontView.bounds;
      const width = fb.maxX - fb.minX;
      const height = fb.maxY - fb.minY;

      // Width dimension (horizontal bottom) - only if geometry has extent
      if (width > 1e-3) {
        dims.push(this.createLinearDimension(
          { x: fb.minX, y: fb.maxY },
          { x: fb.maxX, y: fb.maxY },
          { offset: 24, orientation: 'horizontal', text: `${(width / scale).toFixed(1)} mm` }
        ));
      }

      // Height dimension (vertical left) - only if geometry has extent
      if (height > 1e-3) {
        dims.push(this.createLinearDimension(
          { x: fb.minX, y: fb.minY },
          { x: fb.minX, y: fb.maxY },
          { offset: -14, orientation: 'vertical', text: `${(height / scale).toFixed(1)} mm` }
        ));
      }
    }

    if (topView && topView.bounds) {
      const tb = topView.bounds;
      const depth = tb.maxY - tb.minY;
      // Depth dimension (vertical right) - only if geometry has extent
      if (depth > 1e-3) {
        dims.push(this.createLinearDimension(
          { x: tb.maxX, y: tb.minY },
          { x: tb.maxX, y: tb.maxY },
          { offset: 12, orientation: 'vertical', text: `${(depth / scale).toFixed(1)} mm` }
        ));
      }
    }

    return dims;
  }

  /**
   * Create an ANSI / ISO linear dimension with extension lines, arrows, and formatted text
   */
  createLinearDimension(p1: Point2D, p2: Point2D, options: { offset?: number; orientation?: 'horizontal' | 'vertical' | 'aligned'; text?: string } = {}): LinearDimension {
    const offset = options.offset !== undefined ? options.offset : 10;
    const orientation = options.orientation || 'aligned';
    const text = options.text || `${Math.hypot(p2.x - p1.x, p2.y - p1.y).toFixed(1)}`;

    let dimP1 = { ...p1 };
    let dimP2 = { ...p2 };
    let ext1P1 = { ...p1 };
    let ext1P2 = { ...p1 };
    let ext2P1 = { ...p2 };
    let ext2P2 = { ...p2 };

    if (orientation === 'horizontal') {
      const yDim = Math.max(p1.y, p2.y) + offset;
      dimP1 = { x: p1.x, y: yDim };
      dimP2 = { x: p2.x, y: yDim };
      ext1P1 = { x: p1.x, y: p1.y + (offset > 0 ? 2 : -2) };
      ext1P2 = { x: p1.x, y: yDim + (offset > 0 ? 3 : -3) };
      ext2P1 = { x: p2.x, y: p2.y + (offset > 0 ? 2 : -2) };
      ext2P2 = { x: p2.x, y: yDim + (offset > 0 ? 3 : -3) };
    } else if (orientation === 'vertical') {
      const xDim = (offset > 0 ? Math.max(p1.x, p2.x) : Math.min(p1.x, p2.x)) + offset;
      dimP1 = { x: xDim, y: p1.y };
      dimP2 = { x: xDim, y: p2.y };
      ext1P1 = { x: p1.x + (offset > 0 ? 2 : -2), y: p1.y };
      ext1P2 = { x: xDim + (offset > 0 ? 3 : -3), y: p1.y };
      ext2P1 = { x: p2.x + (offset > 0 ? 2 : -2), y: p2.y };
      ext2P2 = { x: xDim + (offset > 0 ? 3 : -3), y: p2.y };
    }

    const midX = (dimP1.x + dimP2.x) / 2;
    const midY = (dimP1.y + dimP2.y) / 2;

    return {
      type: 'linear',
      dimLine: { p1: dimP1, p2: dimP2 },
      extLine1: { p1: ext1P1, p2: ext1P2 },
      extLine2: { p1: ext2P1, p2: ext2P2 },
      textPos: { x: midX, y: midY - 2 },
      text,
    };
  }

  /**
   * Create GD&T Feature Control Frame (ASME Y14.5 / ISO 1101)
   */
  createFeatureControlFrame(origin: Point2D, config: { characteristic?: string; tolerance?: string; datums?: string[] }): FeatureControlFrame {
    const height = 10;
    const charWidth = 10;
    const tolWidth = 22;
    const datumWidth = 10;
    const datums = config.datums || [];

    const totalWidth = charWidth + tolWidth + datums.length * datumWidth;

    return {
      type: 'gdt_fcf',
      x: origin.x,
      y: origin.y,
      width: totalWidth,
      height,
      characteristic: config.characteristic || GDT_SYMBOLS.POSITION.symbol,
      tolerance: config.tolerance || '0.05',
      datums,
      compartments: [
        { label: config.characteristic || GDT_SYMBOLS.POSITION.symbol, width: charWidth },
        { label: config.tolerance || '0.05', width: tolWidth },
        ...datums.map(d => ({ label: d, width: datumWidth })),
      ],
    };
  }

  /**
   * Create GD&T Datum Feature Symbol [ A ]
   */
  createDatumSymbol(origin: Point2D, datumLetter = 'A'): DatumSymbol {
    return {
      type: 'gdt_datum',
      x: origin.x,
      y: origin.y,
      letter: datumLetter,
      triangleSize: 4,
      boxWidth: 8,
      boxHeight: 8,
    };
  }

  /**
   * Export 2D Engineering Drawing Sheet to clean scalable vector SVG
   * @param {Object} sheetData - Data produced by createStandardSheet
   * @returns {string} SVG xml string
   */
  exportSVG(sheetData: SheetData | null | undefined): string {
    if (!sheetData) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 297 210" width="297mm" height="210mm"></svg>';
    const { sheetSize, border, titleBlock, views, dimensions, gdtFrames } = sheetData;
    const w = Math.max(10, Number(sheetSize?.width) || 297);
    const h = Math.max(10, Number(sheetSize?.height) || 210);

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" width="${w.toFixed(2)}mm" height="${h.toFixed(2)}mm">\n`;
    svg += `  <style>\n`;
    svg += `    .sheet-bg { fill: #ffffff; }\n`;
    svg += `    .border-outer { stroke: #000000; stroke-width: 0.7; fill: none; }\n`;
    svg += `    .border-inner { stroke: #000000; stroke-width: 0.35; fill: none; }\n`;
    svg += `    .visible-line { stroke: #111111; stroke-width: 0.45; stroke-linecap: round; }\n`;
    svg += `    .hidden-line { stroke: #666666; stroke-width: 0.25; stroke-dasharray: 2.5 1.5; }\n`;
    svg += `    .dim-line { stroke: #0055aa; stroke-width: 0.25; fill: none; }\n`;
    svg += `    .dim-text { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 3.2px; fill: #0055aa; text-anchor: middle; }\n`;
    svg += `    .view-label { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 3.5px; font-weight: bold; fill: #222222; text-anchor: middle; }\n`;
    svg += `    .tb-line { stroke: #000000; stroke-width: 0.35; }\n`;
    svg += `    .tb-text-title { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 4px; font-weight: bold; fill: #000; }\n`;
    svg += `    .tb-text-sm { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 2.5px; fill: #333; }\n`;
    svg += `    .gdt-rect { stroke: #000000; stroke-width: 0.35; fill: #ffffff; }\n`;
    svg += `    .gdt-text { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 3px; font-weight: bold; fill: #000; text-anchor: middle; }\n`;
    svg += `    .bom-head { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 2.6px; font-weight: bold; fill: #000; }\n`;
    svg += `    .bom-cell { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 2.6px; fill: #222; }\n`;
    svg += `    .balloon { stroke: #000; stroke-width: 0.35; fill: #fff; }\n`;
    svg += `    .balloon-leader { stroke: #000; stroke-width: 0.25; }\n`;
    svg += `    .balloon-dot { fill: #000; }\n`;
    svg += `    .balloon-text { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 3.4px; font-weight: bold; fill: #000; text-anchor: middle; }\n`;
    svg += `  </style>\n\n`;

    // 1. Background & Sheet Borders
    svg += `  <!-- Sheet Background & Borders -->\n`;
    svg += `  <rect class="sheet-bg" x="0" y="0" width="${w.toFixed(2)}" height="${h.toFixed(2)}" />\n`;
    if (border) {
      svg += `  <rect class="border-outer" x="${border.x.toFixed(2)}" y="${border.y.toFixed(2)}" width="${border.width.toFixed(2)}" height="${border.height.toFixed(2)}" />\n`;
      svg += `  <rect class="border-inner" x="${(border.x + border.innerMargin).toFixed(2)}" y="${(border.y + border.innerMargin).toFixed(2)}" width="${(border.width - 2 * border.innerMargin).toFixed(2)}" height="${(border.height - 2 * border.innerMargin).toFixed(2)}" />\n\n`;
    }

    // 2. Title Block
    if (titleBlock) {
      const tb = titleBlock;
      svg += `  <!-- Engineering Title Block -->\n`;
      svg += `  <g id="title-block">\n`;
      svg += `    <rect class="gdt-rect" x="${tb.x.toFixed(2)}" y="${tb.y.toFixed(2)}" width="${tb.width.toFixed(2)}" height="${tb.height.toFixed(2)}" />\n`;
      svg += `    <line class="tb-line" x1="${tb.x.toFixed(2)}" y1="${(tb.y + 15).toFixed(2)}" x2="${(tb.x + tb.width).toFixed(2)}" y2="${(tb.y + 15).toFixed(2)}" />\n`;
      svg += `    <line class="tb-line" x1="${tb.x.toFixed(2)}" y1="${(tb.y + 28).toFixed(2)}" x2="${(tb.x + tb.width).toFixed(2)}" y2="${(tb.y + 28).toFixed(2)}" />\n`;
      svg += `    <line class="tb-line" x1="${(tb.x + 45).toFixed(2)}" y1="${(tb.y + 15).toFixed(2)}" x2="${(tb.x + 45).toFixed(2)}" y2="${(tb.y + tb.height).toFixed(2)}" />\n`;
      svg += `    <text class="tb-text-title" x="${(tb.x + 5).toFixed(2)}" y="${(tb.y + 10).toFixed(2)}">${escapeXml(tb.title)}</text>\n`;
      svg += `    <text class="tb-text-sm" x="${(tb.x + 5).toFixed(2)}" y="${(tb.y + 22).toFixed(2)}">PART NO: ${escapeXml(tb.partNumber)}</text>\n`;
      svg += `    <text class="tb-text-sm" x="${(tb.x + 50).toFixed(2)}" y="${(tb.y + 22).toFixed(2)}">MATERIAL: ${escapeXml(tb.material)}</text>\n`;
      svg += `    <text class="tb-text-sm" x="${(tb.x + 5).toFixed(2)}" y="${(tb.y + 35).toFixed(2)}">${escapeXml(tb.scaleText)}</text>\n`;
      svg += `    <text class="tb-text-sm" x="${(tb.x + 50).toFixed(2)}" y="${(tb.y + 35).toFixed(2)}">DATE: ${escapeXml(tb.date)} | ${escapeXml(tb.revision)}</text>\n`;
      svg += `  </g>\n\n`;
    }

    // 3. Projections & Edge Geometry
    if (views) {
      svg += `  <!-- Orthographic Views -->\n`;
      for (const v of views) {
        const safeId = escapeXml(v.label.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, ''));
        svg += `  <g id="${safeId}">\n`;
        svg += `    <text class="view-label" x="${((v.bounds.minX + v.bounds.maxX) / 2).toFixed(2)}" y="${(v.labelY ?? v.bounds.maxY + 8).toFixed(2)}">${escapeXml(v.label)}</text>\n`;

        // Hidden lines first
        for (const line of (v.hidden || [])) {
          svg += `    <line class="hidden-line" x1="${line.p1.x.toFixed(2)}" y1="${line.p1.y.toFixed(2)}" x2="${line.p2.x.toFixed(2)}" y2="${line.p2.y.toFixed(2)}" />\n`;
        }

        // Visible lines
        for (const line of (v.visible || [])) {
          svg += `    <line class="visible-line" x1="${line.p1.x.toFixed(2)}" y1="${line.p1.y.toFixed(2)}" x2="${line.p2.x.toFixed(2)}" y2="${line.p2.y.toFixed(2)}" />\n`;
        }
        svg += `  </g>\n`;
      }
    }

    // 4. Dimensions
    if (dimensions && dimensions.length > 0) {
      svg += `  <!-- Dimensions -->\n  <g id="dimensions">\n`;
      for (const d of dimensions) {
        svg += `    <line class="dim-line" x1="${d.extLine1.p1.x.toFixed(2)}" y1="${d.extLine1.p1.y.toFixed(2)}" x2="${d.extLine1.p2.x.toFixed(2)}" y2="${d.extLine1.p2.y.toFixed(2)}" />\n`;
        svg += `    <line class="dim-line" x1="${d.extLine2.p1.x.toFixed(2)}" y1="${d.extLine2.p1.y.toFixed(2)}" x2="${d.extLine2.p2.x.toFixed(2)}" y2="${d.extLine2.p2.y.toFixed(2)}" />\n`;
        svg += `    <line class="dim-line" x1="${d.dimLine.p1.x.toFixed(2)}" y1="${d.dimLine.p1.y.toFixed(2)}" x2="${d.dimLine.p2.x.toFixed(2)}" y2="${d.dimLine.p2.y.toFixed(2)}" />\n`;
        svg += `    <text class="dim-text" x="${d.textPos.x.toFixed(2)}" y="${d.textPos.y.toFixed(2)}">${escapeXml(d.text)}</text>\n`;
      }
      svg += `  </g>\n`;
    }

    // 5. GD&T Feature Control Frames & Datums
    if (gdtFrames && gdtFrames.length > 0) {
      svg += `  <!-- GD&T Frames -->\n  <g id="gdt">\n`;
      for (const f of gdtFrames) {
        if (f.type === 'gdt_fcf') {
          svg += `    <g transform="translate(${f.x.toFixed(2)}, ${f.y.toFixed(2)})">\n`;
          let curX = 0;
          for (const c of f.compartments) {
            svg += `      <rect class="gdt-rect" x="${curX.toFixed(2)}" y="0" width="${c.width.toFixed(2)}" height="${f.height.toFixed(2)}" />\n`;
            svg += `      <text class="gdt-text" x="${(curX + c.width / 2).toFixed(2)}" y="${(f.height * 0.68).toFixed(2)}">${escapeXml(c.label)}</text>\n`;
            curX += c.width;
          }
          svg += `    </g>\n`;
        } else if (f.type === 'gdt_datum') {
          svg += `    <g transform="translate(${f.x.toFixed(2)}, ${f.y.toFixed(2)})">\n`;
          svg += `      <polygon points="0,0 -3,5 3,5" fill="#000" />\n`;
          svg += `      <line x1="0" y1="5" x2="0" y2="9" stroke="#000" stroke-width="0.35" />\n`;
          svg += `      <rect class="gdt-rect" x="-4" y="9" width="${f.boxWidth.toFixed(2)}" height="${f.boxHeight.toFixed(2)}" />\n`;
          svg += `      <text class="gdt-text" x="0" y="15">${escapeXml(f.letter)}</text>\n`;
          svg += `    </g>\n`;
        }
      }
      svg += `  </g>\n`;
    }

    // 6. Parts list and item balloons (assembly drawings)
    if (sheetData.bomTable) {
      const t = sheetData.bomTable;
      const width = t.columns.reduce((a, c) => a + c.width, 0);
      const all = [t.columns.map(c => c.title), ...t.rows];
      svg += `  <!-- Parts list -->\n  <g id="bom-table">\n`;
      svg += `    <rect class="gdt-rect" x="${t.x.toFixed(2)}" y="${t.y.toFixed(2)}" width="${width.toFixed(2)}" height="${(all.length * t.rowHeight).toFixed(2)}" />\n`;
      all.forEach((row, r) => {
        const y = t.y + r * t.rowHeight;
        if (r > 0) svg += `    <line class="tb-line" x1="${t.x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(t.x + width).toFixed(2)}" y2="${y.toFixed(2)}" />\n`;
        let x = t.x;
        t.columns.forEach((c, i) => {
          if (r === 0 && i > 0) svg += `    <line class="tb-line" x1="${x.toFixed(2)}" y1="${t.y.toFixed(2)}" x2="${x.toFixed(2)}" y2="${(t.y + all.length * t.rowHeight).toFixed(2)}" />\n`;
          const tx = c.align === 'right' ? x + c.width - 1.5 : c.align === 'center' ? x + c.width / 2 : x + 1.5;
          const anchor = c.align === 'right' ? 'end' : c.align === 'center' ? 'middle' : 'start';
          svg += `    <text class="${r === 0 ? 'bom-head' : 'bom-cell'}" text-anchor="${anchor}" x="${tx.toFixed(2)}" y="${(y + t.rowHeight * 0.68).toFixed(2)}">${escapeXml(row[i] ?? '')}</text>\n`;
          x += c.width;
        });
      });
      svg += `  </g>\n`;
    }
    if (sheetData.balloons?.length) {
      svg += `  <!-- Item balloons -->\n  <g id="balloons">\n`;
      for (const b of sheetData.balloons) {
        const dx = b.target.x - b.x, dy = b.target.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const sx = b.x + (dx / d) * b.radius, sy = b.y + (dy / d) * b.radius;
        svg += `    <line class="balloon-leader" x1="${sx.toFixed(2)}" y1="${sy.toFixed(2)}" x2="${b.target.x.toFixed(2)}" y2="${b.target.y.toFixed(2)}" />\n`;
        svg += `    <circle class="balloon-dot" cx="${b.target.x.toFixed(2)}" cy="${b.target.y.toFixed(2)}" r="0.6" />\n`;
        svg += `    <circle class="balloon" cx="${b.x.toFixed(2)}" cy="${b.y.toFixed(2)}" r="${b.radius.toFixed(2)}" />\n`;
        svg += `    <text class="balloon-text" x="${b.x.toFixed(2)}" y="${(b.y + 1.2).toFixed(2)}">${escapeXml(b.label)}</text>\n`;
      }
      svg += `  </g>\n`;
    }

    svg += `</svg>\n`;
    return svg;
  }

  /**
   * Export 2D Engineering Drawing Sheet to standard AutoCAD DXF vector format
   * @param {Object} sheetData
   * @returns {string} DXF string
   */
  /**
   * Export the sheet as DXF R12. Sheet coordinates are y-down (like SVG); DXF
   * is y-up, so y is flipped about the sheet height.
   */
  exportDXF(sheetData: SheetData | null | undefined): string {
    if (!sheetData) throw new Error('No drawing sheet to export');
    const { views, dimensions } = sheetData;
    const H = sheetData.sheetSize?.height ?? 210;
    const f = (v: number) => v.toFixed(3);
    const line = (layer: string, p1: Point2D, p2: Point2D) =>
      `0\nLINE\n8\n${layer}\n10\n${f(p1.x)}\n20\n${f(H - p1.y)}\n30\n0.0\n11\n${f(p2.x)}\n21\n${f(H - p2.y)}\n31\n0.0\n`;

    let dxf = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n';

    // TABLES: linetypes (layers may only reference defined linetypes), then layers
    dxf += '0\nSECTION\n2\nTABLES\n';
    dxf += '0\nTABLE\n2\nLTYPE\n70\n2\n';
    dxf += '0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n';
    dxf += '0\nLTYPE\n2\nDASHED\n70\n0\n3\n__ __ __ __\n72\n65\n73\n2\n40\n4.5\n49\n3.0\n49\n-1.5\n';
    dxf += '0\nENDTAB\n';
    dxf += '0\nTABLE\n2\nLAYER\n70\n4\n';
    dxf += '0\nLAYER\n2\nVISIBLE\n70\n0\n62\n7\n6\nCONTINUOUS\n';
    dxf += '0\nLAYER\n2\nHIDDEN\n70\n0\n62\n8\n6\nDASHED\n';
    dxf += '0\nLAYER\n2\nDIMENSION\n70\n0\n62\n4\n6\nCONTINUOUS\n';
    dxf += '0\nLAYER\n2\nBORDER\n70\n0\n62\n7\n6\nCONTINUOUS\n';
    dxf += '0\nENDTAB\n0\nENDSEC\n';

    dxf += '0\nSECTION\n2\nENTITIES\n';
    for (const v of views) {
      for (const l of v.visible) dxf += line('VISIBLE', l.p1, l.p2);
      for (const l of v.hidden) dxf += line('HIDDEN', l.p1, l.p2);
    }
    for (const d of dimensions ?? []) {
      dxf += line('DIMENSION', d.dimLine.p1, d.dimLine.p2);
      dxf += line('DIMENSION', d.extLine1.p1, d.extLine1.p2);
      dxf += line('DIMENSION', d.extLine2.p1, d.extLine2.p2);
      dxf += `0\nTEXT\n8\nDIMENSION\n10\n${f(d.textPos.x)}\n20\n${f(H - d.textPos.y)}\n30\n0.0\n40\n3.0\n1\n${d.text}\n`;
    }
    const text = (layer: string, x: number, y: number, h: number, s: string) =>
      `0\nTEXT\n8\n${layer}\n10\n${f(x)}\n20\n${f(H - y)}\n30\n0.0\n40\n${f(h)}\n1\n${s.replace(/[\r\n]+/g, ' ')}\n`;
    const t = sheetData.bomTable;
    if (t) {
      const width = t.columns.reduce((a, c) => a + c.width, 0);
      const all = [t.columns.map(c => c.title), ...t.rows];
      const bottom = t.y + all.length * t.rowHeight;
      for (let r = 0; r <= all.length; r++) dxf += line('BORDER', { x: t.x, y: t.y + r * t.rowHeight }, { x: t.x + width, y: t.y + r * t.rowHeight });
      let x = t.x;
      for (const c of [...t.columns, null]) {
        dxf += line('BORDER', { x, y: t.y }, { x, y: bottom });
        if (c) x += c.width;
      }
      all.forEach((row, r) => {
        let cx = t.x;
        t.columns.forEach((c, i) => { dxf += text('BORDER', cx + 1.5, t.y + (r + 0.7) * t.rowHeight, 2.2, row[i] ?? ''); cx += c.width; });
      });
    }
    for (const b of sheetData.balloons ?? []) {
      dxf += `0\nCIRCLE\n8\nDIMENSION\n10\n${f(b.x)}\n20\n${f(H - b.y)}\n30\n0.0\n40\n${f(b.radius)}\n`;
      const dx = b.target.x - b.x, dy = b.target.y - b.y, d = Math.hypot(dx, dy) || 1;
      dxf += line('DIMENSION', { x: b.x + (dx / d) * b.radius, y: b.y + (dy / d) * b.radius }, b.target);
      dxf += text('DIMENSION', b.x - 1, b.y + 1.2, 3.0, b.label);
    }
    dxf += '0\nENDSEC\n0\nEOF\n';
    return dxf;
  }
}

export const drawingEngine = new DrawingEngine();
export default DrawingEngine;

// =====================================================================
// Sheet layout checking
// =====================================================================

export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface SheetElementBox { kind: 'view' | 'label' | 'dimension' | 'gdt' | 'datum' | 'titleBlock' | 'bom' | 'balloon'; name: string; box: Box }

/** Approximate extent of a line of text (Helvetica-like proportions). */
function textBox(x: number, baseline: number, text: string, size: number, anchor: 'middle' | 'start' = 'middle'): Box {
  const w = text.length * size * 0.58;
  const minX = anchor === 'middle' ? x - w / 2 : x;
  return { minX, maxX: minX + w, minY: baseline - size * 0.8, maxY: baseline + size * 0.25 };
}

const segBox = (l: { p1: Point2D; p2: Point2D }): Box => ({
  minX: Math.min(l.p1.x, l.p2.x), maxX: Math.max(l.p1.x, l.p2.x), minY: Math.min(l.p1.y, l.p2.y), maxY: Math.max(l.p1.y, l.p2.y),
});

/** The area every drawn element of a sheet occupies (for layout checks). */
export function sheetElementBoxes(sheet: SheetData): SheetElementBox[] {
  const out: SheetElementBox[] = [];
  for (const v of sheet.views) {
    out.push({ kind: 'view', name: v.label, box: { ...v.bounds } });
    out.push({ kind: 'label', name: `${v.label} label`, box: textBox((v.bounds.minX + v.bounds.maxX) / 2, v.labelY ?? v.bounds.maxY + 8, v.label, 3.5) });
  }
  // A dimension is its three lines and its text (the space between the extension lines is free)
  sheet.dimensions.forEach((d, i) => {
    const name = `dimension ${i + 1} (${d.text})`;
    for (const box of [segBox(d.dimLine), segBox(d.extLine1), segBox(d.extLine2), textBox(d.textPos.x, d.textPos.y, d.text, 3.2)]) {
      out.push({ kind: 'dimension', name, box });
    }
  });
  for (const f of sheet.gdtFrames) {
    if (f.type === 'gdt_fcf') out.push({ kind: 'gdt', name: 'feature control frame', box: { minX: f.x, minY: f.y, maxX: f.x + f.width, maxY: f.y + f.height } });
    else out.push({ kind: 'datum', name: `datum ${f.letter}`, box: { minX: f.x - 4, minY: f.y, maxX: f.x + 4, maxY: f.y + 9 + f.boxHeight } });
  }
  if (sheet.bomTable) {
    const t = sheet.bomTable;
    const width = t.columns.reduce((a, c) => a + c.width, 0);
    out.push({ kind: 'bom', name: 'parts list', box: { minX: t.x, minY: t.y, maxX: t.x + width, maxY: t.y + (t.rows.length + 1) * t.rowHeight } });
  }
  (sheet.balloons ?? []).forEach(b => out.push({ kind: 'balloon', name: `balloon ${b.label}`, box: { minX: b.x - b.radius, minY: b.y - b.radius, maxX: b.x + b.radius, maxY: b.y + b.radius } }));
  const tb = sheet.titleBlock;
  if (tb) out.push({ kind: 'titleBlock', name: 'title block', box: { minX: tb.x, minY: tb.y, maxX: tb.x + tb.width, maxY: tb.y + tb.height } });
  return out;
}

/**
 * Layout problems of a sheet: elements that overlap (a datum may touch the
 * edge it marks) or leave the drawing border. Empty when the sheet is clean.
 */
export function layoutProblems(sheet: SheetData, gap = 0.5): string[] {
  const boxes = sheetElementBoxes(sheet);
  const problems: string[] = [];
  const b = sheet.border;
  const inner = b
    ? { minX: b.x + b.innerMargin, minY: b.y + b.innerMargin, maxX: b.x + b.width - b.innerMargin, maxY: b.y + b.height - b.innerMargin }
    : { minX: 0, minY: 0, maxX: sheet.sheetSize.width, maxY: sheet.sheetSize.height };
  for (const e of boxes) {
    // The title block and the parts list on it run out to the border line
    if (e.kind === 'titleBlock' || e.kind === 'bom') continue;
    if (e.box.minX < inner.minX - 1e-6 || e.box.minY < inner.minY - 1e-6 || e.box.maxX > inner.maxX + 1e-6 || e.box.maxY > inner.maxY + 1e-6) {
      problems.push(`${e.name} is outside the border`);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [p, q] = [boxes[i], boxes[j]];
      if (p.name === q.name) continue; // parts of one dimension
      // The datum triangle sits on the edge it marks
      // Boxes must be `t` apart; a datum may touch the view edge it marks
      const t = (p.kind === 'datum' && q.kind === 'view') || (q.kind === 'datum' && p.kind === 'view') ? -0.01 : gap;
      if (p.box.minX < q.box.maxX + t && q.box.minX < p.box.maxX + t && p.box.minY < q.box.maxY + t && q.box.minY < p.box.maxY + t) {
        problems.push(`${p.name} overlaps ${q.name}`);
      }
    }
  }
  return problems;
}
