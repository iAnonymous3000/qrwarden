export type WorkCleanup = () => void;

export class WorkState {
  #generation = 0;
  #suspended = false;
  readonly #cleanups = new Set<WorkCleanup>();

  get generation(): number {
    return this.#generation;
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  get hasRetainedResources(): boolean {
    return this.#cleanups.size > 0;
  }

  begin(): number {
    this.#suspended = false;
    this.#generation += 1;
    return this.#generation;
  }

  invalidate(): number {
    this.#generation += 1;
    return this.#generation;
  }

  isLive(generation: number): boolean {
    return !this.#suspended && generation === this.#generation;
  }

  retain(cleanup: WorkCleanup): () => void {
    if (this.#suspended) {
      try {
        cleanup();
      } catch {
        // A late resource must still be rejected without reviving suspended work.
      }
      return () => undefined;
    }
    this.#cleanups.add(cleanup);
    return () => {
      this.#cleanups.delete(cleanup);
    };
  }

  suspend(): void {
    if (this.#suspended) {
      return;
    }
    this.#suspended = true;
    this.#generation += 1;
    const cleanups = [...this.#cleanups];
    this.#cleanups.clear();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Cleanup is deliberately best-effort and must continue for all resources.
      }
    }
  }
}
