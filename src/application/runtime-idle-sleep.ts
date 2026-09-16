export type IdleSleepHandle = { isActive: () => boolean; release: () => Promise<void>; failure?: () => Error | undefined };
export type IdleSleepInhibitor = (signal: AbortSignal) => Promise<IdleSleepHandle>;
export class IdleSleepAcquisitionFailure extends Error {
  constructor(message: string, readonly handle: IdleSleepHandle, options?: ErrorOptions) { super(message, options); }
}

/** Host-owned OS capability, independent of business storage and cleanup.
 * A key binds the assertion to the current management intent and lease.
 * Failed release retains the handle; it must not create a second assertion. */
export function createRuntimeIdleSleep(ports: {
  readKey: () => string | null;
  acquire: IdleSleepInhibitor;
  onError: (error: unknown) => void;
  scheduleInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
  cancelInterval?: (timer: NodeJS.Timeout) => void;
}) {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let desired: string | null = null;
  let current: { key: string; handle: IdleSleepHandle; retireOnly?: true } | undefined;
  let acquiring: AbortController | undefined;
  let operation = Promise.resolve();
  let pending = false;
  let dirty = false;
  const report = (error: unknown) => { try { ports.onError(error); } catch { /* never disable supervision */ } };
  const read = () => {
    if (closed) return null;
    try { return ports.readKey(); } catch (error) { report(error); return null; }
  };
  async function synchronize() {
    desired = read();
    const inactive = current && !current.handle.isActive();
    if (inactive) report(current!.handle.failure?.() || new Error('防休眠断言已失效，将重新申请'));
    if (current && (current.key !== desired || inactive || current.retireOnly)) {
      await current.handle.release();
      current = undefined;
    }
    // A different host can stop the loop while OS release is awaited, without
    // calling this process's reconcile. Re-read before starting another helper.
    desired = read();
    if (closed || !desired || current) return;
    const key = desired;
    const controller = new AbortController();
    acquiring = controller;
    try {
      const handle = await ports.acquire(controller.signal);
      // Stop/lease loss during asynchronous OS startup cannot resurrect a
      // running assertion. Save even a stale handle until release succeeds.
      current = { key, handle };
      const inactive = !handle.isActive();
      if (inactive) report(handle.failure?.() || new Error('防休眠申请完成时断言已失效'));
      if (controller.signal.aborted || read() !== key || desired !== key || inactive) {
        await handle.release();
        current = undefined;
      }
    } catch (error) {
      if (error instanceof IdleSleepAcquisitionFailure) current = { key, handle: error.handle, retireOnly: true };
      if (!controller.signal.aborted || error instanceof IdleSleepAcquisitionFailure) throw error;
    } finally { if (acquiring === controller) acquiring = undefined; }
  }
  function reconcile() {
    const next = read();
    if (next !== desired) acquiring?.abort();
    desired = next;
    dirty = true;
    if (!pending) {
      pending = true;
      operation = (async () => {
        try {
          while (dirty) {
            dirty = false;
            try { await synchronize(); } catch (error) { report(error); }
          }
        } finally { pending = false; }
      })();
    }
    return operation;
  }
  return {
    start() {
      if (closed) return Promise.reject(new Error('已关闭的防休眠宿主不能重新启动'));
      if (!timer) {
        timer = (ports.scheduleInterval || setInterval)(() => { void reconcile(); }, 5_000);
        timer.unref();
      }
      return reconcile();
    },
    reconcile,
    shutdown() {
      closed = true;
      if (timer) (ports.cancelInterval || clearInterval)(timer);
      timer = undefined;
      acquiring?.abort();
      return reconcile().then(() => { if (current) throw new Error('宿主退出时防休眠断言尚未确认释放'); });
    },
  };
}
