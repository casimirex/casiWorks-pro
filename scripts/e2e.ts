// CasiWorks Pro - End-to-end smoke test in a real browser
//
//   npm run build && npm run e2e
//
// Serves dist/ with `vite preview`, drives headless Chrome over the DevTools
// protocol and checks the main user flows. Screenshots go to e2e-output/.
// Chrome is taken from $CHROME_PATH or the usual install locations; without
// one the test is skipped (exit 0) so it never blocks machines without Chrome.
import { existsSync } from 'node:fs';
import { findChrome, sleep, waitFor, withApp } from './browser.ts';
import type { Page } from './browser.ts';

const OUT = 'e2e-output';

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
    name: 'sketch a slot and an 8-sided polygon with the mouse',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Sketch');
      await p.click('Sketch on the Front plane');
      const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      const at = (fx: number, fy: number) => p.mouseClick(r.left + r.width * fx, r.top + r.height * fy);
      await p.click('Straight Slot: first centre, second centre, side');
      const hints = [await status(p)];
      await at(0.35, 0.5); hints.push(await status(p));
      await at(0.6, 0.5); hints.push(await status(p));
      await at(0.5, 0.42);
      assert(hints[0].startsWith('Slot: click the first') && hints[2].startsWith('Slot: click a point on the side'), `hints: ${hints}`);
      await p.eval(`(() => {
        const sel = document.querySelector('.polygon-sides');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '8');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(200);
      await at(0.5, 0.75);
      await at(0.55, 0.75);
      await p.screenshot('02b-slot-polygon');
      await p.click('Confirm & Exit Sketch', 800);
      const kinds = await p.eval<string>(`(() => {
        const s = window.casiworks.features.list().find(f => f.type === 'sketch');
        return window.casiworks.sketches.getEntities(s.sketchId).map(e => e.type).join(',');
      })()`);
      const counts = kinds.split(',').reduce((m: Record<string, number>, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
      assert(counts.arc === 2 && counts.line === 2 + 8, `entities: ${kinds}`);
      return `slot (2 arcs + 2 lines) and octagon (8 lines); hints: ${hints[0]} → ${hints[2]}`;
    },
  },
  {
    name: 'sketch editing with the mouse: extend, trim, offset, mirror, spline',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Sketch');
      await p.click('Sketch on the Front plane');
      // Snap off: points land exactly where clicked, so a click between two
      // click positions lands on the line drawn through them
      await p.click('Snap', 100);
      const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      const at = (fx: number, fy: number) => p.mouseClick(r.left + r.width * fx, r.top + r.height * fy);
      const esc = () => p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      const said: string[] = [];
      const note = async () => { said.push(await status(p)); };

      await p.click('Corner Rectangle (R)'); await at(0.3, 0.3); await at(0.6, 0.7);
      await p.click('Line Tool (L)'); await at(0.45, 0.2); await at(0.45, 0.8); await esc();
      await p.click('Line Tool (L)'); await at(0.35, 0.75); await at(0.42, 0.75); await esc();
      await p.click('Extend: click a line near the end to lengthen to the next entity'); await at(0.415, 0.75); await note();
      await p.click('Trim: click the part to remove, up to the nearest crossings (T)'); await at(0.45, 0.25); await note(); await at(0.45, 0.78); await note();
      await p.eval(`(() => {
        const el = document.querySelector('.offset-distance');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '3');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(100);
      await at(0.3, 0.5); await at(0.25, 0.5); await note();
      await p.click('Mirror: click the mirror line, then the entities to mirror'); await at(0.45, 0.5); await at(0.38, 0.75); await note();
      await p.click('Spline: click points; click the last again to finish, or the first to close (S)');
      // (kept above the FEA panel in the lower right)
      await at(0.7, 0.3); await at(0.8, 0.4); await at(0.75, 0.52); await at(0.75, 0.52); await note();
      await esc();
      await p.screenshot('02c-sketch-edit');
      const expected = [/^Line extended by /, /^Line trimmed$/, /^Line trimmed$/, /^Closed chain of 4 offset 3 mm$/, /^Mirrored 1 entity$/, /^Spline through 3 points$/];
      expected.forEach((re, i) => assert(re.test(said[i] ?? ''), `step ${i + 1}: "${said[i]}" (all: ${said.join(' | ')})`));

      await p.click('Confirm & Exit Sketch', 800);
      const ents = await p.eval<Array<{ type: string; p1?: { x: number; y: number }; p2?: { x: number; y: number } }>>(`(() => {
        const s = window.casiworks.features.list().find(f => f.type === 'sketch');
        return window.casiworks.sketches.getEntities(s.sketchId);
      })()`);
      const lines = ents.filter(e => e.type === 'line');
      assert(lines.length === 11 && ents.filter(e => e.type === 'spline').length === 1, `entities: ${ents.map(e => e.type)}`);
      // The trimmed vertical line now runs from the rectangle's top edge down to the extended line
      const v = lines.find(l => Math.abs(l.p1!.x - l.p2!.x) < 1e-6 && Math.abs(l.p1!.y - l.p2!.y) < 200 && lines.some(h => Math.abs(h.p2!.x - l.p1!.x) < 1e-6 && Math.abs(h.p1!.y - h.p2!.y) < 1e-6));
      assert(v, 'vertical line meeting the extended horizontal line');
      await p.click('Snap', 100);
      return said.join(' → ');
    },
  },
  {
    name: 'equations and configurations: variables drive an extrude depth typed as an expression',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      const type = (sel: string, i: number, value: string) => p.eval(`(() => {
        const el = document.querySelectorAll('${sel}')[${i}];
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await p.click('Tools');
      await p.click('Equations: global variables that drive feature sizes', 300);
      await p.click('Add variable', 100); await p.click('Add variable', 100);
      await type('.eq-name', 0, 'wall'); await type('.eq-expression', 0, '3');
      await type('.eq-name', 1, 'depth'); await type('.eq-expression', 1, 'wall * 8');
      await sleep(200);
      const shown = await p.eval<string[]>(`[...document.querySelectorAll('.eq-value')].map(e => e.textContent)`);
      assert(shown.join() === '3,24', `values ${shown}`);
      await p.click('Apply', 300);
      await p.click('Close', 300);

      await p.eval(`window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: 0, y: 0 }, corner2: { x: 40, y: 20 } }] })`);
      await p.click('Features');
      await p.click('Extruded Boss/Base', 500);
      await setField(p, 'Extrude Depth', 'depth + 1');
      await sleep(200);
      const linked = await p.eval<boolean>(`[...document.querySelectorAll('.property-panel .numeric-input-wrapper')].some(w => w.classList.contains('linked') && w.title === '= depth + 1')`);
      assert(linked, 'depth field is linked (ƒ)');
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      const v1 = await volume(p);
      assert(Math.abs(v1 - 40 * 20 * 25) < 1e-6, `volume ${v1}, expected 20000 (depth 3 × 8 + 1)`);

      // Change the wall: the extrude follows
      await p.click('Tools');
      await p.click('Equations: global variables that drive feature sizes', 300);
      await type('.eq-expression', 0, '5');
      await sleep(200);
      await p.screenshot('02d-equations');
      await p.click('Apply', 1200);
      const linkRow = await p.eval<string>(`document.querySelector('.equation-links')?.textContent ?? ''`);
      await p.click('Close', 300);
      await sleep(800);
      const v2 = await volume(p);
      assert(Math.abs(v2 - 40 * 20 * 41) < 1e-6, `volume ${v2}, expected 32800 (depth 5 × 8 + 1)`);
      assert(/Boss|Extrude/.test(linkRow) && linkRow.includes('= depth + 1') && linkRow.includes('41'), `links: ${linkRow}`);

      // Configurations: a Large version with wall = 10, switched from the ribbon
      await p.click('Tools');
      await p.click('Configurations: versions of the part from variable values (design table)', 300);
      await p.click('Add configuration', 100);
      await type('.config-name', 0, 'Large');
      await type('.config-cell', 0, '10');
      await sleep(200);
      await p.click('Apply', 600);
      await p.screenshot('02e-configurations');
      await p.click('Close', 300);
      await p.eval(`(() => {
        const sel = document.querySelector('.config-switch');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'Large');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(1200);
      const v3 = await volume(p);
      const badge = await p.eval<string>(`document.querySelector('.doc-config-tag')?.textContent ?? ''`);
      assert(Math.abs(v3 - 40 * 20 * 81) < 1e-6 && badge === 'Large', `Large: volume ${v3} (expected 64800), badge "${badge}"`);
      await p.eval(`window.casiworks.configurations.activate('Default')`);
      await sleep(1200);
      const v4 = await volume(p);
      assert(Math.abs(v4 - v2) < 1e-6, `back to Default: ${v4}`);
      await p.click('Features', 200);
      return `wall 3 → ${v1} mm³; wall 5 → ${v2} mm³; Large (wall 10) → ${v3} mm³, back to Default → ${v4}; link row "${linkRow}"`;
    },
  },
  {
    name: 'measure: two clicks on opposite faces give the wall thickness',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.eval(`(() => {
        const s = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
        window.casiworks.features.extrude({ sketchId: s.sketchId, depth: 20 });
      })()`);
      await sleep(1000);
      const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      const centre = () => p.mouseClick(r.left + r.width * 0.5, r.top + r.height * 0.5);
      await p.click('Evaluate');
      await p.click('Measure (M): click two points on the model', 200);
      await p.eval(`window.casiworks.commands.execute('view.front')`);
      await sleep(600);
      await centre();
      await sleep(200);
      const hint = await p.eval<string>(`document.querySelector('.measure-panel')?.textContent ?? ''`);
      await p.eval(`window.casiworks.commands.execute('view.back')`);
      await sleep(600);
      await centre();
      await sleep(300);
      const gap = await p.eval<string>(`document.querySelector('.measure-gap')?.textContent ?? ''`);
      const angle = await p.eval<string>(`document.querySelector('.measure-angle')?.textContent ?? ''`);
      assert(hint.includes('Click the second point'), `after one click: ${hint}`);
      assert(gap === '20 mm' && angle === '180°', `gap "${gap}", angle "${angle}"`);
      await p.eval(`window.casiworks.commands.execute('view.isometric')`);
      await sleep(600);
      await p.screenshot('04b-measure');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);
      const closed = await p.eval<boolean>(`!document.querySelector('.measure-panel')`);
      assert(closed, 'Esc ends measuring');
      await p.click('Features', 200);
      return `front face to back face: gap ${gap}, angle ${angle}`;
    },
  },
  {
    name: 'sketch on a face and on a reference plane',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.eval(`(() => {
        const s = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
        window.casiworks.features.extrude({ sketchId: s.sketchId, depth: 15 });
      })()`);
      await sleep(1000);
      const v0 = await volume(p);
      const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      const at = (fx: number, fy: number) => p.mouseClick(r.left + r.width * fx, r.top + r.height * fy);
      await p.eval(`window.casiworks.commands.execute('view.front')`);
      await sleep(500);
      await p.click('Sketch');
      await p.click('Sketch on a face: click a flat face of the part', 200);
      await at(0.5, 0.5);
      await sleep(600);
      const sketching = await p.eval<boolean>(`!!document.querySelector('.exit-sketch-btn')`);
      assert(sketching, 'a click on the face starts a sketch');
      await p.click('Center Circle (C)');
      await at(0.5, 0.5); await at(0.53, 0.5);
      await p.screenshot('02f-sketch-on-face');
      await p.click('Confirm & Exit Sketch', 800);
      const faceSketch = await p.eval<{ frame?: { origin: { z: number }; normal: { z: number } } }>(`window.casiworks.features.list().filter(f => f.type === 'sketch').at(-1).parameters`);
      assert(faceSketch.frame?.origin.z === 15 && faceSketch.frame.normal.z === 1, `face sketch frame ${JSON.stringify(faceSketch.frame)}`);
      await p.click('Features');
      await p.click('Extruded Boss/Base', 500);
      await setField(p, 'Extrude Depth', 10);
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      const box = await p.eval<{ max: { z: number } }>(`window.casiworks.model.boundingBox()`);
      const v1 = await volume(p);
      assert(Math.abs(box.max.z - 25) < 1e-6 && v1 > v0 + 50, `boss on the face: max z ${box.max.z}, volume ${v0} → ${v1}`);

      // Reference plane from the panel, then a sketch on it from the ribbon
      await p.click('Reference Plane: offset and tilt a standard plane, then sketch on it', 400);
      await setField(p, 'Offset', 40);
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(800);
      const names = await treeNames(p);
      await p.click('Sketch');
      const planeId = await p.eval<string>(`window.casiworks.features.list().find(f => f.type === 'reference_plane')?.id ?? ''`);
      await p.eval(`(() => {
        const sel = document.querySelector('.sketch-on-plane');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(planeId)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(600);
      await p.click('Center Circle (C)');
      await at(0.5, 0.5); await at(0.52, 0.5);
      await p.screenshot('02g-sketch-on-plane');
      await p.click('Confirm & Exit Sketch', 800);
      const planeSketch = await p.eval<{ planeRef?: string }>(`window.casiworks.features.list().filter(f => f.type === 'sketch').at(-1).parameters`);
      assert(names.includes('Plane1') && planeSketch.planeRef === planeId, `tree ${names}; sketch ${JSON.stringify(planeSketch)}`);
      await p.eval(`window.casiworks.commands.execute('view.isometric')`);
      await p.click('Features', 200);
      return `boss on the front face reaches z = ${box.max.z}; sketch on Plane1 (offset 40) keeps its plane`;
    },
  },
  {
    name: 'revolve about a centreline picked in the panel; a reference axis',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      const lineId = await p.eval<string>(`(() => {
        const s = window.casiworks.sketches.create({ entities: [
          { type: 'rectangle', corner1: { x: 10, y: 0 }, corner2: { x: 20, y: 30 } },
          { type: 'line', p1: { x: 5, y: -5 }, p2: { x: 5, y: 40 }, construction: true },
        ] });
        return window.casiworks.sketches.getEntities(s.sketchId).find(e => e.construction).id;
      })()`);
      await p.click('Features');
      await p.click('Revolved Boss/Base', 500);
      const options = await p.eval<string[]>(`[...document.querySelectorAll('.property-panel .revolve-axis option')].map(o => o.textContent)`);
      await p.eval(`(() => {
        const sel = document.querySelector('.property-panel .revolve-axis');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(`line:${lineId}`)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(150);
      await p.screenshot('02h-revolve-axis');
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      const v = await volume(p);
      const expected = 2 * Math.PI * 10 * 300;
      assert(options.includes('Centreline (5, -5) → (5, 40)') && Math.abs(v - expected) / expected < 0.005, `axis options ${options}; volume ${v} vs ${expected}`);

      await p.click('Reference Axis: parallel to model X, Y or Z through a point; use it to revolve about', 400);
      await setField(p, 'X', 40);
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(600);
      const names = await treeNames(p);
      assert(names.includes('Axis1'), `tree ${names}`);
      return `revolve about the centreline: ${v.toFixed(0)} mm³ (Pappus ${expected.toFixed(0)}); Axis1 added`;
    },
  },
  {
    name: 'coordinate system from the ribbon; mass properties reported in it',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('file.loadExample', { id: 'l_bracket' })`);
      await sleep(1500);
      await p.click('Features');
      await p.click('Coordinate System: an origin and turned axes; report mass properties in it', 400);
      const com = await p.eval<{ x: number; y: number; z: number }>(`window.casiworks.model.massProperties().centerOfMass`);
      await setField(p, 'Origin X', com.x.toFixed(3));
      await setField(p, 'Origin Y', com.y.toFixed(3));
      await setField(p, 'Origin Z', com.z.toFixed(3));
      await setField(p, 'Turn about Z', 90);
      await sleep(200);
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(800);
      const names = await treeNames(p);
      const label = await p.eval<boolean>(`[...document.querySelectorAll('.cs-label')].some(e => e.textContent === 'CS1')`);
      await p.eval(`window.casiworks.commands.execute('view.isometric')`);
      await sleep(400);
      await p.screenshot('02j-coordinate-system');
      await p.eval(`window.casiworks.commands.execute('evaluate.massProperties')`);
      await sleep(400);
      await p.eval(`(() => {
        const sel = document.querySelector('.mass-props-cs');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, sel.options[1].value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(300);
      const shown = await p.eval<string>(`document.querySelector('.mass-props-com')?.textContent ?? ''`);
      await p.screenshot('02k-mass-props-cs');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await p.eval(`document.querySelector('.dialog-backdrop')?.click()`);
      await sleep(200);
      const csId = await p.eval<string>(`window.casiworks.features.list().find(f => f.type === 'coordinate_system')?.id ?? ''`);
      const rot = await p.eval<{ z: number }>(`window.casiworks.features.list().find(f => f.type === 'coordinate_system').parameters.rotation`);
      assert(names.includes('CS1') && label && rot.z === 90, `tree ${names}, label ${label}, rotation ${JSON.stringify(rot)}`);
      // The centre of mass is (about) the CS origin
      assert(/\(0\.00, 0\.00, 0\.00\) mm/.test(shown), `centre of mass in CS1: ${shown}`);
      const viaApi = await p.eval<{ x: number }>(`window.casiworks.model.massProperties({ coordinateSystem: ${JSON.stringify('')} + ${JSON.stringify(csId)} }).centerOfMass`);
      assert(Math.abs(viaApi.x) < 0.01, `API centre x ${viaApi.x}`);
      return `CS1 at the centre of mass, turned 90° about Z; Mass Properties in CS1: ${shown.trim()}`;
    },
  },
  {
    name: 'sketch relations and driving dimensions with the mouse',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Sketch');
      await p.click('Sketch on the Front plane');
      await p.click('Snap', 100);
      const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      const A = { x: r.left + r.width * 0.35, y: r.top + r.height * 0.35 };
      const B = { x: r.left + r.width * 0.6, y: r.top + r.height * 0.65 };
      await p.click('Corner Rectangle (R)'); await p.mouseClick(A.x, A.y); await p.mouseClick(B.x, B.y);
      await sleep(300);
      type Line = { id: string; type: string; p1: { x: number; y: number }; p2: { x: number; y: number } };
      const sketch = () => p.eval<{ entities: Line[]; state: { message: string } }>(`window.casiworks.commands.execute('sketch.entities')`);
      // Screen ↔ sketch from the two clicked corners (front view: a scale and an offset per axis)
      const first = (await sketch()).entities;
      const xs0 = first.flatMap(e => [e.p1.x, e.p2.x]), ys0 = first.flatMap(e => [e.p1.y, e.p2.y]);
      const sx = (B.x - A.x) / (Math.max(...xs0) - Math.min(...xs0)), sy = (B.y - A.y) / (Math.min(...ys0) - Math.max(...ys0));
      const toScreen = (q: { x: number; y: number }) => ({ x: A.x + (q.x - Math.min(...xs0)) * sx, y: A.y + (q.y - Math.max(...ys0)) * sy });
      /** Click a line a third of the way along (clear of its ends and its tags). */
      const clickLine = async (pick: (ls: Line[]) => Line) => {
        const l = pick((await sketch()).entities);
        const s = toScreen({ x: l.p1.x + (l.p2.x - l.p1.x) / 3, y: l.p1.y + (l.p2.y - l.p1.y) / 3 });
        await p.mouseClick(s.x, s.y);
        await sleep(200);
      };
      const bottom = (ls: Line[]) => ls.reduce((a, b) => (Math.max(b.p1.y, b.p2.y) < Math.max(a.p1.y, a.p2.y) ? b : a));
      const left = (ls: Line[]) => ls.reduce((a, b) => (Math.max(b.p1.x, b.p2.x) < Math.max(a.p1.x, a.p2.x) ? b : a));
      const kind = (k: string) => p.eval(`(() => {
        const sel = document.querySelector('.relation-kind');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(k)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const typeValue = (v: string) => p.eval(`(() => {
        const el = document.querySelector('.dim-prompt-input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`);
      const log: string[] = [];
      const tags = await p.eval<string[]>(`[...document.querySelectorAll('.sketch-rel span')].map(e => e.textContent)`);
      // A duplicate relation is refused
      await kind('horizontal'); await sleep(200); await clickLine(bottom); log.push(await status(p));
      // Dimension the bottom: click it, then empty space, type 60
      await p.click('Smart Dimension (D): click a line, circle or arc, or two items, then type the size; double-click a dimension to change it');
      await clickLine(bottom); await p.mouseClick(r.left + r.width * 0.15, r.top + r.height * 0.15);
      await sleep(250);
      const promptLabel = await p.eval<string>(`document.querySelector('.dim-prompt')?.textContent ?? ''`);
      if (!promptLabel) throw new Error(`no dimension prompt; ${log.join(' | ')} | ${await status(p)}`);
      await typeValue('60'); await sleep(300);
      // Equal: the left side takes the bottom's 60
      await kind('equal'); await sleep(200); await clickLine(bottom); await clickLine(left); log.push(await status(p));
      const solveTag = await p.eval<string>(`document.querySelector('.sketch-solve-tag')?.textContent ?? ''`);
      // Change the dimension to an equation: double-click it, type =wall*3 (wall = 20 → 60)
      await p.eval(`window.casiworks.equations.set([{ name: 'wall', expression: '20' }])`);
      await p.eval(`document.querySelector('.sketch-dim').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await sleep(200);
      await typeValue('=wall*3'); await sleep(300);
      const linked = await p.eval<string>(`document.querySelector('.sketch-dim span')?.textContent ?? ''`);
      // The variable changes while the sketch is open: the sketch follows (25 × 3 = 75)
      await p.eval(`window.casiworks.equations.set([{ name: 'wall', expression: '25' }])`);
      await sleep(300);
      const dimText = await p.eval<string>(`document.querySelector('.sketch-dim span')?.textContent ?? ''`);
      await p.screenshot('02i-sketch-dimensions');
      const final = (await sketch()).entities;
      const xs = final.flatMap(e => [e.p1.x, e.p2.x]), ys = final.flatMap(e => [e.p1.y, e.p2.y]);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      await p.click('Snap', 100);
      await p.click('Confirm & Exit Sketch', 800);
      assert(tags.join() === 'H,V,H,V', `built-in rectangle relations ${tags}`);
      assert(log[0] === 'Already horizontal' && /^Equal added/.test(log[1]), `steps ${log.join(' | ')}`);
      assert(promptLabel.startsWith('Length'), `prompt "${promptLabel}"`);
      assert(linked === 'ƒ 60' && dimText === 'ƒ 75' && Math.abs(w - 75) < 1e-3 && Math.abs(h - 75) < 1e-3, `dimension ${linked} → ${dimText}; ${w} × ${h}`);
      assert(/^Under defined/.test(solveTag), `solve tag "${solveTag}"`);
      return `rectangle relations ${tags}; duplicate refused; 60, Equal, then =wall*3 (${linked}), wall 20 → 25: ${w.toFixed(0)} × ${h.toFixed(0)} square; ${solveTag}`;
    },
  },
  {
    name: 'hole from the property panel removes the drilled volume; Hole Wizard M8 counterbore',
    async run(p) {
      await p.eval(`window.casiworks.document.new()`);
      await p.eval(`(() => { const s = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
        window.casiworks.features.extrude({ sketchId: s.sketchId, depth: 25 }); })()`);
      const before = await volume(p);
      await p.click('Hole', 400);
      await setField(p, 'Diameter', 10);
      await setField(p, 'Hole Depth', 10);
      await setField(p, 'Drill Direction', '+Z');
      // The FEA panel stays in the viewport, clear of the property panel
      const overlap = await p.eval<number>(`(() => {
        const a = document.querySelector('.fea-panel')?.getBoundingClientRect();
        const b = document.querySelector('.property-panel')?.getBoundingClientRect();
        if (!a || !b) return -1;
        return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      })()`);
      assert(overlap === 0, overlap < 0 ? 'FEA panel or property panel missing' : `FEA panel covers ${overlap} px² of the property panel`);
      await p.screenshot('04-hole-panel');
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      const removed = before - await volume(p);
      const faceted = 16 * Math.sin(Math.PI / 16) * 25 * 10; // 32-sided Ø10 × 10
      assert(Math.abs(removed - faceted) < 1, `removed ${removed} mm³, expected ${faceted}`);
      // Hole Wizard: an ISO M8 counterbore beside it, from the panel
      const before2 = await volume(p);
      await p.click('Hole', 400);
      const pick = (cls: string, value: string) => p.eval(`(() => {
        const sel = document.querySelector('.property-panel .${cls}');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await pick('hole-type', 'counterbore');
      await pick('hole-size', 'M8');
      await sleep(150);
      const info = await p.eval<string>(`document.querySelector('.hole-standard-info')?.textContent ?? ''`);
      await setField(p, 'Hole Depth', 10);
      await setField(p, 'Entry X', 15);
      await setField(p, 'Drill Direction', '+Z');
      await p.screenshot('04d-hole-wizard');
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(1200);
      const cb = before2 - await volume(p);
      const area = (r: number) => 16 * r * r * Math.sin(Math.PI / 16);
      const expected = area(4.5) * (10 - 8.6) + area(7.5) * 8.6;
      const names = await treeNames(p);
      assert(/Ø9 clearance \(normal\), counterbore Ø15 × 8\.6 deep/.test(info), `info: ${info}`);
      assert(Math.abs(cb - expected) < 1 && names.includes('M8 Counterbore'), `counterbore removed ${cb} mm³, expected ${expected}; tree ${names}`);
      return `removed ${removed.toFixed(0)} mm³; FEA panel clear of the property panel; M8 counterbore removed ${cb.toFixed(0)} mm³ ("${info}")`;
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
      // Study setup: the same face for fixture and load is refused
      const pick = (cls: string, value: string) => p.eval(`(() => {
        const sel = document.querySelector('.${cls}');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await pick('fea-load-face', 'zMin');
      await sleep(200);
      const problem = await p.eval<string>(`document.querySelector('.fea-setup-problem')?.textContent`);
      await p.click('Solve', 300);
      const refused = await status(p);
      assert(/different face/.test(problem ?? '') && /different face/.test(refused), `same-face setup: ${problem} / ${refused}`);
      await pick('fea-load-face', 'zMax');
      await p.eval(`window.casiworks.commands.execute('view.isometric')`);
      await sleep(500);
      await p.screenshot('04a-fea-setup');

      // Cancel stops a running solve
      await p.click('Solve', 50);
      await p.click('Cancel', 300);
      const cancelled = await status(p);
      assert(cancelled === 'FEA solve cancelled' && !(await p.eval<boolean>(`!!document.querySelector('.fea-solving')`)), `after cancel: ${cancelled}`);

      // The solve runs in a worker: the page answers immediately while it is solving
      await p.click('Solve', 30);
      let responsive = 0;
      while (await p.eval<boolean>(`!!document.querySelector('.fea-solving')`)) {
        const t = Date.now();
        await p.eval('1');
        responsive = Math.max(responsive, Date.now() - t);
        await sleep(50);
      }
      assert(responsive < 200, `page blocked for ${responsive} ms during the solve`);
      const fea = await waitFor(() => p.eval<string>(`document.querySelector('.fea-panel')?.innerText.match(/Max von Mises:[^\\n]*/)?.[0]`), 'FEA results', 30000);
      const meshReport = await p.eval<string>(`document.querySelector('.fea-mesh-report')?.textContent`);
      const coverage = Number(/(\d+)% of the part volume/.exec(meshReport ?? '')?.[1]);
      assert(coverage >= 95 && coverage <= 105, `mesh report: ${meshReport}`);
      const legend = () => p.eval<string>(`document.querySelector('.fea-legend')?.textContent`);
      const stressLegend = await legend();
      assert(/MPa.*MPa/.test(stressLegend), `stress legend: ${stressLegend}`);
      await p.eval(`(() => {
        const sel = document.querySelector('.fea-quantity');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'displacement');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('.fea-deformed').click();
      })()`);
      await sleep(600);
      const dispLegend = await legend();
      assert(/mm.*deformation ×[\d.]+.*mm/.test(dispLegend), `displacement legend: ${dispLegend}`);
      await p.eval(`window.casiworks.commands.execute('view.isometric')`);
      await sleep(500);
      // Probe the plot: click around the middle of the view until the click lands on the part
      const box = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`));
      for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.5], [0.55, 0.45], [0.5, 0.6], [0.4, 0.4], [0.6, 0.55]]) {
        await p.mouseClick(box.left + box.width * fx, box.top + box.height * fy);
        await sleep(250);
        if (await p.eval<number>(`document.querySelectorAll('.fea-probe-row').length`) > 0) break;
      }
      const probe = await p.eval<string>(`document.querySelector('.fea-probe-row')?.textContent ?? ''`);
      const probeLabel = await p.eval<string>(`document.querySelector('.fea-probe-label')?.textContent ?? ''`);
      assert(/^1[\d.]+ MPa[\d.e+-]+ mm$/.test(probe) && /MPa · .* mm/.test(probeLabel), `probe row "${probe}", label "${probeLabel}"`);
      await p.screenshot('04c-fea-probe');
      await p.eval(CAPTURE_DOWNLOADS);
      await p.click('Report', 600);
      const report = await p.eval<string>(`window.__blobs.at(-1).text()`);
      assert(/linear static study/.test(report) && /(PASS|FAIL): safety factor/.test(report) && /<img src="data:image\/png;base64,/.test(report) && /<h2>Probes<\/h2>/.test(report),
        `report: ${report.slice(0, 300)}`);
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
      return `${lines} drawing lines; ${fea} (page stayed responsive: ${responsive} ms max; cancel works; ${meshReport}); plot legend "${dispLegend}"; probe ${probe}; report ${(report.length / 1024).toFixed(0)} KB with plot image; marked out of date after a change, cleared by New`;
    },
  },
  {
    name: 'modal analysis lists natural frequencies and plots the chosen mode shape',
    async run(p) {
      const pick = (cls: string, value: string) => p.eval(`(() => {
        const sel = document.querySelector('.${cls}');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await pick('fea-analysis', 'modal');
      await pick('fea-mesh-quality', 'coarse');
      await sleep(200);
      const loadRowHidden = !(await p.eval<boolean>(`!!document.querySelector('.fea-load-face')`));
      await p.click('Solve', 300);
      const modes = await waitFor(async () => {
        const n = await p.eval<number>(`document.querySelectorAll('.fea-mode').length`);
        return n > 0 ? n : null;
      }, 'mode list', 60000);
      const first = await status(p);
      await p.eval(`document.querySelectorAll('.fea-mode')[1].click()`);
      await sleep(400);
      const active = await p.eval<string>(`document.querySelector('.fea-mode.active')?.textContent ?? ''`);
      const plotted = await p.eval<string>(`document.querySelector('.fea-mode-shape')?.textContent ?? ''`);
      await p.screenshot('04d-fea-modal');
      // The API gives the same first frequency (same mesh preset and element)
      const api = await p.eval<number>(`window.casiworks.model.naturalFrequencies({ modes: 1 }).frequencies[0]`);
      const shown = Number(/([\d.]+) Hz/.exec(first)?.[1]);
      assert(loadRowHidden && modes === 6 && /^Mode 2/.test(active) && /^Showing mode 2/.test(plotted) && /Modal: first natural frequency [\d.]+ Hz/.test(first)
        && Math.abs(api - shown) < 0.1, `hidden load ${loadRowHidden}, modes ${modes}, active "${active}", plot "${plotted}", status "${first}", api ${api}`);
      await pick('fea-analysis', 'static');
      await pick('fea-mesh-quality', 'medium');
      return `${modes} modes; ${first}; mode 2 shape plotted; API agrees (${api.toFixed(1)} Hz)`;
    },
  },
  {
    name: 'exploded view moves mated components apart and collapses',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Assembly');
      await p.click('Insert Base Mounting Plate', 400);
      await p.click('Insert Cylindrical Alignment Pin', 400);
      await p.click('Concentric Mate (Align cylindrical axes)', 400);
      await p.eval(`window.casiworks.commands.execute('view.isometric')`);
      await p.click('Configure Exploded View', 400);
      await p.eval(`(() => {
        const el = document.querySelector('.explode-distance');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '30');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(300);
      await p.eval(`document.querySelector('.action-btn-green').click()`);
      await sleep(600);
      const exploded = await status(p);
      const active = await p.eval<boolean>(`[...document.querySelectorAll('button')].find(b => b.title.startsWith('Exploded view is on'))?.classList.contains('active')`);
      assert(exploded === 'Exploded view: 30 mm step, with leader lines' && active, `after OK: "${exploded}", button active: ${active}`);
      await p.screenshot('08-exploded');
      await p.click('Exploded view is on: change it or collapse it', 400);
      await p.eval(`document.querySelector('.explode-collapse').click()`);
      await sleep(400);
      const collapsed = await status(p);
      assert(collapsed === 'Exploded view collapsed', `after Collapse: ${collapsed}`);
      // Later checks start from the L-bracket on the Features tab
      await p.eval(`window.casiworks.commands.execute('file.loadExample', { id: 'l_bracket' })`);
      await p.click('Features', 1500);
      return `${exploded}; then ${collapsed.toLowerCase()}`;
    },
  },
  {
    name: 'bill of materials: grouped rows, totals, CSV export and the assembly drawing',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Assembly');
      await p.click('Insert Base Mounting Plate', 300);
      await p.click('Insert Cylindrical Alignment Pin', 300);
      await p.click('Insert Cylindrical Alignment Pin', 300);
      await p.click('Bill of Materials: parts, quantities and masses, with CSV export', 400);
      const rows = await p.eval<string[][]>(`[...document.querySelectorAll('.bom-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()))`);
      const total = await p.eval<string>(`document.querySelector('.bom-total').textContent`);
      assert(rows.length === 2 && rows[0][1] === 'Base_Plate' && rows[1][1] === 'Pin_Shaft' && rows[1][3] === '2', `rows ${JSON.stringify(rows)}`);
      assert(rows[0][5] === '237.00', `plate mass ${rows[0][5]} g (50 × 12 × 50 mm of steel = 237.00 g)`);
      // Brass pins: the row's material picker sets both pins
      await p.eval(`(() => {
        const sel = document.querySelectorAll('.bom-material')[1];
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'Brass_C36000');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(300);
      const brass = await p.eval<string[]>(`[...document.querySelectorAll('.bom-table tbody tr')][1].querySelectorAll('td')[5].textContent`);
      const picked = await p.eval<string>(`document.querySelectorAll('.bom-material')[1].value`);
      assert(picked === 'Brass_C36000' && String(brass) === '38.45', `brass pin: ${picked}, ${brass} g (Ø12 × 40 mm × 8500 kg/m³ = 38.45 g)`);
      await p.screenshot('08b-bom');
      await p.eval(CAPTURE_DOWNLOADS);
      await p.click('Export CSV', 400);
      const csv = await p.eval<string>(`window.__blobs.at(-1).text()`);
      assert(csv.startsWith('Item,Part number,Description,Qty') && csv.includes('2,Pin_Shaft,Pin Ø12 × 40 mm,2,Brass C36000,38.45,76.91'), `CSV: ${csv.slice(0, 300)}`);
      await p.click('Close', 300);
      // The assembly drawing: parts list and a balloon per item
      await p.click('Drawing');
      await p.eval(`(() => {
        const sel = document.querySelector('.drawing-subject');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'assembly');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(200);
      await p.click('Open Sheet');
      await waitFor(() => p.eval<number>(`document.querySelectorAll('.drawing-sheet-view line.visible-line').length`), 'assembly sheet');
      const sheet = await p.eval<{ rows: number; balloons: string[]; title: string }>(`({
        rows: document.querySelectorAll('.drawing-sheet-view #bom-table .bom-cell').length / 5,
        balloons: [...document.querySelectorAll('.drawing-sheet-view .balloon-text')].map(t => t.textContent),
        title: [...document.querySelectorAll('.drawing-sheet-view .tb-text-title')].map(t => t.textContent).join(),
      })`);
      assert(sheet.rows === 2 && sheet.balloons.join() === '1,2' && sheet.title === 'UNTITLED PART ASSEMBLY', `assembly sheet ${JSON.stringify(sheet)}`);
      await p.screenshot('08c-assembly-drawing');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(300);
      await p.eval(`window.casiworks.commands.execute('drawing.options', { subject: 'part' })`);
      await p.eval(`window.casiworks.commands.execute('file.loadExample', { id: 'l_bracket' })`);
      await p.click('Features', 1500);
      return `${rows.map(r => `${r[3]} × ${r[1]}`).join(', ')}; ${total.replace(/\s+/g, ' ')}; CSV ${csv.split('\r\n').length - 1} lines; assembly sheet: ${sheet.rows} rows, balloons ${sheet.balloons}`;
    },
  },
  {
    name: 'interference detection: none side by side, the pin through the plate once mated',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Assembly');
      await p.click('Insert Base Mounting Plate', 300);
      await p.click('Insert Cylindrical Alignment Pin', 300);
      await p.click('Interference detection: find components that overlap', 500);
      const none = await p.eval<string>(`document.querySelector('.interference-none')?.textContent ?? ''`);
      await p.click('Concentric Mate (Align cylindrical axes)', 300);
      await p.click('Re-solve all assembly mates numerically', 500);
      const stale = await p.eval<boolean>(`!!document.querySelector('.interference-panel')?.textContent.includes('The assembly changed')`);
      await p.click('Check again', 600);
      const rows = await p.eval<string[]>(`[...document.querySelectorAll('.interference-row')].map(r => r.textContent)`);
      await p.eval(`window.casiworks.commands.execute('view.isometric')`);
      await sleep(500);
      await p.screenshot('08d-interference');
      const pinArea = 16 * 36 * Math.sin(Math.PI / 16);
      const volume = Number((rows[0] ?? '').match(/([\d.]+) mm³/)?.[1]);
      assert(none === 'No components overlap.' && stale, `before: "${none}", stale after the mate: ${stale}`);
      assert(rows.length === 1 && rows[0].startsWith('Base_Plate ↔ Pin_Shaft') && Math.abs(volume - pinArea * 12) < 1, `rows ${rows}`);
      await p.click('Close', 200).catch(() => {});
      await p.eval(`window.casiworks.commands.execute('assembly.clearInterference')`);
      await p.eval(`window.casiworks.commands.execute('file.loadExample', { id: 'l_bracket' })`);
      await p.click('Features', 1500);
      return `side by side: none; mated: ${rows[0]} (32-gon pin × 12 mm plate = ${(pinArea * 12).toFixed(1)} mm³)`;
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
    name: 'Drawing tab: switches the sheet options, opens the sheet, exports DXF and PDF',
    async run(p) {
      const tabs = await p.eval<string[]>(`[...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t === 'Surfaces' || t === 'Sheet Metal')`);
      assert(tabs.length === 0, `placeholder tabs still shown: ${tabs}`);
      await p.click('Drawing');
      await p.click('Dimensions');
      const off = await p.eval<boolean>(`!document.querySelector('.drawing-dimensions').classList.contains('active')`);
      assert(off, 'Dimensions button still active');
      await p.click('Open Sheet');
      await waitFor(() => p.eval<number>(`document.querySelectorAll('.drawing-sheet-view line.visible-line').length`), 'drawing sheet');
      const sheet = await p.eval<{ dims: boolean; gdt: boolean; label: string }>(`({
        dims: !!document.querySelector('.drawing-sheet-view #dimensions'),
        gdt: !!document.querySelector('.drawing-sheet-view #gdt'),
        label: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).find(t => t.startsWith('Dimensions:')),
      })`);
      assert(!sheet.dims && sheet.gdt && sheet.label === 'Dimensions: OFF', `sheet ${JSON.stringify(sheet)}`);
      await p.screenshot('09-drawing-tab');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(300);
      await p.eval(CAPTURE_DOWNLOADS);
      await p.click('DXF', 600);
      const dxf = await p.eval<string>(`window.__blobs.at(-1).text()`);
      const exported = await status(p);
      assert(dxf.startsWith('0\nSECTION') && /^Drawing exported: .+_drawing\.dxf$/.test(exported), `DXF export: "${exported}"`);
      await p.click('PDF', 600);
      const pdf = await p.eval<{ head: string; size: number; type: string; tail: string }>(`window.__blobs.at(-1).arrayBuffer().then(b => {
        const u = new Uint8Array(b);
        const str = (x) => String.fromCharCode(...x);
        return { head: str(u.slice(0, 8)), size: u.length, type: window.__blobs.at(-1).type, tail: str(u.slice(-6)) };
      })`);
      assert(pdf.head === '%PDF-1.4' && pdf.tail === '%%EOF\n' && pdf.type === 'application/pdf' && pdf.size > 2000, `PDF export: ${JSON.stringify(pdf)}`);
      await p.click('Dimensions');
      await p.click('Features', 300);
      return `dimensions switched off on the sheet, GD&T kept; ${exported}; PDF ${pdf.size} bytes`;
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
  {
    name: 'API reference is served and opened from Tools',
    async run(p) {
      const page = await p.eval<string>(`fetch('/api/').then(r => r.ok ? r.text() : 'HTTP ' + r.status)`);
      const title = /<title>([^<]+)<\/title>/.exec(page)?.[1];
      const version = await p.eval<string>('window.casiworks.version');
      assert(title === `CasiWorks API ${version}`, `title: ${title ?? page.slice(0, 80)}`);
      await p.eval(`window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }`);
      await p.click('Tools');
      await p.click('API reference (opens in a new tab)');
      const opened = await p.eval<string[]>('window.__opened');
      assert(opened.length === 1 && opened[0].endsWith('/api/'), `opened ${opened}`);
      return `${title}; button opens ${opened[0]}`;
    },
  },
  {
    name: 'add-ins: load the example, use its ribbon button, unload it',
    async run(p) {
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await p.click('Add-ins');
      await p.click('Load, list and unload add-ins');
      await p.click('Example: washer generator', 200);
      await p.click('Load', 1500);
      const message = await p.eval<string>(`document.querySelector('.addins-message')?.textContent`);
      assert(/Loaded Washer generator 1\.0\.0/.test(message), `message: ${message}`);
      await p.click('Close');
      await p.click('ISO 7089 washer M8 (Ø16 × 1.6)', 1200);
      const names = await treeNames(p);
      assert(names.includes('Washer M8'), `tree: ${names}`);
      const v = await volume(p);
      const exact = Math.PI * (64 - 4.2 ** 2) * 1.6;
      assert(Math.abs(v - exact) / exact < 0.01, `volume ${v}`);
      await p.screenshot('07-addins');
      await p.click('Load, list and unload add-ins');
      await p.click('Unload Washer generator', 300);
      await p.click('Close');
      const left = await p.eval<number>(`document.querySelectorAll('.addin-btn').length`);
      assert(left === 0, `${left} add-in buttons left after unload`);
      return `washer M8 built (${v.toFixed(0)} mm³); unloaded cleanly`;
    },
  },
  {
    name: 'autosave: a reload brings the document back; an empty New stays empty',
    async run(p) {
      const reload = async () => {
        await sleep(1500); // past the autosave delay
        await p.send('Page.reload');
        await sleep(500);
        await waitFor(() => p.eval<boolean>(`!!window.casiworks && document.querySelector('.status-msg-text') !== null`), 'app restart');
        await sleep(1500); // rebuild
      };
      await p.eval(`window.casiworks.commands.execute('file.loadExample', { id: 'l_bracket' })`);
      await sleep(1500);
      const before = { names: await treeNames(p), volume: await volume(p) };
      await reload();
      const after = { names: await treeNames(p), volume: await volume(p) };
      const restored = await status(p);
      assert(/^Restored Mounting_L_Bracket from autosave/.test(restored), `status after reload: "${restored}"`);
      assert(after.names.join() === before.names.join() && Math.abs(after.volume - before.volume) < 1e-6,
        `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
      await p.eval(`window.casiworks.commands.execute('document.new')`);
      await reload();
      const left = await p.eval<number>(`document.querySelectorAll('.feature-item').length`);
      assert(left === 0, `New, then reload: ${left} features (the starter part must not come back)`);
      return `${after.names.length} features and ${after.volume.toFixed(0)} mm³ back after reload; "${restored}"; empty New stays empty`;
    },
  },
];

// ------------------------------------------------------------------ runner
async function main(): Promise<number> {
  const chrome = findChrome();
  if (!chrome) {
    console.log('e2e: no Chrome found (set CHROME_PATH); skipped');
    return 0;
  }
  if (!existsSync('dist/index.html')) {
    console.error('e2e: run `npm run build` first');
    return 1;
  }
  return withApp({ chrome, profile: 'e2e', shots: { dir: OUT, format: 'png' } }, async ({ page }) => {
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
    return failed ? 1 : 0;
  });
}

process.exitCode = await main();
