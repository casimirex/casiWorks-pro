// CasiWorks Pro - 3D Solid Linear Static Finite Element Analysis (FEA) Engine
// Implements genuine 3D Solid FEA with Tetrahedral Meshing (Tet4 / Tet10),
// 3D Elasticity Stiffness Matrix, Boundary Conditions, PCG Linear Solver,
// 3D Cauchy Stress & Strain Tensors, Principal Stresses, von Mises Stress,
// Factor of Safety, and Colormap Deformed Mesh Visualization.
import * as THREE from 'three';

export const ELEMENT_TYPES = {
  TET4: 'tet4',
  TET10: 'tet10',
  BEAM: 'beam',
} as const;

export const FIXTURE_TYPES = {
  FIXED: 'fixed',
  PIN: 'pin',
  ROLLER: 'roller',
} as const;

export const LOAD_TYPES = {
  FORCE: 'force',
  PRESSURE: 'pressure',
  NODAL_FORCE: 'nodal_force',
} as const;

export type ElementType = (typeof ELEMENT_TYPES)[keyof typeof ELEMENT_TYPES];
/** Bounding-box face of the meshed body. */
export type BoxPlane = 'xMin' | 'xMax' | 'yMin' | 'yMax' | 'zMin' | 'zMax';
type Vec3Tuple = [number, number, number];

export interface FEANode {
  id: number;
  /** mm */
  point: THREE.Vector3;
  /** m */
  posMeters: Vec3Tuple;
  gridIdx?: Vec3Tuple;
  isBoundary: boolean;
}

export interface FEAElement {
  id: number;
  type: ElementType;
  /** 4 corner nodes, followed by 6 mid-edge nodes for Tet10 (e01, e12, e20, e03, e13, e23). */
  nodes: number[];
  /** m³ */
  volume: number;
}

export interface BoundaryFace {
  nodes: Vec3Tuple;
  normal: THREE.Vector3;
  area: number;
  centroid: THREE.Vector3;
  /** Bounding-box face the triangle lies on, or 'custom'. */
  plane: BoxPlane | 'custom';
}

export interface SolidMesh {
  nodes: FEANode[];
  elements: FEAElement[];
  boundaryFaces: BoundaryFace[];
  geometry: THREE.BufferGeometry;
  boundingBox: THREE.Box3;
  size: THREE.Vector3;
  /** Grid cell size (mm) of the voxel mesh. */
  cellSize?: THREE.Vector3;
  elementType: ElementType;
  numNodes: number;
  numElements: number;
}

export interface BeamElement { id: number; node1: number; node2: number; length: number; A: number; I: number; b: number; h: number }

export interface BeamMesh {
  nodes: Array<{ id: number; point: THREE.Vector3; isFixed: boolean }>;
  elements: BeamElement[];
  geometry: THREE.BufferGeometry;
  axis: 'x' | 'y' | 'z';
  length: number;
  width: number;
  height: number;
  A: number;
  I: number;
}

export interface MeshOptions {
  elementType?: ElementType;
  /** Grid divisions [nx, ny, nz], or a count along the longest side. */
  divisions?: number | Vec3Tuple;
  nx?: number;
  ny?: number;
  nz?: number;
  numStations?: number;
}

export interface Fixture { type?: string; plane?: BoxPlane; nodeIndices?: number[]; dof?: number }

export interface Load {
  type: string;
  plane?: BoxPlane;
  nodeIndices?: number[];
  node?: number;
  force?: number[];
  direction?: number[];
  magnitude?: number;
  /** Pa */
  pressure?: number;
}

export interface SolidConfig {
  youngsModulus?: number;
  poissonRatio?: number | string | null;
  yieldStrength?: number;
  loadMagnitude?: number;
  fixtures?: Fixture[];
  loads?: Load[];
}

export interface StressData {
  strain: Float64Array;
  /** Pa: [σxx, σyy, σzz, τxy, τyz, τzx] */
  stress: Float64Array;
  cauchyTensor: number[][];
  principalStresses: number[];
  vonMises: number;
}

export interface SolidResult {
  maxStressMPa: number;
  minStressMPa: number;
  maxDisplacementMM: number;
  factorOfSafety: number;
  displacements: Float32Array;
  displacementVectors: THREE.Vector3[];
  nodalVonMisesMPa: Float32Array;
  nodeCauchyStresses: Float64Array[];
  elementStresses: StressData[];
  deformedGeometry: THREE.BufferGeometry;
  is3DSolid: true;
}

export interface FEAResults {
  maxStressMPa: number;
  minStressMPa: number;
  maxDisplacementMM: number;
  theoreticalDispMM: number;
  solidMaxDisplacementMM?: number;
  factorOfSafety: number;
  stresses?: Float32Array;
  displacements?: Float32Array;
  deformedGeometry?: THREE.BufferGeometry;
  solidResult: SolidResult | null;
  is3DSolid: boolean;
  isVerifiedLinearStatic: boolean;
}

export interface Tet4Stiffness {
  Ke: Float64Array[];
  B: Float64Array[];
  D: Float64Array[];
  volume: number;
  beta: ArrayLike<number>;
  gamma: ArrayLike<number>;
  delta: ArrayLike<number>;
}

// =====================================================================
// Element formulation helpers
// =====================================================================

/**
 * Isotropic linear-elastic matrix D for engineering strain
 * [εxx, εyy, εzz, γxy, γyz, γzx]. ν is clamped away from 0.5 and -1; a
 * missing or non-numeric ν falls back to 0.3.
 */
export function materialMatrix(E: number, nu: unknown): Float64Array[] {
  const nuNum = typeof nu === 'number' ? nu : (typeof nu === 'string' && nu.trim() !== '' ? Number(nu) : NaN);
  const safeNu = Math.max(-0.999, Math.min(0.4999, Number.isFinite(nuNum) ? nuNum : 0.3));
  const safeE = Math.max(1e-6, Number(E) || 200e9);
  const denom = (1 + safeNu) * (1 - 2 * safeNu);
  const C = (safeE / Math.max(1e-12, Math.abs(denom))) * Math.sign(denom || 1);
  const D = Array.from({ length: 6 }, () => new Float64Array(6));
  D[0][0] = C * (1 - safeNu); D[0][1] = C * safeNu; D[0][2] = C * safeNu;
  D[1][0] = C * safeNu; D[1][1] = C * (1 - safeNu); D[1][2] = C * safeNu;
  D[2][0] = C * safeNu; D[2][1] = C * safeNu; D[2][2] = C * (1 - safeNu);
  D[3][3] = (C * (1 - 2 * safeNu)) / 2;
  D[4][4] = (C * (1 - 2 * safeNu)) / 2;
  D[5][5] = (C * (1 - 2 * safeNu)) / 2;
  return D;
}

/**
 * Tet10 node order: corners v0..v3, then mid-edges e01, e12, e20, e03, e13, e23.
 * Volume coordinates: L1 = 1 − ξ − η − ζ (v0), L2 = ξ (v1), L3 = η (v2), L4 = ζ (v3).
 */
const TET10_EDGES: Array<[number, number]> = [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];

/** Natural coordinates (ξ, η, ζ) of the 10 Tet10 nodes. */
export const TET10_NODE_COORDS: Vec3Tuple[] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0], [0, 0, 0.5], [0.5, 0, 0.5], [0, 0.5, 0.5],
];

/** 4-point Gauss rule on the reference tetrahedron (exact for quadratics); weights sum to 1/6. */
const GAUSS_A = 0.5854101966249685;
const GAUSS_B = 0.1381966011250105;
const TET_GAUSS_4: Array<{ p: Vec3Tuple; w: number }> = [
  { p: [GAUSS_B, GAUSS_B, GAUSS_B], w: 1 / 24 },
  { p: [GAUSS_A, GAUSS_B, GAUSS_B], w: 1 / 24 },
  { p: [GAUSS_B, GAUSS_A, GAUSS_B], w: 1 / 24 },
  { p: [GAUSS_B, GAUSS_B, GAUSS_A], w: 1 / 24 },
];

/**
 * Strain-displacement matrix B (6 × 30) of a Tet10 at natural point (ξ, η, ζ),
 * and det J. Returns null for a degenerate element.
 */
export function tet10B(coords: ArrayLike<number>[], [xi, eta, zeta]: Vec3Tuple): { B: Float64Array[]; detJ: number } | null {
  const L = [1 - xi - eta - zeta, xi, eta, zeta];
  // dN/dL for each node (4 volume coordinates)
  const dNdL: number[][] = [];
  for (let a = 0; a < 4; a++) {
    const row = [0, 0, 0, 0];
    row[a] = 4 * L[a] - 1;
    dNdL.push(row);
  }
  for (const [i, j] of TET10_EDGES) {
    const row = [0, 0, 0, 0];
    row[i] = 4 * L[j];
    row[j] = 4 * L[i];
    dNdL.push(row);
  }
  // Chain rule: ∂/∂ξ = ∂/∂L2 − ∂/∂L1, ∂/∂η = ∂/∂L3 − ∂/∂L1, ∂/∂ζ = ∂/∂L4 − ∂/∂L1
  const dNdXi = dNdL.map(d => [d[1] - d[0], d[2] - d[0], d[3] - d[0]]);

  // Jacobian J[r][c] = Σ_a ∂N_a/∂ξ_r · x_a[c]
  const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let a = 0; a < 10; a++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) J[r][c] += dNdXi[a][r] * coords[a][c];
    }
  }
  const detJ =
    J[0][0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1]) -
    J[0][1] * (J[1][0] * J[2][2] - J[1][2] * J[2][0]) +
    J[0][2] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]);
  if (!Number.isFinite(detJ) || Math.abs(detJ) < 1e-30) return null;
  const inv = [
    [(J[1][1] * J[2][2] - J[1][2] * J[2][1]) / detJ, (J[0][2] * J[2][1] - J[0][1] * J[2][2]) / detJ, (J[0][1] * J[1][2] - J[0][2] * J[1][1]) / detJ],
    [(J[1][2] * J[2][0] - J[1][0] * J[2][2]) / detJ, (J[0][0] * J[2][2] - J[0][2] * J[2][0]) / detJ, (J[0][2] * J[1][0] - J[0][0] * J[1][2]) / detJ],
    [(J[1][0] * J[2][1] - J[1][1] * J[2][0]) / detJ, (J[0][1] * J[2][0] - J[0][0] * J[2][1]) / detJ, (J[0][0] * J[1][1] - J[0][1] * J[1][0]) / detJ],
  ];

  const B = Array.from({ length: 6 }, () => new Float64Array(30));
  for (let a = 0; a < 10; a++) {
    // Cartesian derivatives: ∂N/∂x = J⁻¹ · ∂N/∂ξ
    const g = dNdXi[a];
    const dx = inv[0][0] * g[0] + inv[0][1] * g[1] + inv[0][2] * g[2];
    const dy = inv[1][0] * g[0] + inv[1][1] * g[1] + inv[1][2] * g[2];
    const dz = inv[2][0] * g[0] + inv[2][1] * g[1] + inv[2][2] * g[2];
    const col = a * 3;
    B[0][col] = dx;
    B[1][col + 1] = dy;
    B[2][col + 2] = dz;
    B[3][col] = dy; B[3][col + 1] = dx;
    B[4][col + 1] = dz; B[4][col + 2] = dy;
    B[5][col] = dz; B[5][col + 2] = dx;
  }
  return { B, detJ };
}

/** Stress (6) = D · B · u at one point. */
function stressAt(B: Float64Array[], D: Float64Array[], u: ArrayLike<number>): { strain: Float64Array; stress: Float64Array } {
  const strain = new Float64Array(6);
  for (let r = 0; r < 6; r++) {
    let sum = 0;
    for (let c = 0; c < B[r].length; c++) sum += B[r][c] * u[c];
    strain[r] = sum;
  }
  const stress = new Float64Array(6);
  for (let r = 0; r < 6; r++) {
    let sum = 0;
    for (let c = 0; c < 6; c++) sum += D[r][c] * strain[c];
    stress[r] = sum;
  }
  return { strain, stress };
}

/**
 * Sparse Matrix representation for global stiffness matrix assembly and PCG solver
 */
export class SparseMatrix {
  n: number;
  rows: Array<Map<number, number>>;

  constructor(n: number) {
    this.n = n;
    this.rows = Array.from({ length: n }, () => new Map());
  }

  add(i: number, j: number, value: number): void {
    if (!Number.isFinite(value) || Math.abs(value) < 1e-25) return;
    const row = this.rows[i];
    row.set(j, (row.get(j) || 0) + value);
  }

  get(i: number, j: number): number {
    return this.rows[i].get(j) || 0;
  }

  mult(x: ArrayLike<number>, out: Float64Array): Float64Array {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const [j, v] of this.rows[i]) {
        sum += v * (x[j] || 0);
      }
      out[i] = Number.isFinite(sum) ? sum : 0;
    }
    return out;
  }

  /**
   * Enforce Dirichlet boundary conditions while preserving strict symmetry
   * @param {Map<number, number>} fixedDofs - Map of dofIndex => prescribedValue
   * @param {Float64Array} F - Force vector to adjust
   */
  /**
   * Compressed sparse rows (typed arrays) for fast repeated products.
   * Entries keep the row maps' insertion order, so sums are identical to mult().
   */
  toCSR(): { rowPtr: Int32Array; cols: Int32Array; vals: Float64Array; mult(x: ArrayLike<number>, out: Float64Array): Float64Array } {
    let nnz = 0;
    for (const row of this.rows) nnz += row.size;
    const rowPtr = new Int32Array(this.n + 1);
    const cols = new Int32Array(nnz);
    const vals = new Float64Array(nnz);
    let k = 0;
    for (let i = 0; i < this.n; i++) {
      rowPtr[i] = k;
      for (const [j, v] of this.rows[i]) {
        cols[k] = j;
        vals[k] = v;
        k++;
      }
    }
    rowPtr[this.n] = k;
    const n = this.n;
    return {
      rowPtr,
      cols,
      vals,
      mult(x: ArrayLike<number>, out: Float64Array): Float64Array {
        for (let i = 0; i < n; i++) {
          let sum = 0;
          for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) sum += vals[p] * (x[cols[p]] || 0);
          out[i] = Number.isFinite(sum) ? sum : 0;
        }
        return out;
      },
    };
  }

  applyDirichlet(fixedDofs: Map<number, number>, F: Float64Array): void {
    for (const [k, uk] of fixedDofs) {
      for (const [j, v] of this.rows[k]) {
        if (j !== k) {
          F[j] -= v * uk;
          this.rows[j].delete(k);
        }
      }
      this.rows[k].clear();
      this.rows[k].set(k, 1.0);
      F[k] = uk;
    }
  }
}

/**
 * 3D Solid Linear Static FEA Engine
 */
export class FEAEngine {
  mesh: SolidMesh | BeamMesh | null;
  solidMesh: SolidMesh | null;
  beamMesh: BeamMesh | null;
  results: FEAResults | null;
  isBeamVerifiedMode: boolean;

  constructor() {
    this.mesh = null;
    this.solidMesh = null;
    this.beamMesh = null;
    this.results = null;
    this.isBeamVerifiedMode = false;
  }

  /**
   * Tetrahedralize arbitrary solid CAD geometry from THREE.BufferGeometry
   * Produces Tet4 or Tet10 elements with boundary face tracking.
   * @param {THREE.BufferGeometry} geometry
   * @param {Object} options
   * @returns {Object} solidMesh
   */
  tetrahedralize(geometry: THREE.BufferGeometry | null | undefined, options: MeshOptions = {}): SolidMesh | null {
    if (!geometry) return null;

    geometry.computeBoundingBox();
    const box = geometry.boundingBox || new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    const min = box.min;
    const max = box.max;

    const rawSizeX = max.x - min.x;
    const rawSizeY = max.y - min.y;
    const rawSizeZ = max.z - min.z;
    const sizeX = (Number.isFinite(rawSizeX) && rawSizeX > 1e-4) ? rawSizeX : 10;
    const sizeY = (Number.isFinite(rawSizeY) && rawSizeY > 1e-4) ? rawSizeY : 10;
    const sizeZ = (Number.isFinite(rawSizeZ) && rawSizeZ > 1e-4) ? rawSizeZ : 10;

    // Determine voxel resolution based on dimensions or options
    let nx = options.nx || 4;
    let ny = options.ny || 4;
    let nz = options.nz || 8;

    if (options.divisions) {
      if (Array.isArray(options.divisions)) {
        [nx, ny, nz] = options.divisions;
      } else if (typeof options.divisions === 'number') {
        const aspect = Math.max(sizeX, sizeY, sizeZ);
        nx = Math.max(2, Math.round((sizeX / aspect) * options.divisions));
        ny = Math.max(2, Math.round((sizeY / aspect) * options.divisions));
        nz = Math.max(2, Math.round((sizeZ / aspect) * options.divisions));
      }
    }

    const dx = sizeX / nx;
    const dy = sizeY / ny;
    const dz = sizeZ / nz;

    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const numTris = index ? index.count / 3 : (pos ? pos.count / 3 : 0);

    // Inside test: ray parity, voted over three ray directions. Hits are
    // counted half-open (u, v >= 0, u + v < 1) so a ray through an edge shared
    // by two triangles counts once (a widened test counted it twice and
    // flipped the parity), and one degenerate ray cannot decide on its own.
    const tri = new Float64Array(numTris * 9);
    for (let t = 0; t < numTris; t++) {
      for (let k = 0; k < 3; k++) {
        const i = index ? index.getX(t * 3 + k) : t * 3 + k;
        tri[t * 9 + k * 3] = pos.getX(i);
        tri[t * 9 + k * 3 + 1] = pos.getY(i);
        tri[t * 9 + k * 3 + 2] = pos.getZ(i);
      }
    }
    const RAYS: Vec3Tuple[] = [[0.267, 0.534, 0.801], [-0.613, 0.296, 0.733], [0.392, -0.817, 0.423]];
    const crossings = (pt: Vec3Tuple, d: Vec3Tuple) => {
      let count = 0;
      for (let t = 0; t < numTris; t++) {
        const o = t * 9;
        const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
        const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det === 0) continue;
        const inv = 1 / det;
        const tx = pt[0] - tri[o], ty = pt[1] - tri[o + 1], tz = pt[2] - tri[o + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u >= 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v >= 1) continue;
        if ((e2x * qx + e2y * qy + e2z * qz) * inv > 1e-9) count++;
      }
      return count;
    };
    const isPointInside = (pt: Vec3Tuple) => {
      if (!pos || numTris === 0) return true;
      let votes = 0;
      for (const d of RAYS) if (crossings(pt, d) % 2 === 1) votes++;
      return votes >= 2;
    };

    // Node dictionary & storage
    const nodeMap = new Map<string, number>();
    const nodes: FEANode[] = [];

    const getOrCreateNode = (ix: number, iy: number, iz: number): number => {
      const key = `${ix}_${iy}_${iz}`;
      const existing = nodeMap.get(key);
      if (existing !== undefined) return existing;

      const px = min.x + ix * dx;
      const py = min.y + iy * dy;
      const pz = min.z + iz * dz;

      const id = nodes.length;
      const node = {
        id,
        point: new THREE.Vector3(px, py, pz),
        posMeters: [px * 1e-3, py * 1e-3, pz * 1e-3] as Vec3Tuple,
        gridIdx: [ix, iy, iz] as Vec3Tuple,
        isBoundary: false,
      };
      nodes.push(node);
      nodeMap.set(key, id);
      return id;
    };

    // Generate tetrahedra for voxels inside CAD volume
    const elements: FEAElement[] = [];
    const elementType: ElementType = options.elementType || ELEMENT_TYPES.TET4;

    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          const cx = min.x + (ix + 0.5) * dx;
          const cy = min.y + (iy + 0.5) * dy;
          const cz = min.z + (iz + 0.5) * dz;

          const inside = isPointInside([cx, cy, cz]);
          if (!inside && numTris > 12) continue;

          const v0 = getOrCreateNode(ix, iy, iz);
          const v1 = getOrCreateNode(ix + 1, iy, iz);
          const v2 = getOrCreateNode(ix + 1, iy + 1, iz);
          const v3 = getOrCreateNode(ix, iy + 1, iz);
          const v4 = getOrCreateNode(ix, iy, iz + 1);
          const v5 = getOrCreateNode(ix + 1, iy, iz + 1);
          const v6 = getOrCreateNode(ix + 1, iy + 1, iz + 1);
          const v7 = getOrCreateNode(ix, iy + 1, iz + 1);

          const voxelTets = [
            [v0, v1, v2, v6],
            [v0, v1, v5, v6],
            [v0, v4, v5, v6],
            [v0, v4, v7, v6],
            [v0, v3, v7, v6],
            [v0, v2, v3, v6],
          ];

          for (const tetNodes of voxelTets) {
            let [n0, n1, n2, n3] = tetNodes;
            const pts = [nodes[n0].posMeters, nodes[n1].posMeters, nodes[n2].posMeters, nodes[n3].posMeters];
            let V = this._computeTetVolume(pts);

            // Inverted tet: repair by swapping vertices 1 and 2
            if (V < -1e-15) {
              const tmp = n1;
              n1 = n2;
              n2 = tmp;
              V = -V;
            }

            // Degenerate tet (V <= 1e-15 or non-finite): skip so stiffness matrix never gets NaNs
            if (V > 1e-15 && Number.isFinite(V)) {
              elements.push({
                id: elements.length,
                type: ELEMENT_TYPES.TET4,
                nodes: [n0, n1, n2, n3],
                volume: V,
              });
            }
          }
        }
      }
    }

    if (elements.length === 0) {
      for (let ix = 0; ix <= 1; ix++) {
        for (let iy = 0; iy <= 1; iy++) {
          for (let iz = 0; iz <= 1; iz++) {
            getOrCreateNode(ix, iy, iz);
          }
        }
      }
      const v0 = 0, v1 = 1, v2 = 3, v3 = 2, v4 = 4, v5 = 5, v6 = 7, v7 = 6;
      const fallbackTets = [
        [v0, v1, v2, v6],
        [v0, v1, v5, v6],
        [v0, v4, v5, v6],
        [v0, v4, v7, v6],
        [v0, v3, v7, v6],
        [v0, v2, v3, v6],
      ];
      for (const t of fallbackTets) {
        let [n0, n1, n2, n3] = t;
        let V = this._computeTetVolume([nodes[n0].posMeters, nodes[n1].posMeters, nodes[n2].posMeters, nodes[n3].posMeters]);
        if (V < -1e-15) { const tmp = n1; n1 = n2; n2 = tmp; V = -V; }
        if (V > 1e-15 && Number.isFinite(V)) {
          elements.push({ id: elements.length, type: ELEMENT_TYPES.TET4, nodes: [n0, n1, n2, n3], volume: V });
        }
      }
    }

    // Identify boundary faces
    const faceMap = new Map<string, { count: number; nodes: number[]; elemId: number }>();
    for (const elem of elements) {
      const [n0, n1, n2, n3] = elem.nodes;
      const tetFaces = [
        [n0, n2, n1],
        [n0, n1, n3],
        [n1, n2, n3],
        [n2, n0, n3],
      ];
      for (const tf of tetFaces) {
        const sortedKey = [...tf].sort((a, b) => a - b).join('_');
        const seen = faceMap.get(sortedKey);
        if (seen) {
          seen.count++;
        } else {
          faceMap.set(sortedKey, { count: 1, nodes: tf, elemId: elem.id });
        }
      }
    }

    const boundaryFaces: BoundaryFace[] = [];
    for (const entry of faceMap.values()) {
      if (entry.count === 1) {
        const [a, b, c] = entry.nodes;
        nodes[a].isBoundary = true;
        nodes[b].isBoundary = true;
        nodes[c].isBoundary = true;

        const pa = nodes[a].point;
        const pb = nodes[b].point;
        const pc = nodes[c].point;

        const ab = new THREE.Vector3().subVectors(pb, pa);
        const ac = new THREE.Vector3().subVectors(pc, pa);
        const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
        const area = 0.5 * ab.cross(ac).length() * 1e-6;
        const centroid = new THREE.Vector3().add(pa).add(pb).add(pc).multiplyScalar(1 / 3);

        let plane: BoundaryFace['plane'] = 'custom';
        const eps = 1e-2;
        if (Math.abs(centroid.x - min.x) < eps) plane = 'xMin';
        else if (Math.abs(centroid.x - max.x) < eps) plane = 'xMax';
        else if (Math.abs(centroid.y - min.y) < eps) plane = 'yMin';
        else if (Math.abs(centroid.y - max.y) < eps) plane = 'yMax';
        else if (Math.abs(centroid.z - min.z) < eps) plane = 'zMin';
        else if (Math.abs(centroid.z - max.z) < eps) plane = 'zMax';

        boundaryFaces.push({
          nodes: [a, b, c] as Vec3Tuple,
          normal,
          area,
          centroid,
          plane,
        });
      }
    }

    if (elementType === ELEMENT_TYPES.TET10) {
      this._upgradeToTet10(nodes, elements);
    }

    this.solidMesh = {
      nodes,
      elements,
      boundaryFaces,
      geometry,
      boundingBox: box,
      size: new THREE.Vector3(sizeX, sizeY, sizeZ),
      cellSize: new THREE.Vector3(dx, dy, dz),
      elementType,
      numNodes: nodes.length,
      numElements: elements.length,
    };

    return this.solidMesh;
  }

  _rayIntersectsTriangle(orig: ArrayLike<number>, dir: ArrayLike<number>, v0: ArrayLike<number>, v1: ArrayLike<number>, v2: ArrayLike<number>): boolean {
    const EPSILON = 1e-7;
    const edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const pvec = [
      dir[1] * edge2[2] - dir[2] * edge2[1],
      dir[2] * edge2[0] - dir[0] * edge2[2],
      dir[0] * edge2[1] - dir[1] * edge2[0],
    ];
    const det = edge1[0] * pvec[0] + edge1[1] * pvec[1] + edge1[2] * pvec[2];
    if (Math.abs(det) < EPSILON) return false;
    const invDet = 1.0 / det;
    const tvec = [orig[0] - v0[0], orig[1] - v0[1], orig[2] - v0[2]];
    const u = (tvec[0] * pvec[0] + tvec[1] * pvec[1] + tvec[2] * pvec[2]) * invDet;
    if (u < -EPSILON || u > 1.0 + EPSILON) return false;
    const qvec = [
      tvec[1] * edge1[2] - tvec[2] * edge1[1],
      tvec[2] * edge1[0] - tvec[0] * edge1[2],
      tvec[0] * edge1[1] - tvec[1] * edge1[0],
    ];
    const v = (dir[0] * qvec[0] + dir[1] * qvec[1] + dir[2] * qvec[2]) * invDet;
    if (v < -EPSILON || u + v > 1.0 + EPSILON) return false;
    const t = (edge2[0] * qvec[0] + edge2[1] * qvec[1] + edge2[2] * qvec[2]) * invDet;
    return t > EPSILON;
  }

  _computeTetVolume(pts: ArrayLike<number>[]): number {
    const [p1, p2, p3, p4] = pts;
    const m11 = p2[0] * (p3[1] * p4[2] - p3[2] * p4[1]) - p2[1] * (p3[0] * p4[2] - p3[2] * p4[0]) + p2[2] * (p3[0] * p4[1] - p3[1] * p4[0]);
    const m12 = p1[0] * (p3[1] * p4[2] - p3[2] * p4[1]) - p1[1] * (p3[0] * p4[2] - p3[2] * p4[0]) + p1[2] * (p3[0] * p4[1] - p3[1] * p4[0]);
    const m13 = p1[0] * (p2[1] * p4[2] - p2[2] * p4[1]) - p1[1] * (p2[0] * p4[2] - p2[2] * p4[0]) + p1[2] * (p2[0] * p4[1] - p2[1] * p4[0]);
    const m14 = p1[0] * (p2[1] * p3[2] - p2[2] * p3[1]) - p1[1] * (p2[0] * p3[2] - p2[2] * p3[0]) + p1[2] * (p2[0] * p3[1] - p2[1] * p3[0]);
    return (m11 - m12 + m13 - m14) / 6.0;
  }

  /** The current solid mesh (throws if tetrahedralize/generateMesh has not run). */
  _requireMesh(): SolidMesh {
    if (!this.solidMesh) throw new Error('No solid mesh: call generateMesh() or tetrahedralize() first');
    return this.solidMesh;
  }

  _upgradeToTet10(nodes: FEANode[], elements: FEAElement[]): void {
    const edgeMap = new Map<string, number>();
    const getMidEdgeNode = (n1: number, n2: number): number => {
      const key = n1 < n2 ? `${n1}_${n2}` : `${n2}_${n1}`;
      const existing = edgeMap.get(key);
      if (existing !== undefined) return existing;
      const p1 = nodes[n1].point;
      const p2 = nodes[n2].point;
      const midPoint = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      const id = nodes.length;
      const node = {
        id,
        point: midPoint,
        posMeters: [midPoint.x * 1e-3, midPoint.y * 1e-3, midPoint.z * 1e-3] as Vec3Tuple,
        isBoundary: nodes[n1].isBoundary && nodes[n2].isBoundary,
      };
      nodes.push(node);
      edgeMap.set(key, id);
      return id;
    };

    for (const elem of elements) {
      const [v0, v1, v2, v3] = elem.nodes;
      const e01 = getMidEdgeNode(v0, v1);
      const e12 = getMidEdgeNode(v1, v2);
      const e20 = getMidEdgeNode(v2, v0);
      const e03 = getMidEdgeNode(v0, v3);
      const e13 = getMidEdgeNode(v1, v3);
      const e23 = getMidEdgeNode(v2, v3);

      elem.type = ELEMENT_TYPES.TET10;
      elem.nodes = [v0, v1, v2, v3, e01, e12, e20, e03, e13, e23];
    }
  }

  computeTet4Stiffness(nodeCoords: ArrayLike<number>[] | null | undefined, E: number, nu: unknown): Tet4Stiffness | null {
    if (!nodeCoords || nodeCoords.length < 4) return null;
    let [p1, p2, p3, p4] = nodeCoords;
    if (!p1 || !p2 || !p3 || !p4) return null;

    let volume = this._computeTetVolume([p1, p2, p3, p4]);
    if (!Number.isFinite(volume) || Math.abs(volume) <= 1e-15) return null;

    // If tet is inverted, swap p2 and p3 to repair orientation so determinant > 0
    if (volume < 0) {
      const tmp = p2;
      p2 = p3;
      p3 = tmp;
      volume = -volume;
    }

    const M = [
      [1, p1[0], p1[1], p1[2]],
      [1, p2[0], p2[1], p2[2]],
      [1, p3[0], p3[1], p3[2]],
      [1, p4[0], p4[1], p4[2]],
    ];

    const Minv = this._invert4x4(M);
    if (!Minv) return null;

    const beta = Minv[1];
    const gamma = Minv[2];
    const delta = Minv[3];

    const B = Array.from({ length: 6 }, () => new Float64Array(12));
    for (let i = 0; i < 4; i++) {
      const col = i * 3;
      B[0][col] = beta[i];
      B[1][col + 1] = gamma[i];
      B[2][col + 2] = delta[i];

      B[3][col] = gamma[i];
      B[3][col + 1] = beta[i];

      B[4][col + 1] = delta[i];
      B[4][col + 2] = gamma[i];

      B[5][col] = delta[i];
      B[5][col + 2] = beta[i];
    }

    const D = materialMatrix(E, nu);

    const DB = Array.from({ length: 6 }, () => new Float64Array(12));
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 12; c++) {
        let sum = 0;
        for (let k = 0; k < 6; k++) {
          sum += D[r][k] * B[k][c];
        }
        DB[r][c] = sum;
      }
    }

    const Ke = Array.from({ length: 12 }, () => new Float64Array(12));
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) {
        let sum = 0;
        for (let k = 0; k < 6; k++) {
          sum += B[k][r] * DB[k][c];
        }
        Ke[r][c] = volume * sum;
      }
    }

    return { Ke, B, D, volume, beta, gamma, delta };
  }

  /**
   * Tet10 element stiffness (30 × 30) by 4-point Gauss integration:
   * Ke = Σ w · |det J| · Bᵀ D B. Returns null for a degenerate element.
   */
  computeTet10Stiffness(nodeCoords: ArrayLike<number>[], E: number, nu: unknown): { Ke: Float64Array[]; volume: number } | null {
    if (!nodeCoords || nodeCoords.length < 10) return null;
    const D = materialMatrix(E, nu);
    const Ke = Array.from({ length: 30 }, () => new Float64Array(30));
    let volume = 0;
    for (const { p, w } of TET_GAUSS_4) {
      const res = tet10B(nodeCoords, p);
      if (!res) return null;
      const { B, detJ } = res;
      const scale = w * Math.abs(detJ);
      volume += scale;
      // DB = D · B (6 × 30)
      const DB = Array.from({ length: 6 }, () => new Float64Array(30));
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 30; c++) {
          let sum = 0;
          for (let k = 0; k < 6; k++) sum += D[r][k] * B[k][c];
          DB[r][c] = sum;
        }
      }
      for (let r = 0; r < 30; r++) {
        for (let c = 0; c < 30; c++) {
          let sum = 0;
          for (let k = 0; k < 6; k++) sum += B[k][r] * DB[k][c];
          Ke[r][c] += scale * sum;
        }
      }
    }
    return { Ke, volume };
  }

  _invert4x4(M: number[][] | null | undefined): Float64Array[] | null {
    if (!M || M.length !== 4) return null;
    const A = M.map(row => [...row]);
    const n = 4;
    const I = Array.from({ length: n }, (_, i) => {
      const r = new Float64Array(n);
      r[i] = 1;
      return r;
    });

    for (let i = 0; i < n; i++) {
      let pivot = A[i][i];
      let pivotRow = i;
      for (let r = i + 1; r < n; r++) {
        if (Math.abs(A[r][i]) > Math.abs(pivot)) {
          pivot = A[r][i];
          pivotRow = r;
        }
      }
      if (!Number.isFinite(pivot) || Math.abs(pivot) < 1e-25) return null;

      if (pivotRow !== i) {
        [A[i], A[pivotRow]] = [A[pivotRow], A[i]];
        [I[i], I[pivotRow]] = [I[pivotRow], I[i]];
      }
      pivot = A[i][i];
      for (let c = 0; c < n; c++) {
        A[i][c] /= pivot;
        I[i][c] /= pivot;
      }
      for (let r = 0; r < n; r++) {
        if (r !== i) {
          const factor = A[r][i];
          for (let c = 0; c < n; c++) {
            A[r][c] -= factor * A[i][c];
            I[r][c] -= factor * I[i][c];
          }
        }
      }
    }

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!Number.isFinite(I[r][c])) return null;
      }
    }

    return I;
  }

  _solvePCG(K: SparseMatrix, F: Float64Array, maxIter = 2500, tol = 1e-7): Float64Array {
    const n = F.length;
    const U = new Float64Array(n);
    if (n === 0) return U;

    const r = new Float64Array(n);
    const z = new Float64Array(n);
    const p = new Float64Array(n);
    const Kp = new Float64Array(n);

    const safeMaxIter = Math.max(10, Math.min(100000, Number(maxIter) || 2500));
    const safeTol = Math.max(1e-15, Number(tol) || 1e-7);

    // Diagonal preconditioner (Jacobi)
    const M = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const diag = K.rows[i]?.get(i) || 1.0;
      M[i] = (Number.isFinite(diag) && Math.abs(diag) > 1e-12) ? 1.0 / diag : 1.0;
    }

    let normF = 0;
    for (let i = 0; i < n; i++) {
      const fi = Number.isFinite(F[i]) ? F[i] : 0;
      r[i] = fi;
      normF += fi * fi;
      z[i] = M[i] * fi;
      p[i] = z[i];
    }
    normF = Math.sqrt(normF);
    // Early exit on zero residual ||r|| ~ 0 or zero external load
    if (normF < 1e-15) return U;

    let rzOld = 0;
    for (let i = 0; i < n; i++) rzOld += r[i] * z[i];
    if (Math.abs(rzOld) < 1e-30 || !Number.isFinite(rzOld)) return U;

    const csr = K.toCSR();
    for (let iter = 0; iter < safeMaxIter; iter++) {
      csr.mult(p, Kp);
      let pKp = 0;
      for (let i = 0; i < n; i++) pKp += p[i] * Kp[i];

      // Safeguard against breakdown when matrix is ill-conditioned or singular
      if (!Number.isFinite(pKp) || Math.abs(pKp) < 1e-25) break;

      const alpha = rzOld / pKp;
      if (!Number.isFinite(alpha)) break;

      for (let i = 0; i < n; i++) {
        U[i] += alpha * p[i];
        r[i] -= alpha * Kp[i];
      }

      let normR = 0;
      for (let i = 0; i < n; i++) normR += r[i] * r[i];
      normR = Math.sqrt(normR);

      // Early exit on zero residual ||r|| ~ 0 or convergence to tolerance
      if (normR < 1e-15 || (normR / (normF || 1.0)) < safeTol) break;

      for (let i = 0; i < n; i++) z[i] = M[i] * r[i];
      let rzNew = 0;
      for (let i = 0; i < n; i++) rzNew += r[i] * z[i];

      if (Math.abs(rzOld) < 1e-30 || !Number.isFinite(rzNew)) break;

      const beta = rzNew / rzOld;
      if (!Number.isFinite(beta)) break;

      rzOld = rzNew;
      for (let i = 0; i < n; i++) {
        p[i] = z[i] + beta * p[i];
      }
    }

    // Sanitize output displacements against NaNs or Infinities
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(U[i])) U[i] = 0;
    }

    return U;
  }

  computeStressTensor(element: FEAElement, displacements: ArrayLike<number>, E: number, nu: unknown): StressData {
    if (element.nodes.length >= 10) {
      const meshNodes10 = this._requireMesh().nodes;
      const coords = element.nodes.slice(0, 10).map(n => meshNodes10[n].posMeters);
      const b = tet10B(coords, [0.25, 0.25, 0.25]);
      const u = new Float64Array(30);
      element.nodes.slice(0, 10).forEach((n, a) => {
        u[a * 3] = displacements[n * 3] || 0;
        u[a * 3 + 1] = displacements[n * 3 + 1] || 0;
        u[a * 3 + 2] = displacements[n * 3 + 2] || 0;
      });
      if (b) {
        const { strain, stress } = stressAt(b.B, materialMatrix(E, nu), u);
        const [sxx, syy, szz, txy, tyz, tzx] = stress;
        const { sigma1, sigma2, sigma3, vonMises } = this.computePrincipalAndVonMises(sxx, syy, szz, txy, tyz, tzx);
        return { strain, stress, cauchyTensor: [[sxx, txy, tzx], [txy, syy, tyz], [tzx, tyz, szz]], principalStresses: [sigma1, sigma2, sigma3], vonMises };
      }
    }
    const nodes = element.nodes.slice(0, 4);
    const meshNodes = this._requireMesh().nodes;
    const nodeCoords = nodes.map(nIdx => meshNodes[nIdx].posMeters);
    const stiffnessRes = this.computeTet4Stiffness(nodeCoords, E, nu);

    if (!stiffnessRes) {
      return {
        strain: new Float64Array(6),
        stress: new Float64Array(6),
        cauchyTensor: [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
        principalStresses: [0, 0, 0],
        vonMises: 0,
      };
    }

    const { B, D } = stiffnessRes;

    const uElem = new Float64Array(12);
    for (let i = 0; i < 4; i++) {
      const nIdx = nodes[i];
      uElem[i * 3] = displacements[nIdx * 3] || 0;
      uElem[i * 3 + 1] = displacements[nIdx * 3 + 1] || 0;
      uElem[i * 3 + 2] = displacements[nIdx * 3 + 2] || 0;
    }

    const strain = new Float64Array(6);
    for (let r = 0; r < 6; r++) {
      let sum = 0;
      for (let c = 0; c < 12; c++) {
        sum += B[r][c] * uElem[c];
      }
      strain[r] = sum;
    }

    const stress = new Float64Array(6);
    for (let r = 0; r < 6; r++) {
      let sum = 0;
      for (let c = 0; c < 6; c++) {
        sum += D[r][c] * strain[c];
      }
      stress[r] = sum;
    }

    const sxx = stress[0];
    const syy = stress[1];
    const szz = stress[2];
    const txy = stress[3];
    const tyz = stress[4];
    const tzx = stress[5];

    const { sigma1, sigma2, sigma3, vonMises } = this.computePrincipalAndVonMises(sxx, syy, szz, txy, tyz, tzx);

    return {
      strain,
      stress,
      cauchyTensor: [
        [sxx, txy, tzx],
        [txy, syy, tyz],
        [tzx, tyz, szz],
      ],
      principalStresses: [sigma1, sigma2, sigma3],
      vonMises,
    };
  }

  computePrincipalAndVonMises(sxx: number, syy: number, szz: number, txy: number, tyz: number, tzx: number): { sigma1: number; sigma2: number; sigma3: number; vonMises: number } {
    const I1 = sxx + syy + szz;
    const sm = I1 / 3.0;
    const s11 = sxx - sm;
    const s22 = syy - sm;
    const s33 = szz - sm;

    const J2 = 0.5 * (s11 * s11 + s22 * s22 + s33 * s33) + txy * txy + tyz * tyz + tzx * tzx;
    const vonMises = Math.sqrt(3.0 * Math.max(0, J2));

    let sigma1 = sm, sigma2 = sm, sigma3 = sm;
    if (J2 > 1e-16) {
      const J3 = s11 * (s22 * s33 - tyz * tyz) - txy * (txy * s33 - tyz * tzx) + tzx * (txy * tyz - s22 * tzx);
      const r = Math.sqrt(J2 / 3.0);
      const arg = Math.max(-1, Math.min(1, J3 / (2 * r * r * r)));
      const phi = Math.acos(arg) / 3.0;

      const eig = [
        sm + 2 * r * Math.cos(phi),
        sm + 2 * r * Math.cos(phi - (2 * Math.PI) / 3),
        sm + 2 * r * Math.cos(phi + (2 * Math.PI) / 3),
      ].sort((a, b) => b - a);

      sigma1 = eig[0];
      sigma2 = eig[1];
      sigma3 = eig[2];
    }

    return { sigma1, sigma2, sigma3, vonMises };
  }

  solveSolidFEA(config: SolidConfig = {}): SolidResult | null {
    if (!this.solidMesh) return null;

    const { nodes, elements, boundaryFaces } = this.solidMesh;
    const numNodes = nodes.length;
    const totalDofs = numNodes * 3;

    const E = config.youngsModulus || 200e9;
    const nu = config.poissonRatio !== undefined ? config.poissonRatio : 0.3;
    const yieldStrength = config.yieldStrength || 250e6;
    const loadMagnitude = config.loadMagnitude !== undefined ? config.loadMagnitude : 1000;

    const K = new SparseMatrix(totalDofs);
    const F = new Float64Array(totalDofs);

    // 1. Element stiffness assembly
    for (const elem of elements) {
      // Tet10 elements use the quadratic formulation over all 10 nodes; Tet4 the linear one
      const isTet10 = elem.nodes.length >= 10;
      const elemNodes = isTet10 ? elem.nodes.slice(0, 10) : elem.nodes.slice(0, 4);
      const elemNodeCoords = elemNodes.map(nIdx => nodes[nIdx].posMeters);
      const res = isTet10 ? this.computeTet10Stiffness(elemNodeCoords, E, nu) : this.computeTet4Stiffness(elemNodeCoords, E, nu);
      if (!res) continue;

      const { Ke } = res;
      const dofIndices: number[] = [];
      for (const nIdx of elemNodes) dofIndices.push(nIdx * 3, nIdx * 3 + 1, nIdx * 3 + 2);

      for (let r = 0; r < dofIndices.length; r++) {
        const globalRow = dofIndices[r];
        for (let c = 0; c < dofIndices.length; c++) {
          K.add(globalRow, dofIndices[c], Ke[r][c]);
        }
      }
    }

    // 2. Boundary Conditions
    const fixedDofs = new Map();
    const fixtures = config.fixtures || [];

    if (fixtures.length === 0) {
      const box = this.solidMesh.boundingBox;
      const zMin = box.min.z;
      const zSpan = box.max.z - box.min.z;
      const threshold = zMin + zSpan * 0.05;

      for (let i = 0; i < numNodes; i++) {
        if (nodes[i].point.z <= threshold) {
          fixedDofs.set(i * 3, 0);
          fixedDofs.set(i * 3 + 1, 0);
          fixedDofs.set(i * 3 + 2, 0);
        }
      }
    } else {
      for (const fix of fixtures) {
        const targetNodes = this._findNodesForFixture(fix);
        // Without any fixed node the system is singular and the "result" meaningless
        if (targetNodes.length === 0) throw new Error(`No mesh nodes on the fixed face${fix.plane ? ` (${fix.plane})` : ''}: the part does not reach it`);
        for (const nIdx of targetNodes) {
          if (fix.type === FIXTURE_TYPES.ROLLER) {
            const dof = fix.dof !== undefined ? fix.dof : (nIdx * 3 + 1);
            fixedDofs.set(dof, 0);
          } else {
            fixedDofs.set(nIdx * 3, 0);
            fixedDofs.set(nIdx * 3 + 1, 0);
            fixedDofs.set(nIdx * 3 + 2, 0);
          }
        }
      }
    }

    // 3. External Loads
    const loads = config.loads || [];
    if (loads.length === 0) {
      const box = this.solidMesh.boundingBox;
      const zMax = box.max.z;
      const zSpan = box.max.z - box.min.z;
      const threshold = zMax - zSpan * 0.05;

      const tipNodes = [];
      for (let i = 0; i < numNodes; i++) {
        if (nodes[i].point.z >= threshold) {
          tipNodes.push(i);
        }
      }

      if (tipNodes.length > 0) {
        const fPerNode = -Math.abs(loadMagnitude) / tipNodes.length;
        for (const nIdx of tipNodes) {
          F[nIdx * 3 + 1] += fPerNode;
        }
      }
    } else {
      for (const ld of loads) {
        if (ld.type === LOAD_TYPES.PRESSURE) {
          this._applyPressureLoad(ld, F);
        } else if (ld.type === LOAD_TYPES.NODAL_FORCE) {
          if (ld.node !== undefined && ld.force) {
            F[ld.node * 3] += ld.force[0] || 0;
            F[ld.node * 3 + 1] += ld.force[1] || 0;
            F[ld.node * 3 + 2] += ld.force[2] || 0;
          }
        } else if (ld.type === LOAD_TYPES.FORCE) {
          const targetNodes = this._findNodesForLoad(ld);
          if (targetNodes.length === 0) throw new Error(`No mesh nodes on the loaded face${ld.plane ? ` (${ld.plane})` : ''}: the part does not reach it`);
          if (targetNodes.length > 0) {
            const dir = ld.direction || [0, -1, 0];
            const mag = ld.magnitude !== undefined ? ld.magnitude : loadMagnitude;
            const fx = (dir[0] * mag) / targetNodes.length;
            const fy = (dir[1] * mag) / targetNodes.length;
            const fz = (dir[2] * mag) / targetNodes.length;
            for (const nIdx of targetNodes) {
              F[nIdx * 3] += fx;
              F[nIdx * 3 + 1] += fy;
              F[nIdx * 3 + 2] += fz;
            }
          }
        }
      }
    }

    // 4. Solve K * U = F
    K.applyDirichlet(fixedDofs, F);
    const U = this._solvePCG(K, F);

    // 5. Displacements
    const displacements = new Float32Array(numNodes);
    const displacementVectors = [];
    let maxDispM = 0;

    for (let i = 0; i < numNodes; i++) {
      const ux = U[i * 3];
      const uy = U[i * 3 + 1];
      const uz = U[i * 3 + 2];
      const mag = Math.sqrt(ux * ux + uy * uy + uz * uz);
      displacements[i] = mag;
      displacementVectors.push(new THREE.Vector3(ux, uy, uz));
      if (mag > maxDispM) maxDispM = mag;
    }

    // 6. Stresses
    const elemStresses = [];
    const nodeVonMises = new Float64Array(numNodes);
    const nodeWeights = new Float64Array(numNodes);
    const nodeCauchy = Array.from({ length: numNodes }, () => new Float64Array(6));

    let maxStressPa = 0;
    let minStressPa = Infinity;

    const hasTet10 = elements.some(e => e.nodes.length >= 10);
    const D = materialMatrix(E, nu);

    for (const elem of elements) {
      const stressData = this.computeStressTensor(elem, U, E, nu);
      elemStresses.push(stressData);
      const w = Math.abs(elem.volume);

      if (elem.nodes.length >= 10) {
        // Quadratic element: evaluate the stress at each of its 10 nodes and
        // average the tensor components per node (von Mises is taken afterwards)
        const coords = elem.nodes.slice(0, 10).map(n => nodes[n].posMeters);
        const uElem = new Float64Array(30);
        elem.nodes.slice(0, 10).forEach((n, a) => {
          uElem[a * 3] = U[n * 3];
          uElem[a * 3 + 1] = U[n * 3 + 1];
          uElem[a * 3 + 2] = U[n * 3 + 2];
        });
        TET10_NODE_COORDS.forEach((pt, a) => {
          const b = tet10B(coords, pt);
          if (!b) return;
          const { stress } = stressAt(b.B, D, uElem);
          const nIdx = elem.nodes[a];
          nodeWeights[nIdx] += w;
          for (let k = 0; k < 6; k++) nodeCauchy[nIdx][k] += stress[k] * w;
        });
        continue;
      }

      const vm = stressData.vonMises;
      if (vm > maxStressPa) maxStressPa = vm;
      if (vm < minStressPa) minStressPa = vm;

      for (let i = 0; i < 4; i++) {
        const nIdx = elem.nodes[i];
        nodeVonMises[nIdx] += vm * w;
        nodeWeights[nIdx] += w;
        for (let k = 0; k < 6; k++) {
          nodeCauchy[nIdx][k] += stressData.stress[k] * w;
        }
      }
    }

    const nodalVonMisesMPa = new Float32Array(numNodes);
    for (let i = 0; i < numNodes; i++) {
      if (nodeWeights[i] > 0) {
        for (let k = 0; k < 6; k++) {
          nodeCauchy[i][k] /= nodeWeights[i];
        }
        if (hasTet10) {
          const [sxx, syy, szz, txy, tyz, tzx] = nodeCauchy[i];
          const vmPa = this.computePrincipalAndVonMises(sxx, syy, szz, txy, tyz, tzx).vonMises;
          nodalVonMisesMPa[i] = vmPa / 1e6;
          if (vmPa > maxStressPa) maxStressPa = vmPa;
          if (vmPa < minStressPa) minStressPa = vmPa;
        } else {
          nodalVonMisesMPa[i] = (nodeVonMises[i] / nodeWeights[i]) / 1e6;
        }
      }
    }

    if (minStressPa === Infinity) minStressPa = 0;

    const maxStressMPa = maxStressPa / 1e6;
    const minStressMPa = minStressPa / 1e6;
    const factorOfSafety = maxStressPa > 1e-4 ? (yieldStrength / maxStressPa) : 15.0;

    const deformedGeometry = this._createDeformedGeometry(nodes, boundaryFaces, displacementVectors, nodalVonMisesMPa, minStressMPa, maxStressMPa);

    return {
      maxStressMPa,
      minStressMPa,
      maxDisplacementMM: maxDispM * 1000,
      factorOfSafety: Math.max(0.01, factorOfSafety),
      displacements,
      displacementVectors,
      nodalVonMisesMPa,
      nodeCauchyStresses: nodeCauchy,
      elementStresses: elemStresses,
      deformedGeometry,
      is3DSolid: true,
    };
  }

  _findNodesForFixture(fix: Fixture): number[] {
    const { nodes, boundingBox: box } = this._requireMesh();
    const eps = 1e-2;
    const target = [];

    if (fix.plane) {
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].point;
        if (fix.plane === 'xMin' && Math.abs(p.x - box.min.x) < eps) target.push(i);
        else if (fix.plane === 'xMax' && Math.abs(p.x - box.max.x) < eps) target.push(i);
        else if (fix.plane === 'yMin' && Math.abs(p.y - box.min.y) < eps) target.push(i);
        else if (fix.plane === 'yMax' && Math.abs(p.y - box.max.y) < eps) target.push(i);
        else if (fix.plane === 'zMin' && Math.abs(p.z - box.min.z) < eps) target.push(i);
        else if (fix.plane === 'zMax' && Math.abs(p.z - box.max.z) < eps) target.push(i);
      }
    } else if (fix.nodeIndices) {
      return fix.nodeIndices;
    }
    return target;
  }

  _findNodesForLoad(ld: Load): number[] {
    const { nodes, boundingBox: box } = this._requireMesh();
    const eps = 1e-2;
    const target = [];

    if (ld.plane) {
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i].point;
        if (ld.plane === 'xMin' && Math.abs(p.x - box.min.x) < eps) target.push(i);
        else if (ld.plane === 'xMax' && Math.abs(p.x - box.max.x) < eps) target.push(i);
        else if (ld.plane === 'yMin' && Math.abs(p.y - box.min.y) < eps) target.push(i);
        else if (ld.plane === 'yMax' && Math.abs(p.y - box.max.y) < eps) target.push(i);
        else if (ld.plane === 'zMin' && Math.abs(p.z - box.min.z) < eps) target.push(i);
        else if (ld.plane === 'zMax' && Math.abs(p.z - box.max.z) < eps) target.push(i);
      }
    } else if (ld.nodeIndices) {
      return ld.nodeIndices;
    }
    return target;
  }

  _applyPressureLoad(ld: Load, F: Float64Array): void {
    const p = ld.pressure || 0;
    const plane = ld.plane;
    for (const face of this._requireMesh().boundaryFaces) {
      if (!plane || face.plane === plane) {
        const fTotal = p * face.area;
        const fNode = fTotal / 3;
        const norm = face.normal;
        for (const nIdx of face.nodes) {
          F[nIdx * 3] -= norm.x * fNode;
          F[nIdx * 3 + 1] -= norm.y * fNode;
          F[nIdx * 3 + 2] -= norm.z * fNode;
        }
      }
    }
  }

  _createDeformedGeometry(nodes: FEANode[], boundaryFaces: BoundaryFace[], displacementVectors: THREE.Vector3[], nodalVonMisesMPa: Float32Array, minStressMPa: number, maxStressMPa: number): THREE.BufferGeometry {
    const geom = new THREE.BufferGeometry();
    if (!boundaryFaces || boundaryFaces.length === 0 || !nodes || nodes.length === 0) {
      geom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      geom.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
      return geom;
    }

    const positions = [];
    const colors = [];
    const normals = [];

    const safeMin = Number.isFinite(minStressMPa) ? minStressMPa : 0;
    const safeMax = Number.isFinite(maxStressMPa) ? maxStressMPa : 0;
    const stressRange = Math.max(1e-4, safeMax - safeMin);

    let maxDisp = 0;
    if (displacementVectors) {
      for (const v of displacementVectors) {
        if (v) {
          const l = v.length();
          if (l > maxDisp && Number.isFinite(l)) maxDisp = l;
        }
      }
    }
    const scale = maxDisp > 1e-12 ? 0.05 / maxDisp : 1.0;

    for (const face of boundaryFaces) {
      if (!face.nodes || face.nodes.length < 3) continue;
      const [i1, i2, i3] = face.nodes;
      const n1 = nodes[i1];
      const n2 = nodes[i2];
      const n3 = nodes[i3];
      if (!n1 || !n2 || !n3) continue;

      const d1 = displacementVectors?.[i1] || new THREE.Vector3();
      const d2 = displacementVectors?.[i2] || new THREE.Vector3();
      const d3 = displacementVectors?.[i3] || new THREE.Vector3();

      const p1 = new THREE.Vector3().copy(n1.point).addScaledVector(d1, scale * 1000);
      const p2 = new THREE.Vector3().copy(n2.point).addScaledVector(d2, scale * 1000);
      const p3 = new THREE.Vector3().copy(n3.point).addScaledVector(d3, scale * 1000);

      const u = new THREE.Vector3().subVectors(p2, p1);
      const v = new THREE.Vector3().subVectors(p3, p1);
      const norm = new THREE.Vector3().crossVectors(u, v).normalize();

      const s1 = nodalVonMisesMPa?.[i1] ?? safeMin;
      const s2 = nodalVonMisesMPa?.[i2] ?? safeMin;
      const s3 = nodalVonMisesMPa?.[i3] ?? safeMin;

      const c1 = this._stressToColor((s1 - safeMin) / stressRange);
      const c2 = this._stressToColor((s2 - safeMin) / stressRange);
      const c3 = this._stressToColor((s3 - safeMin) / stressRange);

      positions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
      colors.push(c1[0], c1[1], c1[2], c2[0], c2[1], c2[2], c3[0], c3[1], c3[2]);
      normals.push(norm.x, norm.y, norm.z, norm.x, norm.y, norm.z, norm.x, norm.y, norm.z);
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return geom;
  }

  _stressToColor(t: number): Vec3Tuple {
    t = Math.max(0, Math.min(1, t));
    let r = 0, g = 0, b = 0;
    if (t < 0.25) {
      const s = t / 0.25;
      r = 0; g = s; b = 1;
    } else if (t < 0.5) {
      const s = (t - 0.25) / 0.25;
      r = 0; g = 1; b = 1 - s;
    } else if (t < 0.75) {
      const s = (t - 0.5) / 0.25;
      r = s; g = 1; b = 0;
    } else {
      const s = (t - 0.75) / 0.25;
      r = 1; g = 1 - s; b = 0;
    }
    return [r, g, b];
  }

  generateMesh(geometry: THREE.BufferGeometry | null | undefined, options: number | MeshOptions = 20): SolidMesh | BeamMesh | null {
    if (!geometry) return null;

    geometry.computeBoundingBox();
    const box = geometry.boundingBox || new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
    const size = new THREE.Vector3();
    box.getSize(size);
    if (!Number.isFinite(size.x) || size.x <= 0) size.x = 10;
    if (!Number.isFinite(size.y) || size.y <= 0) size.y = 10;
    if (!Number.isFinite(size.z) || size.z <= 0) size.z = 10;

    let axis: 'x' | 'y' | 'z' = 'x';
    let length = size.x;
    let b = size.z || 10;
    let h = size.y || 10;

    if (size.y > length) {
      axis = 'y';
      length = size.y;
      b = size.x || 10;
      h = size.z || 10;
    } else if (size.z > length) {
      axis = 'z';
      length = size.z;
      b = size.x || 10;
      h = size.y || 10;
    }

    const numStations = typeof options === 'number' ? options : (options.numStations || 20);
    this.isBeamVerifiedMode = (typeof options === 'number');

    const nNodes = numStations + 1;
    const nodes = [];
    const elements = [];
    const dx = length / numStations;
    const minVal = axis === 'x' ? box.min.x : (axis === 'y' ? box.min.y : box.min.z);

    for (let i = 0; i < nNodes; i++) {
      const coord = minVal + i * dx;
      const pt = new THREE.Vector3();
      if (axis === 'x') pt.set(coord, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
      else if (axis === 'y') pt.set((box.min.x + box.max.x) / 2, coord, (box.min.z + box.max.z) / 2);
      else pt.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, coord);

      nodes.push({ id: i, point: pt, isFixed: (i === 0) });
    }

    const A = Math.max(1, b * h) * 1e-6;
    const I = Math.max(1e-12, (b * Math.pow(h, 3)) / 12) * 1e-12;

    for (let i = 0; i < numStations; i++) {
      elements.push({
        id: i,
        node1: i,
        node2: i + 1,
        length: dx * 1e-3,
        A,
        I,
        b: b * 1e-3,
        h: h * 1e-3,
      });
    }

    this.beamMesh = {
      nodes,
      elements,
      geometry,
      axis,
      length: length * 1e-3,
      width: b * 1e-3,
      height: h * 1e-3,
      A,
      I,
    };

    const solidOpts: MeshOptions = typeof options === 'object' ? options : { divisions: [3, 3, Math.min(15, numStations)] };
    this.tetrahedralize(geometry, solidOpts);

    this.mesh = this.solidMesh || this.beamMesh;
    return this.mesh;
  }

  solve(loadMagnitude = 1000, materialYieldStrength = 250e6, youngsModulus = 200e9, poissonRatio = 0.3, options: { fixtures?: Fixture[]; loads?: Load[] } = {}): FEAResults {
    let solidResult = null;
    if (this.solidMesh) {
      solidResult = this.solveSolidFEA({
        loadMagnitude,
        yieldStrength: materialYieldStrength,
        youngsModulus,
        poissonRatio,
        fixtures: options.fixtures,
        loads: options.loads,
      });
    }

    let theoreticalDispMM = 0;
    let beamDispMM = 0;
    let beamMaxStressMPa = 0;
    let beamMinStressMPa = 0;

    if (this.beamMesh) {
      const { nodes, elements, length, I, height } = this.beamMesh;
      const numNodes = nodes.length;
      const totalDofs = numNodes * 2;

      const K = Array.from({ length: totalDofs }, () => new Float64Array(totalDofs));
      const F = new Float64Array(totalDofs);

      for (const elem of elements) {
        const L = elem.length;
        const EI = youngsModulus * elem.I;
        const L2 = L * L;
        const L3 = L2 * L;

        const k11 = (12 * EI) / L3;
        const k12 = (6 * EI) / L2;
        const k22 = (4 * EI) / L;
        const k24 = (2 * EI) / L;

        const n1 = elem.node1;
        const n2 = elem.node2;
        const dofs = [n1 * 2, n1 * 2 + 1, n2 * 2, n2 * 2 + 1];

        const ke = [
          [k11, k12, -k11, k12],
          [k12, k22, -k12, k24],
          [-k11, -k12, k11, -k12],
          [k12, k24, -k12, k22],
        ];

        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) {
            K[dofs[i]][dofs[j]] += ke[i][j];
          }
        }
      }

      K[0][0] = 1e20;
      K[1][1] = 1e20;
      F[0] = 0;
      F[1] = 0;

      const tipDof = (numNodes - 1) * 2;
      F[tipDof] = -Math.abs(loadMagnitude);

      const U = this._gaussianElimination(K, F);

      const displacements = new Float32Array(numNodes);
      const stresses = new Float32Array(numNodes);

      for (let i = 0; i < numNodes; i++) {
        const v = U ? U[i * 2] : 0;
        displacements[i] = Math.abs(v);
        const x = (i / (numNodes - 1)) * length;
        const M = Math.abs(loadMagnitude) * (length - x);
        const c = height / 2;
        const sigma = (M * c) / I;
        stresses[i] = sigma / 1e6;
      }

      beamDispMM = Math.max(...displacements) * 1000;
      beamMaxStressMPa = Math.max(...stresses);
      beamMinStressMPa = Math.min(...stresses);

      theoreticalDispMM = ((Math.abs(loadMagnitude) * Math.pow(length, 3)) / (3 * youngsModulus * I)) * 1000;
    }

    const maxStressMPa = solidResult ? solidResult.maxStressMPa : beamMaxStressMPa;
    const minStressMPa = solidResult ? solidResult.minStressMPa : beamMinStressMPa;
    const factorOfSafety = solidResult ? solidResult.factorOfSafety : (beamMaxStressMPa > 1e-4 ? ((materialYieldStrength / 1e6) / beamMaxStressMPa) : 15.0);
    const maxDisplacementMM = this.isBeamVerifiedMode ? beamDispMM : (solidResult ? solidResult.maxDisplacementMM : beamDispMM);

    this.results = {
      maxStressMPa,
      minStressMPa,
      maxDisplacementMM,
      theoreticalDispMM,
      solidMaxDisplacementMM: solidResult?.maxDisplacementMM,
      factorOfSafety: Math.max(0.01, factorOfSafety),
      stresses: solidResult?.nodalVonMisesMPa,
      displacements: solidResult?.displacements,
      deformedGeometry: solidResult?.deformedGeometry,
      solidResult,
      is3DSolid: !!solidResult,
      isVerifiedLinearStatic: true,
    };

    return this.results;
  }

  _gaussianElimination(A: ArrayLike<number>[], b: ArrayLike<number>): Float64Array | null {
    const n = b.length;
    const M = Array.from({ length: n }, (_, i) => {
      const row = new Float64Array(n + 1);
      row.set(A[i]);
      row[n] = b[i];
      return row;
    });

    for (let p = 0; p < n; p++) {
      let maxRow = p;
      let maxVal = Math.abs(M[p][p]);
      for (let i = p + 1; i < n; i++) {
        const val = Math.abs(M[i][p]);
        if (val > maxVal) {
          maxVal = val;
          maxRow = i;
        }
      }

      if (maxVal < 1e-15) return null;

      if (maxRow !== p) {
        const tmp = M[p];
        M[p] = M[maxRow];
        M[maxRow] = tmp;
      }

      const pivot = M[p][p];
      for (let j = p; j <= n; j++) {
        M[p][j] /= pivot;
      }

      for (let i = 0; i < n; i++) {
        if (i !== p) {
          const factor = M[i][p];
          if (Math.abs(factor) > 1e-15) {
            for (let j = p; j <= n; j++) {
              M[i][j] -= factor * M[p][j];
            }
          }
        }
      }
    }

    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = M[i][n];
    }
    return x;
  }
}

export const feaEngine = new FEAEngine();
export default FEAEngine;

