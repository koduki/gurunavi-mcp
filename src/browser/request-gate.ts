export class RequestGate {
  #nextAllowedAt = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(readonly minimumIntervalMs: number) {}

  async wait(): Promise<void> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const delay = Math.max(0, this.#nextAllowedAt - Date.now());
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.#nextAllowedAt = Date.now() + this.minimumIntervalMs;
    release?.();
  }
}
