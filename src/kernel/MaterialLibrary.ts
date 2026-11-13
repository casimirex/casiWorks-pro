// CasiWorks Pro - Engineering Material Library
import * as THREE from 'three';
import { MATERIALS } from '../utils/constants.ts';
import type { MaterialData } from '../utils/constants.ts';

export type MaterialInfo = MaterialData & { key: string };

export class MaterialLibrary {
  materials: Record<string, MaterialData>;
  threeMaterialCache = new Map<string, THREE.MeshStandardMaterial>();

  constructor() {
    this.materials = { ...MATERIALS };
  }

  /** Material by key; falls back to AISI 1020 steel for unknown keys. */
  getMaterial(key: string): MaterialData {
    return this.materials[key] || this.materials['Steel_1020'];
  }

  getAllMaterials(): MaterialInfo[] {
    return Object.entries(this.materials).map(([key, data]) => ({ key, ...data }));
  }

  addCustomMaterial(key: string, properties: Partial<MaterialData>): void {
    this.materials[key] = {
      name: properties.name || key,
      density: properties.density || 7850,
      youngsModulus: properties.youngsModulus || 200e9,
      poissonsRatio: properties.poissonsRatio || 0.3,
      yieldStrength: properties.yieldStrength || 250e6,
      color: properties.color || '#999999',
    };
    // Cache entries are keyed per render mode; drop both so the new colour shows
    for (const wireframe of [false, true]) {
      this.threeMaterialCache.get(`${key}_${wireframe}`)?.dispose();
      this.threeMaterialCache.delete(`${key}_${wireframe}`);
    }
  }

  /** Shared (cached) render material for a material key. Callers must clone before modifying. */
  getThreeMaterial(key: string, wireframe = false): THREE.MeshStandardMaterial {
    const cacheKey = `${key}_${wireframe}`;
    const cached = this.threeMaterialCache.get(cacheKey);
    if (cached) return cached;

    const data = this.getMaterial(key);
    const lower = key.toLowerCase();
    const isMetal = ['steel', 'aluminum', 'titanium', 'copper', 'brass', 'iron'].some(m => lower.includes(m));

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(data.color || '#b0b0b0'),
      metalness: isMetal ? 0.8 : 0.1,
      roughness: isMetal ? 0.35 : 0.6,
      wireframe,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    this.threeMaterialCache.set(cacheKey, material);
    return material;
  }
}

export const materialLibrary = new MaterialLibrary();
export default MaterialLibrary;
