export type RunnerWakeReason =
  | 'runtime-event'
  | 'execution-completed'
  | 'background-completed'
  | 'deadline'
  | 'safety-reconcile'
  | 'closed';

export type RunnerWake = { revision: number; reason: RunnerWakeReason };

export class RunnerWakeCoordinator {
  private currentRevision = 0;
  private closed = false;
  private readonly waiters = new Set<(wake: RunnerWake) => void>();

  revision() {
    return this.currentRevision;
  }

  wake(reason: RunnerWakeReason = 'runtime-event') {
    if (this.closed) return;
    this.currentRevision += 1;
    const wake = { revision: this.currentRevision, reason };
    for (const resolve of this.waiters) resolve(wake);
    this.waiters.clear();
  }

  wait(sinceRevision: number, deadlineAt?: number | null): Promise<RunnerWake> {
    if (this.closed) return Promise.resolve({ revision: this.currentRevision, reason: 'closed' });
    if (this.currentRevision !== sinceRevision) {
      return Promise.resolve({ revision: this.currentRevision, reason: 'runtime-event' });
    }
    if (deadlineAt !== undefined && deadlineAt !== null && deadlineAt <= Date.now()) {
      return Promise.resolve({ revision: this.currentRevision, reason: 'deadline' });
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (wake: RunnerWake) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(wake);
      };
      this.waiters.add(finish);
      if (deadlineAt !== undefined && deadlineAt !== null) {
        const delay = Math.min(2_147_000_000, Math.max(0, deadlineAt - Date.now()));
        timer = setTimeout(() => finish({ revision: this.currentRevision, reason: 'deadline' }), delay);
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const wake = { revision: this.currentRevision, reason: 'closed' as const };
    for (const resolve of this.waiters) resolve(wake);
    this.waiters.clear();
  }
}
