/** External wrapper ownership is distinct from the management lease. Losing
 * the wrapper stops THIS host, never signals an unrelated reused parent PID.
 * Cheap liveness remains independent of slow asynchronous identity queries. */
export function createHostParentWatch(ports: {
  isAvailable: () => boolean; readIdentity: () => Promise<string | null>; onLost: (error: Error) => Promise<void>;
  now?: () => number; scheduleInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
}) {
  const now = ports.now || (() => performance.now());
  let closed = false; let timer: NodeJS.Timeout | undefined; let pending = false;
  let marker: string | undefined; let nextIdentityAt = 0; let starting: Promise<void> | undefined;
  const stop = () => { closed = true; if (timer) clearInterval(timer); timer = undefined; };
  async function lose(error: Error) { if (closed) return; stop(); await ports.onLost(error); }
  async function check() {
    if (closed) return;
    try {
      if (!ports.isAvailable()) { await lose(new Error('外部父宿主已不可用，当前宿主必须退出')); return; }
      if (pending || now() < nextIdentityAt) return;
      pending = true;
      try {
        const identity = await ports.readIdentity();
        if (!closed && identity !== marker) await lose(new Error('外部父宿主身份已改变或无法确认，当前宿主必须退出'));
        nextIdentityAt = now() + 30_000;
      } finally { pending = false; }
    } catch (cause) { await lose(new Error('外部父宿主检查失败，当前宿主必须退出', { cause })); }
  }
  return {
    start() {
      if (closed) return Promise.reject(new Error('已关闭的父宿主观察不能重新启动'));
      return starting ||= (async () => {
        const identity = await ports.readIdentity();
        if (closed) return;
        if (!identity || !ports.isAvailable()) throw new Error('启动时无法确认外部父宿主身份');
        marker = identity; nextIdentityAt = now() + 30_000;
        timer = (ports.scheduleInterval || setInterval)(() => { void check().catch(error => { void lose(error).catch(() => undefined); }); }, 1_000);
        timer.unref();
      })();
    },
    check,
    stop,
  };
}
