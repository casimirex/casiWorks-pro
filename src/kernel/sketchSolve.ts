// CasiWorks Pro - Solving a sketch: its relations and driving dimensions
//
// The sketch keeps its own relations (horizontal, coincident, …) and
// dimensions as solver constraints. Solving also keeps what the drawing
// already joins together: line ends (and points) that meet stay together, and
// an arc that meets a line end keeps meeting it. Arcs are solved by centre and
// radius; their end angles are then turned to follow the line ends they meet.
import { ConstraintSolver } from './ConstraintSolver.ts';
import type { PointRef, SketchConstraint, SolveResult } from './ConstraintSolver.ts';
import { generateId } from '../utils/math.ts';
import type { ArcEntity, Point2, SketchEntity } from '../types/cad.ts';

const JOIN_TOL = 1e-4;
/** The sketch solver: dimensions to about 1e-5 mm; joined ends are then made to meet exactly. */
const sketchSolver = new ConstraintSolver(150, 1e-5);
const TAU = Math.PI * 2;

type End = { id: string; ref: PointRef; at: Point2; arc?: ArcEntity; arcEnd?: 'start' | 'end' };

function endsOf(e: SketchEntity): End[] {
  if (e.type === 'line') return [{ id: e.id, ref: 'p1', at: e.p1 }, { id: e.id, ref: 'p2', at: e.p2 }];
  if (e.type === 'point') return [{ id: e.id, ref: 0, at: { x: e.x, y: e.y } }];
  if (e.type === 'arc') {
    const at = (a: number) => ({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) });
    return [
      { id: e.id, ref: 'start', at: at(e.startAngle), arc: e, arcEnd: 'start' },
      { id: e.id, ref: 'end', at: at(e.endAngle), arc: e, arcEnd: 'end' },
    ];
  }
  return [];
}

export interface SketchSolve {
  entities: SketchEntity[];
  result: SolveResult;
  /** All relations and dimensions are met (within 1e-4 mm). */
  ok: boolean;
  /** Short state for the status bar, e.g. "Fully defined" or "Under defined (4 DOF)". */
  state: 'fully' | 'under' | 'over' | 'failed';
  message: string;
}

/** The constraints that still refer to existing entities. */
export function liveConstraints(entities: SketchEntity[], constraints: SketchConstraint[]): SketchConstraint[] {
  const ids = new Set(entities.map(e => e.id));
  return constraints.filter(c => [c.entity1Id ?? c.entityId, c.entity2Id, c.entity3Id ?? c.axisId].every(id => id === undefined || ids.has(id)));
}

/** Solve the sketch; returns new entities (the input is not changed). */
export function solveSketch(entities: SketchEntity[], constraints: SketchConstraint[]): SketchSolve {
  const work = JSON.parse(JSON.stringify(entities)) as SketchEntity[];
  const user = liveConstraints(work, constraints);

  // Joins the drawing already has: ends that meet stay together
  const ends = work.flatMap(endsOf);
  const implicit: SketchConstraint[] = [];
  const arcLinks: Array<{ arc: ArcEntity; arcEnd: 'start' | 'end'; to: End }> = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i], b = ends[j];
      if (a.id === b.id || Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) > JOIN_TOL) continue;
      if (a.arc && b.arc) continue; // arc to arc: kept by their centres and radii
      if (a.arc || b.arc) {
        const [arcEnd, other] = a.arc ? [a, b] : [b, a];
        implicit.push({ id: generateId('join'), type: 'coincident', entity1Id: other.id, point1: other.ref, entity2Id: arcEnd.id });
        arcLinks.push({ arc: arcEnd.arc!, arcEnd: arcEnd.arcEnd!, to: other });
        // A line meeting an arc tangentially (a slot, a rounded corner) stays tangent
        const line = work.find(e => e.id === other.id);
        if (line?.type === 'line') {
          const arc = arcEnd.arc!;
          const dx = line.p2.x - line.p1.x, dy = line.p2.y - line.p1.y, l = Math.hypot(dx, dy);
          const rx = arcEnd.at.x - arc.center.x, ry = arcEnd.at.y - arc.center.y, r = Math.hypot(rx, ry);
          if (l > 1e-9 && r > 1e-9 && Math.abs((dx * rx + dy * ry) / (l * r)) < 1e-3) {
            implicit.push({ id: generateId('join'), type: 'tangent', entity1Id: line.id, entity2Id: arc.id });
          }
        }
      } else {
        implicit.push({ id: generateId('join'), type: 'coincident', entity1Id: a.id, point1: a.ref, entity2Id: b.id, point2: b.ref });
      }
    }
  }

  // Least change: what the relations and dimensions leave free stays where it was
  const result = sketchSolver.solve(work as never, [...implicit, ...user], { stayNear: 1e-2 });

  // Joined ends meet exactly (the solver stops within its tolerance)
  const endPoint = (id: string, ref: PointRef): Point2 | null => {
    const e = work.find(x => x.id === id);
    if (e?.type === 'line') return ref === 'p1' ? e.p1 : e.p2;
    return null;
  };
  for (const c of implicit) {
    if (c.type !== 'coincident' || c.point2 === undefined) continue;
    const a = endPoint(c.entity1Id!, c.point1!), b = endPoint(c.entity2Id!, c.point2);
    if (a && b) { const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2; a.x = b.x = x; a.y = b.y = y; }
  }

  // Arcs follow the line ends they meet
  for (const { arc, arcEnd, to } of arcLinks) {
    const target = work.find(e => e.id === to.id);
    if (!target) continue;
    const p = target.type === 'line' ? (to.ref === 'p1' ? target.p1 : target.p2) : target.type === 'point' ? { x: target.x, y: target.y } : null;
    if (!p) continue;
    const a = Math.atan2(p.y - arc.center.y, p.x - arc.center.x);
    if (arcEnd === 'start') {
      const sweep = ((arc.endAngle - arc.startAngle) % TAU + TAU) % TAU || TAU;
      arc.startAngle = a;
      arc.endAngle = a + sweep;
    } else {
      const s = ((a - arc.startAngle) % TAU + TAU) % TAU;
      arc.endAngle = arc.startAngle + (s < 1e-9 ? TAU : s);
    }
  }
  // Sweep angles were kept for start moves; recompute the end of arcs whose both ends are linked
  for (const { arc, arcEnd, to } of arcLinks) {
    if (arcEnd !== 'end') continue;
    const target = work.find(e => e.id === to.id);
    const p = target?.type === 'line' ? (to.ref === 'p1' ? target.p1 : target.p2) : null;
    if (!p) continue;
    const a = Math.atan2(p.y - arc.center.y, p.x - arc.center.x);
    const s = ((a - arc.startAngle) % TAU + TAU) % TAU;
    arc.endAngle = arc.startAngle + (s < 1e-9 ? TAU : s);
  }

  const ok = user.length === 0 || (result.converged && result.error < 1e-4);
  const state = !ok ? 'failed' : result.status === 'over_constrained' ? 'over' : result.status === 'fully_constrained' ? 'fully' : 'under';
  const message = state === 'failed'
    ? (result.conflict?.message ?? 'The relations and dimensions cannot all be met')
    : state === 'fully' ? 'Fully defined'
      : state === 'over' ? `Over defined${result.redundant ? `: ${result.redundant.message}` : ''}`
        : `Under defined (${result.dof} degree${result.dof === 1 ? '' : 's'} of freedom)`;
  return { entities: work, result, ok, state, message };
}

// ------------------------------------------------------------------ relations and dimensions as the user sees them

export type RelationKind = 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal' | 'coincident' | 'concentric' | 'tangent' | 'fix';

/** What each relation needs: the entity types for its first and (if any) second pick. */
export const RELATIONS: Record<RelationKind, { label: string; glyph: string; picks: 1 | 2; accepts: Array<SketchEntity['type'] | 'end'> }> = {
  horizontal: { label: 'Horizontal', glyph: 'H', picks: 1, accepts: ['line'] },
  vertical: { label: 'Vertical', glyph: 'V', picks: 1, accepts: ['line'] },
  parallel: { label: 'Parallel', glyph: '∥', picks: 2, accepts: ['line'] },
  perpendicular: { label: 'Perpendicular', glyph: '⊥', picks: 2, accepts: ['line'] },
  equal: { label: 'Equal', glyph: '=', picks: 2, accepts: ['line', 'circle', 'arc'] },
  coincident: { label: 'Coincident', glyph: '●', picks: 2, accepts: ['end', 'line', 'circle', 'arc', 'point'] },
  concentric: { label: 'Concentric', glyph: '◎', picks: 2, accepts: ['circle', 'arc'] },
  tangent: { label: 'Tangent', glyph: 'T', picks: 2, accepts: ['line', 'circle', 'arc'] },
  fix: { label: 'Fix', glyph: '⚓', picks: 1, accepts: ['line', 'circle', 'arc', 'point', 'end'] },
};

/** A pick in the sketch: an entity, or one of its end points. */
export interface SketchPick { id: string; ref?: PointRef }

/** The constraint for a relation between picks, or an error message. */
export function relationConstraint(kind: RelationKind, picks: SketchPick[], entities: SketchEntity[]): SketchConstraint | string {
  const spec = RELATIONS[kind];
  const typeOf = (p: SketchPick) => (p.ref !== undefined && entities.find(e => e.id === p.id)?.type !== 'point' ? 'end' : entities.find(e => e.id === p.id)?.type);
  for (const p of picks) {
    const t = typeOf(p);
    if (!t || !spec.accepts.includes(t)) return `${spec.label} needs ${spec.accepts.map(a => (a === 'end' ? 'an end point' : `a ${a}`)).join(' or ')}`;
  }
  if (picks.length !== spec.picks) return `${spec.label} needs ${spec.picks} pick${spec.picks === 1 ? '' : 's'}`;
  if (spec.picks === 2 && picks[0].id === picks[1].id && picks[0].ref === picks[1].ref) return 'Pick two different items';
  const [a, b] = picks;
  const c: SketchConstraint = { id: generateId('rel'), type: kind, entity1Id: a.id, ...(a.ref !== undefined ? { point1: a.ref } : {}) };
  if (b) Object.assign(c, { entity2Id: b.id, ...(b.ref !== undefined ? { point2: b.ref } : {}) });
  if (kind === 'equal' && b) {
    const ta = typeOf(a), tb = typeOf(b);
    if ((ta === 'line') !== (tb === 'line')) return 'Equal needs two lines, or two circles / arcs';
  }
  return c;
}

/** The current size a dimension on these picks would have, and what it measures. */
export function measureForDimension(picks: SketchPick[], entities: SketchEntity[]): { value: number; label: string; diameter?: boolean } | string {
  const ent = (p: SketchPick) => entities.find(e => e.id === p.id);
  const point = (p: SketchPick): Point2 | null => {
    const e = ent(p);
    if (!e) return null;
    if (e.type === 'point') return { x: e.x, y: e.y };
    if (p.ref === undefined) return null;
    if (e.type === 'line') return p.ref === 'p1' || p.ref === 0 ? e.p1 : e.p2;
    if ((e.type === 'circle' || e.type === 'arc') && p.ref === 'center') return e.center;
    return null;
  };
  if (picks.length === 1) {
    const e = ent(picks[0]);
    if (e?.type === 'line') return { value: Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y), label: 'Length' };
    if (e?.type === 'circle') return { value: 2 * e.radius, label: 'Diameter', diameter: true };
    if (e?.type === 'arc') return { value: e.radius, label: 'Radius' };
    return 'Dimension a line, circle or arc, or pick two items';
  }
  const [a, b] = picks;
  const pa = point(a), pb = point(b);
  if (pa && pb) return { value: Math.hypot(pb.x - pa.x, pb.y - pa.y), label: 'Distance' };
  const ea = ent(a), eb = ent(b);
  const lineDist = (p: Point2, l: SketchEntity) => {
    if (l.type !== 'line') return null;
    const dx = l.p2.x - l.p1.x, dy = l.p2.y - l.p1.y, len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : Math.abs((p.x - l.p1.x) * dy - (p.y - l.p1.y) * dx) / len;
  };
  if (pa && eb && !pb) { const d = lineDist(pa, eb); if (d !== null) return { value: d, label: 'Distance to line' }; }
  if (pb && ea && !pa) { const d = lineDist(pb, ea); if (d !== null) return { value: d, label: 'Distance to line' }; }
  if (ea?.type === 'line' && eb?.type === 'line' && !pa && !pb) {
    const d = lineDist(ea.p1, eb);
    if (d !== null) return { value: d, label: 'Distance between lines' };
  }
  return 'Dimension two end points, a point and a line, or two lines';
}

/** The dimension constraint for picks, at `value` mm (a circle's value is its diameter). */
export function dimensionConstraint(picks: SketchPick[], value: number, entities: SketchEntity[]): SketchConstraint {
  const [a, b] = picks;
  const e = entities.find(x => x.id === a.id);
  const isDiameter = picks.length === 1 && e?.type === 'circle';
  return {
    id: generateId('dim'),
    type: 'dimension',
    entity1Id: a.id,
    ...(a.ref !== undefined ? { point1: a.ref } : {}),
    ...(b ? { entity2Id: b.id, ...(b.ref !== undefined ? { point2: b.ref } : {}) } : {}),
    value: isDiameter ? value / 2 : value,
    ...(isDiameter ? { diameter: true } : {}),
  } as SketchConstraint;
}

/** Where a relation tag or dimension label sits in the sketch, and the text of a dimension. */
export function constraintLabel(c: SketchConstraint & { diameter?: boolean }, entities: SketchEntity[]): { at: Point2; text: string } | null {
  const e1 = entities.find(e => e.id === (c.entity1Id ?? c.entityId));
  if (!e1) return null;
  const e2 = c.entity2Id ? entities.find(e => e.id === c.entity2Id) : undefined;
  const pointOf = (e: SketchEntity, ref: PointRef | undefined): Point2 | null => {
    if (e.type === 'point') return { x: e.x, y: e.y };
    if (e.type === 'line') return ref === 'p2' || ref === 1 || ref === 'end' ? e.p2 : ref === undefined ? null : e.p1;
    if (e.type === 'circle' || e.type === 'arc') return ref === 'center' ? e.center : null;
    return null;
  };
  const middle = (e: SketchEntity): Point2 => {
    if (e.type === 'line') return { x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 };
    if (e.type === 'circle') return { x: e.center.x + e.radius * Math.SQRT1_2, y: e.center.y + e.radius * Math.SQRT1_2 };
    if (e.type === 'arc') {
      const sweep = ((e.endAngle - e.startAngle) % TAU + TAU) % TAU || TAU;
      const a = e.startAngle + sweep / 2;
      return { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) };
    }
    if (e.type === 'point') return { x: e.x, y: e.y };
    return { x: 0, y: 0 };
  };
  const f = (v: number) => String(+v.toFixed(3));
  if (c.type === 'dimension') {
    const p1 = pointOf(e1, c.point1), p2 = e2 ? pointOf(e2, c.point2) : null;
    const at = p1 && p2 ? { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } : e2 ? { x: (middle(e1).x + middle(e2).x) / 2, y: (middle(e1).y + middle(e2).y) / 2 } : middle(e1);
    const v = c.value ?? 0;
    const text = !e2 && e1.type === 'circle' ? `Ø${f(2 * v)}` : !e2 && e1.type === 'arc' ? `R${f(v)}` : f(v);
    return { at, text };
  }
  const p = pointOf(e1, c.point1);
  return { at: p ?? middle(e1), text: RELATIONS[c.type as RelationKind]?.glyph ?? c.type };
}
