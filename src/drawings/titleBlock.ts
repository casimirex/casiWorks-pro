// CasiWorks Pro - The title block (roadmap 5.4)
//
// What it says (fields the user edits, saved with the document; a blank field
// takes the generated value) and how it is laid out: one layout of lines and
// texts that the SVG, PDF and DXF exports all draw.
//
//   ┌──────────────────────────────────────────────┐
//   │ COMPANY                                       │
//   │ TITLE                                         │  14
//   ├───────────────────────┬─────────┬─────────────┤
//   │ PART NO               │ REV     │ SCALE       │  8.5
//   ├───────────────────────────┬─────┴─────────────┤
//   │ MATERIAL                  │ DATE              │  8.5
//   ├───────────────┬───────────┴───┬───────────────┤
//   │ DRAWN         │ CHECKED       │ APPROVED      │  9
//   └───────────────┴───────────────┴───────────────┘
//                         100 mm

import type { Point2D } from './DrawingEngine.ts';

/** The fields of the title block a user can set. */
export interface TitleBlockFields {
  title: string;
  partNumber: string;
  revision: string;
  material: string;
  company: string;
  drawnBy: string;
  checkedBy: string;
  approvedBy: string;
  date: string;
}
export const TITLE_BLOCK_FIELDS: ReadonlyArray<{ key: keyof TitleBlockFields; label: string; max: number }> = [
  { key: 'title', label: 'Title', max: 60 },
  { key: 'partNumber', label: 'Part number', max: 30 },
  { key: 'revision', label: 'Revision', max: 6 },
  { key: 'material', label: 'Material', max: 40 },
  { key: 'company', label: 'Company', max: 60 },
  { key: 'drawnBy', label: 'Drawn by', max: 24 },
  { key: 'checkedBy', label: 'Checked by', max: 24 },
  { key: 'approvedBy', label: 'Approved by', max: 24 },
  { key: 'date', label: 'Date', max: 20 },
];

export const TITLE_BLOCK_SIZE = { width: 100, height: 40 } as const;

/** Stored fields cleaned up: known keys, strings, trimmed, within their length; blank ones dropped. */
export function sanitizeTitleBlock(input: unknown): Partial<TitleBlockFields> {
  const out: Partial<TitleBlockFields> = {};
  if (!input || typeof input !== 'object') return out;
  for (const { key, max } of TITLE_BLOCK_FIELDS) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v !== 'string') continue;
    const t = v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
    if (t) out[key] = t;
  }
  return out;
}

export interface TitleBlockText { x: number; y: number; size: number; text: string; kind: 'title' | 'label' | 'value' }
export interface TitleBlockDrawing { lines: Array<[Point2D, Point2D]>; texts: TitleBlockText[] }

/** Text cut to fit a width (Helvetica-like proportions), with an ellipsis. */
export function fitText(text: string, width: number, size: number): string {
  const max = Math.max(1, Math.floor(width / (size * 0.58)));
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** The lines and texts of a title block at (x, y) on the sheet (y down). */
export function titleBlockDrawing(tb: { x: number; y: number; width: number; height: number; title: string; partNumber: string; revision: string; material: string; scaleText: string; date: string; company?: string; drawnBy?: string; checkedBy?: string; approvedBy?: string }): TitleBlockDrawing {
  const { x, y, width: w, height: h } = tb;
  const rows = [y + 14, y + 22.5, y + 31];
  const lines: Array<[Point2D, Point2D]> = [
    [{ x, y }, { x: x + w, y }], [{ x: x + w, y }, { x: x + w, y: y + h }], [{ x: x + w, y: y + h }, { x, y: y + h }], [{ x, y: y + h }, { x, y }],
    ...rows.map(r => [{ x, y: r }, { x: x + w, y: r }] as [Point2D, Point2D]),
  ];
  const texts: TitleBlockText[] = [];
  /** A cell from x0 to x1 between rows top and bottom: its label in small type, its value below. */
  const cell = (x0: number, x1: number, top: number, bottom: number, label: string, value: string) => {
    texts.push({ x: x + x0 + 1.5, y: top + 2.4, size: 1.6, text: label, kind: 'label' });
    if (value) texts.push({ x: x + x0 + 1.5, y: bottom - 1.8, size: 2.5, text: fitText(value, x1 - x0 - 3, 2.5), kind: 'value' });
  };
  const vline = (at: number, top: number, bottom: number) => lines.push([{ x: x + at, y: top }, { x: x + at, y: bottom }]);

  if (tb.company) texts.push({ x: x + 3, y: y + 4.5, size: 2.2, text: fitText(tb.company, w - 6, 2.2), kind: 'value' });
  texts.push({ x: x + 3, y: y + 11.5, size: 4, text: fitText(tb.title, w - 6, 4), kind: 'title' });

  vline(50, rows[0], rows[1]); vline(70, rows[0], rows[1]);
  cell(0, 50, rows[0], rows[1], 'PART NO', tb.partNumber);
  cell(50, 70, rows[0], rows[1], 'REV', tb.revision);
  cell(70, w, rows[0], rows[1], 'SCALE', tb.scaleText.replace(/^Scale:\s*/, ''));

  vline(60, rows[1], rows[2]);
  cell(0, 60, rows[1], rows[2], 'MATERIAL', tb.material);
  cell(60, w, rows[1], rows[2], 'DATE', tb.date);

  const third = w / 3;
  vline(third, rows[2], y + h); vline(2 * third, rows[2], y + h);
  cell(0, third, rows[2], y + h, 'DRAWN', tb.drawnBy ?? '');
  cell(third, 2 * third, rows[2], y + h, 'CHECKED', tb.checkedBy ?? '');
  cell(2 * third, w, rows[2], y + h, 'APPROVED', tb.approvedBy ?? '');
  return { lines, texts };
}
