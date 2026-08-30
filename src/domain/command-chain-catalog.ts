export const COMMAND_CHAIN_CATALOG = [
  { id: 'idea-context', agentId: 'idea-context-agent', fileName: 'idea-context-agent.yaml', label: '需求意图确认' },
  { id: 'business-design', agentId: 'business-design-agent', fileName: 'business-design-agent.yaml', label: '业务方案设计' },
  { id: 'requirement-spec', agentId: 'requirement-spec-agent', fileName: 'requirement-spec-agent.yaml', label: '需求规格编写' },
  { id: 'spec-review', agentId: 'spec-review-agent', fileName: 'spec-review-agent.yaml', label: '规格独立审查' },
  { id: 'requirement-context', agentId: 'backlog-agent', fileName: 'backlog-agent.yaml', label: '需求梳理' },
  { id: 'delivery-plan', agentId: 'story-splitter-agent', fileName: 'story-splitter-agent.yaml', label: '交付规划' },
  { id: 'delivery-analysis', agentId: 'analyst-agent', fileName: 'analyst-agent.yaml', label: '交付分析' },
  { id: 'reproduction', agentId: 'repro-agent', fileName: 'repro-agent.yaml', label: '问题复现' },
  { id: 'development', agentId: 'dev-agent', fileName: 'dev-agent.yaml', label: '开发实现' },
  { id: 'verification', agentId: 'test-agent', fileName: 'test-agent.yaml', label: '独立验证' },
  { id: 'review', agentId: 'review-agent', fileName: 'review-agent.yaml', label: '结卡报告' },
  { id: 'feedback-triage', agentId: 'feedback-agent', fileName: 'feedback-agent.triage.yaml', label: '反馈分流' },
  { id: 'feedback-verify', agentId: 'feedback-agent', fileName: 'feedback-agent.verify.yaml', label: '反馈验证' },
] as const;

export type ConfigurableCommandChainId = typeof COMMAND_CHAIN_CATALOG[number]['id'];

export const COMMAND_CHAIN_FILE_BY_ID: Record<string, string> = Object.fromEntries(
  COMMAND_CHAIN_CATALOG.map((item) => [item.id, item.fileName]),
);

export function commandChainCatalogItem(commandChainId: string) {
  return COMMAND_CHAIN_CATALOG.find((item) => item.id === commandChainId) || null;
}

export function agentCommandChainCatalog(agentId: string) {
  return COMMAND_CHAIN_CATALOG.filter((item) => item.agentId === agentId);
}
