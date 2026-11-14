// Example CasiWorks Pro add-in: flat washer generator (ISO 7089 normal series)
//
// Load it from Add-ins ▸ Manage (URL /plugins/washer.js), or from the console:
//   await api.plugins.load('/plugins/washer.js')
//   run('washer.create', { size: 'M10' })
//
// An add-in is an ES module whose default export describes it. It only uses
// the public API it is given (host.api), like any script.

/** ISO 7089 flat washers: inner diameter d1, outer diameter d2, thickness h (mm). */
const SIZES = {
  M5: { d1: 5.3, d2: 10, h: 1 },
  M6: { d1: 6.4, d2: 12, h: 1.6 },
  M8: { d1: 8.4, d2: 16, h: 1.6 },
  M10: { d1: 10.5, d2: 20, h: 2 },
  M12: { d1: 13, d2: 24, h: 2.5 },
  M16: { d1: 17, d2: 30, h: 3 },
};

function dimensions(args = {}) {
  if (args.size) {
    const s = SIZES[args.size];
    if (!s) throw new Error(`Unknown size ${args.size}; known: ${Object.keys(SIZES).join(', ')}`);
    return { outer: s.d2, inner: s.d1, thickness: s.h, label: `Washer ${args.size}` };
  }
  const { outer, inner, thickness } = args;
  if (!(outer > inner && inner > 0 && thickness > 0)) throw new Error('Give a size (e.g. M8) or outer > inner > 0 and thickness > 0 (mm)');
  return { outer, inner, thickness, label: `Washer Ø${outer}` };
}

export default {
  id: 'washer',
  name: 'Washer generator',
  version: '1.0.0',
  author: 'CasiWorks examples',
  description: 'Adds flat washers (ISO 7089) to the part as a sketch and an extrude',
  apiVersion: '1.4',

  commands: [
    {
      name: 'create',
      label: 'Washer',
      description: "args: { size: 'M5' … 'M16' } or { outer, inner, thickness } in mm; returns { sketchId, featureId }",
      run(args, host) {
        const { outer, inner, thickness, label } = dimensions(args);
        const sketch = host.api.sketches.create({
          plane: 'Front',
          name: `${label} sketch`,
          entities: [
            { type: 'circle', center: { x: 0, y: 0 }, radius: outer / 2 },
            { type: 'circle', center: { x: 0, y: 0 }, radius: inner / 2 },
          ],
        });
        const featureId = host.api.features.extrude({ sketchId: sketch.sketchId, depth: thickness, name: label });
        return { sketchId: sketch.sketchId, featureId };
      },
    },
  ],

  buttons: [
    { command: 'create', label: 'M8', title: 'ISO 7089 washer M8 (Ø16 × 1.6)', args: { size: 'M8' }, icon: '◎' },
    { command: 'create', label: 'M12', title: 'ISO 7089 washer M12 (Ø24 × 2.5)', args: { size: 'M12' }, icon: '◎' },
  ],
};
