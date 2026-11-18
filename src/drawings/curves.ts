// CasiWorks Pro - True arcs, circles and straight lines for drawing views
//
// The mesh kernel draws a view as many short segments: a hole is a 64-sided
// polygon. Before hidden-line removal, the model's edges are joined into
// chains (by shared mesh vertices) and a chain lying in a plane facing the
// viewer whose corners lie on one circle becomes an arc or a full circle,
// with the exact centre and radius of the circle the polygon was made from.
// Hidden-line removal then runs along each arc, and arcs of the same circle
// seen at several depths are merged. What is left stays as segments, and
// straight runs of those are merged into single lines.
//
// Tessellation corners lie on the true circle, so the fit is tight; a free
// curve does not fit and stays as segments. Circles seen at an angle
// (ellipses, as in the isometric view) also stay as segments.
import type { DrawingLine, LineType, Point2D } from './DrawingEngine.ts';

/** An arc counter-clockwise from startAngle to endAngle (radians) in the frame it is given in. */
export interface DrawingArc {
  center: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
  /** A full circle (startAngle 0, endAngle 2π). */
  full?: boolean;
  type?: LineType;
}

const TAU = Math.PI * 2;

/** Least-squares circle through points (Kåsa fit); null when they are (nearly) collinear. */
export function fitCircle(pts: Point2D[]): { center: Point2D; radius: number } | null {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  const scale = (suu + svv) ** 2;
  if (!(Math.abs(det) > 1e-12 * scale)) return null;
  const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2;
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  const center = { x: uc + mx, y: vc + my };
  let r = 0;
  for (const p of pts) r += Math.hypot(p.x - center.x, p.y - center.y);
  return { center, radius: r / n };
}

const sub = (a: Point2D, b: Point2D) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Point2D, b: Point2D) => a.x * b.y - a.y * b.x;
const dist = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Walk a graph of edges (node pairs) into chains of nodes: open chains run
 * between end points and junctions, closed chains repeat their first node.
 */
export function chainIds(edges: Array<[number, number]>): number[][] {
  const adj = new Map<number, number[]>();
  edges.forEach(([a, b], i) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(i);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(i);
  });
  const used = new Array(edges.length).fill(false);
  const walk = (start: number, firstEdge: number): number[] => {
    const ids = [start];
    let node = start, e = firstEdge;
    for (;;) {
      used[e] = true;
      node = edges[e][0] === node ? edges[e][1] : edges[e][0];
      ids.push(node);
      if (adj.get(node)!.length !== 2 || node === start) break;
      const next = adj.get(node)!.find(k => !used[k]);
      if (next === undefined) break;
      e = next;
    }
    return ids;
  };
  const chains: number[][] = [];
  for (const [node, list] of adj) {
    if (list.length === 2) continue;
    for (const e of list) if (!used[e]) chains.push(walk(node, e));
  }
  for (let e = 0; e < edges.length; e++) if (!used[e]) chains.push(walk(edges[e][0], e));
  return chains;
}

/**
 * Chains of edges that run on smoothly through junctions: from each edge
 * (longest first) the chain is extended at both ends by the unused edge that
 * turns least, if it turns by less than `maxTurn` and stays at the same depth
 * (z within `depthTol`). Small slivers that touch a rim (left by booleans) so
 * do not cut it into pieces. Closed chains repeat their first node.
 */
export function chainSmooth(edges: Array<[number, number]>, pts: Array<{ x: number; y: number; z: number }>, maxTurn: number, depthTol: number): number[][] {
  const adj = new Map<number, number[]>();
  edges.forEach(([a, b], i) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(i);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(i);
  });
  const used = new Array(edges.length).fill(false);
  const len = (e: number) => Math.hypot(pts[edges[e][1]].x - pts[edges[e][0]].x, pts[edges[e][1]].y - pts[edges[e][0]].y);
  const other = (e: number, n: number) => (edges[e][0] === n ? edges[e][1] : edges[e][0]);
  /** Extend from `node`, arriving from `prev`, until no edge carries on; returns the nodes after `node`. */
  const extend = (prev: number, node: number, stop: number, z0: number): number[] => {
    const out: number[] = [];
    for (;;) {
      if (node === stop) break;
      const ux = pts[node].x - pts[prev].x, uy = pts[node].y - pts[prev].y;
      let best = -1, bestTurn = maxTurn;
      for (const e of adj.get(node) ?? []) {
        if (used[e]) continue;
        const q = other(e, node);
        if (Math.abs(pts[q].z - z0) > depthTol) continue;
        const vx = pts[q].x - pts[node].x, vy = pts[q].y - pts[node].y;
        const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
        if (turn < bestTurn) { bestTurn = turn; best = e; }
      }
      if (best < 0) break;
      used[best] = true;
      prev = node;
      node = other(best, node);
      out.push(node);
    }
    return out;
  };
  const order = edges.map((_, i) => i).sort((p, q) => len(q) - len(p));
  const chains: number[][] = [];
  for (const e of order) {
    if (used[e]) continue;
    used[e] = true;
    const [a, b] = edges[e];
    const z0 = pts[a].z;
    const forward = extend(a, b, a, z0);
    const closed = forward[forward.length - 1] === a;
    const backward = closed ? [] : extend(b, a, -1, z0);
    chains.push([...backward.reverse(), a, b, ...forward]);
  }
  return chains;
}

/**
 * Join 2D segments that share end points (within `tol`) into chains of points.
 * Loose ends up to `gap` apart are joined too, nearest first, when the join
 * carries both chains on in their own direction.
 */
export function chainSegments(lines: DrawingLine[], tol: number, gap = 0): Point2D[][] {
  const nodes: Point2D[] = [];
  const nodeIds = new Map<string, number>();
  const nodeOf = (p: Point2D): number => {
    const cx = Math.round(p.x / tol), cy = Math.round(p.y / tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const id = nodeIds.get(`${cx + dx},${cy + dy}`);
      if (id !== undefined && dist(nodes[id], p) <= tol) return id;
    }
    nodes.push({ x: p.x, y: p.y });
    nodeIds.set(`${cx},${cy}`, nodes.length - 1);
    return nodes.length - 1;
  };
  const edges: Array<[number, number]> = [];
  for (const l of lines) {
    const a = nodeOf(l.p1), b = nodeOf(l.p2);
    if (a !== b) edges.push([a, b]);
  }
  if (gap > tol) {
    const ends = new Map<number, number[]>();
    edges.forEach(([a, b], i) => { (ends.get(a) ?? ends.set(a, []).get(a)!).push(i); (ends.get(b) ?? ends.set(b, []).get(b)!).push(i); });
    const loose = [...ends].filter(([, l]) => l.length === 1).map(([id]) => id);
    const out = (id: number) => {
      const [a, b] = edges[ends.get(id)![0]];
      const from = nodes[a === id ? b : a], to = nodes[id];
      const len = dist(from, to) || 1;
      return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
    };
    const pairs: Array<[number, number, number]> = [];
    for (let i = 0; i < loose.length; i++) for (let j = i + 1; j < loose.length; j++) {
      const p = nodes[loose[i]], q = nodes[loose[j]];
      const d = dist(p, q);
      if (d > gap || d === 0) continue;
      const u = { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
      const op = out(loose[i]), oq = out(loose[j]);
      if (u.x * op.x + u.y * op.y > 0.85 && -(u.x * oq.x + u.y * oq.y) > 0.85) pairs.push([d, loose[i], loose[j]]);
    }
    pairs.sort((x, y) => x[0] - y[0]);
    const done = new Set<number>();
    for (const [, a, b] of pairs) {
      if (done.has(a) || done.has(b)) continue;
      done.add(a); done.add(b);
      edges.push([a, b]);
    }
  }
  return chainIds(edges).map(c => c.map(id => nodes[id]));
}

/** The turn (radians) at b going a → b → c. */
function turnAt(a: Point2D, b: Point2D, c: Point2D): number {
  const u = sub(b, a), v = sub(c, b);
  return Math.abs(Math.atan2(cross(u, v), u.x * v.x + u.y * v.y));
}

/**
 * Indices of the corners of a chain where it really turns: a corner within
 * `tol` of the line past it, or where the chain turns by less than 0.23°, is
 * a piece of one segment and is dropped. Polygon corners of arcs turn by
 * several degrees and stay.
 */
function keptCorners(pts: Point2D[], tol: number): number[] {
  const straight = (a: Point2D, b: Point2D, c: Point2D) => {
    const ac = sub(c, a);
    const len = Math.hypot(ac.x, ac.y);
    if (len === 0 || (b.x - a.x) * ac.x + (b.y - a.y) * ac.y <= 0) return false;
    return Math.abs(cross(ac, sub(b, a))) / len <= tol || turnAt(a, b, c) < 4e-3;
  };
  const out = [0];
  for (let i = 1; i < pts.length - 1; i++) {
    if (!straight(pts[out[out.length - 1]], pts[i], pts[i + 1])) out.push(i);
  }
  out.push(pts.length - 1);
  return out;
}

/**
 * The circle through a run of polygon corners. Corners of the true polygon
 * lie on the circle; points cut part-way along a chord (T-junctions left by
 * booleans) lie inside, so the circle is fitted again to the outermost points.
 */
function circleOfRun(run: Point2D[], tol: number): { center: Point2D; radius: number } | null {
  let fit = fitCircle(run);
  for (let pass = 0; fit && pass < 4; pass++) {
    const f = fit;
    const ds = run.map(p => dist(p, f.center));
    const max = Math.max(...ds);
    const outer = run.filter((_, k) => ds[k] >= max - (0.25 * tol + 1e-4 * f.radius));
    if (outer.length < 3 || outer.length === run.length) break;
    fit = fitCircle(outer) ?? fit;
  }
  return fit;
}

/**
 * Do the points lie on one circle? No point may lie off it by more than
 * `tol`, except inwards by up to the sagitta of the chords next to it (a point
 * cut part-way along a chord). The run must keep turning one way, by less
 * than 45° per chord, and be at least three chords long.
 */
export function arcThrough(run: Point2D[], tol: number): DrawingArc | null {
  if (run.length < 4) return null;
  // The ends of a run may be cut part-way along a chord: fit to the corners between them
  const fit = circleOfRun(run.length >= 5 ? run.slice(1, -1) : run, tol);
  if (!fit) return null;
  const { center, radius } = fit;
  const onTol = tol + 2e-4 * radius;
  for (let k = 0; k < run.length; k++) {
    // Only short chords (polygon sides, under ~11°) give slack: not a straight edge running into the arc
    const chordSlack = (c: number) => (c <= 0.2 * radius ? (c * c) / (2 * radius) : 0);
    const slack = Math.max(k > 0 ? chordSlack(dist(run[k], run[k - 1])) : 0, k + 1 < run.length ? chordSlack(dist(run[k], run[k + 1])) : 0);
    const d = dist(run[k], center) - radius;
    if (d > onTol || d < -(onTol + slack)) return null;
  }
  let sweep = 0;
  let sign = 0;
  for (let k = 0; k + 1 < run.length; k++) {
    let d = Math.atan2(run[k + 1].y - center.y, run[k + 1].x - center.x) - Math.atan2(run[k].y - center.y, run[k].x - center.x);
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    if (Math.abs(d) > Math.PI / 4 || Math.abs(d) < 1e-9) return null;
    const s = Math.sign(d);
    if (sign && s !== sign) return null;
    sign = s;
    sweep += d;
  }
  if (Math.abs(sweep) > TAU + 1e-6) return null;
  const from = sign > 0 ? run[0] : run[run.length - 1];
  const startAngle = Math.atan2(from.y - center.y, from.x - center.x);
  return { center, radius, startAngle, endAngle: startAngle + Math.abs(sweep) };
}

/** A piece of a chain: points `ids` (indices into the chain, in order), an arc or straight segments. */
export interface ChainPiece { ids: number[]; arc?: DrawingArc }

/**
 * Split a chain of points into arcs and the rest. A closed chain (last point
 * = first) that lies on one circle is a full circle; otherwise a closed chain
 * starts at its sharpest corner, so no arc is cut at the seam. Arcs are taken
 * greedily, as long as possible.
 */
export function arcsInChain(chain: Point2D[], size: number): ChainPiece[] {
  // Mesh corners are rounded to 1e-4 mm when welded: within that, pieces of one segment are straight
  const straightTol = 2e-4 + 1e-6 * size;
  const circleTol = 1.5e-4 * size + 1e-9;
  let order = chain.map((_, i) => i);
  const closed = chain.length > 4 && dist(chain[0], chain[chain.length - 1]) <= 1e-9 * (size || 1);
  if (closed) {
    const ring = order.slice(0, -1);
    const pts = ring.map(i => chain[i]);
    const kept = keptCorners([...pts, pts[0]], straightTol).slice(0, -1);
    if (kept.length >= 8) {
      const whole = arcThrough([...kept.map(k => pts[k]), pts[kept[0]]], circleTol);
      if (whole && Math.abs(whole.endAngle - whole.startAngle - TAU) < 1e-6) {
        return [{ ids: [...ring, ring[0]], arc: { ...whole, startAngle: 0, endAngle: TAU, full: true } }];
      }
    }
    let sharpest = 0, worst = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      const turn = turnAt(pts[(k + ring.length - 1) % ring.length], pts[k], pts[(k + 1) % ring.length]);
      if (turn > worst) { worst = turn; sharpest = k; }
    }
    order = [...ring.slice(sharpest), ...ring.slice(0, sharpest), ring[sharpest]];
  }
  const pts = order.map(i => chain[i]);
  const kept = keptCorners(pts, straightTol);
  const corners = kept.map(k => pts[k]);
  const pieces: ChainPiece[] = [];
  const span = (a: number, b: number) => order.slice(kept[a], kept[b] + 1);
  const last = corners.length - 1;
  let i = 0;
  while (i < last) {
    const fits = (j: number) => arcThrough(corners.slice(i, j + 1), circleTol);
    const probe = Math.min(i + 4, last);
    let j = probe > i + 3 && fits(probe) ? probe : i + 3;
    let arc = j <= last ? fits(j) : null;
    if (!arc) {
      pieces.push({ ids: span(i, i + 1) });
      i++;
      continue;
    }
    while (j < last) {
      const longer = fits(j + 1);
      if (!longer) break;
      arc = longer;
      j++;
    }
    pieces.push({ ids: span(i, j), arc });
    i = j;
  }
  return pieces;
}

/** Straight runs of 2D segments merged into single lines (small gaps up to `gap` bridged). */
export function mergeStraight(lines: DrawingLine[], type: LineType, size: number, gap = 0): DrawingLine[] {
  const out: DrawingLine[] = [];
  const straightTol = 1e-4 * size + 1e-9;
  for (const chain of chainSegments(lines, 1e-6 * size + 1e-9, gap)) {
    const kept = keptCorners(chain, straightTol);
    for (let k = 0; k + 1 < kept.length; k++) {
      const a = chain[kept[k]], b = chain[kept[k + 1]];
      out.push({ p1: a, p2: b, type, length: dist(a, b) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- angle intervals

/** Angle intervals on a circle, as [from, to] with 0 ≤ from < to ≤ 2π. */
export type Intervals = Array<[number, number]>;

/** [a, b] (b > a, any range) as intervals in [0, 2π]. */
export function wrapInterval(a: number, b: number): Intervals {
  if (b - a >= TAU - 1e-12) return [[0, TAU]];
  const s = ((a % TAU) + TAU) % TAU;
  const e = s + (b - a);
  return e <= TAU ? [[s, e]] : [[s, TAU], [0, e - TAU]];
}

export function unionIntervals(list: Intervals, eps = 1e-9): Intervals {
  const sorted = [...list].sort((p, q) => p[0] - q[0]);
  const out: Intervals = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + eps) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function subtractIntervals(list: Intervals, minus: Intervals): Intervals {
  let out = unionIntervals(list);
  for (const [c, d] of unionIntervals(minus)) {
    const next: Intervals = [];
    for (const [a, b] of out) {
      if (d <= a || c >= b) { next.push([a, b]); continue; }
      if (c > a) next.push([a, c]);
      if (d < b) next.push([d, b]);
    }
    out = next;
  }
  return out;
}

/** Arcs covering the intervals of one circle (an interval through angle 0 is one arc; all round is a circle). */
export function intervalsToArcs(list: Intervals, center: Point2D, radius: number, type: LineType, minLength: number): DrawingArc[] {
  const u = unionIntervals(list, minLength / radius);
  if (u.length === 1 && u[0][0] <= 1e-9 && u[0][1] >= TAU - 1e-9) return [{ center, radius, startAngle: 0, endAngle: TAU, full: true, type }];
  if (u.length > 1 && u[0][0] <= 1e-9 && u[u.length - 1][1] >= TAU - 1e-9) {
    const tail = u.pop()!;
    u[0] = [tail[0] - TAU, u[0][1]];
  }
  return u.filter(([a, b]) => (b - a) * radius >= minLength).map(([a, b]) => ({ center, radius, startAngle: a, endAngle: b, type }));
}

// ---------------------------------------------------------------- geometry of arcs

/** A point on an arc at angle a. */
export const arcPoint = (arc: DrawingArc, a: number): Point2D => ({ x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) });

/**
 * Cubic Bézier pieces of an arc (each at most 90°), as [start, control1, control2, end].
 * Used where a format has no arc primitive (PDF).
 */
export function arcBeziers(arc: DrawingArc): Array<[Point2D, Point2D, Point2D, Point2D]> {
  const sweep = arc.endAngle - arc.startAngle;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / n;
  const k = (4 / 3) * Math.tan(step / 4) * arc.radius;
  const out: Array<[Point2D, Point2D, Point2D, Point2D]> = [];
  for (let s = 0; s < n; s++) {
    const a0 = arc.startAngle + s * step, a1 = a0 + step;
    const p0 = arcPoint(arc, a0), p3 = arcPoint(arc, a1);
    out.push([
      p0,
      { x: p0.x - k * Math.sin(a0), y: p0.y + k * Math.cos(a0) },
      { x: p3.x + k * Math.sin(a1), y: p3.y - k * Math.cos(a1) },
      p3,
    ]);
  }
  return out;
}
