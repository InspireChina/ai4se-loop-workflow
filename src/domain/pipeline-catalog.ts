export type RequirementPipelineId = 'feature' | 'bug';

export type RequirementPipelineStage = {
  key: string;
  title: string;
  owner: string;
  lane: '控制' | '交付分析' | '开发验证' | '人工';
  description: string;
};

export type RequirementPipelineDefinition = {
  id: RequirementPipelineId;
  label: string;
  summary: string;
  stages: readonly RequirementPipelineStage[];
};

const deliveryStages: readonly RequirementPipelineStage[] = [{
  key: 'delivery-plan',
  title: '交付规划',
  owner: '交付规划 Agent',
  lane: '控制',
  description: '拆分为具备稳定身份、业务触发、可观察结果和验收语义的交付单元。',
}, {
  key: 'delivery-analysis',
  title: '交付分析',
  owner: '交付分析 Agent',
  lane: '交付分析',
  description: '逐个单元确认实际影响、关键决策并冻结可执行交付契约。',
}, {
  key: 'implementation',
  title: '开发实现',
  owner: '开发实现 Agent',
  lane: '开发验证',
  description: '实现已冻结的业务承诺，并完成代码审查、开发者验证和提交确认。',
}, {
  key: 'verification',
  title: '独立验证',
  owner: '验证 Agent',
  lane: '开发验证',
  description: '从用户入口独立验证交付契约、相邻回归与失败边界。',
}, {
  key: 'review',
  title: '结卡报告',
  owner: '结卡报告 Agent',
  lane: '控制',
  description: '对账需求级最终事实；有缺口时直接形成新增交付单元，否则生成结卡报告。',
}, {
  key: 'acknowledgement',
  title: '阅读确认',
  owner: '用户',
  lane: '人工',
  description: '阅读当前结卡报告并确认关闭需求。',
}];

const requirementContext: RequirementPipelineStage = {
  key: 'requirement-context',
  title: '需求梳理',
  owner: '需求梳理 Agent',
  lane: '控制',
  description: '确认 AS IS、决策树、TO BE、SCOPE、影响和验收语义。',
};

export const REQUIREMENT_PIPELINES: readonly RequirementPipelineDefinition[] = [{
  id: 'feature',
  label: '功能需求',
  summary: '用于新增或主动改变业务能力与用户可观察行为。',
  stages: [requirementContext, ...deliveryStages],
}, {
  id: 'bug',
  label: 'BUG',
  summary: '用于 Actual 偏离已有明确 Expected 的问题修复。',
  stages: [requirementContext, {
    key: 'reproduction',
    title: '问题复现',
    owner: '问题复现 Agent',
    lane: '控制',
    description: '确认实际异常、成立条件和证据边界，再进入交付规划。',
  }, ...deliveryStages],
}];

export function requirementPipeline(input: unknown): RequirementPipelineId {
  if (input === 'feature' || input === 'bug') return input;
  throw new Error('PIPELINE 只能选择功能需求或 BUG');
}
