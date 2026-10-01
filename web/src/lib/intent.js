export class IntentChangedError extends Error {
  constructor() {
    super('The form, wallet or selected escrow changed. This preparation was cancelled before broadcast. Review the current details again.');
    this.name = 'IntentChangedError';
  }
}

// Each user intention owns one generation. A new preparation, input edit,
// navigation, verification or wallet change invalidates all older async work.
// Call assertCurrent after awaits and again at the final signing boundary.
export class IntentGuard {
  #generation = 0;
  invalidate() { this.#generation++; }
  begin() {
    const generation = ++this.#generation;
    return Object.freeze({
      assertCurrent: () => {
        if (generation !== this.#generation) throw new IntentChangedError();
      },
    });
  }
}
