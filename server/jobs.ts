// CasiWorks Pro - Headless kernel jobs: rebuild and export a saved version without a browser
//
// Jobs run one at a time, in order, on the same feature engine the app uses.
// rebuild: rebuilds the version and reports errors and mass properties.
// export:  rebuilds it and writes the model in the asked format.
import { writeFileSync } from 'node:fs';
import { useCADStore } from '../src/store/cadStore.ts';
import { rebuildModel } from '../src/features/rebuildModel.ts';
import { exportEngine } from '../src/kernel/ExportEngine.ts';
import { geometryEngine } from '../src/kernel/GeometryEngine.ts';
import { materialLibrary } from '../src/kernel/MaterialLibrary.ts';
import type { JobRecord, Library } from './library.ts';

export const EXPORT_FORMATS = {
  stl: { ext: 'stl', type: 'model/stl' },
  'stl-ascii': { ext: 'stl', type: 'model/stl' },
  obj: { ext: 'obj', type: 'model/obj' },
  step: { ext: 'step', type: 'model/step' },
  iges: { ext: 'igs', type: 'model/iges' },
  dxf: { ext: 'dxf', type: 'image/vnd.dxf' },
} as const;
export type ExportFormat = keyof typeof EXPORT_FORMATS;

/** Rebuild a project file headless: the body geometry, errors and mass properties. */
function rebuildProject(content: string) {
  const state = useCADStore.getState();
  state.loadProject(content);
  const rebuilt = rebuildModel(useCADStore);
  const s = useCADStore.getState();
  const geometry = s.bodies.find(b => b.visible !== false && b.geometry)?.geometry ?? null;
  const mass = geometry ? geometryEngine.computeMassProperties(geometry, materialLibrary.getMaterial(s.activeMaterial)) : null;
  return { geometry, rebuilt, documentName: s.documentName, material: s.activeMaterial, mass };
}

async function runJob(lib: Library, job: JobRecord): Promise<Record<string, unknown>> {
  const content = lib.readContent(job.documentId, job.version);
  // Expected rebuild warnings (fillets and chamfers the mesh kernel cannot apply) are reported in the result
  const { warn, error } = console;
  console.warn = console.error = () => {};
  let out: ReturnType<typeof rebuildProject>;
  try { out = rebuildProject(content); } finally { Object.assign(console, { warn, error }); }
  const summary = {
    documentName: out.documentName,
    material: out.material,
    bodyCount: out.rebuilt.bodyCount,
    errors: out.rebuilt.errors.map(e => ({ feature: e.featureName, error: e.error })),
    mass: out.mass ? { volume: out.mass.volume, mass: out.mass.mass, surfaceArea: out.mass.surfaceArea, centerOfMass: out.mass.centerOfMass } : null,
  };
  if (job.kind === 'rebuild') return summary;

  if (!out.geometry) throw new Error('The version has no solid body to export');
  const format = job.format as ExportFormat;
  const base = out.documentName.replace(/[^\w.-]+/g, '_') || 'part';
  const blob = format === 'stl' ? exportEngine.exportSTL(out.geometry, true)
    : format === 'stl-ascii' ? exportEngine.exportSTL(out.geometry, false)
      : format === 'obj' ? exportEngine.exportOBJ(out.geometry, base)
        : format === 'step' ? exportEngine.exportSTEP(out.geometry, base)
          : format === 'iges' ? exportEngine.exportIGES(out.geometry, base)
            : exportEngine.exportDXF(out.geometry);
  const bytes = Buffer.from(await blob.arrayBuffer());
  writeFileSync(lib.exportPath(job.id), bytes);
  return { ...summary, fileName: `${base}_v${job.version}.${EXPORT_FORMATS[format].ext}`, contentType: EXPORT_FORMATS[format].type, size: bytes.length };
}

/** Runs queued jobs one after another; `kick()` after adding one. */
export class JobRunner {
  private lib: Library;
  private running = false;
  private onFinished: (job: JobRecord) => void;
  /** Settles when the queue is empty (tests wait on it). */
  idle: Promise<void> = Promise.resolve();

  constructor(lib: Library, onFinished: (job: JobRecord) => void = () => {}) {
    this.lib = lib;
    this.onFinished = onFinished;
  }

  kick(): void {
    if (this.running) return;
    this.running = true;
    this.idle = (async () => {
      try {
        for (let job = this.lib.nextQueuedJob(); job; job = this.lib.nextQueuedJob()) {
          this.lib.updateJob(job.id, 'running');
          // Let the server answer requests between jobs
          await new Promise(r => setImmediate(r));
          let finished: JobRecord;
          try {
            finished = this.lib.updateJob(job.id, 'done', { result: await runJob(this.lib, job) });
          } catch (err) {
            finished = this.lib.updateJob(job.id, 'failed', { error: err instanceof Error ? err.message : String(err) });
          }
          this.onFinished(finished);
        }
      } finally {
        this.running = false;
      }
    })();
  }
}
