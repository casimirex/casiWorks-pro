// CasiWorks Pro - FEA solver worker: meshing and solving off the UI thread
import { runSolve, transferables } from './feaTransfer.ts';
import type { SolveRequest, SolvePhase, PackedSolve } from './feaTransfer.ts';

export type WorkerMessage =
  | { type: 'phase'; phase: SolvePhase }
  | { type: 'done'; data: PackedSolve }
  | { type: 'error'; message: string };

// The worker global, typed without pulling in the WebWorker library (it clashes with DOM)
const worker = self as unknown as {
  onmessage: ((e: MessageEvent<SolveRequest>) => void) | null;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
};

worker.onmessage = (e) => {
  try {
    const data = runSolve(e.data, (phase) => worker.postMessage({ type: 'phase', phase }));
    worker.postMessage({ type: 'done', data }, transferables(data));
  } catch (err) {
    worker.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
