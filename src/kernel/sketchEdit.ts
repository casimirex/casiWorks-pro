// CasiWorks Pro - Sketch editing: trim, extend, offset and mirror
//
// Pure functions over the sketch's entity list. Each returns the new list (the
// caller stores it) or an error message for the status bar. Lines, arcs and
// circles are edited exactly; splines and ellipses take part as boundaries
// (through their drawn polylines) and can be mirrored, but not trimmed or offset.
import { entityPolyline } from './profile.ts';
import type { ProfileEntity } from './profile.ts';
import { generateId } from '../utils/math.ts';
import type { ArcEntity, CircleEntity, LineEntity, Point2, SketchEntity } from '../types/cad.ts';

export type EditResult = { entities: SketchEntity[]; message: string } | { error: string };

const TAU = Math.PI * 2;
const EPS = 1e-9;
/** Endpoints closer than this (mm) are the same point. */
const JOIN_TOL = 1e-4;

const sub = (a: Point2, b: Point2): Point2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point2, b: Point2): Point2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Point2, s: number): Point2 => ({ x: a.x * s, y: a.y * s });
const dot = (a: Point2, b: Point2) => a.x * b.x + a.y * b.y;
const cross = (a: Point2, b: Point2) => a.x * b.y - a.y * b.x;
const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
const pt = (p: Point2): Point2 => ({ x: p.x, y: p.y });
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const polar = (c: Point2, r: number, a: number): Point2 => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });

/** Sweep of an arc, counter-clockwise from its start, in (0, 2π]. */
export function arcSweep(a: ArcEntity): number {
  const s = norm(a.endAngle - a.startAngle);
  return s < EPS ? TAU : s;
}
const arcParam = (a: ArcEntity, angle: number) => norm(angle - a.startAngle);
const arcStart = (a: ArcEntity) => polar(a.center, a.radius, a.startAngle);
const arcEnd = (a: ArcEntity) => polar(a.center, a.radius, a.startAngle + arcSweep(a));

// ------------------------------------------------------------------ pieces and intersections

/** A bounded piece of an entity: a segment, or part of a circle (sweep 2π for a full one). */
type Piece =
  | { kind: 'seg'; a: Point2; b: Point2 }
  | { kind: 'arc'; c: Point2; r: number; start: number; sweep: number };

function piecesOf(e: SketchEntity): Piece[] {
  switch (e.type) {
    case 'line': return [{ kind: 'seg', a: e.p1, b: e.p2 }];
    case 'arc': return [{ kind: 'arc', c: e.center, r: e.radius, start: e.startAngle, sweep: arcSweep(e) }];
    case 'circle': return [{ kind: 'arc', c: e.center, r: e.radius, start: 0, sweep: TAU }];
    case 'point': return [];
    default: {
      const poly = entityPolyline(e as unknown as ProfileEntity);
      if (!poly) return [];
      const pts = poly.closed ? [...poly.points, poly.points[0]] : poly.points;
      return pts.slice(1).map((b, i) => ({ kind: 'seg' as const, a: pts[i], b }));
    }
  }
}

function onPiece(p: Piece, q: Point2, tol: number): boolean {
  if (p.kind === 'seg') {
    const d = sub(p.b, p.a);
    const len2 = dot(d, d);
    if (len2 < EPS) return dist(p.a, q) <= tol;
    const t = dot(sub(q, p.a), d) / len2;
    const lenTol = tol / Math.sqrt(len2);
    return t >= -lenTol && t <= 1 + lenTol;
  }
  if (p.sweep >= TAU) return true;
  const u = norm(Math.atan2(q.y - p.c.y, q.x - p.c.x) - p.start);
  const angTol = tol / Math.max(p.r, EPS);
  return u <= p.sweep + angTol || u >= TAU - angTol;
}

/** Intersections of the infinite line through a, b with a line or circle (pieces taken unbounded). */
function lineWith(a: Point2, b: Point2, other: Piece): Point2[] {
  const d = sub(b, a);
  if (other.kind === 'seg') {
    const e = sub(other.b, other.a);
    const den = cross(d, e);
    if (Math.abs(den) < EPS * Math.max(1, dot(d, d), dot(e, e))) return [];
    const t = cross(sub(other.a, a), e) / den;
    return [add(a, mul(d, t))];
  }
  // |a + t d - c|² = r²
  const f = sub(a, other.c);
  const A = dot(d, d);
  const B = 2 * dot(f, d);
  const C = dot(f, f) - other.r * other.r;
  const disc = B * B - 4 * A * C;
  if (A < EPS || disc < -EPS) return [];
  if (disc <= EPS * Math.max(1, B * B)) return [add(a, mul(d, -B / (2 * A)))];
  const s = Math.sqrt(disc);
  return [add(a, mul(d, (-B - s) / (2 * A))), add(a, mul(d, (-B + s) / (2 * A)))];
}

function circleWith(c: Point2, r: number, other: Piece): Point2[] {
  if (other.kind === 'seg') return lineWith(other.a, other.b, { kind: 'arc', c, r, start: 0, sweep: TAU });
  const d = dist(c, other.c);
  if (d < EPS || d > r + other.r + EPS || d < Math.abs(r - other.r) - EPS) return [];
  const a = (r * r - other.r * other.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r * r - a * a));
  const u = mul(sub(other.c, c), 1 / d);
  const m = add(c, mul(u, a));
  if (h < 1e-9) return [m];
  const n = { x: -u.y, y: u.x };
  return [add(m, mul(n, h)), add(m, mul(n, -h))];
}

/** Where the entity's own piece crosses the other entities (bounded on both sides). */
function crossings(target: Piece, others: SketchEntity[]): Point2[] {
  const out: Point2[] = [];
  const tol = 1e-6;
  for (const o of others) {
    for (const p of piecesOf(o)) {
      const hits = target.kind === 'seg' ? lineWith(target.a, target.b, p) : circleWith(target.c, target.r, p);
      for (const h of hits) if (onPiece(target, h, tol) && onPiece(p, h, tol)) out.push(h);
    }
  }
  return out;
}

// ------------------------------------------------------------------ picking

/** Distance from q to the entity as drawn. */
export function distanceToEntity(e: SketchEntity, q: Point2): number {
  if (e.type === 'point') return dist(e, q);
  let best = Infinity;
  for (const p of piecesOf(e)) {
    if (p.kind === 'seg') {
      const d = sub(p.b, p.a);
      const len2 = dot(d, d);
      const t = len2 < EPS ? 0 : Math.min(1, Math.max(0, dot(sub(q, p.a), d) / len2));
      best = Math.min(best, dist(q, add(p.a, mul(d, t))));
    } else if (onPiece(p, q, 0)) {
      best = Math.min(best, Math.abs(dist(q, p.c) - p.r));
    } else {
      best = Math.min(best, dist(q, polar(p.c, p.r, p.start)), dist(q, polar(p.c, p.r, p.start + p.sweep)));
    }
  }
  return best;
}

/** The entity nearest q within tol, or null. */
export function pickEntity(entities: SketchEntity[], q: Point2, tol: number): SketchEntity | null {
  let best: SketchEntity | null = null;
  let bestD = tol;
  for (const e of entities) {
    const d = distanceToEntity(e, q);
    if (d <= bestD) { best = e; bestD = d; }
  }
  return best;
}

// ------------------------------------------------------------------ trim

const replaceWith = (entities: SketchEntity[], id: string, pieces: SketchEntity[]) => {
  const i = entities.findIndex(e => e.id === id);
  return [...entities.slice(0, i), ...pieces, ...entities.slice(i + 1)];
};

/**
 * Trim the entity `id` at the click: the part between the nearest crossings
 * on either side of the click is removed. With no crossings the whole entity goes.
 */
export function trimEntity(entities: SketchEntity[], id: string, click: Point2): EditResult {
  const e = entities.find(x => x.id === id);
  if (!e) return { error: 'Nothing to trim there' };
  const others = entities.filter(x => x.id !== id);
  const keep = { construction: e.construction };

  if (e.type === 'point') return { entities: replaceWith(entities, id, []), message: 'Point deleted' };

  if (e.type === 'line') {
    const d = sub(e.p2, e.p1);
    const len = Math.hypot(d.x, d.y);
    const tOf = (p: Point2) => dot(sub(p, e.p1), d) / (len * len);
    const edge = 1e-6 / len;
    const cuts = crossings({ kind: 'seg', a: e.p1, b: e.p2 }, others).map(tOf).filter(t => t > edge && t < 1 - edge);
    if (cuts.length === 0) return { entities: replaceWith(entities, id, []), message: 'Line deleted (it crosses nothing)' };
    const t0 = Math.min(1, Math.max(0, tOf(click)));
    const lo = Math.max(-Infinity, ...cuts.filter(t => t < t0));
    const hi = Math.min(Infinity, ...cuts.filter(t => t > t0));
    const at = (t: number) => add(e.p1, mul(d, t));
    const pieces: LineEntity[] = [];
    if (lo > -Infinity) pieces.push({ id: e.id, type: 'line', p1: pt(e.p1), p2: at(lo), ...keep });
    if (hi < Infinity) pieces.push({ id: pieces.length ? generateId('ent') : e.id, type: 'line', p1: at(hi), p2: pt(e.p2), ...keep });
    return { entities: replaceWith(entities, id, pieces), message: 'Line trimmed' };
  }

  if (e.type === 'arc') {
    const sweep = arcSweep(e);
    const uOf = (p: Point2) => arcParam(e, Math.atan2(p.y - e.center.y, p.x - e.center.x));
    const edge = 1e-6 / e.radius;
    const cuts = crossings({ kind: 'arc', c: e.center, r: e.radius, start: e.startAngle, sweep }, others)
      .map(uOf).filter(u => u > edge && u < sweep - edge);
    if (cuts.length === 0) return { entities: replaceWith(entities, id, []), message: 'Arc deleted (it crosses nothing)' };
    let u0 = uOf(click);
    if (u0 > sweep) u0 = u0 - sweep < TAU - u0 ? sweep : 0; // clicked just past an end
    const lo = Math.max(-Infinity, ...cuts.filter(u => u < u0));
    const hi = Math.min(Infinity, ...cuts.filter(u => u > u0));
    const pieces: ArcEntity[] = [];
    const arc = (a: number, b: number, newId: string): ArcEntity => ({ id: newId, type: 'arc', center: pt(e.center), radius: e.radius, startAngle: e.startAngle + a, endAngle: e.startAngle + b, ...keep });
    if (lo > -Infinity) pieces.push(arc(0, lo, e.id));
    if (hi < Infinity) pieces.push(arc(hi, sweep, pieces.length ? generateId('ent') : e.id));
    return { entities: replaceWith(entities, id, pieces), message: 'Arc trimmed' };
  }

  if (e.type === 'circle') {
    const cuts = [...new Set(crossings({ kind: 'arc', c: e.center, r: e.radius, start: 0, sweep: TAU }, others)
      .map(p => norm(Math.atan2(p.y - e.center.y, p.x - e.center.x))).map(a => +a.toFixed(12)))].sort((a, b) => a - b);
    if (cuts.length === 0) return { entities: replaceWith(entities, id, []), message: 'Circle deleted (it crosses nothing)' };
    if (cuts.length === 1) return { error: 'A circle needs two crossings to trim' };
    const a0 = norm(Math.atan2(click.y - e.center.y, click.x - e.center.x));
    const hi = cuts.find(a => a > a0) ?? cuts[0];
    const lo = [...cuts].reverse().find(a => a < a0) ?? cuts[cuts.length - 1];
    // Keep the rest: from the crossing after the click round to the one before it
    let end = lo;
    if (end <= hi) end += TAU;
    const arc: ArcEntity = { id: e.id, type: 'arc', center: pt(e.center), radius: e.radius, startAngle: hi, endAngle: end, ...keep };
    return { entities: replaceWith(entities, id, [arc]), message: 'Circle trimmed to an arc' };
  }

  return { error: 'Trim works on lines, arcs and circles' };
}

// ------------------------------------------------------------------ extend

/** Extend the end of line `id` nearest the click to the first entity it would meet. */
export function extendLine(entities: SketchEntity[], id: string, click: Point2): EditResult {
  const e = entities.find(x => x.id === id);
  if (!e) return { error: 'Nothing to extend there' };
  if (e.type !== 'line') return { error: 'Extend works on lines' };
  const fromEnd = dist(click, e.p2) <= dist(click, e.p1);
  const d = sub(e.p2, e.p1);
  const len2 = dot(d, d);
  let best: number | null = null;
  for (const o of entities) {
    if (o.id === id) continue;
    for (const p of piecesOf(o)) {
      for (const h of lineWith(e.p1, e.p2, p)) {
        if (!onPiece(p, h, 1e-6)) continue;
        const t = dot(sub(h, e.p1), d) / len2;
        if (fromEnd ? t > 1 + 1e-9 && (best === null || t < best) : t < -1e-9 && (best === null || t > best)) best = t;
      }
    }
  }
  if (best === null) return { error: 'Nothing to extend to in that direction' };
  const to = add(e.p1, mul(d, best));
  const line: LineEntity = fromEnd ? { ...e, p1: pt(e.p1), p2: to } : { ...e, p1: to, p2: pt(e.p2) };
  return { entities: replaceWith(entities, id, [line]), message: `Line extended by ${(dist(fromEnd ? e.p2 : e.p1, to)).toFixed(2)} mm` };
}

// ------------------------------------------------------------------ offset

/** A line or arc in a chain, in the direction the chain runs. */
interface Link { e: LineEntity | ArcEntity; rev: boolean }
const linkStart = (l: Link) => l.e.type === 'line' ? (l.rev ? l.e.p2 : l.e.p1) : (l.rev ? arcEnd(l.e) : arcStart(l.e));
const linkEnd = (l: Link) => l.e.type === 'line' ? (l.rev ? l.e.p1 : l.e.p2) : (l.rev ? arcStart(l.e) : arcEnd(l.e));

/** The chain of lines and arcs joined end to end through `start`; stops where the sketch branches. */
function chainFrom(entities: SketchEntity[], start: LineEntity | ArcEntity): { links: Link[]; closed: boolean } {
  const pool = entities.filter((e): e is LineEntity | ArcEntity => (e.type === 'line' || e.type === 'arc') && !!e.construction === !!start.construction);
  const used = new Set([start.id]);
  const links: Link[] = [{ e: start, rev: false }];
  const next = (p: Point2): Link | null => {
    const found: Link[] = [];
    for (const e of pool) {
      if (used.has(e.id)) continue;
      const fwd = { e, rev: false };
      const back = { e, rev: true };
      if (dist(linkStart(fwd), p) < JOIN_TOL) found.push(fwd);
      else if (dist(linkStart(back), p) < JOIN_TOL) found.push(back);
    }
    return found.length === 1 ? found[0] : null; // a branch: stop
  };
  for (let l = next(linkEnd(links[links.length - 1])); l; l = next(linkEnd(links[links.length - 1]))) { used.add(l.e.id); links.push(l); }
  const closed = links.length > 1 && dist(linkEnd(links[links.length - 1]), linkStart(links[0])) < JOIN_TOL;
  if (!closed) {
    // Walk backwards from the start too
    const prev = (p: Point2): Link | null => {
      const l = next(p); // a link starting at p, reversed, ends at p
      return l ? { e: l.e, rev: !l.rev } : null;
    };
    for (let l = prev(linkStart(links[0])); l; l = prev(linkStart(links[0]))) { used.add(l.e.id); links.unshift(l); }
  }
  return { links, closed };
}

/** Offset of one link by s to the left of its travel direction. */
function offsetLink(l: Link, s: number): Link | null {
  if (l.e.type === 'line') {
    const a = linkStart(l), b = linkEnd(l);
    const d = sub(b, a);
    const len = Math.hypot(d.x, d.y);
    const n = { x: -d.y / len * s, y: d.x / len * s };
    const p1 = add(l.e.p1, n), p2 = add(l.e.p2, n);
    return { e: { ...l.e, id: generateId('ent'), p1, p2 }, rev: l.rev };
  }
  // Travelling counter-clockwise, left is towards the centre
  const r = l.e.radius + (l.rev ? s : -s);
  if (r <= 1e-6) return null;
  return { e: { ...l.e, id: generateId('ent'), center: pt(l.e.center), radius: r }, rev: l.rev };
}

const pieceOfLink = (l: Link): Piece => l.e.type === 'line'
  ? { kind: 'seg', a: l.e.p1, b: l.e.p2 }
  : { kind: 'arc', c: l.e.center, r: l.e.radius, start: 0, sweep: TAU };

function setLinkEnd(l: Link, which: 'start' | 'end', p: Point2): void {
  if (l.e.type === 'line') {
    const firstPoint = (which === 'start') !== l.rev;
    if (firstPoint) l.e.p1 = p; else l.e.p2 = p;
  } else {
    const a = Math.atan2(p.y - l.e.center.y, p.x - l.e.center.x);
    const arcStartSide = (which === 'start') !== l.rev;
    const sweep = arcSweep(l.e);
    if (arcStartSide) {
      const end = l.e.startAngle + sweep;
      l.e.startAngle = a;
      l.e.endAngle = a + (norm(end - a) || TAU);
    } else {
      l.e.endAngle = l.e.startAngle + (norm(a - l.e.startAngle) || TAU);
    }
  }
}

/** Distance of q from the line's or arc's side: + on the left of the link's direction. */
function sideOf(l: Link, q: Point2): number {
  if (l.e.type === 'line') return Math.sign(cross(sub(linkEnd(l), linkStart(l)), sub(q, linkStart(l))));
  const inside = dist(q, l.e.center) < l.e.radius;
  return (inside !== l.rev) ? 1 : -1;
}

/**
 * Offset the entity `id` by `distance` towards `side`. Lines and arcs offset
 * their whole chain (e.g. a rectangle or a slot), with corners re-joined.
 */
export function offsetEntity(entities: SketchEntity[], id: string, distance: number, side: Point2): EditResult {
  if (!(distance > 0) || !Number.isFinite(distance)) return { error: 'Offset distance must be above 0' };
  const e = entities.find(x => x.id === id);
  if (!e) return { error: 'Nothing to offset there' };
  if (e.type === 'circle') {
    const inside = dist(side, e.center) < e.radius;
    const r = e.radius + (inside ? -distance : distance);
    if (r <= 1e-6) return { error: `Offset ${distance} mm is larger than the radius` };
    const c: CircleEntity = { ...e, id: generateId('ent'), center: pt(e.center), radius: r };
    return { entities: [...entities, c], message: `Circle offset ${distance} mm ${inside ? 'inwards' : 'outwards'}` };
  }
  if (e.type !== 'line' && e.type !== 'arc') return { error: 'Offset works on lines, arcs and circles' };

  const { links, closed } = chainFrom(entities, e);
  const clicked = links.find(l => l.e.id === id)!;
  const s = sideOf(clicked, side) * distance;
  if (s === 0) return { error: 'Click to one side of the entity' };
  const out: Link[] = [];
  for (const l of links) {
    const o = offsetLink(l, s);
    if (!o) return { error: `Offset ${distance} mm is larger than an arc's radius` };
    out.push(o);
  }

  // Re-join neighbours: move both ends to where the offset curves meet, nearest the old corner
  const extra: LineEntity[] = [];
  const joins = closed ? out.length : out.length - 1;
  for (let i = 0; i < joins; i++) {
    const a = out[i], b = out[(i + 1) % out.length];
    const ea = linkEnd(a), sb = linkStart(b);
    if (dist(ea, sb) < JOIN_TOL) continue;
    const corner = linkEnd(links[i]);
    const pa = pieceOfLink(a), pb = pieceOfLink(b);
    const hits = pa.kind === 'seg' ? lineWith(pa.a, pa.b, pb) : circleWith(pa.c, pa.r, pb);
    const hit = hits.sort((p, q) => dist(p, corner) - dist(q, corner))[0];
    if (hit && dist(hit, corner) < 2 * distance + dist(ea, sb)) {
      setLinkEnd(a, 'end', hit);
      setLinkEnd(b, 'start', hit);
    } else {
      extra.push({ id: generateId('ent'), type: 'line', p1: pt(ea), p2: pt(sb), construction: e.construction });
    }
  }
  // A line that turned round has collapsed: the offset is too big for it
  for (let i = 0; i < out.length; i++) {
    const o = out[i].e, l = links[i].e;
    if (o.type === 'line' && l.type === 'line' && dot(sub(o.p2, o.p1), sub(l.p2, l.p1)) <= 0) {
      return { error: `Offset ${distance} mm is too large for this shape` };
    }
  }
  const made = [...out.map(l => l.e), ...extra];
  const what = links.length === 1 ? (e.type === 'line' ? 'Line' : 'Arc') : `${closed ? 'Closed chain' : 'Chain'} of ${links.length}`;
  return { entities: [...entities, ...made], message: `${what} offset ${distance} mm` };
}

// ------------------------------------------------------------------ mirror

/** Mirror a copy of each entity in `ids` about the line `axisId`. */
export function mirrorEntities(entities: SketchEntity[], axisId: string, ids: string[]): EditResult {
  const axis = entities.find(x => x.id === axisId);
  if (!axis || axis.type !== 'line') return { error: 'Pick a line as the mirror line' };
  const d = sub(axis.p2, axis.p1);
  const len = Math.hypot(d.x, d.y);
  if (len < EPS) return { error: 'The mirror line has no length' };
  const u = mul(d, 1 / len);
  const phi = Math.atan2(u.y, u.x);
  const reflect = (p: Point2): Point2 => {
    const v = sub(p, axis.p1);
    return add(axis.p1, sub(mul(u, 2 * dot(v, u)), v));
  };
  const copies: SketchEntity[] = [];
  for (const id of ids) {
    const e = entities.find(x => x.id === id);
    if (!e || id === axisId) continue;
    const nid = generateId('ent');
    switch (e.type) {
      case 'line': copies.push({ ...e, id: nid, p1: reflect(e.p1), p2: reflect(e.p2) }); break;
      case 'circle': copies.push({ ...e, id: nid, center: reflect(e.center) }); break;
      case 'arc': {
        // Reflection reverses the direction: the old end becomes the new start
        const start = 2 * phi - (e.startAngle + arcSweep(e));
        copies.push({ ...e, id: nid, center: reflect(e.center), startAngle: start, endAngle: start + arcSweep(e) });
        break;
      }
      case 'point': { const p = reflect(e); copies.push({ ...e, id: nid, x: p.x, y: p.y }); break; }
      case 'spline': copies.push({ ...e, id: nid, controlPoints: e.controlPoints.map(reflect) }); break;
      case 'ellipse': copies.push({ ...e, id: nid, center: reflect(e.center), rotation: 2 * phi - e.rotation }); break;
    }
  }
  if (copies.length === 0) return { error: 'Nothing to mirror' };
  return { entities: [...entities, ...copies], message: `Mirrored ${copies.length} entit${copies.length === 1 ? 'y' : 'ies'}` };
}
