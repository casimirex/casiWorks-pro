// CasiWorks Pro - Interactive sketch tools: what each click creates
//
// UI-free so it can be tested: given the tool and the points clicked so far,
// it says how many clicks the tool needs, what to create when the last click
// lands, what to preview while the mouse moves, and what to tell the user.
import { sketchEngine } from '../kernel/SketchEngine.ts';
import { TOOLS } from '../utils/constants.ts';
import type { ToolId } from '../utils/constants.ts';
import type { Point2, SketchEntity } from '../types/cad.ts';

export interface ToolOptions {
  /** Sides of the polygon tool (3–64). */
  polygonSides?: number;
}

/** Clicks each drawing tool needs to create its geometry. */
export const TOOL_CLICKS: Partial<Record<ToolId, number>> = {
  [TOOLS.SKETCH_POINT]: 1,
  [TOOLS.SKETCH_LINE]: 2,
  [TOOLS.SKETCH_RECT]: 2,
  [TOOLS.SKETCH_CIRCLE]: 2,
  [TOOLS.SKETCH_POLYGON]: 2,
  [TOOLS.SKETCH_ARC]: 3,
  [TOOLS.SKETCH_SLOT]: 3,
};

const HINTS: Partial<Record<ToolId, string[]>> = {
  [TOOLS.SKETCH_POINT]: ['Point: click to place'],
  [TOOLS.SKETCH_LINE]: ['Line: click the start point', 'Line: click the end point (lines chain; Esc to stop)'],
  [TOOLS.SKETCH_RECT]: ['Rectangle: click the first corner', 'Rectangle: click the opposite corner'],
  [TOOLS.SKETCH_CIRCLE]: ['Circle: click the centre', 'Circle: click a point on the circle'],
  [TOOLS.SKETCH_POLYGON]: ['Polygon: click the centre', 'Polygon: click a vertex'],
  [TOOLS.SKETCH_ARC]: ['Arc: click the centre', 'Arc: click the start point', 'Arc: click the end point (counter-clockwise from the start)'],
  [TOOLS.SKETCH_SLOT]: ['Slot: click the first end centre', 'Slot: click the second end centre', 'Slot: click a point on the side (sets the width)'],
};

/** Status-bar guidance for the next click. */
export function toolHint(tool: ToolId, clicks: number): string | null {
  const hints = HINTS[tool];
  return hints ? hints[Math.min(clicks, hints.length - 1)] : null;
}

const dist = (a: Point2, b: Point2) => Math.hypot(b.x - a.x, b.y - a.y);
const angle = (from: Point2, to: Point2) => Math.atan2(to.y - from.y, to.x - from.x);

/**
 * Geometry for a complete set of clicks (length === TOOL_CLICKS[tool]), or
 * null when the clicks do not define any (e.g. zero radius).
 */
export function entitiesFor(tool: ToolId, pts: Point2[], options: ToolOptions = {}): SketchEntity[] | null {
  const tooSmall = 1e-6;
  switch (tool) {
    case TOOLS.SKETCH_POINT:
      return [sketchEngine.createPoint(pts[0])];
    case TOOLS.SKETCH_LINE:
      return dist(pts[0], pts[1]) > tooSmall ? [sketchEngine.createLine(pts[0], pts[1])] : null;
    case TOOLS.SKETCH_RECT:
      return Math.abs(pts[1].x - pts[0].x) > tooSmall && Math.abs(pts[1].y - pts[0].y) > tooSmall ? sketchEngine.createRectangle(pts[0], pts[1]) : null;
    case TOOLS.SKETCH_CIRCLE: {
      const r = dist(pts[0], pts[1]);
      return r > tooSmall ? [sketchEngine.createCircle(pts[0], r)] : null;
    }
    case TOOLS.SKETCH_POLYGON: {
      const r = dist(pts[0], pts[1]);
      const sides = Math.min(64, Math.max(3, Math.round(options.polygonSides ?? 6)));
      return r > tooSmall ? sketchEngine.createPolygon(pts[0], r, sides, false, angle(pts[0], pts[1])) : null;
    }
    case TOOLS.SKETCH_ARC: {
      const [c, start, end] = pts;
      const r = dist(c, start);
      if (r <= tooSmall || dist(c, end) <= tooSmall) return null;
      const a0 = angle(c, start);
      let a1 = angle(c, end);
      if (a1 <= a0 + 1e-9) a1 += Math.PI * 2; // counter-clockwise from start to end
      return [sketchEngine.createArc(c, r, a0, a1)];
    }
    case TOOLS.SKETCH_SLOT: {
      const [p1, p2, side] = pts;
      const len = dist(p1, p2);
      if (len <= tooSmall) return null;
      // Width from the distance of the third click to the centre line
      const r = Math.abs((p2.x - p1.x) * (p1.y - side.y) - (p1.x - side.x) * (p2.y - p1.y)) / len;
      return r > tooSmall ? sketchEngine.createSlot(p1, p2, r) : null;
    }
    default:
      return null;
  }
}

/**
 * What to draw while the mouse moves: the geometry the next click would
 * create when that click is the last one, otherwise a rubber band.
 */
export function previewFor(tool: ToolId, clicked: Point2[], mouse: Point2 | null, options: ToolOptions = {}): { entities: SketchEntity[]; band: Point2[] } {
  const need = TOOL_CLICKS[tool];
  if (!need || !mouse || clicked.length === 0) return { entities: [], band: clicked };
  const pts = [...clicked, mouse];
  if (pts.length === need) return { entities: entitiesFor(tool, pts, options) ?? [], band: [] };
  return { entities: [], band: pts };
}
