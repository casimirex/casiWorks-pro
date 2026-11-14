// CasiWorks Pro - Run an FEA study without freezing the UI
//
// The solve runs in a Web Worker; the returned handle can cancel it (the
// worker is terminated). Where workers are unavailable it runs inline.
import type * as THREE from 'three';
import { runSolve, unpack } from './feaTransfer.ts';
import type { SolveRequest, SolvePhase, Solved } from './feaTransfer.ts';
import type { WorkerMessage } from './fea.worker.ts';

export interface SolveHandle {
  promise: Promise<Solved>;
  /** Stop the solve; the promise rejects with a CancelledError. */
  cancel(): void;
}

export class CancelledError extends Error {
  constructor() {
    super('Solve cancelled');
    this.name = 'CancelledError';
  }
}

export interface StudyInput {
  geometry: THREE.BufferGeometry;
  elementType: SolveRequest['elementType'];
  load: number;
  yieldStrength: number;
  youngsModulus: number;
  poissonRatio: number;
  quality?: SolveRequest['quality'];
  setup?: SolveRequest['setup'];
}

function requestFor(input: StudyInput): SolveRequest {
  const pos = input.geometry.getAttribute('position');
  const idx = input.geometry.getIndex();
  // Copies: the arrays are transferred to the worker and must not be the model's own
  return {
    positions: Float32Array.from(pos.array as ArrayLike<number>),
    index: idx ? Uint32Array.from(idx.array as ArrayLike<number>) : null,
    elementType: input.elementType,
    load: input.load,
    yieldStrength: input.yieldStrength,
    youngsModulus: input.youngsModulus,
    poissonRatio: input.poissonRatio,
    quality: input.quality,
    setup: input.setup,
  };
}

export function startSolve(input: StudyInput, onPhase: (phase: SolvePhase) => void = () => {}): SolveHandle {
  const request = requestFor(input);

  if (typeof Worker === 'undefined') {
    let cancelled = false;
    const promise = new Promise<Solved>((resolve, reject) => {
      // Yield once so the caller can show progress before the (blocking) inline solve
      setTimeout(() => {
        if (cancelled) return reject(new CancelledError());
        try { resolve(unpack(runSolve(request, onPhase))); } catch (err) { reject(err); }
      }, 0);
    });
    return { promise, cancel: () => { cancelled = true; } };
  }

  const worker = new Worker(new URL('./fea.worker.ts', import.meta.url), { type: 'module' });
  let rejectPromise: (err: unknown) => void = () => {};
  const promise = new Promise<Solved>((resolve, reject) => {
    rejectPromise = reject;
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'phase') onPhase(msg.phase);
      else {
        worker.terminate();
        if (msg.type === 'done') resolve(unpack(msg.data));
        else reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The solver worker failed'));
    };
  });
  worker.postMessage(request, [request.positions.buffer, ...(request.index ? [request.index.buffer] : [])]);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      rejectPromise(new CancelledError());
    },
  };
}
