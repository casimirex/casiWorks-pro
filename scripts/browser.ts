// CasiWorks Pro - Headless Chrome harness shared by the e2e test, the tutorial
// screenshots and the performance budgets
//
// Serves dist/ with `vite preview`, starts headless Chrome and drives the page
// over the DevTools protocol. Chrome is taken from $CHROME_PATH or the usual
// install locations.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROMES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter((p): p is string => Boolean(p));

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A Chrome to drive, or undefined when none is installed. */
export const findChrome = () => CHROMES.find(p => existsSync(p));

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
  srv.on('error', reject);
});

export async function waitFor<T>(fn: () => Promise<T | undefined | null>, what: string, timeoutMs = 15000): Promise<T> {
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

export interface PageOptions {
  /** Where screenshots go, and as what. */
  shots: { dir: string; format: 'png' | 'webp' };
  /** Accept page dialogs (true), or dismiss and report them as problems (false, the default). */
  acceptDialogs?: boolean;
}

export class Page {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, (msg: { result?: Record<string, unknown> }) => void>();
  private options: PageOptions;
  /** Page exceptions, console errors and dialogs seen so far. */
  readonly problems: string[] = [];

  constructor(ws: WebSocket, options: PageOptions) {
    this.ws = ws;
    this.options = options;
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.method === 'Runtime.exceptionThrown') {
        this.problems.push('exception: ' + String(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).split('\n')[0]);
      }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') {
        this.problems.push('console.error: ' + d.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' ').slice(0, 200));
      }
      // A dialog would block the page forever: answer it at once
      if (d.method === 'Page.javascriptDialogOpening') {
        if (!this.options.acceptDialogs) this.problems.push(`${d.params.type} dialog: ${d.params.message}`);
        void this.send('Page.handleJavaScriptDialog', { accept: !!this.options.acceptDialogs });
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

  async mouseMove(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(150);
  }

  async mouseClick(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(250);
  }

  async screenshot(name: string): Promise<void> {
    const { dir, format } = this.options.shots;
    const r = await this.send('Page.captureScreenshot', format === 'webp' ? { format, quality: 82 } : { format });
    writeFileSync(join(dir, `${name}.${format}`), Buffer.from(String(r.result?.data), 'base64'));
  }
}

export interface AppSession {
  page: Page;
  /** Where the built app is served, e.g. http://127.0.0.1:4173/ */
  appUrl: string;
}

/**
 * Serve dist/, open it in headless Chrome, wait for the app to start, run `fn`,
 * then stop Chrome and the server whatever happens.
 */
export async function withApp<T>(options: PageOptions & { profile: string; chrome: string }, fn: (session: AppSession) => Promise<T>): Promise<T> {
  mkdirSync(options.shots.dir, { recursive: true });
  const procs: ChildProcess[] = [];
  const profile = mkdtempSync(join(tmpdir(), `casiworks-${options.profile}-`));
  try {
    const appPort = await freePort();
    const debugPort = await freePort();
    procs.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(appPort), '--strictPort'], { stdio: 'ignore' }));
    await waitFor(() => fetch(`http://127.0.0.1:${appPort}/`).then(r => r.ok), 'vite preview');
    procs.push(spawn(options.chrome, ['--headless=new', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1440,900', '--hide-scrollbars', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: 'ignore' }));
    const target = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      return list.find(t => t.type === 'page');
    }, 'Chrome');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const page = new Page(ws, options);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    const appUrl = `http://127.0.0.1:${appPort}/`;
    try {
      await page.send('Page.navigate', { url: appUrl });
      await waitFor(() => page.eval<boolean>(`!!window.casiworks && document.querySelectorAll('.feature-item').length > 0`), 'app start');
      return await fn({ page, appUrl });
    } finally {
      ws.close();
    }
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
