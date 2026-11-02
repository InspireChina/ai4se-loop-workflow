export const AGENT_EXECUTORS = ['cursor', 'codex', 'claude', 'omp'] as const;
export type AgentExecutorId = typeof AGENT_EXECUTORS[number];

// Historical executor IDs remain readable in stored execution records.
export const SUPPORTED_AGENT_EXECUTORS = ['omp'] as const;
export function assertSupportedAgentExecutor(id: string): asserts id is 'omp' {
  if (id !== 'omp') throw new Error(`DJI 分支仅支持 OMP Runtime，不支持：${id}`);
}
