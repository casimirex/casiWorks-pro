// CasiWorks Pro - Debounce utility
// Prevent UI thread freeze during continuous slider drags and geometry rebuilds

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drop a pending call. */
  cancel(): void;
}

/** Call `fn` once, `delayMs` after the last invocation. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delayMs = 120): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  }) as Debounced<A>;
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
