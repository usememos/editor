// The item source of a suggestion: one request at a time. A new request
// aborts the previous one's signal, waits out the debounce, and calls the
// source. A result that arrives after a newer request started, or after
// `cancel`, is dropped. A rejection counts as no result.

/** How long a request may be pending before the popup shows its loading row. */
export const LOADING_DELAY = 300;

export interface SourceHandlers<T> {
  /** The result, or null when the source threw or rejected. */
  show(value: T | null): void;
  /** The request has been pending for `LOADING_DELAY` ms. */
  loading(): void;
}

export class SourceRunner<T> {
  private request = 0;
  private controller: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private loadingTimer: ReturnType<typeof setTimeout> | null = null;
  private waiting = false;

  /** True from `run` until its result arrives or it is cancelled. */
  get pending(): boolean {
    return this.waiting;
  }

  /** Calls `fetch` after `debounce` ms and passes its result to `show`, unless a newer request or `cancel` came first. */
  run(fetch: (signal: AbortSignal) => T | Promise<T>, handlers: SourceHandlers<T>, debounce = 0): void {
    this.cancel();
    const request = this.request;
    this.waiting = true;
    this.loadingTimer = setTimeout(() => {
      this.loadingTimer = null;
      if (request === this.request) handlers.loading();
    }, LOADING_DELAY);
    const done = (value: T | null) => {
      if (request !== this.request) return;
      this.settle();
      handlers.show(value);
    };
    const start = () => {
      this.debounceTimer = null;
      const controller = new AbortController();
      this.controller = controller;
      let result: T | Promise<T>;
      try {
        result = fetch(controller.signal);
      } catch {
        done(null);
        return;
      }
      if (isPromise(result)) result.then(done, () => done(null));
      else done(result);
    };
    if (debounce > 0) this.debounceTimer = setTimeout(start, debounce);
    else start();
  }

  /** Drops the pending request: aborts its signal and clears its timers. */
  cancel(): void {
    this.request++;
    this.controller?.abort();
    this.settle();
  }

  private settle(): void {
    this.waiting = false;
    this.controller = null;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.loadingTimer !== null) clearTimeout(this.loadingTimer);
    this.debounceTimer = this.loadingTimer = null;
  }
}

export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}
