// CasiWorks Pro - Screenshots for the tutorial e-book (docs/tutorial/)
//
//   npm run build && node scripts/tutorial-shots.ts [shot-name-filter]
//
// Serves dist/ with `vite preview`, drives headless Chrome over the DevTools
// protocol through the same flows the tutorial teaches, and writes one WebP per
// step to docs/tutorial/img/. A failing step is reported and the rest go on.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = 'docs/tutorial/img';
const CHROMES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter((p): p is string => Boolean(p));
const FILTER = process.argv[2];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
  srv.on('error', reject);
});

async function waitFor<T>(fn: () => Promise<T | undefined | null>, what: string, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not ready yet */ }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

class Page {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, (msg: { result?: Record<string, unknown> }) => void>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true });
      if (d.id && this.pending.has(d.id)) {
        this.pending.get(d.id)!(d);
        this.pending.delete(d.id);
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown> }> {
    return new Promise(resolve => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const res = r.result as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (res?.exceptionDetails) throw new Error(String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text).split('\n')[0]);
    return res?.result?.value as T;
  }

  /** Click the button whose trimmed text or title matches. */
  async click(label: string, wait = 300): Promise<void> {
    const ok = await this.eval<boolean>(`(() => {
      const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} || b.title === ${JSON.stringify(label)});
      if (!b) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No button "${label}"`);
    await sleep(wait);
  }

  async mouseClick(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(250);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(150);
  }

  async screenshot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'webp', quality: 82 });
    writeFileSync(join(OUT, `${name}.webp`), Buffer.from(String(r.result?.data), 'base64'));
  }
}

// ------------------------------------------------------------------ helpers
const run = (p: Page, id: string, args?: unknown, wait = 600) =>
  p.eval(`window.casiworks.commands.execute(${JSON.stringify(id)}${args === undefined ? '' : ', ' + JSON.stringify(args)})`).then(() => sleep(wait));
const setField = (p: Page, label: string, value: string | number) => p.eval(`(() => {
  const row = [...document.querySelectorAll('.property-panel .property-row')].find(r => r.querySelector('.property-label')?.textContent.startsWith(${JSON.stringify(label)}));
  const el = row?.querySelector('select, input');
  if (!el) throw new Error('No field ' + ${JSON.stringify(label)});
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
const pick = (p: Page, selector: string, value: string) => p.eval(`(() => {
  const sel = document.querySelector(${JSON.stringify(selector)});
  if (!sel) throw new Error('No select ' + ${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)});
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const apply = async (p: Page, wait = 1200) => { await p.eval(`document.querySelector('.action-btn-green').click()`); await sleep(wait); };
const closeDialog = async (p: Page) => { await p.eval(`document.querySelector('.dialog-backdrop')?.click()`); await sleep(300); };
const canvasRect = async (p: Page) => JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`)) as DOMRect;
const iso = (p: Page) => run(p, 'view.isometric', undefined, 600);
const fresh = (p: Page) => run(p, 'document.new', undefined, 600);
const example = (p: Page, id: string) => run(p, 'file.loadExample', { id }, 2000);

/** A 80 × 50 × 20 plate, built through the API, as the base for later steps. */
const plate = (p: Page) => p.eval(`(() => {
  window.casiworks.document.new();
  const s = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -40, y: -25 }, corner2: { x: 40, y: 25 } }] });
  window.casiworks.features.extrude({ sketchId: s.sketchId, depth: 20, name: 'Plate' });
})()`).then(() => sleep(800));

/** Fold the FEA panel away (it sits over the property panel) or bring it back. */
const feaPanel = async (p: Page, open: boolean) => {
  await p.eval(open ? `document.querySelector('.fea-minimized-badge')?.click()` : `document.querySelector('.fea-panel button[title="Minimize"]')?.click()`);
  await sleep(300);
};
const zoom = async (p: Page, clicks: number) => {
  const r = await canvasRect(p);
  for (let i = 0; i < Math.abs(clicks); i++) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.left + r.width / 2, y: r.top + r.height / 2, deltaX: 0, deltaY: clicks > 0 ? 120 : -120 });
    await sleep(60);
  }
  await sleep(400);
};

type Shot = { name: string; run(p: Page): Promise<void> };

const SHOTS: Shot[] = [
  // ------------------------------------------------------------ Part 1: novice
  { name: '01-interface', async run(p) { await iso(p); await p.screenshot('01-interface'); await feaPanel(p, false); } },
  {
    name: '02-examples-menu', async run(p) {
      await p.click('Load Mechanical CAD Examples', 400);
      await p.screenshot('02-examples-menu');
      await p.eval(`[...document.querySelectorAll('.example-item-btn')].find(b => b.textContent.includes('Hex Bolt')).click()`);
      await sleep(2000);
      await iso(p);
      await p.screenshot('03-example-bolt');
    },
  },
  {
    name: '04-display-modes', async run(p) {
      await example(p, 'bearing_block'); await iso(p);
      await run(p, 'view.toggleWireframe');
      await p.screenshot('04-wireframe');
      await run(p, 'view.toggleWireframe');
      await run(p, 'view.toggleSection', undefined, 900);
      await p.screenshot('05-section');
      await run(p, 'view.toggleSection');
      await run(p, 'view.front');
      await p.screenshot('06-front-view');
    },
  },
  {
    name: '07-sketch-rectangle', async run(p) {
      await fresh(p);
      await p.click('Sketch');
      await p.click('Sketch on the Front plane', 800);
      await p.click('Corner Rectangle (R)');
      const r = await canvasRect(p);
      await p.mouseClick(r.left + r.width * 0.35, r.top + r.height * 0.32);
      await p.mouseClick(r.left + r.width * 0.65, r.top + r.height * 0.68);
      await p.click('Center Circle (C)');
      await p.mouseClick(r.left + r.width * 0.5, r.top + r.height * 0.5);
      await p.mouseMove(r.left + r.width * 0.55, r.top + r.height * 0.5);
      await p.screenshot('07-sketch-rectangle');
      await p.mouseClick(r.left + r.width * 0.55, r.top + r.height * 0.5);
      await p.screenshot('08-sketch-circle');
      await p.click('Confirm & Exit Sketch', 1000);
      await iso(p);
      await p.click('Features');
      await p.click('Extruded Boss/Base', 600);
      await setField(p, 'Extrude Depth', 20);
      await sleep(600);
      await p.screenshot('09-extrude-panel');
      await apply(p);
      await iso(p);
      await p.screenshot('10-first-part');
    },
  },
  {
    name: '10b-keyhole', async run(p) {
      await fresh(p);
      await feaPanel(p, false);
      await p.click('Sketch');
      await p.click('Sketch on the Front plane', 800);
      await p.click('Snap', 100); // exact points, so the clicks below land on the lines
      const r = await canvasRect(p);
      const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.36, R = 80, w = 40;
      await p.click('Center Circle (C)');
      await p.mouseClick(cx, cy); await p.mouseClick(cx + R, cy);
      await p.click('Corner Rectangle (R)');
      await p.mouseClick(cx - w, cy); await p.mouseClick(cx + w, cy + 200);
      await p.click('Trim: click the part to remove, up to the nearest crossings (T)');
      await p.mouseClick(cx, cy);                 // top of the slot, inside the circle
      await p.mouseClick(cx - w, cy + 20);        // left side, inside the circle
      await p.mouseClick(cx + w, cy + 20);        // right side, inside the circle
      await p.mouseMove(cx, cy + R);              // hover the circle's bottom: highlighted
      await sleep(300);
      await p.screenshot('10b-keyhole-trim');
      await p.mouseClick(cx, cy + R);             // the circle between the slot sides
      await p.mouseMove(r.left + 20, r.top + 20);
      await sleep(300);
      await p.screenshot('10c-keyhole-sketch');
      await p.click('Snap', 100);
      await p.click('Confirm & Exit Sketch', 1000);
      await p.click('Features');
      await p.click('Extruded Boss/Base', 600);
      await setField(p, 'Extrude Depth', 8);
      await apply(p);
      await iso(p);
      await p.screenshot('10d-keyhole-part');
    },
  },
  // -------------------------------------------------------- Part 2: intermediate
  {
    name: '11-hole', async run(p) {
      await plate(p); await iso(p);
      await p.click('Features');
      await p.click('Hole Wizard', 500);
      await setField(p, 'Diameter', 12);
      await setField(p, 'Hole Depth', 20);
      await setField(p, 'Drill Direction', '+Z').catch(() => {});
      await sleep(500);
      await p.screenshot('11-hole-panel');
      await apply(p);
      await p.screenshot('12-hole-result');
    },
  },
  {
    name: '13-fillet', async run(p) {
      await p.click('Fillet Edges', 500);
      await setField(p, 'Radius', 4);
      await sleep(500);
      await p.screenshot('13-fillet-panel');
      await apply(p);
      await p.click('Chamfer Edges', 500);
      await p.eval(`document.querySelector('.action-btn-red').click()`);
      await sleep(300);
      await p.screenshot('14-fillet-result');
    },
  },
  {
    name: '15-pattern', async run(p) {
      await p.eval(`(() => {
        window.casiworks.document.new();
        const base = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -60, y: -20 }, corner2: { x: 60, y: 20 } }] });
        window.casiworks.features.extrude({ sketchId: base.sketchId, depth: 8, name: 'Rail' });
        const boss = window.casiworks.sketches.create({ entities: [{ type: 'circle', center: { x: -45, y: 0 }, radius: 6 }] });
        window.casiworks.features.extrude({ sketchId: boss.sketchId, depth: 20, name: 'Peg' });
      })()`);
      await sleep(900); await iso(p);
      await p.click('Linear Pattern', 500);
      await setField(p, 'Instances', 4);
      await setField(p, 'Spacing', 30);
      await sleep(500);
      await p.screenshot('15-pattern-panel');
      await apply(p);
      await p.screenshot('16-pattern-result');
    },
  },
  {
    name: '17-revolve', async run(p) {
      await example(p, 'piston_head'); await iso(p); await zoom(p, 5);
      await p.screenshot('17-revolve-piston');
    },
  },
  {
    name: '18-rollback', async run(p) {
      await example(p, 'l_bracket'); await iso(p);
      await run(p, 'model.rollbackTo', { index: 3 }, 1200);
      await p.screenshot('18-rollback');
      await run(p, 'model.rollbackTo', { index: -1 }, 1200);
    },
  },
  {
    name: '19-edit-feature', async run(p) {
      await example(p, 'l_bracket'); await iso(p);
      await p.eval(`[...document.querySelectorAll('.feature-item')].find(e => e.textContent.includes('Boss-Extrude2')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await sleep(700);
      await p.screenshot('19-edit-feature');
      await p.eval(`document.querySelector('.action-btn-red')?.click()`);
      await sleep(300);
    },
  },
  {
    name: '20-material', async run(p) {
      await run(p, 'model.material', undefined, 500);
      await p.screenshot('20-material');
      await closeDialog(p);
      await run(p, 'evaluate.massProperties', undefined, 700);
      await p.screenshot('21-mass-properties');
      await closeDialog(p);
    },
  },
  // ------------------------------------------------------------ Part 3: advanced
  {
    name: '22-assembly', async run(p) {
      await fresh(p);
      await feaPanel(p, false);
      await p.click('Assembly');
      await p.click('Insert Base Mounting Plate', 600);
      await p.click('Insert Cylindrical Alignment Pin', 600);
      await iso(p);
      await p.screenshot('22-assembly-insert');
      await p.click('Concentric Mate (Align cylindrical axes)', 600);
      await p.screenshot('23-assembly-mate');
      await p.click('Re-solve all assembly mates numerically', 800);
      await p.screenshot('24-assembly-solved');
      await p.click('Configure Exploded View', 600);
      await p.eval(`(() => {
        const el = document.querySelector('.explode-distance');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '40');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(300);
      await p.screenshot('25-exploded-panel');
      await apply(p, 800);
      await zoom(p, 4);
      await p.screenshot('25-exploded');
      await run(p, 'assembly.collapse');
      await p.click('Insert Cylindrical Alignment Pin', 600);
      await p.click('Bill of Materials: parts, quantities and masses, with CSV export', 600);
      await p.eval(`(() => {
        const sel = document.querySelectorAll('.bom-material')[1];
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'Brass_C36000');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(400);
      await p.screenshot('25b-bom');
      await p.click('Close', 300);
      await run(p, 'drawing.options', { subject: 'assembly' });
      await run(p, 'drawing.open');
      await waitFor(() => p.eval<number>(`document.querySelectorAll('.drawing-sheet-view .balloon').length`), 'assembly sheet');
      await sleep(400);
      await p.screenshot('26c-assembly-drawing');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(300);
      await run(p, 'drawing.options', { subject: 'part' });
    },
  },
  {
    name: '26-drawing-tab', async run(p) {
      await example(p, 'l_bracket');
      await feaPanel(p, false);
      await p.click('Drawing', 400);
      await p.screenshot('26-drawing-tab');
      await p.click('Features', 300);
    },
  },
  {
    name: '26-drawing', async run(p) {
      await example(p, 'l_bracket');
      await run(p, 'drawing.open');
      await waitFor(() => p.eval<number>(`document.querySelectorAll('svg line.visible-line').length`), 'drawing sheet');
      await sleep(500);
      await p.screenshot('26-drawing');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(300);
      await closeDialog(p);
    },
  },
  {
    name: '27-export', async run(p) {
      await run(p, 'file.export', undefined, 500);
      await p.screenshot('27-export');
      await closeDialog(p);
    },
  },
  {
    name: '28-fea', async run(p) {
      await example(p, 'l_bracket'); await iso(p);
      await feaPanel(p, true);
      await p.click('Features');
      await pick(p, '.fea-load-face', 'zMax');
      await sleep(400);
      await p.screenshot('28-fea-setup');
      await p.eval(`[...document.querySelectorAll('.fea-panel button')].find(b => b.textContent.trim() === 'Solve').click()`);
      await waitFor(() => p.eval<string>(`document.querySelector('.fea-panel')?.innerText.match(/Max von Mises:[^\\n]*/)?.[0]`), 'FEA results', 60000);
      await sleep(800);
      await p.screenshot('29-fea-stress');
      await pick(p, '.fea-quantity', 'displacement');
      await p.eval(`document.querySelector('.fea-deformed')?.click()`);
      await sleep(800);
      await p.screenshot('30-fea-deformed');
      await feaPanel(p, false);
    },
  },
  // -------------------------------------------------------- Part 4: professional
  {
    name: '31-macro', async run(p) {
      await fresh(p);
      await p.click('Tools');
      await p.click('Record a macro of model changes', 400);
      await p.click('Sketch');
      await p.click('Sketch on the Front plane', 600);
      await p.click('Corner Rectangle (R)');
      const r = await canvasRect(p);
      await p.mouseClick(r.left + r.width * 0.4, r.top + r.height * 0.4);
      await p.mouseClick(r.left + r.width * 0.6, r.top + r.height * 0.6);
      await p.click('Confirm & Exit Sketch', 800);
      await p.click('Features');
      await p.click('Extruded Boss/Base', 400);
      await setField(p, 'Extrude Depth', 12);
      await apply(p);
      await p.click('Tools');
      await iso(p);
      await p.screenshot('31-macro-recording');
      await p.eval(`HTMLAnchorElement.prototype.click = function () {}`);
      await p.click('Stop recording and save the macro file', 400);
    },
  },
  {
    name: '32-console', async run(p) {
      await fresh(p);
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', ctrlKey: true }))`);
      await sleep(400);
      await p.eval(`[...document.querySelectorAll('.console-example')].find(b => b.textContent === 'Plate with a hole').click()`);
      await sleep(200);
      await p.eval(`document.querySelector('.script-console-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await sleep(1800);
      await iso(p);
      await p.screenshot('32-console');
      await p.eval(`document.querySelector('.script-console-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
    },
  },
  {
    name: '33-addins', async run(p) {
      await fresh(p);
      await p.click('Add-ins');
      await p.click('Load, list and unload add-ins');
      await p.click('Example: washer generator', 200);
      await p.click('Load', 1500);
      await p.screenshot('33-addins');
      await p.click('Close');
      await p.click('ISO 7089 washer M8 (Ø16 × 1.6)', 1200);
      await iso(p);
      await p.screenshot('34-addin-washer');
    },
  },
];

// ------------------------------------------------------------------ runner
async function main(): Promise<number> {
  const chrome = CHROMES.find(p => existsSync(p));
  if (!chrome) { console.error('No Chrome found (set CHROME_PATH)'); return 1; }
  if (!existsSync('dist/index.html')) { console.error('Run `npm run build` first'); return 1; }
  mkdirSync(OUT, { recursive: true });

  const procs: ChildProcess[] = [];
  const profile = mkdtempSync(join(tmpdir(), 'casiworks-shots-'));
  try {
    const appPort = await freePort();
    const debugPort = await freePort();
    procs.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(appPort), '--strictPort'], { stdio: 'ignore' }));
    await waitFor(() => fetch(`http://127.0.0.1:${appPort}/`).then(r => r.ok), 'vite preview');
    procs.push(spawn(chrome, ['--headless=new', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1440,900', '--hide-scrollbars', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: 'ignore' }));
    const target = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      return list.find(t => t.type === 'page');
    }, 'Chrome');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    await waitFor(() => page.eval<boolean>(`!!window.casiworks && document.querySelectorAll('.feature-item').length > 0`), 'app start');
    await sleep(1000);

    let failed = 0;
    for (const shot of SHOTS) {
      if (FILTER && !shot.name.includes(FILTER)) continue;
      try {
        await Promise.race([shot.run(page), sleep(90000).then(() => { throw new Error('timed out'); })]);
        console.log(`  ✓ ${shot.name}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${shot.name}: ${err instanceof Error ? err.message : err}`);
        await page.eval(`document.querySelector('.dialog-backdrop')?.click(); document.querySelector('.action-btn-red')?.click()`).catch(() => {});
      }
    }

    // The generated API reference, served next to the app
    if (!FILTER || 'api-reference'.includes(FILTER)) {
      await page.send('Page.navigate', { url: `http://127.0.0.1:${appPort}/api/` });
      await sleep(1500);
      await page.screenshot('35-api-reference');
      console.log('  ✓ api-reference');
    }
    console.log(`${failed ? 'FAILED' : 'OK'}: ${failed} failure(s); screenshots in ${OUT}/`);
    ws.close();
    return failed ? 1 : 0;
  } finally {
    await Promise.all(procs.map(p => new Promise<void>(resolve => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      p.once('exit', () => resolve());
      p.kill();
      setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 3000);
    })));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

process.exitCode = await main();
