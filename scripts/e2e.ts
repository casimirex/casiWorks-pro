// CasiWorks Pro - End-to-end smoke test in a real browser
//
//   npm run build && npm run e2e
//
// Serves dist/ with `vite preview`, drives headless Chrome over the DevTools
// protocol and checks the main user flows. Screenshots go to e2e-output/.
// Chrome is taken from $CHROME_PATH or the usual install locations; without
// one the test is skipped (exit 0) so it never blocks machines without Chrome.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = 'e2e-output';
const CHROMES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter((p): p is string => Boolean(p));

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
  readonly problems: string[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.method === 'Runtime.exceptionThrown') {
        this.problems.push('exception: ' + String(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).split('\n')[0]);
      }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
        this.problems.push('console.error: ' + d.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' ').slice(0, 200));
      }
      // A dialog would block the page forever: dismiss it and report it
      if (d.method === 'Page.javascriptDialogOpening') {
        this.problems.push(`${d.params.type} dialog: ${d.params.message}`);
        void this.send('Page.handleJavaScriptDialog', { accept: false });
      }
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

  /** Evaluate an expression in the page (awaits promises); throws on page exceptions. */
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

  async screenshot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(String(r.result?.data), 'base64'));
  }
}

// ------------------------------------------------------------------ checks
type Check = { name: string; run(page: Page): Promise<string> };

const status = (p: Page) => p.eval<string>(`document.querySelector('.status-msg-text')?.textContent`);
const treeNames = (p: Page) => p.eval<string[]>(`[...document.querySelectorAll('.feature-item .tree-node-label')].map(e => e.firstChild.textContent)`);
const volume = async (p: Page) => (await p.eval<{ volume: number }>(`window.casiworks.model.massProperties()`)).volume;
const setField = (p: Page, label: string, value: string | number) => p.eval(`(() => {
  const row = [...document.querySelectorAll('.property-panel .property-row')].find(r => r.querySelector('.property-label')?.textContent.startsWith(${JSON.stringify(label)}));
  const el = row?.querySelector('select, input');
  if (!el) throw new Error('No field ' + ${JSON.stringify(label)});
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  // Enter commits numeric fields (the page has no window focus for blur events)
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
/** Keep downloaded files in window.__blobs instead of saving them (idempotent). */
const CAPTURE_DOWNLOADS = `if (!window.__blobs) {
  window.__blobs = [];
  const create = URL.createObjectURL;
  URL.createObjectURL = (b) => { window.__blobs.push(b); return create(b); };
  HTMLAnchorElement.prototype.click = function () {};
}`;

const CHECKS: Check[] = [
  {
    name: 'starts with the starter part and the public API',
    async run(p) {
      const v = await p.eval<string>('window.casiworks.version');
      const names = await treeNames(p);
      assert(names.join() === 'Sketch1,Boss-Extrude1', `tree: ${names}`);
      assert(Math.abs(await volume(p) - 60000) < 1, 'starter block volume');
      await p.screenshot('01-start');
      return `API ${v}, ${names.length} features`;
    },
  },
  {
    name: 'sketch a rectangle on the Front plane',
    async run(p) {
      await p.click('Sketch');
      await p.click('Sketch on the Front plane');
      await p.click('Corner Rectangle (R)');
      const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      await p.mouseClick(r.left + r.width * 0.75, r.top + r.height * 0.25);
      await p.mouseClick(r.left + r.width * 0.9, r.top + r.height * 0.4);
      await p.screenshot('02-sketch');
      await p.click('Confirm & Exit Sketch', 1200);
      const names = await treeNames(p);
      assert(names.includes('Sketch2'), `tree: ${names}`);
      return names.join(', ');
    },
  },
  {
    name: 'hole from the property panel removes the drilled volume',
    async run(p) {
      await p.eval(`window.casiworks.document.new()`);
      await p.eval(`(() => { const s = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
        window.casiworks.features.extrude({ sketchId: s.sketchId, depth: 25 }); })()`);
      const before = await volume(p);
      await p.click('Hole', 400);
      await setField(p, 'Diameter', 10);
      await setField(p, 'Hole Depth', 10);
      await setField(p, 'Drill Direction', '+Z');
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      const removed = before - await volume(p);
      const faceted = 16 * Math.sin(Math.PI / 16) * 25 * 10; // 32-sided Ø10 × 10
      assert(Math.abs(removed - faceted) < 1, `removed ${removed} mm³, expected ${faceted}`);
      return `removed ${removed.toFixed(0)} mm³`;
    },
  },
  {
    name: 'example, drawing sheet and FEA solve',
    async run(p) {
      await p.click('Load Mechanical CAD Examples');
      await p.eval(`document.querySelector('.example-item-btn').click()`);
      await sleep(2500);
      await p.eval(`window.casiworks.commands.execute('drawing.open')`);
      const lines = await waitFor(() => p.eval<number>(`document.querySelectorAll('svg line.visible-line').length`), 'drawing sheet');
      await p.screenshot('03-drawing');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(300);
      await p.click('Solve');
      const fea = await waitFor(() => p.eval<string>(`document.querySelector('.fea-panel')?.innerText.match(/Max von Mises:[^\\n]*/)?.[0]`), 'FEA results', 30000);
      await p.screenshot('04-fea');
      const staleBefore = await p.eval<boolean>(`!!document.querySelector('.fea-stale')`);
      await p.eval(`window.casiworks.commands.execute('model.setMaterial', { key: 'Titanium_Ti6Al4V' })`);
      await sleep(300);
      const staleAfterEdit = await p.eval<boolean>(`!!document.querySelector('.fea-stale')`);
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await sleep(500);
      const resultsAfterNew = await p.eval<boolean>(`!!document.querySelector('.fea-results')`);
      await p.eval(`window.casiworks.commands.execute('file.loadExample', { id: 'l_bracket' })`); // later checks need a body
      await sleep(1500);
      assert(!staleBefore && staleAfterEdit && !resultsAfterNew, `stale: before ${staleBefore}, after edit ${staleAfterEdit}; results after New: ${resultsAfterNew}`);
      return `${lines} drawing lines; ${fea}; marked out of date after a change, cleared by New`;
    },
  },
  {
    name: 'commands, keyboard and events',
    async run(p) {
      await p.eval(`window.__events = []; ['featureAdded', 'featureRemoved', 'commandExecuted'].forEach(n => window.casiworks.on(n, e => window.__events.push(n + ':' + (e.feature?.type ?? e.id))));`);
      await p.click('Linear Pattern', 300);
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))`);
      await sleep(800);
      const events = await p.eval<string[]>('window.__events');
      const expected = ['commandExecuted:feature.linearPattern', 'featureAdded:linear_pattern', 'commandExecuted:edit.undo'];
      for (const e of expected) assert(events.includes(e), `events ${events} lack ${e}`);
      assert(events.some(e => e.startsWith('featureRemoved:')), 'undo removed the pattern');
      return events.join(' ');
    },
  },
  {
    name: 'model export writes a DXF of the faces',
    async run(p) {
      await p.eval(CAPTURE_DOWNLOADS);
      await p.click('Export CAD Model');
      await p.eval(`[...document.querySelectorAll('.dialog-body label')].find(l => l.textContent.includes('DXF')).querySelector('input').click()`);
      await sleep(100);
      await p.click('Export File', 600);
      const faces = await p.eval<number>(`window.__blobs.at(-1).text().then(t => (t.match(/3DFACE/g) || []).length)`);
      assert(faces > 100, `${faces} faces`);
      return `${faces} 3DFACE entities`;
    },
  },
  {
    name: 'record a macro in the UI and replay it into a new part',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Tools');
      await p.click('Record a macro of model changes');
      // A sketch drawn with the mouse and an extrude from the property panel
      await p.click('Sketch');
      await p.click('Sketch on the Front plane');
      await p.click('Corner Rectangle (R)');
      const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      await p.mouseClick(r.left + r.width * 0.4, r.top + r.height * 0.4);
      await p.mouseClick(r.left + r.width * 0.6, r.top + r.height * 0.6);
      await p.click('Confirm & Exit Sketch', 800);
      await p.click('Extruded Boss/Base', 400);
      await setField(p, 'Extrude Depth', 12);
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      const recordedVolume = await volume(p);
      await p.click('Tools');
      const label = await p.eval<string>(`[...document.querySelectorAll('button')].find(b => b.title.startsWith('Stop recording')).textContent`);
      await p.eval(CAPTURE_DOWNLOADS);
      await p.click('Stop recording and save the macro file', 400);
      const macroText = await p.eval<string>(`window.__blobs.at(-1).text()`);
      const macro = JSON.parse(macroText) as { steps: Array<{ command: string }> };
      const steps = macro.steps.map(st => st.command).join(', ');
      assert(steps === 'sketch.create, feature.create', `recorded: ${steps}`);

      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.eval(`window.casiworks.commands.execute('macro.run', { macro: ${JSON.stringify(macroText)} })`);
      await sleep(800);
      const replayed = await volume(p);
      assert(recordedVolume > 0 && Math.abs(replayed - recordedVolume) < 1e-6, `volume ${replayed} vs recorded ${recordedVolume}`);
      await p.screenshot('05-macro');
      return `"${label}" → ${steps}; replayed volume ${replayed.toFixed(0)} mm³`;
    },
  },
  {
    name: 'scripting console: run an example, see errors and history',
    async run(p) {
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', ctrlKey: true }))`);
      await sleep(300);
      assert(await p.eval<boolean>(`!!document.querySelector('.script-console')`), 'Ctrl+` opens the console');
      const type = (text: string) => p.eval(`(() => {
        const el = document.querySelector('.script-console-input');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const enter = async () => {
        await p.eval(`document.querySelector('.script-console-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
        await sleep(1500);
      };
      const lastOf = (kind: string) => p.eval<string>(`[...document.querySelectorAll('.script-console .console-${kind}')].at(-1)?.textContent`);

      await p.eval(`[...document.querySelectorAll('.console-example')].find(b => b.textContent === 'Plate with a hole').click()`);
      await sleep(200);
      await enter();
      const value = await lastOf('value');
      const names = await treeNames(p);
      assert(names.join() === 'Sketch1,Plate,Sketch2,Hole', `tree after example: ${names}`);
      assert(/"volume":/.test(value), `value: ${value}`);

      await type("run('nope.nope')");
      await enter();
      const error = await lastOf('error');
      assert(/NOT_FOUND/.test(error), `error: ${error}`);

      await p.eval(`document.querySelector('.script-console-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
      await sleep(200);
      const recalled = await p.eval<string>(`document.querySelector('.script-console-input').value`);
      assert(recalled === "run('nope.nope')", `history: ${recalled}`);
      await p.screenshot('06-console');
      await p.eval(`document.querySelector('.script-console-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      assert(!(await p.eval<boolean>(`!!document.querySelector('.script-console')`)), 'Esc closes the console');
      return `tree ${names.join(', ')}; error shown with its code; history and Esc work`;
    },
  },
];

// ------------------------------------------------------------------ runner
async function main(): Promise<number> {
  const chrome = CHROMES.find(p => existsSync(p));
  if (!chrome) {
    console.log('e2e: no Chrome found (set CHROME_PATH); skipped');
    return 0;
  }
  if (!existsSync('dist/index.html')) {
    console.error('e2e: run `npm run build` first');
    return 1;
  }
  mkdirSync(OUT, { recursive: true });

  const procs: ChildProcess[] = [];
  const profile = mkdtempSync(join(tmpdir(), 'casiworks-e2e-'));
  try {
    const appPort = await freePort();
    const debugPort = await freePort();
    procs.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(appPort), '--strictPort'], { stdio: 'ignore' }));
    await waitFor(() => fetch(`http://127.0.0.1:${appPort}/`).then(r => r.ok), 'vite preview');

    procs.push(spawn(chrome, ['--headless=new', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1440,900', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: 'ignore' }));
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

    let failed = 0;
    for (const check of CHECKS) {
      const t = Date.now();
      try {
        const detail = await Promise.race([
          check.run(page),
          sleep(60000).then(() => { throw new Error('timed out after 60 s'); }),
        ]);
        console.log(`  ✓ ${check.name} (${Date.now() - t} ms) — ${detail}`);
      } catch (err) {
        failed++;
        console.log(`  ✗ ${check.name}: ${err instanceof Error ? err.message : err}`);
        await page.screenshot(`FAILED-${check.name.replace(/\W+/g, '-')}`).catch(() => {});
      }
    }
    if (page.problems.length) {
      failed++;
      console.log(`  ✗ page errors:\n    ${page.problems.join('\n    ')}`);
    }
    console.log(`${failed ? 'FAILED' : 'OK'}: ${CHECKS.length} checks, ${failed} failure(s); screenshots in ${OUT}/ (status bar: ${await status(page)})`);
    ws.close();
    return failed ? 1 : 0;
  } finally {
    // Wait for Chrome and the server to exit before removing Chrome's profile
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
