// CasiWorks Pro - The 2D drawing sheet for the current part, as the Drawing tab and the sheet window show it
import { drawingEngine, SHEET_SIZES } from './DrawingEngine.ts';
import type { SheetData } from './DrawingEngine.ts';
import type { Body } from '../features/rebuildModel.ts';
import type { DrawingOptions } from '../store/cadStore.ts';
import { createAssemblySheet } from './assemblyDrawing.ts';
import type { DrawingComponent } from './assemblyDrawing.ts';
import { buildBom } from '../assembly/bom.ts';
import type { BomComponent } from '../assembly/bom.ts';

export type DrawingFormat = 'svg' | 'dxf';

/** What the sheet is built from: a slice of the store. */
export interface DrawingSource {
  bodies: Body[];
  documentName: string;
  activeMaterial: string;
  drawingOptions: DrawingOptions;
  /** Used when the subject is the assembly. */
  assemblyComponents?: Array<DrawingComponent & BomComponent>;
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
  });
}

/** The sheet with the annotations the options switch off removed. */
export function visibleSheet(sheet: SheetData, options: DrawingOptions): SheetData {
  return {
    ...sheet,
    dimensions: options.dimensions ? sheet.dimensions : [],
    gdtFrames: options.gdt ? sheet.gdtFrames : [],
  };
}

/** The sheet as an SVG or DXF file. Null when there is no solid body. */
export function drawingFile(src: DrawingSource, format: DrawingFormat): { filename: string; text: string; mimeType: string } | null {
  const sheet = buildDrawingSheet(src);
  if (!sheet) return null;
  const shown = visibleSheet(sheet, src.drawingOptions);
  const base = `${(src.documentName || 'Part1').replace(/\s+/g, '_')}_${src.drawingOptions.subject === 'assembly' ? 'assembly_' : ''}drawing`;
  return format === 'svg'
    ? { filename: `${base}.svg`, text: drawingEngine.exportSVG(shown), mimeType: 'image/svg+xml;charset=utf-8' }
    : { filename: `${base}.dxf`, text: drawingEngine.exportDXF(shown), mimeType: 'application/dxf;charset=utf-8' };
}
