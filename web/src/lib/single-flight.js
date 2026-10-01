// A repeated lookup joins the current operation; it never queues or starts a
// second RPC burst. Invalidating a UI result does not release this lock before
// the underlying request settles.
export class SingleFlight {
  #active = null;
  #onBusy;
  constructor(onBusy = () => {}) { this.#onBusy = onBusy; }
  get busy() { return this.#active !== null; }
  wait() { return this.#active ?? Promise.resolve(); }
  run(operation) {
    if (this.#active) return this.#active;
    this.#active = Promise.resolve().then(operation).finally(() => {
      this.#active = null;
      this.#onBusy(false);
    });
    this.#onBusy(true);
    return this.#active;
  }
}
