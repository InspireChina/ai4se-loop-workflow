/** External wrapper ownership is distinct from the management lease. Losing
 * the wrapper stops THIS host, never signals an unrelated reused parent PID.
 * Cheap liveness remains independent of slow asynchronous identity queries. */
export function createHostParentWatch(ports: {
  isAvailable: () => boolean; readIdentity: () => Promise<string | null>; onLost: (error: Error) => Promise<void>;
  now?: () => number; scheduleInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
  waitBeforeRetry?: () => Promise<void>; maxUnknownChecks?: number; identityRetryMs?: number;
}) {
  const now = ports.now || (() => performance.now());
  const maxUnknownChecks = Math.max(2, ports.maxUnknownChecks ?? 3);
  const identityRetryMs = Math.max(100, ports.identityRetryMs ?? 1_000);
  let closed = false; let timer: NodeJS.Timeout | undefined; let pending = false;
  let marker: string | undefined; let nextIdentityAt = 0; let unknownChecks = 0; let starting: Promise<void> | undefined;
  const stop = () => { closed = true; if (timer) clearInterval(timer); timer = undefined; };
  async function lose(error: Error) { if (closed) return; stop(); await ports.onLost(error); }
  const read = async () => {
    try { return await ports.readIdentity(); }
    catch { return null; }
  };
  const waitBeforeRetry = ports.waitBeforeRetry || (() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  async function check() {
    if (closed) return;
    try {
      if (!ports.isAvailable()) { await lose(new Error('外部父宿主已不可用，当前宿主必须退出')); return; }
      if (pending || now() < nextIdentityAt) return;
      pending = true;
      try {
        const identity = await read();
        if (closed) return;
        if (identity === marker) { unknownChecks = 0; nextIdentityAt = now() + 30_000; return; }
        if (identity) { await lose(new Error('外部父宿主身份已改变，当前宿主必须退出')); return; }
        // OS identity inspection is observation, not the ownership fact itself.
        // A live parent plus one failed query is unknown evidence; require
        // consecutive failures before fencing this child. Definite death or a
        // positive marker mismatch above still stops it immediately.
        unknownChecks += 1;
        if (unknownChecks >= maxUnknownChecks) {
          await lose(new Error('外部父宿主身份连续无法确认，当前宿主必须退出'));
          return;
        }
        nextIdentityAt = now() + identityRetryMs;
      } finally { pending = false; }
    } catch (cause) { await lose(new Error('外部父宿主检查失败，当前宿主必须退出', { cause })); }
  }
  return {
    start() {
      if (closed) return Promise.reject(new Error('已关闭的父宿主观察不能重新启动'));
      return starting ||= (async () => {
        let identity: string | null = null;
        for (let attempt = 0; attempt < maxUnknownChecks && !closed; attempt += 1) {
          if (!ports.isAvailable()) break;
          identity = await read();
          if (identity) break;
          if (attempt + 1 < maxUnknownChecks) await waitBeforeRetry();
        }
        if (closed) return;
        if (!identity || !ports.isAvailable()) throw new Error('启动时无法确认外部父宿主身份');
        marker = identity; unknownChecks = 0; nextIdentityAt = now() + 30_000;
        timer = (ports.scheduleInterval || setInterval)(() => { void check().catch(error => { void lose(error).catch(() => undefined); }); }, 1_000);
        timer.unref();
      })();
    },
    check,
    stop,
  };
}
