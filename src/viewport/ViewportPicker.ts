// CasiWorks Pro - Viewport Picker and Raycaster
import * as THREE from 'three';
import { sketchPlaneNormal, worldToSketch } from '../utils/math.ts';

/** A pointer position on a sketch plane: sketch coordinates plus the world point. */
export interface SketchPlanePoint {
  x: number;
  y: number;
  z: 0;
  world: THREE.Vector3;
}

export class ViewportPicker {
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  /**
   * Cast a ray from pointer coordinates into scene
   * Robust against null/undefined cameras, detached bodies, and missing geometries
   */
  pickObject(pointerX: number, pointerY: number, camera: THREE.Camera | null | undefined, objects: THREE.Object3D | THREE.Object3D[] | null | undefined): THREE.Intersection | null {
    if (!camera || !objects) return null;
    if (isNaN(pointerX) || isNaN(pointerY)) return null;

    const list = Array.isArray(objects) ? objects : [objects];
    const validObjects = list.filter(obj => {
      if (!obj || !obj.isObject3D) return false;
      const geometry = (obj as THREE.Object3D & { geometry?: THREE.BufferGeometry }).geometry;
      if (geometry) {
        const pos = geometry.getAttribute ? geometry.getAttribute('position') : geometry.attributes?.position;
        return pos && pos.count > 0;
      }
      return obj.children && obj.children.length > 0;
    });

    if (validObjects.length === 0) return null;

    try {
      this.raycaster.setFromCamera(new THREE.Vector2(pointerX, pointerY), camera);
      const intersects = this.raycaster.intersectObjects(validObjects, true);
      return intersects.length > 0 ? intersects[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Convert normalized pointer (-1 to +1) to 3D plane intersection
   */
  screenToSketchPlane(pointerX: number, pointerY: number, camera: THREE.Camera | null | undefined, planeName = 'Front'): SketchPlanePoint | null {
    if (!camera || isNaN(pointerX) || isNaN(pointerY)) return null;

    try {
      this.raycaster.setFromCamera(new THREE.Vector2(pointerX, pointerY), camera);

      // The sketch plane through the origin, mapped exactly as the kernel maps sketches
      const mathPlane = new THREE.Plane(sketchPlaneNormal(planeName), 0);
      const target = new THREE.Vector3();
      const hit = this.raycaster.ray.intersectPlane(mathPlane, target);
      if (!hit) return null;

      const { x, y } = worldToSketch(target, planeName);
      return { x, y, z: 0, world: target };
    } catch {
      return null;
    }
  }

  /**
   * Find closest vertex on mesh to ray
   */
  pickVertex(intersection: THREE.Intersection | null | undefined, threshold = 0.5): { index: number; distance: number } | null {
    if (!intersection || !intersection.object) return null;
    const geom = (intersection.object as THREE.Object3D & { geometry?: THREE.BufferGeometry }).geometry;
    if (!geom) return null;

    const pos = geom.getAttribute ? geom.getAttribute('position') : geom.attributes?.position;
    if (!pos || !pos.count) return null;
    const hitPoint = intersection.point;
    if (!hitPoint) return null;

    try {
      let minD = threshold;
      let closestIndex = -1;

      for (let i = 0; i < pos.count; i++) {
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (intersection.object.matrixWorld) {
          v.applyMatrix4(intersection.object.matrixWorld);
        }
        const d = v.distanceTo(hitPoint);
        if (d < minD) {
          minD = d;
          closestIndex = i;
        }
      }

      return closestIndex !== -1 ? { index: closestIndex, distance: minD } : null;
    } catch {
      return null;
    }
  }
}

export const viewportPicker = new ViewportPicker();
export default ViewportPicker;
