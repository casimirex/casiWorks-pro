// CasiWorks Pro - Screenshots for the tutorial e-book (docs/tutorial/)
//
//   npm run build && node scripts/tutorial-shots.ts [shot-name-filter]
//
// Serves dist/ with `vite preview`, drives headless Chrome over the DevTools
// protocol through the same flows the tutorial teaches, and writes one WebP per
// step to docs/tutorial/img/. A failing step is reported and the rest go on.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, sleep, waitFor, withApp } from './browser.ts';
import type { Page } from './browser.ts';
import { assemblyFlow, closeAssemblyFlow } from './assemblyFlow.ts';

const OUT = 'docs/tutorial/img';
const FILTER = process.argv[2];

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
/** Load an example into a new document (so nothing from earlier shots, such as assembly components, is left). */
const example = async (p: Page, id: string) => { await run(p, 'document.new', undefined, 300); await run(p, 'file.loadExample', { id }, 2000); };

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
  {
    name: '10g-sketch-dimensions', async run(p) {
      await fresh(p);
      await feaPanel(p, false);
      await p.click('Sketch');
      await p.click('Sketch on the Front plane', 800);
      await p.click('Snap', 100);
      const r = await canvasRect(p);
      await p.click('Corner Rectangle (R)');
      await p.mouseClick(r.left + r.width * 0.35, r.top + r.height * 0.35);
      await p.mouseClick(r.left + r.width * 0.6, r.top + r.height * 0.65);
      await p.click('Center Circle (C)');
      await p.mouseClick(r.left + r.width * 0.47, r.top + r.height * 0.5);
      await p.mouseClick(r.left + r.width * 0.5, r.top + r.height * 0.5);
      await sleep(300);
      const ents = await p.eval<Array<{ id: string; type: string; p1?: { y: number } }>>(`window.casiworks.commands.execute('sketch.entities').entities`);
      const lines = ents.filter(e => e.type === 'line');
      const bottom = lines.reduce((a, b) => (b.p1!.y < a.p1!.y ? b : a));
      const circle = ents.find(e => e.type === 'circle')!;
      await run(p, 'equations.set', { variables: [{ name: 'plate', expression: '80' }] }, 100);
      await run(p, 'sketch.dimensionPicks', { picks: [{ id: bottom.id }], value: 'plate' }, 300);
      await run(p, 'sketch.dimensionPicks', { picks: [{ id: lines[1].id }], value: 50 }, 300);
      await run(p, 'sketch.dimensionPicks', { picks: [{ id: circle.id }], value: 20 }, 300);
      await p.click('Snap', 100);
      await sleep(400);
      await p.screenshot('10g-sketch-dimensions');
      await p.click('Discard Sketch Changes', 400);
      await p.click('Features');
    },
  },
  {
    name: '10e-sketch-on-face', async run(p) {
      await fresh(p);
      await feaPanel(p, false);
      await p.eval(`(() => {
        const s = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
        window.casiworks.features.extrude({ sketchId: s.sketchId, depth: 15, name: 'Block' });
      })()`);
      await sleep(800);
      await run(p, 'view.front');
      const r = await canvasRect(p);
      await p.click('Sketch');
      await p.click('Sketch on a face: click a flat face of the part', 200);
      await p.mouseClick(r.left + r.width * 0.5, r.top + r.height * 0.5);
      await sleep(600);
      await p.click('Snap', 100);
      await p.click('Center Circle (C)');
      await p.mouseClick(r.left + r.width * 0.5, r.top + r.height * 0.5);
      await p.mouseClick(r.left + r.width * 0.54, r.top + r.height * 0.5);
      await p.click('Snap', 100);
      await p.click('Confirm & Exit Sketch', 800);
      await p.click('Features');
      await p.click('Extruded Boss/Base', 500);
      await setField(p, 'Extrude Depth', 10);
      await apply(p);
      await run(p, 'feature.create', { type: 'reference_plane', name: 'Plane1', base: 'Top', offset: 40, angle: 20 }, 800);
      await iso(p);
      await p.screenshot('10e-sketch-on-face');
      await p.click('Reference Plane: offset and tilt a standard plane, then sketch on it', 500);
      await setField(p, 'Offset', 40);
      await setField(p, 'Tilt (about its X)', 20);
      await sleep(300);
      await p.screenshot('10f-reference-plane');
      await p.eval(`document.querySelector('.action-btn-red')?.click()`);
      await sleep(300);
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
      // Hole Wizard: an ISO M8 counterbore for a socket head cap screw
      await p.click('Hole Wizard', 500);
      await pick(p, '.property-panel .hole-type', 'counterbore');
      await pick(p, '.property-panel .hole-size', 'M8');
      await setField(p, 'Hole Depth', 20);
      await setField(p, 'Entry X', 25);
      await sleep(400);
      await p.screenshot('12b-hole-wizard');
      await apply(p);
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
      // A ring revolved about a centreline beside the profile, and a reference axis
      await fresh(p);
      await feaPanel(p, false);
      await p.eval(`(() => {
        const s = window.casiworks.sketches.create({ name: 'Ring profile', entities: [
          { type: 'rectangle', corner1: { x: 15, y: 0 }, corner2: { x: 25, y: 12 } },
          { type: 'line', p1: { x: 0, y: -10 }, p2: { x: 0, y: 25 }, construction: true },
        ] });
        const id = window.casiworks.sketches.getEntities(s.sketchId).find(e => e.construction).id;
        window.casiworks.features.revolve({ sketchId: s.sketchId, axis: { line: id }, angle: 270, name: 'Ring' });
        window.casiworks.features.referenceAxis({ direction: 'Y', point: { x: 45, y: 0, z: 0 } });
      })()`);
      await sleep(1200);
      await iso(p);
      await p.click('Features');
      await p.eval(`[...document.querySelectorAll('.feature-item')].find(e => e.querySelector('.tree-node-label')?.firstChild?.textContent.trim() === 'Ring').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await sleep(700);
      await p.screenshot('17b-revolve-axis');
      await p.eval(`document.querySelector('.action-btn-red')?.click()`);
      await sleep(300);
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
    name: '19b-equations', async run(p) {
      await fresh(p);
      await feaPanel(p, false);
      await run(p, 'equations.set', { variables: [{ name: 'wall', expression: '4' }, { name: 'plate', expression: 'wall * 3' }] });
      const { sketchId } = await p.eval<{ sketchId: string }>(`window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] })`);
      await run(p, 'feature.create', { type: 'extrude_boss', sketchId, depth: 12, name: 'Plate', expressions: { depth: 'plate' } }, 1200);
      await iso(p);
      await p.eval(`[...document.querySelectorAll('.feature-item')].find(e => e.textContent.includes('Plate')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await sleep(700);
      await p.screenshot('19b-linked-field');
      await p.eval(`document.querySelector('.action-btn-red')?.click()`);
      await sleep(300);
      await run(p, 'tools.equations', undefined, 500);
      await p.screenshot('19c-equations');
      await p.click('Close', 300);
      await run(p, 'configurations.set', { configurations: [{ name: 'Light', values: { wall: '2' } }, { name: 'Heavy', values: { wall: '8' } }] });
      await run(p, 'configurations.activate', { name: 'Heavy' }, 1200);
      await p.click('Tools');
      await run(p, 'tools.configurations', undefined, 500);
      await p.screenshot('19d-configurations');
      await p.click('Close', 300);
      await run(p, 'configurations.activate', { name: 'Default' }, 800);
      await p.click('Features');
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
  {
    name: '21b-measure', async run(p) {
      await fresh(p);
      await feaPanel(p, false);
      await p.eval(`(() => {
        const s = window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }] });
        window.casiworks.features.extrude({ sketchId: s.sketchId, depth: 12, name: 'Plate' });
      })()`);
      await sleep(1000);
      const r = await canvasRect(p);
      await p.click('Evaluate');
      await run(p, 'evaluate.measure', undefined, 200);
      await run(p, 'view.front');
      await p.mouseClick(r.left + r.width * 0.5, r.top + r.height * 0.5);
      await run(p, 'view.back');
      await p.mouseClick(r.left + r.width * 0.5, r.top + r.height * 0.5);
      await sleep(300);
      await iso(p);
      await p.screenshot('21b-measure');
      await run(p, 'edit.cancel', undefined, 200);
      await p.click('Features');
    },
  },
  {
    name: '22b-coordinate-system', async run(p) {
      await example(p, 'l_bracket');
      await feaPanel(p, false);
      await p.eval(`(() => {
        const c = window.casiworks.model.massProperties().centerOfMass;
        window.casiworks.features.coordinateSystem({ origin: c, rotation: { z: 90 } });
      })()`);
      await sleep(800);
      await iso(p);
      await run(p, 'evaluate.massProperties', undefined, 500);
      await p.eval(`(() => {
        const sel = document.querySelector('.mass-props-cs');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, sel.options[1].value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(400);
      await p.screenshot('22b-coordinate-system');
      await closeDialog(p);
    },
  },
  // ------------------------------------------------------------ Part 3: advanced
  {
    name: '22-assembly', async run(p) {
      await run(p, 'workspace.newAssembly', undefined, 600);
      await p.click('Assembly');
      await p.click('Insert Base Mounting Plate', 600);
      await p.click('Insert Cylindrical Alignment Pin', 600);
      await iso(p);
      await p.screenshot('22-assembly-insert');
      await p.click('Concentric Mate (Align cylindrical axes)', 600);
      await p.screenshot('23-assembly-mate');
      await p.click('Re-solve all assembly mates numerically', 800);
      await p.screenshot('24-assembly-solved');
      await run(p, 'assembly.interference', undefined, 600);
      await p.screenshot('24b-interference');
      await run(p, 'assembly.clearInterference', undefined, 200);
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
    name: '26d-drawing-dimensions', async run(p) {
      await example(p, 'l_bracket');
      await run(p, 'drawing.open');
      await waitFor(() => p.eval<number>(`document.querySelectorAll('.drawing-sheet-view #FRONT_VIEW circle.visible-line').length`), 'holes on the sheet');
      await p.click('Dimension', 300);
      // Click the rim of each hole in the front view: one diameter each
      const rims = JSON.parse(await p.eval<string>(`JSON.stringify([...document.querySelectorAll('.drawing-sheet-view #FRONT_VIEW circle.visible-line')].slice(0, 2).map(c => {
        const pt = new DOMPoint(+c.getAttribute('cx') + +c.getAttribute('r'), +c.getAttribute('cy')).matrixTransform(c.ownerSVGElement.getScreenCTM());
        return { x: pt.x, y: pt.y };
      }))`)) as Array<{ x: number; y: number }>;
      for (const r of rims) { await p.mouseClick(r.x, r.y); await sleep(400); }
      await waitFor(() => p.eval<number>(`document.querySelectorAll('.drawing-dimension').length`), 'placed dimensions');
      await sleep(300);
      await p.screenshot('26d-drawing-dimensions');
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(200);
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(300);
      await p.eval(`window.casiworks.commands.execute('drawing.dimensions').forEach(d => window.casiworks.commands.execute('drawing.removeDimension', { id: d.id }))`);
    },
  },
  {
    name: '26e-title-block', async run(p) {
      await example(p, 'l_bracket');
      await run(p, 'drawing.titleBlock', { company: 'Acme Engineering', partNumber: 'BRK-1001', drawnBy: 'A. Kumar', checkedBy: 'R. Iyer' }, 200);
      await run(p, 'drawing.open');
      await waitFor(() => p.eval<number>(`document.querySelectorAll('svg line.visible-line').length`), 'drawing sheet');
      await p.click('Title block', 400);
      await p.screenshot('26e-title-block');
      await p.click('Title block', 200);
      await p.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(300);
      await run(p, 'drawing.titleBlock', { company: '', partNumber: '', drawnBy: '', checkedBy: '' }, 200);
    },
  },
  {
    name: '44-units', async run(p) {
      await fresh(p);
      await feaPanel(p, false);
      await pick(p, '.doc-units-select', 'IPS');
      await sleep(200);
      await p.eval(`window.casiworks.sketches.create({ entities: [{ type: 'rectangle', corner1: { x: -25.4, y: -12.7 }, corner2: { x: 25.4, y: 12.7 } }] })`);
      await sleep(400);
      await p.click('Features', 300);
      await p.click('Extruded Boss/Base', 500);
      await setField(p, 'Extrude Depth', '0.5');
      await sleep(400);
      await iso(p);
      await p.screenshot('44-units');
      await apply(p);
      await run(p, 'evaluate.massProperties', undefined, 700);
      await p.screenshot('44b-units-mass');
      await closeDialog(p);
      await pick(p, '.doc-units-select', 'MMGS');
      await sleep(200);
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
      // Probes: click around the middle until a click lands on the plot, then one more
      const box = await canvasRect(p);
      for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.5], [0.55, 0.45], [0.5, 0.6], [0.4, 0.4], [0.6, 0.55], [0.35, 0.6], [0.3, 0.55]]) {
        await p.mouseClick(box.left + box.width * fx, box.top + box.height * fy);
        await sleep(250);
        if (await p.eval<number>(`document.querySelectorAll('.fea-probe-row').length`) >= 2) break;
      }
      await sleep(400);
      await p.screenshot('30b-fea-probes');
      await p.eval(`document.querySelector('.fea-clear-probes')?.click()`);
      // Modal: natural frequencies, the second mode's shape
      await pick(p, '.fea-analysis', 'modal');
      await pick(p, '.fea-mesh-quality', 'coarse');
      await sleep(300);
      await p.eval(`[...document.querySelectorAll('.fea-panel button')].find(b => b.textContent.trim() === 'Solve').click()`);
      await waitFor(() => p.eval<number>(`document.querySelectorAll('.fea-mode').length || null`), 'modes', 60000);
      await p.eval(`document.querySelectorAll('.fea-mode')[1].click()`);
      await sleep(800);
      await p.screenshot('30c-fea-modal');
      await pick(p, '.fea-analysis', 'static');
      await pick(p, '.fea-mesh-quality', 'medium');
      await feaPanel(p, false);
    },
  },
  {
    name: '30d-fea-faces', async run(p) {
      // Held by its two bolt holes, pushed sideways at the top of the upright
      await example(p, 'l_bracket'); await iso(p);
      await feaPanel(p, true);
      await run(p, 'simulation.study', { fixed: [{ x: 20, y: 0, z: 6 }, { x: -5, y: 0, z: 6 }], load: [{ x: -29, y: 0, z: 55 }], direction: '+X' }, 600);
      await p.screenshot('30d-fea-faces');
      await p.eval(`[...document.querySelectorAll('.fea-panel button')].find(b => b.textContent.trim() === 'Solve').click()`);
      await waitFor(() => p.eval<string>(`document.querySelector('.fea-panel')?.innerText.match(/Max von Mises:[^\\n]*/)?.[0]`), 'FEA results', 60000);
      await sleep(800);
      console.log('    ' + (await p.eval<string>(`document.querySelector('.fea-results')?.innerText.replace(/\\n+/g, ' | ').slice(0, 300) ?? ''`)));
      await p.screenshot('30e-fea-faces-stress');
      await run(p, 'simulation.study', { fixed: 'zMin', load: 'zMax', direction: '-Y' }, 300);
      await feaPanel(p, false);
    },
  },
  // -------------------------------------------------------- Part 4: professional
  {
    name: '36-library', async run(p) {
      // The local library server on this build, with an empty data folder
      const previewUrl = await p.eval<string>(`location.href`);
      const data = mkdtempSync(join(tmpdir(), 'casiworks-shots-library-'));
      const port = 5800 + Math.floor(Math.random() * 100);
      const server = spawn(process.execPath, ['server/main.ts', '--port', String(port), '--data', data], { stdio: 'ignore' });
      try {
        await waitFor(() => fetch(`http://127.0.0.1:${port}/api/v1/health`).then(r => r.ok), 'library server');
        await p.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
        await waitFor(() => p.eval<boolean>(`!!window.casiworks && document.querySelectorAll('.feature-item').length > 0`), 'app');
        await example(p, 'l_bracket');
        await feaPanel(p, false);
        await p.eval(`window.casiworks.commands.execute('library.save', { message: 'First cut for the motor mount' })`);
        await sleep(600);
        await p.eval(`(() => { const f = window.casiworks.features.list().find(f => f.type === 'extrude_boss'); window.casiworks.features.update(f.id, { depth: 30 }); })()`);
        await sleep(800);
        await p.eval(`window.casiworks.commands.execute('library.save', { message: 'Base 30 mm deep for the M8 bolts' })`);
        await sleep(600);
        await run(p, 'library.open', undefined, 800);
        await p.eval(`[...document.querySelectorAll('.library-version')].find(b => b.textContent.includes('Version 1')).click()`);
        await sleep(200);
        await p.eval(`document.querySelector('.library-release').click()`);
        await waitFor(() => p.eval<boolean>(`!!document.querySelector('.library-revision')`), 'Rev A');
        await sleep(300);
        await p.screenshot('36-library');
        // Review and release version 2 (the same run makes the lifecycle shot)
        const note = (text: string) => p.eval(`(() => { const el = document.querySelector('.library-note');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        const press = async (cls: string) => {
          await waitFor(() => p.eval<boolean>(`!!document.querySelector('${cls}:not(:disabled)')`), cls);
          await p.eval(`document.querySelector('${cls}').click()`);
        };
        await note('Check the bolt holes clear M8');
        await press('.library-move-in_review');
        await waitFor(() => p.eval<boolean>(`document.querySelector('.library-lifecycle .library-state')?.textContent === 'In review' || null`), 'in review');
        await note('Holes OK, approved');
        await press('.library-move-released');
        await waitFor(() => p.eval<boolean>(`document.querySelector('.library-lifecycle .library-state')?.textContent === 'Released' || null`), 'released');
        await p.eval(`document.querySelector('.library-history').open = true`);
        await sleep(300);
        await p.screenshot('37-library-lifecycle');
        await closeDialog(p);
      } finally {
        server.kill();
        await new Promise(r => server.once('exit', r));
        rmSync(data, { recursive: true, force: true });
        await p.send('Page.navigate', { url: previewUrl });
        await waitFor(() => p.eval<boolean>(`!!window.casiworks && document.querySelectorAll('.feature-item').length > 0`), 'back to the preview');
      }
    },
  },
  {
    name: '38-assembly-of-parts', async run(p) {
      await fresh(p);
      await assemblyFlow(p, (name) => p.screenshot(name));
      await closeAssemblyFlow(p);
    },
  },
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
  const chrome = findChrome();
  if (!chrome) { console.error('No Chrome found (set CHROME_PATH)'); return 1; }
  if (!existsSync('dist/index.html')) { console.error('Run `npm run build` first'); return 1; }
  return withApp({ chrome, profile: 'shots', shots: { dir: OUT, format: 'webp' }, acceptDialogs: true }, async ({ page, appUrl }) => {
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
      await page.send('Page.navigate', { url: `${appUrl}api/` });
      await sleep(1500);
      await page.screenshot('35-api-reference');
      console.log('  ✓ api-reference');
    }
    console.log(`${failed ? 'FAILED' : 'OK'}: ${failed} failure(s); screenshots in ${OUT}/`);
    return failed ? 1 : 0;
  });
}

process.exitCode = await main();
