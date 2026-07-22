export const DEFAULT_AGENT_EXECUTOR_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_AGENT_EXECUTOR_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

type RuntimeLimitEnvironment = Record<string, string | undefined>;

function positiveNumber(value: string | undefined) {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveAgentExecutionLimits(env: RuntimeLimitEnvironment = process.env) {
  const maxRuntimeMs = positiveNumber(env.AGENT_EXECUTOR_TIMEOUT_MS)
    ?? positiveNumber(env.CURSOR_AGENT_TIMEOUT_MS)
    ?? DEFAULT_AGENT_EXECUTOR_TIMEOUT_MS;
  const idleTimeoutMs = positiveNumber(env.AGENT_EXECUTOR_IDLE_TIMEOUT_MS)
    ?? positiveNumber(env.CURSOR_AGENT_IDLE_TIMEOUT_MS)
    ?? DEFAULT_AGENT_EXECUTOR_IDLE_TIMEOUT_MS;
  return { maxRuntimeMs, idleTimeoutMs };
}
