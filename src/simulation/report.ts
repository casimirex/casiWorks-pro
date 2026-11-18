// CasiWorks Pro - FEA study report: one self-contained HTML page to save, print or send
//
// Pure: everything it shows is passed in, so it is tested without the app.
import { faceChoiceLabel } from './studySetup.ts';
import type { StudySetup } from './studySetup.ts';
import type { FeaProbe } from './resultPlot.ts';
import type { MeshInfo } from './autoMesh.ts';

export interface FeaReportData {
  documentName: string;
  /** When the report was made, as shown (local time, e.g. '2026-11-17 12:47'). */
  date: string;
  material: { name: string; youngsModulus: number; poissonsRatio: number; yieldStrength: number; density: number };
  setup: StudySetup;
  /** N */
  load: number;
  elementType: string;
  mesh: Pick<MeshInfo, 'elements' | 'nodes' | 'coverage' | 'quality'> | null;
  results: { maxStressMPa: number; minStressMPa: number; maxDisplacementMM: number; factorOfSafety: number };
  /** The safety factor the design must reach. */
  requiredSafetyFactor: number;
  probes: FeaProbe[];
  /** PNG data URL of the result plot, or null. */
  image: string | null;
  /** Shown as a warning when the results did not match the model any more. */
  stale?: boolean;
}

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (v: number, digits = 3) => (Number.isFinite(v) ? (+v.toPrecision(digits)).toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—');

/** The report page. */
export function feaReportHtml(d: FeaReportData): string {
  const pass = d.results.factorOfSafety >= d.requiredSafetyFactor;
  const coverage = d.mesh ? `${(d.mesh.coverage * 100).toFixed(0)}%` : '—';
  const rows = (pairs: Array<[string, string]>) => pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
  const image = d.image && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(d.image)
    ? `<figure><img src="${d.image}" alt="Result plot"><figcaption>Result plot as shown in CasiWorks.</figcaption></figure>` : '';
  const probes = d.probes.length
    ? `<h2>Probes</h2><table class="grid"><thead><tr><th>#</th><th>Position x, y, z (mm)</th><th>von Mises (MPa)</th><th>Displacement (mm)</th></tr></thead><tbody>${
      d.probes.map((p, i) => `<tr><td>${i + 1}</td><td>${num(p.point.x, 4)}, ${num(p.point.y, 4)}, ${num(p.point.z, 4)}</td><td>${num(p.vonMisesMPa, 4)}</td><td>${num(p.displacementMM, 4)}</td></tr>`).join('')
    }</tbody></table>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.documentName)} – FEA report</title>
<style>
  :root { --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --ok: #15803d; --bad: #b91c1c; }
  body { font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--ink); background: #fff; margin: 0; padding: 32px 16px; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  .meta { color: var(--muted); margin: 0 0 20px; }
  .verdict { display: inline-block; padding: 6px 12px; border-radius: 6px; font-weight: 700; color: #fff; background: ${pass ? 'var(--ok)' : 'var(--bad)'}; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 16px 0; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .card b { display: block; font-size: 20px; } .card span { color: var(--muted); font-size: 12px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.kv th { width: 40%; color: var(--muted); font-weight: 500; }
  table.grid thead th { color: var(--muted); font-weight: 600; } table.grid td:not(:nth-child(2)) { font-variant-numeric: tabular-nums; }
  figure { margin: 16px 0; } img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; } figcaption { color: var(--muted); font-size: 12px; }
  .warn { background: #fef3c7; border: 1px solid #f59e0b; padding: 8px 12px; border-radius: 6px; }
  .note { color: var(--muted); font-size: 12px; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } figure, table { break-inside: avoid; } }
</style></head>
<body><main>
<h1>${esc(d.documentName)}: linear static study</h1>
<p class="meta">CasiWorks Pro FEA report · ${esc(d.date)}</p>
${d.stale ? '<p class="warn">These results were computed for an earlier state of the model or study.</p>' : ''}
<p><span class="verdict">${pass ? 'PASS' : 'FAIL'}: safety factor ${num(d.results.factorOfSafety)} ${pass ? '≥' : '<'} ${num(d.requiredSafetyFactor)}</span></p>
<div class="cards">
  <div class="card"><span>Max von Mises stress</span><b>${num(d.results.maxStressMPa, 4)} MPa</b></div>
  <div class="card"><span>Max displacement</span><b>${num(d.results.maxDisplacementMM, 4)} mm</b></div>
  <div class="card"><span>Safety factor (yield ÷ max stress)</span><b>${num(d.results.factorOfSafety)}</b></div>
  <div class="card"><span>Yield strength</span><b>${num(d.material.yieldStrength / 1e6)} MPa</b></div>
</div>
${image}
<h2>Study</h2>
<table class="kv">${rows([
    ['Fixed face', esc(faceChoiceLabel(d.setup, 'fixed'))],
    ['Loaded face', esc(faceChoiceLabel(d.setup, 'load'))],
    ['Load', `${num(d.load, 6)} N towards ${esc(d.setup.loadDirection)}, spread over the face${d.setup.loadFace === 'faces' && (d.setup.loadFaces?.length ?? 0) > 1 ? 's' : ''}`],
    ['Analysis', 'Linear static, small displacements, no contact'],
  ])}</table>
<h2>Material</h2>
<table class="kv">${rows([
    ['Material', esc(d.material.name)],
    ["Young's modulus", `${num(d.material.youngsModulus / 1e9)} GPa`],
    ["Poisson's ratio", num(d.material.poissonsRatio)],
    ['Yield strength', `${num(d.material.yieldStrength / 1e6)} MPa`],
    ['Density', `${num(d.material.density, 4)} kg/m³`],
  ])}</table>
<h2>Mesh</h2>
<table class="kv">${rows([
    ['Element type', esc(d.elementType)],
    ['Elements · nodes', d.mesh ? `${d.mesh.elements.toLocaleString('en-US')} · ${d.mesh.nodes.toLocaleString('en-US')}` : '—'],
    ['Mesh size', d.mesh ? esc(d.mesh.quality) : '—'],
    ['Meshed volume ÷ part volume', coverage],
  ])}</table>
${probes}
<h2>Notes</h2>
<p class="note">Fixed and loaded faces are the sides of the part's bounding box. The mesh is built from grid cells, so thin walls and small features are approximated (see the volume ratio above). Sharp inside corners show stress peaks that are higher than reality. Check critical results with a finer mesh or by hand.</p>
<p class="note">Min von Mises stress: ${num(d.results.minStressMPa, 4)} MPa.</p>
</main></body></html>
`;
}
