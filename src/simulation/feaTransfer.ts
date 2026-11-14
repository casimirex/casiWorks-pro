// CasiWorks Pro - FEA solve as plain data: shared by the solver worker and the inline fallback
//
// A Web Worker can only send plain data (typed arrays, numbers, objects), so
// results and the mesh needed for plotting are packed into arrays here and
// rebuilt on the main thread.
import * as THREE from 'three';
import { FEAEngine } from './FEAEngine.ts';
import type { ElementType, FEAResults, SolidResult } from './FEAEngine.ts';
import type { PlotMesh } from './resultPlot.ts';
import { autoMesh } from './autoMesh.ts';
import type { MeshInfo, MeshQuality } from './autoMesh.ts';

export interface SolveRequest {
  /** Model triangles (mm), as in a non-indexed or indexed BufferGeometry. */
  positions: Float32Array;
  index: Uint32Array | null;
  elementType: ElementType;
  /** N */
  load: number;
  /** Pa */
  yieldStrength: number;
  /** Pa */
  youngsModulus: number;
  poissonRatio: number;
  /** Mesh size preset (default medium). */
  quality?: MeshQuality;
}

export type SolvePhase = 'meshing' | 'solving';

/** Results and plot mesh as transferable plain data. */
export interface PackedSolve {
  results: Omit<FEAResults, 'deformedGeometry' | 'solidResult'> & {
    solidResult: (Omit<SolidResult, 'displacementVectors' | 'deformedGeometry'> & { displacementVectors: Float64Array }) | null;
  };
  mesh: { points: Float64Array; faces: Uint32Array; size: [number, number, number] } | null;
  /** How the part was meshed and how well the mesh matches it. */
  meshInfo?: MeshInfo;
}

export interface Solved {
  results: FEAResults;
  mesh: PlotMesh | null;
  meshInfo?: MeshInfo;
}

/** Mesh and solve (runs in the worker, or inline without one). */
export function runSolve(req: SolveRequest, onPhase: (phase: SolvePhase) => void = () => {}): PackedSolve {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(req.positions, 3));
  if (req.index) geometry.setIndex(new THREE.BufferAttribute(req.index, 1));
  const fea = new FEAEngine();
  onPhase('meshing');
  const meshInfo = autoMesh(fea, geometry, req.elementType, req.quality ?? 'medium');
  onPhase('solving');
  const res = fea.solve(req.load, req.yieldStrength, req.youngsModulus, req.poissonRatio);
  return { ...pack(res, fea.solidMesh), meshInfo };
}

export function pack(res: FEAResults, mesh: { nodes: Array<{ point: THREE.Vector3 }>; boundaryFaces: Array<{ nodes: ArrayLike<number> }>; size: THREE.Vector3 } | null): PackedSolve {
  const { deformedGeometry: _dropped, solidResult, ...rest } = res;
  let packedSolid: PackedSolve['results']['solidResult'] = null;
  if (solidResult) {
    const { displacementVectors, deformedGeometry: _geometry, ...solidRest } = solidResult;
    const d = new Float64Array(displacementVectors.length * 3);
    displacementVectors.forEach((v, i) => { d[i * 3] = v?.x ?? 0; d[i * 3 + 1] = v?.y ?? 0; d[i * 3 + 2] = v?.z ?? 0; });
    packedSolid = { ...solidRest, displacementVectors: d };
  }
  let packedMesh: PackedSolve['mesh'] = null;
  if (mesh) {
    const points = new Float64Array(mesh.nodes.length * 3);
    mesh.nodes.forEach((n, i) => { points[i * 3] = n.point.x; points[i * 3 + 1] = n.point.y; points[i * 3 + 2] = n.point.z; });
    const faces = new Uint32Array(mesh.boundaryFaces.length * 3);
    mesh.boundaryFaces.forEach((f, i) => { faces[i * 3] = f.nodes[0]; faces[i * 3 + 1] = f.nodes[1]; faces[i * 3 + 2] = f.nodes[2]; });
    packedMesh = { points, faces, size: [mesh.size.x, mesh.size.y, mesh.size.z] };
  }
  return { results: { ...rest, solidResult: packedSolid }, mesh: packedMesh };
}

export function unpack(data: PackedSolve): Solved {
  const s = data.results.solidResult;
  let solidResult: SolidResult | null = null;
  if (s) {
    const n = s.displacementVectors.length / 3;
    const vectors = Array.from({ length: n }, (_, i) => new THREE.Vector3(s.displacementVectors[i * 3], s.displacementVectors[i * 3 + 1], s.displacementVectors[i * 3 + 2]));
    solidResult = { ...s, displacementVectors: vectors, deformedGeometry: new THREE.BufferGeometry() };
  }
  let mesh: PlotMesh | null = null;
  if (data.mesh) {
    const { points, faces, size } = data.mesh;
    mesh = {
      nodes: Array.from({ length: points.length / 3 }, (_, i) => ({ point: new THREE.Vector3(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]) })),
      boundaryFaces: Array.from({ length: faces.length / 3 }, (_, i) => ({ nodes: [faces[i * 3], faces[i * 3 + 1], faces[i * 3 + 2]] as [number, number, number] })),
      size: new THREE.Vector3(...size),
    };
  }
  return { results: { ...data.results, solidResult }, mesh, meshInfo: data.meshInfo };
}

/** Typed arrays the message can move instead of copy. */
export function transferables(data: PackedSolve): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const add = (a: { buffer: ArrayBufferLike } | undefined | null) => { if (a && a.buffer instanceof ArrayBuffer && !out.includes(a.buffer)) out.push(a.buffer); };
  add(data.mesh?.points);
  add(data.mesh?.faces);
  add(data.results.solidResult?.displacementVectors);
  return out;
}
