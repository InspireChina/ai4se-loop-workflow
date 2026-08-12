export type InFlightWorkItem<T> = {
  value: T;
  promise: Promise<void>;
};

export class InFlightWork<T> {
  private readonly items = new Map<string, InFlightWorkItem<T>>();
  private completionRevision = 0;

  get size() {
    return this.items.size;
  }

  values() {
    return [...this.items.values()].map((item) => item.value);
  }

  revision() {
    return this.completionRevision;
  }

  launch(
    key: string,
    value: T,
    run: () => Promise<void>,
    onError: (error: unknown) => Promise<void> | void,
  ) {
    if (this.items.has(key)) return false;
    const promise = Promise.resolve()
      .then(run)
      .catch(async (error) => {
        try { await onError(error); } catch { /* Error reporting cannot break scheduler progress. */ }
      })
      .finally(() => {
        this.items.delete(key);
        this.completionRevision += 1;
      });
    this.items.set(key, { value, promise });
    return true;
  }

  async waitForNextCompletion(sinceRevision = this.completionRevision) {
    if (this.completionRevision !== sinceRevision) return;
    if (!this.items.size) return;
    await Promise.race([...this.items.values()].map((item) => item.promise));
  }
}
