// CasiWorks Pro - The assembly-of-parts scenario, shared by the browser checks (e2e) and the tutorial screenshots
//
// Two part documents (a plate with a Ø10 hole, a Ø10 pin), an assembly that
// references both, mates made by clicking real faces, the plate edited and the
// assembly following it, an angle mate driven (motion) and an explode step.
import { sleep, waitFor } from './browser.ts';
import type { Page } from './browser.ts';

export interface AssemblyFlowResult {
  tabs: string[];
  inserted: string[];
  mates: string[];
  pinAt: { x: number; y: number; z: number };
  dof: { status: string; pin: string; motions: string[] };
  plateDepthAfterEdit: number;
  pinZAfterEdit: number;
  motionAngle: number;
  explodeSteps: number;
  treeTags: string[];
}

type Vec = { x: number; y: number; z: number };

const project = (p: Page, v: Vec) => p.eval<{ x: number; y: number; visible: boolean }>(`window.__casiworksView.project(${JSON.stringify(v)})`);

/** Click a model point (it must be on a visible face). */
async function clickAt(p: Page, v: Vec, wait = 400) {
  const s = await project(p, v);
  await p.mouseClick(s.x, s.y);
  await sleep(wait);
}

/** Zoom the view out (or in) with the mouse wheel over the canvas centre. */
async function wheel(p: Page, clicks: number) {
  const r = JSON.parse(await p.eval<string>(`JSON.stringify(document.querySelector('canvas').getBoundingClientRect())`)) as DOMRect;
  for (let i = 0; i < Math.abs(clicks); i++) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.left + r.width / 2, y: r.top + r.height / 2, deltaX: 0, deltaY: clicks > 0 ? 120 : -120 });
    await sleep(50);
  }
  await sleep(400);
}

export async function assemblyFlow(p: Page, shot: (name: string) => Promise<void>): Promise<AssemblyFlowResult> {
  const api = (js: string) => p.eval<unknown>(`(() => { const api = window.casiworks; ${js} })()`);
  // Two parts, each its own document
  await api(`
    api.workspace.newPart('Plate');
    const s = api.sketches.create({ plane: 'Front', entities: [
      { type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } },
      { type: 'circle', center: { x: 10, y: 0 }, radius: 5 } ] });
    api.features.extrude({ sketchId: s.sketchId, depth: 10, name: 'Plate' });
    api.materials.setActive('Aluminum_6061');
    api.workspace.newPart('Pin');
    const t = api.sketches.create({ plane: 'Front', entities: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 5 }] });
    api.features.extrude({ sketchId: t.sketchId, depth: 30, name: 'Pin' });
    api.materials.setActive('Steel_4140');
    api.workspace.newAssembly('Fixture');`);
  await sleep(800);
  await p.eval(`document.querySelector('.fea-panel button[title="Minimize"]')?.click()`);

  // Insert both parts from the dialog
  for (const name of ['Plate', 'Pin']) {
    await p.click('Part…', 500);
    await waitFor(() => p.eval<boolean>(`!!document.querySelector('.insert-part-dialog')`), 'insert dialog');
    if (name === 'Plate') await shot('38-insert-part');
    await p.click(`Insert ${name}`, 800);
  }
  await p.eval(`window.casiworks.commands.execute('view.isometric')`);
  await sleep(700);
  await shot('39-assembly-parts');
  const inserted = await p.eval<string[]>(`window.casiworks.assembly.list().map(c => c.name + ':' + c.part.linked)`);
  const [plateId, pinId] = await p.eval<string[]>(`window.casiworks.assembly.list().map(c => c.id)`);
  const pinPos = await p.eval<Vec>(`window.casiworks.assembly.list()[1].position`);
  const cam = await p.eval<Vec>(`window.__casiworksView.camera()`);
  // Towards the camera, across the Z axis (to find the side of a cylinder that faces it)
  const len = Math.hypot(cam.x - 10, cam.y);
  const toCam = { x: (cam.x - 10) / len, y: cam.y / len };

  // Mate 1: the pin's side and the hole's wall (the far wall, which faces the camera): concentric
  await p.click('Mate', 300);
  await clickAt(p, { x: pinPos.x + 5 * toCam.x, y: pinPos.y + 5 * toCam.y, z: 20 });
  await clickAt(p, { x: 10 - 4.9 * toCam.x, y: -4.9 * toCam.y, z: 9.5 }, 600);
  await waitFor(() => p.eval<boolean>(`document.querySelectorAll('.mate-pick').length === 2 || null`), 'two faces picked');
  await shot('40-mate-faces');
  const firstType = await p.eval<string>(`document.querySelector('input[name="mate-type"]:checked')?.value ?? ''`);
  await p.click('Add mate', 600);

  // Mate 2: the pin's top face on the plate's front face: coincident
  const pinNow = await p.eval<Vec>(`window.casiworks.assembly.list()[1].position`);
  await clickAt(p, { x: pinNow.x + 2, y: pinNow.y + 1, z: pinNow.z + 30 });
  await clickAt(p, { x: -20, y: 10, z: 10 }, 600);
  await waitFor(() => p.eval<boolean>(`document.querySelectorAll('.mate-pick').length === 2 || null`), 'two flat faces picked');
  await p.click('Add mate', 600);
  await p.key('Escape');
  await sleep(300);

  const mates = await p.eval<string[]>(`window.casiworks.assembly.mates().map(m => m.type)`);
  const pinAt = await p.eval<Vec>(`window.casiworks.assembly.list()[1].position`);
  const dofInfo = await p.eval<{ status: string; components: Array<{ status: string; motions: string[] }> }>(`window.casiworks.assembly.dof()`);
  const treeTags = await p.eval<string[]>(`[...document.querySelectorAll('.assembly-component')].map(b => b.textContent.trim())`);
  await shot('41-assembly-dof');

  // Edit the plate (its own tab): the assembly follows, and the pin stays on the face
  await p.eval(`(() => { const api = window.casiworks; const plate = api.workspace.list().find(d => d.name === 'Plate'); api.workspace.activate(plate.id);
    const f = api.features.list().find(f => f.type === 'extrude_boss'); api.features.update(f.id, { depth: 16 }); })()`);
  await sleep(800);
  await p.eval(`document.querySelector('.document-tab [title^="Fixture"]').click()`);
  await sleep(1200);
  const plateBox = await p.eval<number>(`window.casiworks.assembly.list()[0].position.z`);
  void plateBox;
  const after = await p.eval<{ depth: number; pinZ: number }>(`(() => {
    const api = window.casiworks;
    const plateTop = api.assembly.faceAt(${JSON.stringify(plateId)}, { x: -20, y: 10, z: 30 });
    return { depth: plateTop.point.z, pinZ: api.assembly.list()[1].position.z };
  })()`);

  // Motion: an angle mate about the pin's axis, played from the Motion panel
  await p.eval(`window.casiworks.assembly.mate({ type: 'angle', component1: ${JSON.stringify(plateId)}, ref1: 'right', component2: ${JSON.stringify(pinId)}, ref2: 'right', angle: 0, axis: { x: 0, y: 0, z: 1 } })`);
  await sleep(300);
  await p.click('Motion', 500);
  await waitFor(() => p.eval<boolean>(`!!document.querySelector('.motion-play')`), 'motion panel');
  await shot('42-motion');
  await p.eval(`document.querySelector('.motion-play').click()`);
  await sleep(3200);
  const motionAngle = await p.eval<number>(`window.casiworks.assembly.mates().find(m => m.type === 'angle').angle`);
  await p.key('Escape');
  await sleep(300);

  // Explode step: the pin up out of the plate, played from the Explode panel
  await p.eval(`window.casiworks.assembly.setExplodeSteps([{ components: [${JSON.stringify(pinId)}], direction: '+Z', distance: 45 }])`);
  await p.click('Configure Exploded View', 500);
  await p.eval(`document.querySelector('.assembly-component[aria-label^="Pin"]')?.click()`);
  await waitFor(() => p.eval<boolean>(`!!document.querySelector('.explode-play')`), 'explode steps');
  await p.eval(`window.casiworks.assembly.explode({ progress: 1 })`);
  await sleep(500);
  await wheel(p, 7);
  await shot('43-explode-steps');
  const explodeSteps = await p.eval<number>(`window.casiworks.assembly.explodeSteps().length`);
  await p.eval(`window.casiworks.assembly.collapse()`);
  await p.key('Escape');
  await sleep(300);

  const tabs = await p.eval<string[]>(`window.casiworks.workspace.list().map(d => d.name + ':' + d.type)`);
  return {
    tabs, inserted, mates: [firstType, ...mates], pinAt,
    dof: { status: dofInfo.status, pin: dofInfo.components[1]?.status, motions: dofInfo.components[1]?.motions ?? [] },
    plateDepthAfterEdit: after.depth, pinZAfterEdit: after.pinZ, motionAngle, explodeSteps, treeTags,
  };
}

/** Close the scenario's documents (so later checks start clean). */
export async function closeAssemblyFlow(p: Page): Promise<void> {
  await p.eval(`(() => { const api = window.casiworks;
    for (const d of api.workspace.list()) if (['Plate', 'Pin', 'Fixture'].includes(d.name)) api.workspace.close(d.id, { discard: true }); })()`);
  await sleep(500);
}
