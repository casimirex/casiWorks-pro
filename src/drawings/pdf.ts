// CasiWorks Pro - The drawing sheet as a vector PDF (no library)
//
// Draws the same elements as the SVG export: border, title block, views
// (visible and dashed hidden lines), labels, dimensions, GD&T, parts list
// and balloons. Text uses the PDF standard fonts Helvetica / Helvetica-Bold
// in WinAnsi encoding, so nothing is embedded. Characters outside WinAnsi are
// replaced (⌀ → Ø); the perpendicularity symbol ⊥ is drawn as lines.
import type { Point2D, SheetData } from './DrawingEngine.ts';
import { arcBeziers } from './curves.ts';
import { titleBlockDrawing } from './titleBlock.ts';
import type { DrawingArc } from './curves.ts';

const PT = 72 / 25.4; // points per mm

/** Helvetica advance widths (1/1000 em) for ASCII 32–126 (Adobe AFM). */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** WinAnsi codes and widths for the non-ASCII characters the sheet uses. */
const EXTRA: Record<string, { code: number; width: number }> = {
  'Ø': { code: 0xd8, width: 778 },
  '×': { code: 0xd7, width: 584 },
  '°': { code: 0xb0, width: 400 },
  '…': { code: 0x85, width: 1000 },
  '±': { code: 0xb1, width: 584 },
  'µ': { code: 0xb5, width: 556 },
  '²': { code: 0xb2, width: 333 },
  '³': { code: 0xb3, width: 333 },
};
/** GD&T characteristic symbols drawn as lines (perpendicularity, parallelism, straightness, circularity, concentricity, angularity). */
const GDT_SYMBOLS = new Set(['⟂', '⊥', '∥', '—', '○', '◎', '∠']);
const SUBSTITUTE: Record<string, string> = { '⌀': 'Ø', '−': '-', '–': '-', '—': '-', '’': "'", '“': '"', '”': '"' };

/** The text as WinAnsi bytes (in a JS string, one char per byte) and its width in em/1000. */
function encode(text: string): { bytes: string; width: number } {
  let bytes = '';
  let width = 0;
  for (const raw of text) {
    const ch = SUBSTITUTE[raw] ?? raw;
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      bytes += ch;
      width += HELVETICA[code - 32];
    } else if (EXTRA[ch]) {
      bytes += String.fromCharCode(EXTRA[ch].code);
      width += EXTRA[ch].width;
    } else {
      bytes += '?';
      width += 556;
    }
  }
  return { bytes, width };
}

const pdfString = (bytes: string) => `(${bytes.replace(/[\\()]/g, m => `\\${m}`)})`;
const n = (v: number) => (Math.abs(v) < 1e-9 ? '0' : (+v.toFixed(3)).toString());

type Rgb = [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const GREY: Rgb = [0.4, 0.4, 0.4];
const BLUE: Rgb = [0, 0.333, 0.667];

/** Page content in sheet millimetres (y down), written as PDF operators (points, y up). */
class Content {
  private ops: string[] = [];
  private heightMm: number;
  constructor(heightMm: number) {
    this.heightMm = heightMm;
  }
  private X = (x: number) => n(x * PT);
  private Y = (y: number) => n((this.heightMm - y) * PT);

  style(widthMm: number, color: Rgb = BLACK, dash: number[] = []): void {
    this.ops.push(`${n(widthMm * PT)} w ${color.map(n).join(' ')} RG [${dash.map(d => n(d * PT)).join(' ')}] 0 d`);
  }
  line(a: Point2D, b: Point2D): void {
    this.ops.push(`${this.X(a.x)} ${this.Y(a.y)} m ${this.X(b.x)} ${this.Y(b.y)} l S`);
  }
  /** An arc (sheet angles) as cubic Bézier pieces. */
  arc(a: DrawingArc): void {
    const P = (p: Point2D) => `${this.X(p.x)} ${this.Y(p.y)}`;
    const pieces = arcBeziers(a);
    this.ops.push(`${P(pieces[0][0])} m ${pieces.map(([, c1, c2, e]) => `${P(c1)} ${P(c2)} ${P(e)} c`).join(' ')} S`);
  }
  rect(x: number, y: number, w: number, h: number, fill = false): void {
    this.ops.push(`${this.X(x)} ${this.Y(y + h)} ${n(w * PT)} ${n(h * PT)} re ${fill ? 'B' : 'S'}`);
  }
  fillColor(color: Rgb): void {
    this.ops.push(`${color.map(n).join(' ')} rg`);
  }
  polygon(points: Point2D[]): void {
    this.ops.push(`${points.map((p, i) => `${this.X(p.x)} ${this.Y(p.y)} ${i ? 'l' : 'm'}`).join(' ')} h f`);
  }
  /** A circle as four Bézier quarter arcs; `mode` S stroke, f fill, B both. */
  circle(cx: number, cy: number, r: number, mode: 'S' | 'f' | 'B' = 'S'): void {
    const k = 0.5523 * r;
    const P = (x: number, y: number) => `${this.X(cx + x)} ${this.Y(cy + y)}`;
    this.ops.push(`${P(r, 0)} m ${P(r, k)} ${P(k, r)} ${P(0, r)} c ${P(-k, r)} ${P(-r, k)} ${P(-r, 0)} c `
      + `${P(-r, -k)} ${P(-k, -r)} ${P(0, -r)} c ${P(k, -r)} ${P(r, -k)} ${P(r, 0)} c ${mode}`);
  }
  /** Text with its baseline at y; anchor like SVG's text-anchor. */
  text(x: number, y: number, sizeMm: number, text: string, opts: { bold?: boolean; anchor?: 'start' | 'middle' | 'end'; color?: Rgb } = {}): void {
    // GD&T symbols are not in WinAnsi: draw the common ones
    if (GDT_SYMBOLS.has(text)) {
      const s = sizeMm * 0.75;
      const x0 = opts.anchor === 'middle' ? x - s / 2 : opts.anchor === 'end' ? x - s : x;
      const cx = x0 + s / 2, cy = y - s / 2;
      this.style(sizeMm * 0.09, opts.color ?? BLACK);
      switch (text) {
        case '⟂': case '⊥':
          this.line({ x: x0, y }, { x: x0 + s, y });
          this.line({ x: cx, y }, { x: cx, y: y - s });
          break;
        case '∥':
          this.line({ x: x0 + s * 0.2, y }, { x: x0 + s * 0.5, y: y - s });
          this.line({ x: x0 + s * 0.5, y }, { x: x0 + s * 0.8, y: y - s });
          break;
        case '—':
          this.line({ x: x0, y: cy }, { x: x0 + s, y: cy });
          break;
        case '○':
          this.circle(cx, cy, s / 2);
          break;
        case '◎':
          this.circle(cx, cy, s / 2);
          this.circle(cx, cy, s / 4);
          break;
        case '∠':
          this.line({ x: x0 + s, y }, { x: x0, y });
          this.line({ x: x0, y }, { x: x0 + s, y: y - s * 0.7 });
          break;
      }
      return;
    }
    const { bytes, width } = encode(text);
    const w = width / 1000 * sizeMm * (opts.bold ? 1.05 : 1);
    const x0 = opts.anchor === 'middle' ? x - w / 2 : opts.anchor === 'end' ? x - w : x;
    const font = opts.bold ? '/F2' : '/F1';
    this.ops.push(`BT ${(opts.color ?? BLACK).map(n).join(' ')} rg ${font} ${n(sizeMm * PT)} Tf ${this.X(x0)} ${this.Y(y)} Td ${pdfString(bytes)} Tj ET`);
  }
  toString(): string {
    return this.ops.join('\n');
  }
}

/** The sheet as a one-page PDF; returned as a binary string (one char per byte). */
export function sheetToPdf(sheet: SheetData, title = 'Drawing'): string {
  const W = sheet.sheetSize.width, H = sheet.sheetSize.height;
  const c = new Content(H);
  c.style(0.35);
  c.fillColor([1, 1, 1]);

  const b = sheet.border;
  if (b) {
    c.style(0.7);
    c.rect(b.x, b.y, b.width, b.height);
    c.style(0.35);
    c.rect(b.x + b.innerMargin, b.y + b.innerMargin, b.width - 2 * b.innerMargin, b.height - 2 * b.innerMargin);
  }

  const tb = sheet.titleBlock;
  if (tb) {
    c.style(0.35);
    const { lines, texts } = titleBlockDrawing(tb);
    for (const [p, q] of lines) c.line(p, q);
    for (const t of texts) {
      c.text(t.x, t.y, t.size, t.text, t.kind === 'title' ? { bold: true } : { color: t.kind === 'label' ? [0.4, 0.4, 0.4] : [0.133, 0.133, 0.133] });
    }
  }

  for (const v of sheet.views) {
    c.style(0.25, GREY, [2.5, 1.5]);
    for (const l of v.hidden) c.line(l.p1, l.p2);
    for (const a of v.arcs ?? []) if (a.type === 'hidden') c.arc(a);
    c.style(0.18, GREY, [6, 1.2, 1, 1.2]);
    for (const l of v.centerlines ?? []) c.line(l.p1, l.p2);
    c.style(0.45, [0.067, 0.067, 0.067]);
    for (const l of v.visible) c.line(l.p1, l.p2);
    for (const a of v.arcs ?? []) if (a.type !== 'hidden') c.arc(a);
    c.text((v.bounds.minX + v.bounds.maxX) / 2, v.labelY ?? v.bounds.maxY + 8, 3.5, v.label, { bold: true, anchor: 'middle', color: [0.133, 0.133, 0.133] });
  }

  for (const d of sheet.dimensions) {
    c.style(0.25, BLUE);
    c.line(d.extLine1.p1, d.extLine1.p2);
    c.line(d.extLine2.p1, d.extLine2.p2);
    c.line(d.dimLine.p1, d.dimLine.p2);
    c.text(d.textPos.x, d.textPos.y, 3.2, d.text, { anchor: 'middle', color: BLUE });
  }

  for (const f of sheet.gdtFrames) {
    if (f.type === 'gdt_fcf') {
      let x = f.x;
      for (const comp of f.compartments) {
        c.style(0.35);
        c.rect(x, f.y, comp.width, f.height);
        c.text(x + comp.width / 2, f.y + f.height * 0.68, 3, comp.label, { bold: true, anchor: 'middle' });
        x += comp.width;
      }
    } else {
      c.fillColor(BLACK);
      c.polygon([{ x: f.x, y: f.y }, { x: f.x - 3, y: f.y + 5 }, { x: f.x + 3, y: f.y + 5 }]);
      c.style(0.35);
      c.line({ x: f.x, y: f.y + 5 }, { x: f.x, y: f.y + 9 });
      c.rect(f.x - 4, f.y + 9, f.boxWidth, f.boxHeight);
      c.text(f.x, f.y + 15, 3, f.letter, { bold: true, anchor: 'middle' });
    }
  }

  const t = sheet.bomTable;
  if (t) {
    const width = t.columns.reduce((a, col) => a + col.width, 0);
    const rows = [t.columns.map(col => col.title), ...t.rows];
    c.style(0.35);
    c.rect(t.x, t.y, width, rows.length * t.rowHeight);
    rows.forEach((row, r) => {
      const y = t.y + r * t.rowHeight;
      if (r > 0) c.line({ x: t.x, y }, { x: t.x + width, y });
      let x = t.x;
      t.columns.forEach((col, i) => {
        if (r === 0 && i > 0) c.line({ x, y: t.y }, { x, y: t.y + rows.length * t.rowHeight });
        const tx = col.align === 'right' ? x + col.width - 1.5 : col.align === 'center' ? x + col.width / 2 : x + 1.5;
        c.text(tx, y + t.rowHeight * 0.68, 2.6, row[i] ?? '', { bold: r === 0, anchor: col.align === 'left' ? 'start' : col.align === 'right' ? 'end' : 'middle' });
        x += col.width;
      });
    });
  }

  for (const bl of sheet.balloons ?? []) {
    const dx = bl.target.x - bl.x, dy = bl.target.y - bl.y, d = Math.hypot(dx, dy) || 1;
    c.style(0.25);
    c.line({ x: bl.x + (dx / d) * bl.radius, y: bl.y + (dy / d) * bl.radius }, bl.target);
    c.fillColor(BLACK);
    c.circle(bl.target.x, bl.target.y, 0.6, 'f');
    c.fillColor([1, 1, 1]);
    c.style(0.35);
    c.circle(bl.x, bl.y, bl.radius, 'B');
    c.text(bl.x, bl.y + 1.2, 3.4, bl.label, { bold: true, anchor: 'middle' });
  }

  return assemble(c.toString(), W * PT, H * PT, title);
}

/** Wrap one page of content in a PDF 1.4 file with a correct cross-reference table. */
function assemble(content: string, widthPt: number, heightPt: number, title: string): string {
  const info = encode(title).bytes;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(widthPt)} ${n(heightPt)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfString(info)} /Producer (CasiWorks Pro) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** The binary string as bytes (for a Blob or a file). */
export function pdfBytes(pdf: string): Uint8Array {
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
