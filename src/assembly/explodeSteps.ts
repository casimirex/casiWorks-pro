// CasiWorks Pro - Exploded views made of steps: each step moves its components along a direction
//
// Steps run in order; `progress` (0…1) plays through them, so step 2 starts once
// step 1 is fully out. A component moved by several steps adds them up.

export interface Vec { x: number; y: number; z: number }
export interface StepLike { componentIds: string[]; direction: Vec; distance: number }

/** How far each component has moved at `progress` (only components that have moved). */
export function stepOffsets(steps: StepLike[], progress = 1): Map<string, Vec> {
  const out = new Map<string, Vec>();
  const p = Math.max(0, Math.min(1, progress)) * steps.length;
  steps.forEach((s, i) => {
    const share = Math.max(0, Math.min(1, p - i));
    if (share <= 0) return;
    for (const id of s.componentIds) {
      const o = out.get(id) ?? { x: 0, y: 0, z: 0 };
      out.set(id, { x: o.x + s.direction.x * s.distance * share, y: o.y + s.direction.y * s.distance * share, z: o.z + s.direction.z * s.distance * share });
    }
  });
  return out;
}

/** Leader lines: the path each moved component's centre takes (one corner per step that moves it). */
export function stepPaths(steps: StepLike[], centres: Map<string, Vec>, progress = 1): Array<{ componentId: string; points: Vec[] }> {
  const p = Math.max(0, Math.min(1, progress)) * steps.length;
  const paths = new Map<string, Vec[]>();
  steps.forEach((s, i) => {
    const share = Math.max(0, Math.min(1, p - i));
    if (share <= 0) return;
    for (const id of s.componentIds) {
      const start = centres.get(id);
      if (!start) continue;
      const pts = paths.get(id) ?? [{ ...start }];
      const last = pts[pts.length - 1];
      pts.push({ x: last.x + s.direction.x * s.distance * share, y: last.y + s.direction.y * s.distance * share, z: last.z + s.direction.z * s.distance * share });
      paths.set(id, pts);
    }
  });
  return [...paths].map(([componentId, points]) => ({ componentId, points }));
}
