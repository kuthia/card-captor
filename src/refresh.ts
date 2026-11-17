/** Serialize reads and discard results from credentials/configuration that were replaced. */
export class RefreshScheduler<T> {
  private revision = 0;
  private pending = false;
  private running: Promise<void> | null = null;

  constructor(private readonly callbacks: {
    canRefresh(): boolean;
    load(): Promise<T>;
    accept(value: T): void;
    reject(error: unknown): void;
    busy(value: boolean): void;
  }) {}

  get isRunning(): boolean { return this.running !== null; }

  /** Wait for the invalidated read before issuing a write; never starts another read. */
  waitForIdle(): Promise<void> { return this.running ?? Promise.resolve(); }

  invalidate(): void {
    this.revision += 1;
    this.pending = false;
  }

  request(afterCurrent = false): Promise<void> {
    if (this.running) {
      if (afterCurrent) this.pending = true;
      return this.running;
    }
    if (!this.callbacks.canRefresh()) return Promise.resolve();
    this.callbacks.busy(true);
    this.running = Promise.resolve().then(async () => {
      try {
        do {
          this.pending = false;
          const revision = this.revision;
          try {
            const value = await this.callbacks.load();
            if (revision === this.revision) this.callbacks.accept(value);
          } catch (error) {
            if (revision === this.revision) this.callbacks.reject(error);
          }
          // Only a new explicit request schedules another read; failure never retries itself.
        } while (this.pending && this.callbacks.canRefresh());
      } finally {
        this.pending = false;
        this.running = null;
        this.callbacks.busy(false);
      }
    });
    return this.running;
  }
}
