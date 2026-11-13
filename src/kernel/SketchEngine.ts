// CasiWorks Pro - Sketch Engine: entity factories, snapping and profile checks
import { generateId, distance2D } from '../utils/math.ts';
import { SKETCH_ENTITY_TYPES } from '../utils/constants.ts';
import type {
  ArcEntity,
  CircleEntity,
  EllipseEntity,
  LineEntity,
  Point2,
  PointEntity,
  SketchEntity,
  SplineEntity,
} from '../types/cad.ts';

export type SnapType = 'endpoint' | 'midpoint' | 'center';

export interface SnapResult {
  point: Point2;
  type: SnapType;
  distance: number;
}

/** Endpoint of an arc (angles in radians). */
function arcPoint(arc: ArcEntity, which: 'start' | 'end'): Point2 {
  const angle = which === 'start' ? arc.startAngle : arc.endAngle;
  return { x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) };
}

export class SketchEngine {
  /** Sketch point in the canonical flat format { x, y } (also used by DXF import/export). */
  createPoint(p: Point2, isConstruction = false): PointEntity {
    return { id: generateId('pt'), type: SKETCH_ENTITY_TYPES.POINT, x: p.x, y: p.y, construction: isConstruction };
  }

  createLine(p1: Point2, p2: Point2, isConstruction = false): LineEntity {
    return {
      id: generateId('line'),
      type: SKETCH_ENTITY_TYPES.LINE,
      p1: { x: p1.x, y: p1.y },
      p2: { x: p2.x, y: p2.y },
      construction: isConstruction,
    };
  }

  /** Axis-aligned rectangle from two opposite corners, as four lines. */
  createRectangle(p1: Point2, p2: Point2, isConstruction = false): LineEntity[] {
    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    const corners: Point2[] = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
    return corners.map((pt, i) => this.createLine(pt, corners[(i + 1) % 4], isConstruction));
  }

  createCircle(center: Point2, radius: number, isConstruction = false): CircleEntity {
    return {
      id: generateId('circle'),
      type: SKETCH_ENTITY_TYPES.CIRCLE,
      center: { x: center.x, y: center.y },
      radius: Math.abs(radius),
      construction: isConstruction,
    };
  }

  /** Counter-clockwise arc; angles in radians. */
  createArc(center: Point2, radius: number, startAngle: number, endAngle: number, isConstruction = false): ArcEntity {
    return {
      id: generateId('arc'),
      type: SKETCH_ENTITY_TYPES.ARC,
      center: { x: center.x, y: center.y },
      radius: Math.abs(radius),
      startAngle,
      endAngle,
      construction: isConstruction,
    };
  }

  createSpline(points: Point2[], isConstruction = false): SplineEntity {
    return {
      id: generateId('spline'),
      type: SKETCH_ENTITY_TYPES.SPLINE,
      controlPoints: points.map(p => ({ x: p.x, y: p.y })),
      construction: isConstruction,
    };
  }

  /** Ellipse; rotation in radians. */
  createEllipse(center: Point2, radiusX: number, radiusY: number, rotation = 0, isConstruction = false): EllipseEntity {
    return {
      id: generateId('ellipse'),
      type: SKETCH_ENTITY_TYPES.ELLIPSE,
      center: { x: center.x, y: center.y },
      radiusX: Math.abs(radiusX),
      radiusY: Math.abs(radiusY),
      rotation,
      construction: isConstruction,
    };
  }

  /** Regular polygon inscribed in a circle of `radius`, as lines. */
  createPolygon(center: Point2, radius: number, sides = 6, isConstruction = false): LineEntity[] {
    const n = Math.max(3, Math.floor(sides));
    const step = (Math.PI * 2) / n;
    const pts: Point2[] = [];
    for (let i = 0; i < n; i++) {
      pts.push({ x: center.x + radius * Math.cos(i * step), y: center.y + radius * Math.sin(i * step) });
    }
    return pts.map((pt, i) => this.createLine(pt, pts[(i + 1) % n], isConstruction));
  }

  /** Straight slot between two arc centers with the given end radius: two lines and two arcs. */
  createSlot(p1: Point2, p2: Point2, radius: number, isConstruction = false): Array<LineEntity | ArcEntity> {
    const perp = Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI / 2;
    const dx = radius * Math.cos(perp);
    const dy = radius * Math.sin(perp);
    const s1 = { x: p1.x + dx, y: p1.y + dy };
    const s2 = { x: p2.x + dx, y: p2.y + dy };
    const s3 = { x: p2.x - dx, y: p2.y - dy };
    const s4 = { x: p1.x - dx, y: p1.y - dy };
    return [
      this.createLine(s1, s2, isConstruction),
      this.createArc(p2, radius, perp - Math.PI, perp, isConstruction),
      this.createLine(s3, s4, isConstruction),
      this.createArc(p1, radius, perp, perp + Math.PI, isConstruction),
    ];
  }

  snapToGrid(point: Point2, gridSize = 10): Point2 {
    return {
      x: Math.round(point.x / gridSize) * gridSize,
      y: Math.round(point.y / gridSize) * gridSize,
    };
  }

  /** Nearest endpoint, midpoint or center within `tolerance`, or null. */
  snapToEntity(point: Point2, entities: SketchEntity[], tolerance = 8): SnapResult | null {
    let best: SnapResult | null = null;
    const consider = (candidate: Point2, type: SnapType) => {
      const d = distance2D(point, candidate);
      if (d < (best?.distance ?? tolerance)) best = { point: { x: candidate.x, y: candidate.y }, type, distance: d };
    };

    for (const ent of entities) {
      if (ent.type === SKETCH_ENTITY_TYPES.LINE) {
        consider(ent.p1, 'endpoint');
        consider(ent.p2, 'endpoint');
        consider({ x: (ent.p1.x + ent.p2.x) / 2, y: (ent.p1.y + ent.p2.y) / 2 }, 'midpoint');
      } else if (ent.type === SKETCH_ENTITY_TYPES.CIRCLE) {
        consider(ent.center, 'center');
      } else if (ent.type === SKETCH_ENTITY_TYPES.ARC) {
        consider(ent.center, 'center');
        consider(arcPoint(ent, 'start'), 'endpoint');
        consider(arcPoint(ent, 'end'), 'endpoint');
      }
    }
    return best;
  }

  /**
   * True when the non-construction lines and arcs form one closed chain
   * (or the profile is a single circle or ellipse).
   */
  isProfileClosed(entities: SketchEntity[], tol = 1e-2): boolean {
    const profile = entities.filter(e => !e.construction);
    if (profile.length === 0) return false;
    if (profile.length === 1 && (profile[0].type === SKETCH_ENTITY_TYPES.CIRCLE || profile[0].type === SKETCH_ENTITY_TYPES.ELLIPSE)) {
      return true;
    }

    const segments: Array<{ p1: Point2; p2: Point2; isArc: boolean }> = [];
    for (const ent of profile) {
      if (ent.type === SKETCH_ENTITY_TYPES.LINE) segments.push({ p1: ent.p1, p2: ent.p2, isArc: false });
      else if (ent.type === SKETCH_ENTITY_TYPES.ARC) segments.push({ p1: arcPoint(ent, 'start'), p2: arcPoint(ent, 'end'), isArc: true });
    }

    // Straight lines need at least 3 segments to enclose an area; with an arc, 2 are
    // enough (e.g. a half-disc: one arc closed by one line, or two arcs).
    const minSegments = segments.some(s => s.isArc) ? 2 : 3;
    if (segments.length < minSegments) return false;

    // Walk the chain from segment 0, consuming each segment once
    const visited = new Set<number>([0]);
    let currentPt = segments[0].p2;
    for (let step = 1; step < segments.length; step++) {
      let foundNext = false;
      for (let i = 0; i < segments.length; i++) {
        if (visited.has(i)) continue;
        const seg = segments[i];
        if (distance2D(currentPt, seg.p1) < tol) {
          currentPt = seg.p2;
        } else if (distance2D(currentPt, seg.p2) < tol) {
          currentPt = seg.p1;
        } else {
          continue;
        }
        visited.add(i);
        foundNext = true;
        break;
      }
      if (!foundNext) return false;
    }
    return distance2D(currentPt, segments[0].p1) < tol;
  }
}

export const sketchEngine = new SketchEngine();
export default SketchEngine;
