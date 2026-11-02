export const AGENT_EXECUTORS = ['omp'] as const;
export type AgentExecutorId = typeof AGENT_EXECUTORS[number];
export const SUPPORTED_AGENT_EXECUTORS = AGENT_EXECUTORS;
export function assertSupportedAgentExecutor(id: string): asserts id is AgentExecutorId {
  if (id !== 'omp') throw new Error(`DJI 仅支持 OMP Runtime，不支持：${id}`);
}
