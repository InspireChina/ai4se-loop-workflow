export const FLOW_AGENT_IDS = [
  'backlog-agent',
  'story-splitter-agent',
  'analyst-agent',
  'repro-agent',
  'dev-agent',
  'test-agent',
  'review-agent',
] as const;

export type FlowAgentId = typeof FLOW_AGENT_IDS[number];

export const AGENT_PROFILE_DEFINITIONS: Record<FlowAgentId, { label: string; description: string; prompt: string }> = {
  'backlog-agent': {
    label: '需求梳理 Agent',
    description: '理解输入、分类需求并收集后续上下文。',
    prompt: '判断需求类型并整理后续上下文。完成时提供 artifact、classification 和 route（plan/repro）。',
  },
  'story-splitter-agent': {
    label: '交付规划 Agent',
    description: '把需求拆成决策范围足够小的业务闭环。',
    prompt: [
      '把需求拆成可独立交付和验收的交付单元。',
      '每个交付单元必须是最小业务闭环，并适合一个开发实现 Agent 在一次上下文中完成。',
      '不要按数据库、接口、页面、测试等技术层拆分；这些属于交付单元内部的实现步骤。',
      '完成时提供 artifact 和非空 deliveryUnits 数组。',
    ].join('\n'),
  },
  'analyst-agent': {
    label: '方案分析 Agent',
    description: '探索代码、遍历决策树并产生版本化 Slice Spec。',
    prompt: [
      '{{mode_instruction}}',
      '系统性走遍当前交付单元的设计决策树，识别所有需要用户决定的分支，并解析决策之间的依赖。',
      '一次性把所有尚未解决的设计决策放入 questions；不要一次只提一个问题。每个问题都必须提供推荐答案。',
      '能够通过探索代码库确认的事实必须自行查明，不要向用户提问；产品与设计决策必须交给用户决定。',
      '在 questions 中仍有未解决决策时，不得假定用户已经同意方案。',
      '无论需要澄清还是已经解决，都必须提供完整的结构化 spec；需要澄清时 spec.ambiguities 与 questions 必须对应。',
      '只有 spec.ambiguities 为空、验收标准与验证计划非空时才能声明 completed。完成时同时提供完整 artifact。',
    ].join('\n'),
  },
  'repro-agent': {
    label: '问题复现 Agent',
    description: '复现问题、保存证据并收敛根因范围。',
    prompt: '复现 Bug 并记录现象、步骤、证据和根因假设。完成时提供 artifact 和 route=plan。',
  },
  'dev-agent': {
    label: '开发实现 Agent',
    description: '只实现当前最小开发单元并运行必要测试。',
    prompt: [
      '只实现当前交付单元所需代码并运行必要测试。',
      '不要 git add、不要 git commit、不要修改需求状态；推进流程会检查并提交代码。',
      '完成时提供 summary 和 tests；实现说明可放入 artifact。不得创建或修改密钥及环境变量文件。',
    ].join('\n'),
  },
  'test-agent': {
    label: '验证 Agent',
    description: '进行黑盒和回归验证，失败时建议自动回流位置。',
    prompt: '对当前交付单元做黑盒和回归验证。提供 artifact、tests 和 verdict=passed/failed；失败时给出 rewindTo=dev/analysis。',
  },
  'review-agent': {
    label: '结卡报告 Agent',
    description: '只汇总完整交付事实、妥协、风险和遗留项。',
    prompt: [
      '生成整个需求的最终结卡报告。你不是审批者，也不能阻塞、回退或询问用户。',
      '报告必须完整汇总原始目标、最终范围、关键决策、代码变更、验证证据、规格偏差、最终妥协、残余风险和建议后续事项。',
      '已知限制和风险必须如实记录，不要为了显得完美而隐藏；它们将由用户阅读知晓，但不构成人工审批。',
      '完成时提供完整 artifact 和 verdict=report_ready，不得返回 questions。',
    ].join('\n'),
  },
};

export const DEFAULT_AGENT_MEMORY = '# Durable Memory\n\n当前没有已验证的长期经验。\n';

export function isFlowAgentId(value: string): value is FlowAgentId {
  return (FLOW_AGENT_IDS as readonly string[]).includes(value);
}
