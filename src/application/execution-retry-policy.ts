export const EXECUTION_FAILURE_MAX_RETRIES = 3;

const RETRY_BACKOFF_MS = [10_000, 30_000, 120_000] as const;

export function executionRetryBackoffMs(failureAttempt: number, env: NodeJS.ProcessEnv = process.env) {
  const configuredScale = Number(env.LOOP_RETRY_BACKOFF_SCALE ?? (env.LOOP_TEST === '1' ? 0 : 1));
  const scale = Number.isFinite(configuredScale) && configuredScale >= 0 ? configuredScale : 1;
  const base = RETRY_BACKOFF_MS[Math.min(Math.max(failureAttempt, 1), RETRY_BACKOFF_MS.length) - 1];
  return Math.round(base * scale);
}

export function retryNotBeforeForFailure(failureAttempt: number, now = new Date(), env: NodeJS.ProcessEnv = process.env) {
  const delay = executionRetryBackoffMs(failureAttempt, env);
  return delay > 0 ? new Date(now.getTime() + delay).toISOString() : null;
}

export function remainingExecutionRetries(attempt: number) {
  return Math.max(0, EXECUTION_FAILURE_MAX_RETRIES + 1 - Math.max(attempt, 1));
}

export function shouldRetryReportedFailure(
  result: { outcome?: string; verdict?: string },
  attempt: number,
) {
  return (result.outcome === 'failed' || result.verdict === 'failed')
    && attempt <= EXECUTION_FAILURE_MAX_RETRIES;
}

export async function waitForExecutionRetryBackoff(
  failureAttempt: number,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  const delay = executionRetryBackoffMs(failureAttempt, env);
  if (!delay || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delay);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
