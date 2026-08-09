export type RequirementPipelineId = 'business-analysis' | 'end-to-end' | 'feature' | 'bug';

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

const requirementContext: RequirementPipelineStage = {
  key: 'requirement-context',
  title: '需求梳理',
  owner: '需求梳理 Agent',
  lane: '控制',
  description: '确认 AS IS 与代码事实，校验既有需求规格或业务方案，并补齐 TO BE、SCOPE、真实影响与验收语义。',
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

const businessAnalysisStages: readonly RequirementPipelineStage[] = [{
  key: 'idea-context',
  title: '需求意图确认',
  owner: '需求意图 Agent',
  lane: '控制',
  description: '调查原始想法，批量关闭目标、参与者、成功结果、约束和权威资料中的歧义。',
}, {
  key: 'business-design',
  title: '业务方案设计',
  owner: '业务方案 Agent',
  lane: '控制',
  description: '探索业务场景，分离提出与回答决策树，并形成唯一业务方案。',
}, {
  key: 'requirement-spec',
  title: '需求规格编写',
  owner: '需求规格 Agent',
  lane: '控制',
  description: '把已确认意图和业务方案编译为完整、一致、可验证的需求规格说明书。',
}, {
  key: 'spec-review',
  title: '规格独立审查',
  owner: '规格审查 Agent',
  lane: '控制',
  description: '独立检查目标、决策、场景、规则、范围、验收和来源追踪，批准或结构化回流。',
}];

export const REQUIREMENT_PIPELINES: readonly RequirementPipelineDefinition[] = [{
  id: 'business-analysis',
  label: 'Business Analysis',
  summary: '用于把一个模糊想法发展为经过独立审查的需求规格说明书。',
  stages: [...businessAnalysisStages, {
    key: 'spec-acknowledgement',
    title: '阅读规格',
    owner: '用户',
    lane: '人工',
    description: '阅读通过审查的需求规格说明书并结束本次 Business Analysis。',
  }],
}, {
  id: 'end-to-end',
  label: 'End to End',
  summary: '从模糊想法开始，自动完成 Business Analysis，并把批准后的需求规格直接交给 Develop 主干。',
  stages: [...businessAnalysisStages, requirementContext, ...deliveryStages],
}, {
  id: 'feature',
  label: 'Develop',
  summary: '用于新增或主动改变业务能力与用户可观察行为。',
  stages: [requirementContext, ...deliveryStages],
}, {
  id: 'bug',
  label: 'Bug Fix',
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
  if (input === 'business-analysis' || input === 'end-to-end' || input === 'feature' || input === 'bug') return input;
  throw new Error('PIPELINE 只能选择 Business Analysis、End to End、Develop 或 Bug Fix');
}
