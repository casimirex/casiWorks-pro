// CasiWorks Pro - Performance budgets
//
//   npm run build && npm run perf            check against perf-budgets.json
//   npm run perf -- --update                 set the budgets from this machine
//
// Measures the production bundle size, the rebuild time of every example
// model, a static and a modal FEA solve, and (with Chrome) how long the built
// app takes to load. Each number is compared with its budget in
// perf-budgets.json; any over budget fails the run (exit 1). Times are the
// median of several runs. Results also go to perf-results.json for CI to keep.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import type * as THREE from 'three';

import { useCADStore } from '../src/store/cadStore.ts';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';
import { CAD_EXAMPLES } from '../src/utils/examples.ts';
import { runSolve } from '../src/simulation/feaTransfer.ts';
import { ELEMENT_TYPES } from '../src/simulation/FEAEngine.ts';
import { findChrome, sleep, waitFor, withApp } from './browser.ts';

const BUDGETS = 'perf-budgets.json';
const RESULTS = 'perf-results.json';
const UPDATE = process.argv.includes('--update');

interface Metric { value: number; unit: 'ms' | 'KB' }
const results: Record<string, Metric> = {};
const record = (name: string, value: number, unit: Metric['unit']) => { results[name] = { value: Math.round(value * 10) / 10, unit }; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const time = (fn: () => void, runs: number) => median(Array.from({ length: runs }, () => { const t = performance.now(); fn(); return performance.now() - t; }));

// ------------------------------------------------------------------ bundle
function measureBundle(): void {
  const dir = 'dist/assets';
  let app = 0, worker = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const gz = gzipSync(readFileSync(join(dir, f))).length / 1024;
    if (f.startsWith('fea.worker')) worker += gz; else app += gz;
  }
  record('bundle.app.gzip', app, 'KB');
  record('bundle.worker.gzip', worker, 'KB');
}

// ------------------------------------------------------------------ rebuild and solve (Node)
function measureModel(): void {
  // Examples with fillets and chamfers report them as rebuild warnings: expected, so kept quiet
  const { warn, error } = console;
  console.warn = console.error = () => {};
  try { measureModelQuietly(); } finally { Object.assign(console, { warn, error }); }
}

function measureModelQuietly(): void {
  const registry = createCommandRegistry(useCADStore);
  for (const ex of CAD_EXAMPLES) {
    registry.execute('file.loadExample', { id: ex.id });
    rebuildModel(useCADStore); // warm up
    record(`rebuild.${ex.id}`, time(() => { useCADStore.setState({ needsRebuild: true }); rebuildModel(useCADStore); }, 5), 'ms');
  }

  registry.execute('file.loadExample', { id: 'l_bracket' });
  rebuildModel(useCADStore);
  const g = useCADStore.getState().bodies[0].geometry as THREE.BufferGeometry;
  const request = (analysis: 'static' | 'modal', quality: 'coarse' | 'medium') => ({
    positions: Float32Array.from(g.getAttribute('position').array as ArrayLike<number>),
    index: g.getIndex() ? Uint32Array.from(g.getIndex()!.array as ArrayLike<number>) : null,
    elementType: ELEMENT_TYPES.TET10, load: 5000, yieldStrength: 276e6, youngsModulus: 68.9e9, poissonRatio: 0.33,
    quality, setup: { fixedFace: 'zMin' as const, loadFace: 'zMax' as const, loadDirection: '-Y' as const }, analysis, density: 2700,
  });
  record('fea.static.tet10-medium', time(() => runSolve(request('static', 'medium')), 3), 'ms');
  record('fea.modal.tet10-coarse', time(() => runSolve(request('modal', 'coarse')), 3), 'ms');
  useCADStore.getState().newProject();
}

// ------------------------------------------------------------------ app load (Chrome)
async function measureLoad(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) { console.log('perf: no Chrome found (set CHROME_PATH); load time not measured'); return; }
  await withApp({ chrome, profile: 'perf', shots: { dir: 'e2e-output', format: 'png' } }, async ({ page, appUrl }) => {
    // A first visit: nothing cached
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    const ready: number[] = [], dom: number[] = [];
    for (let i = 0; i < 5; i++) {
      await page.send('Page.navigate', { url: appUrl });
      await sleep(50);
      // Times from the page's own clock: 0 is the start of this navigation
      const t = await waitFor(() => page.eval<{ ready: number; dom: number }>(`new Promise(resolve => {
        const check = () => (window.casiworks && document.querySelectorAll('.feature-item').length > 0)
          ? resolve({ ready: performance.now(), dom: performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? 0 })
          : requestAnimationFrame(check);
        check();
      })`), 'app start', 30000);
      ready.push(t.ready); dom.push(t.dom);
    }
    record('load.domContentLoaded', median(dom), 'ms');
    record('load.appReady', median(ready), 'ms');
  });
}

// ------------------------------------------------------------------ compare
async function main(): Promise<number> {
  if (!existsSync('dist/index.html')) { console.error('perf: run `npm run build` first'); return 1; }
  measureBundle();
  measureModel();
  await measureLoad();
  writeFileSync(RESULTS, JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2) + '\n');

  if (UPDATE) {
    // Times get 3× headroom (a CI runner can be twice as slow as a desktop); sizes 10%
    const budgets = Object.fromEntries(Object.entries(results).map(([k, m]) => {
      const raw = m.unit === 'KB' ? m.value * 1.1 : Math.max(m.value * 3, 25);
      const step = raw >= 1000 ? 100 : raw >= 100 ? 10 : 5;
      return [k, { budget: Math.ceil(raw / step) * step, unit: m.unit }];
    }));
    writeFileSync(BUDGETS, JSON.stringify(budgets, null, 2) + '\n');
    console.log(`perf: budgets written to ${BUDGETS}`);
  }

  const budgets = existsSync(BUDGETS) ? JSON.parse(readFileSync(BUDGETS, 'utf8')) as Record<string, { budget: number; unit: string }> : {};
  let over = 0;
  const width = Math.max(...Object.keys(results).map(k => k.length));
  for (const [name, m] of Object.entries(results)) {
    const b = budgets[name];
    const ok = !b || m.value <= b.budget;
    if (!ok) over++;
    const share = b ? ` ${String(Math.round((m.value / b.budget) * 100)).padStart(3)}% of ${b.budget} ${b.unit}` : '  (no budget)';
    console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(width)} ${String(m.value).padStart(8)} ${m.unit}${share}`);
  }
  const missing = Object.keys(budgets).filter(k => !(k in results) && !k.startsWith('load.'));
  for (const k of missing) { over++; console.log(`  ✗ ${k}: budgeted but not measured`); }
  console.log(`${over ? 'FAILED' : 'OK'}: ${Object.keys(results).length} measurements, ${over} over budget; results in ${RESULTS}`);
  return over ? 1 : 0;
}

process.exitCode = await main();
