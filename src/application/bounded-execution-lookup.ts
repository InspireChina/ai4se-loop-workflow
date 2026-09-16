/** Bounds asynchronous pre-spawn reads. Late completion has no persistence
 * callback, so a timed-out read cannot grant authority or replace saved state. */
export async function boundedExecutionLookup<T>(read: () => Promise<T>, signal: AbortSignal, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Execution lookup timeout must be positive');
  if (signal.aborted) throw new Error(`${label} cancelled`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    abort = () => reject(new Error(`${label} cancelled`));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw new Error(`${label} cancelled`);
      return read();
    }), boundary]);
  } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
