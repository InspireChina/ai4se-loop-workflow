export const AGENT_EXECUTORS = ['cursor', 'codex', 'claude'] as const;
export type AgentExecutorId = typeof AGENT_EXECUTORS[number];
