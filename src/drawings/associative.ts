// CasiWorks Pro - Drawing dimensions that follow the model (roadmap 5.2)
//
// A dimension is attached to things in one view: a corner (end of an edge),
// the centre of a circle or arc, or a circle itself. Each attachment keeps
// where it was picked, both in model units and as a fraction of the view's
// extent. Every time the sheet is made, the attachments are found again on
// the current geometry (the nearest corner / centre / circle to either
// position), so the value follows the model. One that cannot be found any
// more leaves the dimension dangling: it is listed, not drawn.
//
// The mesh kernel has no persistent face or edge names, so this is a
// nearest-match, as for faces picked for mates (4.2).
import type { DrawingLine, Point2D, ViewBounds } from './DrawingEngine.ts';
import type { DrawingArc } from './curves.ts';

export type DimensionView = 'front' | 'top' | 'right';
export const DIMENSION_VIEWS: readonly DimensionView[] = ['front', 'top', 'right'];
export type DimensionKind = 'horizontal' | 'vertical' | 'diameter' | 'radius';
export const DIMENSION_KINDS: readonly DimensionKind[] = ['horizontal', 'vertical', 'diameter', 'radius'];

/** What a dimension is attached to, in view coordinates (model units, u right, v up). */
export interface DimensionRef {
  snap: 'end' | 'center' | 'circle';
  /** Where it was picked. */
  at: Point2D;
  /** The same place as a fraction of the view's extent (0..1 across, 0..1 up). */
  rel: Point2D;
  /** Circles: the radius when picked. */
  radius?: number;
}

export interface DrawingDimension {
  id: string;
  view: DimensionView;
  kind: DimensionKind;
  /** Two corners / centres for horizontal and vertical; one circle for diameter and radius. */
  refs: DimensionRef[];
  /** The value (mm) when it was placed, shown for a dangling dimension. */
  value: number;
}

/** What a view offers to attach dimensions to. */
export interface ViewFeatures {
  ends: Point2D[];
  centers: Point2D[];
  circles: Array<{ center: Point2D; radius: number; full: boolean; mid: number }>;
}

type ViewLike = { visible: DrawingLine[]; hidden: DrawingLine[]; arcs: DrawingArc[]; bounds: ViewBounds };

/** Corners, centres and circles of a projected view (model units). Circles of one centre and radius count once. */
export function viewFeatures(v: ViewLike): ViewFeatures {
  const ends: Point2D[] = [];
  const centers: Point2D[] = [];
  const circles: ViewFeatures['circles'] = [];
  const size = Math.hypot((v.bounds.maxX - v.bounds.minX) || 0, (v.bounds.maxY - v.bounds.minY) || 0) || 1;
  const tol = 1e-4 * size;
  const add = (list: Point2D[], p: Point2D) => {
    if (!list.some(q => Math.hypot(q.x - p.x, q.y - p.y) <= tol)) list.push({ x: p.x, y: p.y });
  };
  for (const l of [...v.visible, ...v.hidden]) { add(ends, l.p1); add(ends, l.p2); }
  for (const a of v.arcs) {
    add(centers, a.center);
    if (!a.full) {
      add(ends, { x: a.center.x + a.radius * Math.cos(a.startAngle), y: a.center.y + a.radius * Math.sin(a.startAngle) });
      add(ends, { x: a.center.x + a.radius * Math.cos(a.endAngle), y: a.center.y + a.radius * Math.sin(a.endAngle) });
    }
    const same = circles.find(c => Math.hypot(c.center.x - a.center.x, c.center.y - a.center.y) <= tol && Math.abs(c.radius - a.radius) <= tol);
    if (same) same.full = same.full || !!a.full;
    else circles.push({ center: a.center, radius: a.radius, full: !!a.full, mid: a.full ? 0 : (a.startAngle + a.endAngle) / 2 });
  }
  return { ends, centers, circles };
}

const relOf = (b: ViewBounds, p: Point2D): Point2D => ({
  x: (p.x - b.minX) / ((b.maxX - b.minX) || 1),
  y: (p.y - b.minY) / ((b.maxY - b.minY) || 1),
});
const fromRel = (b: ViewBounds, r: Point2D): Point2D => ({
  x: b.minX + r.x * ((b.maxX - b.minX) || 1),
  y: b.minY + r.y * ((b.maxY - b.minY) || 1),
});

/** An attachment to what lies at `at` in the view (the nearest of its kind), or null when nothing of that kind is within `reach`. */
export function refAt(features: ViewFeatures, bounds: ViewBounds, snap: DimensionRef['snap'], at: Point2D, reach: number): DimensionRef | null {
  if (snap === 'circle') {
    let best: ViewFeatures['circles'][number] | null = null, bestD = reach;
    for (const c of features.circles) {
      const d = Math.abs(Math.hypot(at.x - c.center.x, at.y - c.center.y) - c.radius);
      if (d <= bestD) { bestD = d; best = c; }
    }
    return best ? { snap, at: { ...best.center }, rel: relOf(bounds, best.center), radius: best.radius } : null;
  }
  if (snap === 'center') {
    // The circle it is the centre of (the largest, for concentric ones) gives the radius to find it by
    let best: ViewFeatures['circles'][number] | null = null, bestD = reach;
    for (const c of features.circles) {
      const d = Math.hypot(c.center.x - at.x, c.center.y - at.y);
      if (d < bestD - 1e-9 || (best && Math.abs(d - bestD) <= 1e-9 && c.radius > best.radius)) { bestD = d; best = c; }
    }
    return best ? { snap, at: { ...best.center }, rel: relOf(bounds, best.center), radius: best.radius } : null;
  }
  let best: Point2D | null = null, bestD = reach;
  for (const p of features.ends) {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best ? { snap, at: { ...best }, rel: relOf(bounds, best) } : null;
}

/**
 * Find an attachment again on the current view: nearest to where it was or to
 * the same place relative to the view. Corners must be within 6% of the
 * view's size; circles and centres, which are rarer and carry a radius, within
 * 25%, the radius counting too (a hole moved and resized is still found).
 */
export function resolveRef(ref: DimensionRef, features: ViewFeatures, bounds: ViewBounds): { point: Point2D; radius?: number; mid?: number; full?: boolean } | null {
  const size = Math.hypot((bounds.maxX - bounds.minX) || 0, (bounds.maxY - bounds.minY) || 0) || 1;
  const reach = (ref.snap === 'end' ? 0.06 : 0.25) * size;
  const targets = [ref.at, fromRel(bounds, ref.rel)];
  const distance = (p: Point2D) => Math.min(...targets.map(t => Math.hypot(p.x - t.x, p.y - t.y)));
  if (ref.snap === 'circle') {
    let best: ViewFeatures['circles'][number] | null = null, bestD = Infinity;
    for (const c of features.circles) {
      const d = distance(c.center) + 0.5 * Math.abs(c.radius - (ref.radius ?? c.radius));
      if (d < bestD) { bestD = d; best = c; }
    }
    return best && bestD <= reach ? { point: best.center, radius: best.radius, mid: best.mid, full: best.full } : null;
  }
  if (ref.snap === 'center') {
    let best: Point2D | null = null, bestD = Infinity;
    for (const c of features.circles) {
      const d = distance(c.center) + (ref.radius !== undefined ? 0.5 * Math.abs(c.radius - ref.radius) : 0);
      if (d < bestD) { bestD = d; best = c.center; }
    }
    return best && bestD <= reach ? { point: best } : null;
  }
  const list = features.ends;
  let best: Point2D | null = null, bestD = Infinity;
  for (const p of list) {
    const d = distance(p);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= reach ? { point: best } : null;
}

/** A dimension measured on the current geometry: the two points it runs between (view coordinates) and its value. */
export interface MeasuredDimension {
  /** Null for automatic callouts (not stored). */
  dim: DrawingDimension | null;
  view: DimensionView;
  orientation: 'horizontal' | 'vertical';
  p1: Point2D;
  p2: Point2D;
  value: number;
  /** Text before the value: 'Ø', 'R', '4× Ø'. */
  prefix: string;
}

/** Measure a stored dimension on a view, or null when an attachment cannot be found (dangling). */
export function measureDimension(dim: DrawingDimension, features: ViewFeatures, bounds: ViewBounds): MeasuredDimension | null {
  if (dim.kind === 'diameter' || dim.kind === 'radius') {
    const c = dim.refs[0] ? resolveRef(dim.refs[0], features, bounds) : null;
    if (!c || c.radius === undefined) return null;
    const { x, y } = c.point;
    const r = c.radius;
    if (dim.kind === 'diameter') return { dim, view: dim.view, orientation: 'horizontal', p1: { x: x - r, y }, p2: { x: x + r, y }, value: 2 * r, prefix: 'Ø' };
    // From the centre to the side the arc faces
    const side = c.full || Math.cos(c.mid ?? 0) >= 0 ? 1 : -1;
    return { dim, view: dim.view, orientation: 'horizontal', p1: { x, y }, p2: { x: x + side * r, y }, value: r, prefix: 'R' };
  }
  const [a, b] = dim.refs.map(r => resolveRef(r, features, bounds));
  if (!a || !b) return null;
  const horizontal = dim.kind === 'horizontal';
  const value = horizontal ? Math.abs(b.point.x - a.point.x) : Math.abs(b.point.y - a.point.y);
  return { dim, view: dim.view, orientation: horizontal ? 'horizontal' : 'vertical', p1: a.point, p2: b.point, value, prefix: '' };
}

/**
 * Hole callouts for a view: one Ø dimension per size of visible full circle
 * (smallest first, at most `max`), on the leftmost circle of that size, with
 * the count when there are several ("4× Ø9").
 */
export function autoDiameters(view: DimensionView, v: ViewLike, max = 3): MeasuredDimension[] {
  const size = Math.hypot((v.bounds.maxX - v.bounds.minX) || 0, (v.bounds.maxY - v.bounds.minY) || 0) || 1;
  const tol = 1e-4 * size;
  const groups: Array<{ radius: number; circles: DrawingArc[] }> = [];
  for (const a of v.arcs) {
    if (!a.full || a.type === 'hidden') continue;
    const g = groups.find(q => Math.abs(q.radius - a.radius) <= tol);
    if (g) g.circles.push(a);
    else groups.push({ radius: a.radius, circles: [a] });
  }
  return groups.sort((p, q) => p.radius - q.radius).slice(0, max).map(g => {
    const c = g.circles.reduce((m, a) => (a.center.x < m.center.x ? a : m));
    const n = g.circles.length;
    return {
      dim: null, view, orientation: 'horizontal' as const,
      p1: { x: c.center.x - g.radius, y: c.center.y }, p2: { x: c.center.x + g.radius, y: c.center.y },
      value: 2 * g.radius, prefix: n > 1 ? `${n}× Ø` : 'Ø',
    };
  });
}

/** Which band of the sheet a dimension goes in: horizontal ones above their view, vertical ones beside it. */
export function dimensionSide(view: DimensionView, orientation: 'horizontal' | 'vertical'): 'above' | 'left' | 'right' {
  if (orientation === 'horizontal') return 'above';
  return view === 'front' ? 'left' : 'right';
}

const isPoint = (p: unknown): p is Point2D => !!p && typeof p === 'object' && Number.isFinite((p as Point2D).x) && Number.isFinite((p as Point2D).y);

/** Dimensions read from a project file: malformed entries are dropped. */
export function sanitizeDimensions(input: unknown): DrawingDimension[] {
  if (!Array.isArray(input)) return [];
  const out: DrawingDimension[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Partial<DrawingDimension>;
    if (typeof d.id !== 'string' || !DIMENSION_VIEWS.includes(d.view as DimensionView) || !DIMENSION_KINDS.includes(d.kind as DimensionKind)) continue;
    const refs = Array.isArray(d.refs) ? d.refs.filter(r => r && ['end', 'center', 'circle'].includes(r.snap) && isPoint(r.at) && isPoint(r.rel)) : [];
    const need = d.kind === 'diameter' || d.kind === 'radius' ? 1 : 2;
    if (refs.length !== need) continue;
    out.push({
      id: d.id, view: d.view as DimensionView, kind: d.kind as DimensionKind,
      refs: refs.map(r => ({ snap: r.snap, at: { x: r.at.x, y: r.at.y }, rel: { x: r.rel.x, y: r.rel.y }, ...(Number.isFinite(r.radius) ? { radius: r.radius } : {}) })),
      value: Number.isFinite(d.value) ? Number(d.value) : 0,
    });
  }
  return out;
}

/** A placed view (sheet millimetres) back in view coordinates (model units), as dimensions see it. */
export function sheetViewToModel(v: { visible: DrawingLine[]; hidden: DrawingLine[]; arcs: DrawingArc[]; bounds: ViewBounds; scale: number; offsetX?: number; offsetY?: number }): ViewLike & { bounds: Required<Pick<ViewBounds, 'minX' | 'maxX' | 'minY' | 'maxY'>> } {
  const k = v.scale || 1, ox = v.offsetX ?? 0, oy = v.offsetY ?? 0;
  const back = (p: Point2D): Point2D => ({ x: (p.x - ox) / k, y: (oy - p.y) / k });
  const line = (l: DrawingLine): DrawingLine => ({ ...l, p1: back(l.p1), p2: back(l.p2) });
  return {
    visible: v.visible.map(line),
    hidden: v.hidden.map(line),
    // Sheet arcs run from s to e with y down: in view coordinates from −e to −s
    arcs: v.arcs.map(a => ({ ...a, center: back(a.center), radius: a.radius / k, startAngle: a.full ? 0 : -a.endAngle, endAngle: a.full ? Math.PI * 2 : -a.startAngle })),
    bounds: { minX: (v.bounds.minX - ox) / k, maxX: (v.bounds.maxX - ox) / k, minY: (oy - v.bounds.maxY) / k, maxY: (oy - v.bounds.minY) / k },
  };
}

/** What a click attaches to: the nearest corner or centre within `reach`, else the nearest circle. */
export function pickRef(features: ViewFeatures, bounds: ViewBounds, at: Point2D, reach: number): DimensionRef | null {
  const end = refAt(features, bounds, 'end', at, reach);
  const center = refAt(features, bounds, 'center', at, reach);
  const circle = refAt(features, bounds, 'circle', at, reach);
  const d = (r: DimensionRef | null) => (r ? Math.hypot(r.at.x - at.x, r.at.y - at.y) : Infinity);
  const point = d(end) <= d(center) ? end : center;
  // A click on the circle line itself, well away from any corner or centre, means the circle
  const onCircle = circle ? Math.abs(Math.hypot(at.x - circle.at.x, at.y - circle.at.y) - (circle.radius ?? 0)) : Infinity;
  return circle && onCircle < 0.5 * d(point) ? circle : point ?? circle;
}

/**
 * A new dimension from picked places in one view (view coordinates). One
 * circle gives a diameter (a full circle) or a radius (an arc); two corners
 * or centres give a horizontal or vertical distance ('auto': along the larger
 * of the two). Returns an error message when the picks do not make one.
 */
export function makeDimension(v: ViewLike, view: DimensionView, kind: DimensionKind | 'auto', points: Point2D[], reach: number, id: string): DrawingDimension | string {
  const features = viewFeatures(v);
  if (kind === 'diameter' || kind === 'radius' || (kind === 'auto' && points.length === 1)) {
    if (points.length !== 1) return 'A diameter or radius takes one point on a circle';
    const ref = refAt(features, v.bounds, 'circle', points[0], reach);
    if (!ref) return 'No circle or arc there';
    const circle = features.circles.find(c => Math.hypot(c.center.x - ref.at.x, c.center.y - ref.at.y) < 1e-9 && c.radius === ref.radius);
    const k: DimensionKind = kind === 'auto' ? (circle?.full ? 'diameter' : 'radius') : kind;
    const dim: DrawingDimension = { id, view, kind: k, refs: [ref], value: 0 };
    dim.value = measureDimension(dim, features, v.bounds)?.value ?? 0;
    return dim;
  }
  if (points.length !== 2) return 'A distance takes two points';
  const refs = points.map(p => pickRef(features, v.bounds, p, reach));
  if (refs.some(r => !r || r.snap === 'circle')) return 'Pick a corner or the centre of a circle';
  const [a, b] = refs as DimensionRef[];
  const dx = Math.abs(b.at.x - a.at.x), dy = Math.abs(b.at.y - a.at.y);
  if (dx < 1e-9 && dy < 1e-9) return 'The two points are the same';
  const k: DimensionKind = kind === 'auto' ? (dx >= dy ? 'horizontal' : 'vertical') : kind;
  const dim: DrawingDimension = { id, view, kind: k, refs: [a, b], value: k === 'horizontal' ? dx : dy };
  if (dim.value < 1e-9) return k === 'horizontal' ? 'The points are one above the other: use vertical' : 'The points are level: use horizontal';
  return dim;
}
