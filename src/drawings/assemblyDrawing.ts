// CasiWorks Pro - Assembly drawing: the assembled components in four views,
// a parts list above the title block, and an item balloon on each part
import * as THREE from 'three';
import { drawingEngine, sheetElementBoxes } from './DrawingEngine.ts';
import type { Balloon, BomTable, Point2D, SheetData, SheetOptions, SheetView } from './DrawingEngine.ts';
import type { Bom } from '../assembly/bom.ts';

export interface DrawingComponent {
  id: string;
  /** World-space geometry (the component as placed in the assembly). */
  geometry: THREE.BufferGeometry;
}

/** All components as one position-only mesh (the views are drawn from it). */
export function assemblyGeometry(components: DrawingComponent[]): THREE.BufferGeometry {
  const parts = components.map(c => (c.geometry.index ? c.geometry.toNonIndexed() : c.geometry).getAttribute('position'));
  const total = parts.reduce((n, p) => n + p.count * 3, 0);
  const positions = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < p.count; i++) {
      positions[at++] = p.getX(i); positions[at++] = p.getY(i); positions[at++] = p.getZ(i);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return merged;
}

const COLUMNS: BomTable['columns'] = [
  { title: 'ITEM', width: 9, align: 'center' },
  { title: 'PART NUMBER', width: 30, align: 'left' },
  { title: 'DESCRIPTION', width: 40, align: 'left' },
  { title: 'MATERIAL', width: 28, align: 'left' },
  { title: 'QTY', width: 9, align: 'center' },
];
const ROW_HEIGHT = 5;
const FONT = 2.6;
const TABLE_GAP = 1;
const BALLOON_R = 4;

/** Shorten text to fit a column (Helvetica-like widths), ending in "…" when cut. */
function fit(text: string, width: number): string {
  const max = Math.floor((width - 3) / (FONT * 0.58));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
const overlaps = (a: Box, b: Box, gap = 0.5) => a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap;

/**
 * Balloons around the view, each on the line from the view centre through its
 * part, moved round (in 10° steps) and outwards until it is clear of everything
 * else on the sheet and inside the border.
 */
function placeBalloons(sheet: SheetData, view: SheetView, targets: Array<{ label: string; target: Point2D }>): Balloon[] {
  const b = view.bounds;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const border = sheet.border!;
  const inner = { minX: border.x + border.innerMargin, minY: border.y + border.innerMargin, maxX: border.x + border.width - border.innerMargin, maxY: border.y + border.height - border.innerMargin };
  const taken: Box[] = sheetElementBoxes(sheet).map(e => e.box);
  const placed: Balloon[] = [];
  for (const { label, target } of targets) {
    const base = Math.atan2(target.y - cy, target.x - cx) || -Math.PI / 4;
    let best: Balloon | null = null;
    search:
    for (let ring = 0; ring < 4; ring++) {
      for (let k = 0; k < 36; k++) {
        const turn = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 18);
        const a = base + turn;
        const dx = Math.cos(a), dy = Math.sin(a);
        // Leave the view box (grown by the balloon and a gap) along this direction
        const pad = BALLOON_R + 3 + ring * 6;
        const tx = dx > 0 ? (b.maxX + pad - target.x) / dx : dx < 0 ? (b.minX - pad - target.x) / dx : Infinity;
        const ty = dy > 0 ? (b.maxY + pad - target.y) / dy : dy < 0 ? (b.minY - pad - target.y) / dy : Infinity;
        const s = Math.max(0, Math.min(tx, ty));
        const x = target.x + dx * s, y = target.y + dy * s;
        const box = { minX: x - BALLOON_R, minY: y - BALLOON_R, maxX: x + BALLOON_R, maxY: y + BALLOON_R };
        if (box.minX < inner.minX || box.minY < inner.minY || box.maxX > inner.maxX || box.maxY > inner.maxY) continue;
        if (taken.some(t => overlaps(t, box))) continue;
        best = { x, y, radius: BALLOON_R, label, target };
        break search;
      }
    }
    if (!best) {
      // Nowhere clear: put it just outside the view's top-right corner
      best = { x: b.maxX + BALLOON_R + 2, y: b.minY - BALLOON_R - 2, radius: BALLOON_R, label, target };
    }
    placed.push(best);
    taken.push({ minX: best.x - BALLOON_R, minY: best.y - BALLOON_R, maxX: best.x + BALLOON_R, maxY: best.y + BALLOON_R });
  }
  return placed;
}

/** The assembly drawing sheet, or null when there are no components. */
export function createAssemblySheet(components: DrawingComponent[], bom: Bom, options: SheetOptions): SheetData | null {
  if (components.length === 0 || bom.rows.length === 0) return null;
  const tableWidth = COLUMNS.reduce((a, c) => a + c.width, 0);
  const tableHeight = (bom.rows.length + 1) * ROW_HEIGHT;
  const sheet = drawingEngine.createStandardSheet(assemblyGeometry(components), {
    ...options,
    reserveAboveTitle: { width: tableWidth, height: tableHeight + TABLE_GAP },
  });
  sheet.gdtFrames = []; // tolerances belong on the part drawings

  const tb = sheet.titleBlock!;
  sheet.bomTable = {
    x: tb.x + tb.width - tableWidth,
    y: tb.y - TABLE_GAP - tableHeight,
    rowHeight: ROW_HEIGHT,
    columns: COLUMNS,
    rows: bom.rows.map(r => [String(r.item), r.partNumber, r.description, r.material, String(r.quantity)].map((t, i) => fit(t, COLUMNS[i].width))),
  };

  const iso = sheet.views.find(v => v.view === 'isometric') ?? sheet.views[sheet.views.length - 1];
  const byId = new Map(components.map(c => [c.id, c]));
  // Each leader ends on its own part: the centre, or when that is where an earlier
  // leader ends (a pin inside a plate), the middle of a face of the part's box,
  // the top first since it shows in the isometric view
  const chosen: Point2D[] = [];
  const MIN_APART = 6;
  const targets = bom.rows.flatMap(r => {
    const c = byId.get(r.componentIds[0]);
    if (!c) return [];
    c.geometry.computeBoundingBox();
    const box = c.geometry.boundingBox!;
    const centre = box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const candidates = [
      centre,
      centre.clone().add(new THREE.Vector3(0, half.y, 0)),
      centre.clone().add(new THREE.Vector3(half.x, 0, 0)),
      centre.clone().add(new THREE.Vector3(0, 0, half.z)),
      centre.clone().add(new THREE.Vector3(0, -half.y, 0)),
      centre.clone().add(new THREE.Vector3(-half.x, 0, 0)),
      centre.clone().add(new THREE.Vector3(0, 0, -half.z)),
    ].map(p => drawingEngine.sheetPoint(iso, p));
    const target = candidates.find(p => chosen.every(q => Math.hypot(p.x - q.x, p.y - q.y) >= MIN_APART)) ?? candidates[0];
    chosen.push(target);
    return [{ label: String(r.item), target }];
  });
  sheet.balloons = placeBalloons(sheet, iso, targets);
  return sheet;
}
