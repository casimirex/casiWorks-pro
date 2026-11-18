// CasiWorks Pro - The 2D drawing sheet for the current part, as the Drawing tab and the sheet window show it
import { drawingEngine, SHEET_SIZES } from './DrawingEngine.ts';
import type { SheetData } from './DrawingEngine.ts';
import type { Body } from '../features/rebuildModel.ts';
import type { DrawingOptions } from '../store/cadStore.ts';
import { createAssemblySheet } from './assemblyDrawing.ts';
import type { DrawingComponent } from './assemblyDrawing.ts';
import { buildBom } from '../assembly/bom.ts';
import { pdfBytes, sheetToPdf } from './pdf.ts';
import type { BomComponent } from '../assembly/bom.ts';
import { DIMENSION_VIEWS, makeDimension, pickRef, sheetViewToModel, viewFeatures } from './associative.ts';
import type { DimensionKind, DimensionView, DrawingDimension } from './associative.ts';
import type { Point2D } from './DrawingEngine.ts';
import { generateId } from '../utils/math.ts';
import { formatLength, unitSystemOf } from '../utils/units.ts';
import type { UnitSystem } from '../utils/units.ts';

export type DrawingFormat = 'svg' | 'dxf' | 'pdf';

/** What the sheet is built from: a slice of the store. */
export interface DrawingSource {
  bodies: Body[];
  documentName: string;
  activeMaterial: string;
  drawingOptions: DrawingOptions;
  /** Used when the subject is the assembly. */
  assemblyComponents?: Array<DrawingComponent & BomComponent>;
  /** Dimensions placed on the part sheet. */
  drawingDimensions?: DrawingDimension[];
  /** The document's unit system (dimension texts); MMGS when absent. */
  settings?: { units?: UnitSystem | string };
}

/** Dimension text on the sheet: one decimal in mm, as the system shows lengths otherwise ("12.5 mm", "0.492 in"). */
export function sheetLengthFormat(src: Pick<DrawingSource, 'settings'>): (mm: number) => string {
  const system = unitSystemOf(src.settings?.units);
  return system === 'MMGS' ? (mm: number) => `${mm.toFixed(1)} mm` : (mm: number) => formatLength(mm, system, { fixed: true });
}

/** The full sheet (all annotations), or null when there is nothing to draw. */
export function buildDrawingSheet(src: DrawingSource): SheetData | null {
  const name = src.documentName || 'Part1';
  if (src.drawingOptions.subject === 'assembly') {
    const components = src.assemblyComponents ?? [];
    return createAssemblySheet(components, buildBom(components, src.activeMaterial), {
      sheetSize: SHEET_SIZES[src.drawingOptions.sheetSize] ?? SHEET_SIZES.A4_LANDSCAPE,
      enableHLR: src.drawingOptions.hiddenLines,
      title: `${name.toUpperCase()} ASSEMBLY`,
      partNumber: 'ASM-' + (name.slice(0, 4).toUpperCase() || 'ASSY'),
      material: 'SEE PARTS LIST',
    });
  }
  const geometry = src.bodies[0]?.geometry;
  if (!geometry) return null;
  return drawingEngine.createStandardSheet(geometry, {
    sheetSize: SHEET_SIZES[src.drawingOptions.sheetSize] ?? SHEET_SIZES.A4_LANDSCAPE,
    enableHLR: src.drawingOptions.hiddenLines,
    title: name.toUpperCase(),
    partNumber: 'DWG-' + (name.slice(0, 4).toUpperCase() || 'PART'),
    material: src.activeMaterial || 'Steel 1020',
    dimensions: src.drawingDimensions ?? [],
    formatLength: sheetLengthFormat(src),
  });
}

/** A stored dimension as measured on the current sheet (value null: dangling, an attachment was not found). */
export interface DimensionInfo { id: string; view: DimensionView; kind: DimensionKind; value: number | null; placedValue: number; dangling: boolean }

/** The stored dimensions with their current values (part sheet). */
export function dimensionInfo(src: DrawingSource, sheet: SheetData | null = buildDrawingSheet({ ...src, drawingOptions: { ...src.drawingOptions, subject: 'part' } })): DimensionInfo[] {
  const values = new Map((sheet?.dimensionValues ?? []).map(v => [v.id, v.value]));
  return (src.drawingDimensions ?? []).map(d => {
    const value = values.get(d.id) ?? null;
    return { id: d.id, view: d.view, kind: d.kind, value, placedValue: d.value, dangling: value === null };
  });
}

/**
 * A new dimension from places in a view of the part sheet: `points` in view
 * coordinates (model units; u right, v up as the view is seen), or in sheet
 * millimetres with `onSheet`. Snaps to the nearest corner, centre or circle
 * within `reach` sheet millimetres. Returns an error message when the picks
 * do not make a dimension.
 */
export function newDimension(sheet: SheetData, view: DimensionView, kind: DimensionKind | 'auto', points: Point2D[], { onSheet = false, reach = 3 } = {}): DrawingDimension | string {
  if (!DIMENSION_VIEWS.includes(view)) return `view must be one of ${DIMENSION_VIEWS.join(', ')}`;
  const placed = sheet.views.find(v => v.view === view);
  if (!placed) return `The sheet has no ${view} view`;
  const model = sheetViewToModel(placed);
  const k = placed.scale || 1;
  const pts = onSheet ? points.map(p => ({ x: (p.x - (placed.offsetX ?? 0)) / k, y: ((placed.offsetY ?? 0) - p.y) / k })) : points;
  return makeDimension(model, view, kind, pts, reach / k, generateId('ddim'));
}

/** The sheet with the annotations the options switch off removed. */
export function visibleSheet(sheet: SheetData, options: DrawingOptions): SheetData {
  return {
    ...sheet,
    dimensions: options.dimensions ? sheet.dimensions : [],
    gdtFrames: options.gdt ? sheet.gdtFrames : [],
  };
}

/**
 * The sheet as an SVG, DXF or PDF file. Null when there is nothing to draw.
 * For PDF, `text` is a binary string (one char per byte) and `bytes` holds the file.
 */
export function drawingFile(src: DrawingSource, format: DrawingFormat): { filename: string; text: string; mimeType: string; bytes?: Uint8Array } | null {
  const sheet = buildDrawingSheet(src);
  if (!sheet) return null;
  const shown = visibleSheet(sheet, src.drawingOptions);
  const base = `${(src.documentName || 'Part1').replace(/\s+/g, '_')}_${src.drawingOptions.subject === 'assembly' ? 'assembly_' : ''}drawing`;
  if (format === 'pdf') {
    const text = sheetToPdf(shown, sheet.titleBlock?.title ?? base);
    return { filename: `${base}.pdf`, text, mimeType: 'application/pdf', bytes: pdfBytes(text) };
  }
  return format === 'svg'
    ? { filename: `${base}.svg`, text: drawingEngine.exportSVG(shown), mimeType: 'image/svg+xml;charset=utf-8' }
    : { filename: `${base}.dxf`, text: drawingEngine.exportDXF(shown), mimeType: 'application/dxf;charset=utf-8' };
}

/**
 * What a click on the sheet (sheet millimetres) would attach a dimension to:
 * the view it is in (front, top or right), whether it is a corner / centre or
 * a circle, and that place in view coordinates. Null when there is nothing
 * within `reach` mm.
 */
export function pickOnSheet(sheet: SheetData, p: Point2D, reach = 3): { view: DimensionView; snap: 'end' | 'center' | 'circle'; at: Point2D; sheetAt: Point2D } | null {
  for (const placed of sheet.views) {
    const view = placed.view as DimensionView;
    if (!DIMENSION_VIEWS.includes(view)) continue;
    const b = placed.bounds;
    if (p.x < b.minX - reach || p.x > b.maxX + reach || p.y < b.minY - reach || p.y > b.maxY + reach) continue;
    const k = placed.scale || 1, ox = placed.offsetX ?? 0, oy = placed.offsetY ?? 0;
    const model = sheetViewToModel(placed);
    const ref = pickRef(viewFeatures(model), model.bounds, { x: (p.x - ox) / k, y: (oy - p.y) / k }, reach / k);
    if (!ref) continue;
    return { view, snap: ref.snap, at: ref.at, sheetAt: { x: ref.at.x * k + ox, y: oy - ref.at.y * k } };
  }
  return null;
}
