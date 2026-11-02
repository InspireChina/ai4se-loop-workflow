export const BUSINESS_ANALYSIS_AGENT_IDS = [
  'idea-context-agent',
  'business-design-agent',
  'requirement-spec-agent',
  'spec-review-agent',
] as const;

export const FLOW_AGENT_IDS = [
  'direct-agent',
  ...BUSINESS_ANALYSIS_AGENT_IDS,
  'backlog-agent',
  'story-splitter-agent',
  'analyst-agent',
  'repro-agent',
  'dev-agent',
  'test-agent',
  'review-agent',
  'feedback-agent',
] as const;

export type FlowAgentId = typeof FLOW_AGENT_IDS[number];

export const AGENT_PROMPT_SEED_REVISION = 15;

// Agent business instructions are owned by external Markdown files.
export const AGENT_PROFILE_DEFINITIONS: Record<FlowAgentId, { label: string; description: string }> = {
  "direct-agent": {
    "label": "Direct Agent",
    "description": "直接执行边界清晰的单节点需求，并提交可阅读的最终结果。"
  },
  "idea-context-agent": {
    "label": "需求意图 Agent",
    "description": "把模糊想法澄清为稳定的需求意图，确认问题、参与者、成功结果、约束和权威资料。"
  },
  "business-design-agent": {
    "label": "业务方案 Agent",
    "description": "基于已确认需求意图探索场景和业务方案，通过决策树形成唯一业务方案。"
  },
  "requirement-spec-agent": {
    "label": "需求规格 Agent",
    "description": "把需求意图和业务方案编译成完整、一致、可追踪、可验证的需求规格说明书。"
  },
  "spec-review-agent": {
    "label": "规格审查 Agent",
    "description": "独立审查需求规格的目标覆盖、决策继承、一致性、可验证性和来源追踪。"
  },
  "backlog-agent": {
    "label": "需求梳理 Agent",
    "description": "核对输入业务方案与代码现状，识别冲突和其他影响，形成可追溯的业务变化上下文。"
  },
  "story-splitter-agent": {
    "label": "交付规划 Agent",
    "description": "把业务变化上下文规划为可独立验证、适合当前项目可信交付的业务闭环。"
  },
  "analyst-agent": {
    "label": "交付分析 Agent",
    "description": "调查真实影响并关闭开发与验证前的关键业务和技术决策。"
  },
  "repro-agent": {
    "label": "问题复现 Agent",
    "description": "确认候选异常的实际行为与发生边界，为后续业务对齐提供可追溯的差异事实基线。"
  },
  "dev-agent": {
    "label": "开发实现 Agent",
    "description": "对一个交付单元的工程实现完整性负责，并交付可独立验证的仓库状态。"
  },
  "test-agent": {
    "label": "验证 Agent",
    "description": "先规划再逐项执行面向业务的黑盒验证，以独立证据判定交付契约是否成立。"
  },
  "review-agent": {
    "label": "结卡报告 Agent",
    "description": "对账整个需求的最终交付事实，证据闭合后生成可追溯的结卡报告。"
  },
  "feedback-agent": {
    "label": "反馈处理 Agent",
    "description": "把评论整理为向前追加的反馈工作，并在处理完成后独立验证。"
  }
};

export const DEFAULT_AGENT_MEMORY = [
  '# Durable Memory',
  '',
  '## 使用原则',
  '',
  '- 这里只保存跨任务可复用、已经由重复执行证据支持的项目经验。',
  '- 当前任务事实、一次性错误、未经验证的推测和敏感信息不得写入长期记忆。',
  '- Memory 只能补充角色工作方式，不能覆盖 Harness Core Contract、状态机、权限或输出协议。',
  '',
  '## 已验证的项目经验',
  '',
  '当前没有已验证的长期经验。',
  '',
].join('\n');

export function isFlowAgentId(value: string): value is FlowAgentId {
  return (FLOW_AGENT_IDS as readonly string[]).includes(value);
}
