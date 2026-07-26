import { z } from 'zod';
import { omitNullObjectProperties } from './schema-normalization';
import { deliveryUnitContractSchema } from './delivery-unit';

const artifactSchema = z.object({
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(100000),
});

const questionSchema = z.object({
  decisionKey: z.string().min(1).max(240).optional(),
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().default(''),
  recommendation: z.string().max(2000).optional().default(''),
  recommendationReason: z.string().max(2000).optional().default(''),
  alternatives: z.array(z.object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(240),
    consequences: z.array(z.string().max(1000)).max(20).optional().default([]),
  })).max(20).optional().default([]),
  dependsOn: z.array(z.string().min(1).max(240)).max(50).optional().default([]),
});

const runtimeInputSchema = z.object({
  key: z.string().min(1).max(120).optional(),
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().default(''),
  recommendation: z.string().max(2000).optional().default(''),
});

const feedbackTriageGroupSchema = z.object({
  groupKey: z.string().min(1).max(200),
  commentIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  workType: z.enum([
    'reply',
    'historical_correction',
    'report_correction',
    'bug',
    'behavior_change',
    'scope_addition',
    'technical_change',
    'learning_only',
  ]),
  title: z.string().min(1).max(240).optional(),
  affectedDeliveryUnits: z.array(z.number().int().positive()).max(50).default([]),
  reason: z.string().min(1).max(4000),
  acceptance: z.array(z.string().min(1).max(2000)).max(30).default([]),
  response: z.string().min(1).max(4000).optional(),
});

const feedbackResultSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('triage'),
    groups: z.array(feedbackTriageGroupSchema).min(1).max(100),
  }),
  z.object({
    mode: z.literal('verify'),
    commentId: z.string().min(1).max(200),
    verdict: z.enum(['resolved', 'reopened']),
    reason: z.string().min(1).max(4000),
    evidence: z.array(z.string().min(1).max(2000)).max(50).default([]),
  }),
]);

const decisionOptionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(240),
  consequences: z.array(z.string().min(1).max(1000)).min(1).max(20),
});

const deliveryDecisionBase = {
  key: z.string().min(1).max(240),
  title: z.string().min(1).max(500),
  type: z.enum(['business', 'technical']),
  question: z.string().min(1).max(4000),
  impact: z.string().min(1).max(4000),
};

const deliveryDecisionSchema = z.discriminatedUnion('status', [
  z.object({
    ...deliveryDecisionBase,
    status: z.literal('resolved'),
    options: z.array(decisionOptionSchema).max(20).default([]),
    selectedOption: z.string().min(1).max(100).optional(),
    authority: z.enum(['upstream', 'user', 'project_evidence', 'agent_authority']),
    decision: z.string().min(1).max(4000),
    rationale: z.string().min(1).max(4000),
    evidence: z.string().min(1).max(4000),
  }),
  z.object({
    ...deliveryDecisionBase,
    status: z.literal('needs_user_input'),
    options: z.array(decisionOptionSchema).min(2).max(20),
    authority: z.literal('needs_user_input'),
    recommendationOption: z.string().min(1).max(100),
    recommendationReason: z.string().min(1).max(4000),
  }),
]);

export const deliverySpecSchema = z.preprocess(omitNullObjectProperties, z.object({
  unit: deliveryUnitContractSchema,
  summary: z.string().min(1).max(10000),
  impacts: z.array(z.object({
    key: z.string().min(1).max(120),
    area: z.string().min(1).max(1000),
    finding: z.string().min(1).max(4000),
    disposition: z.enum(['change', 'preserve', 'exclude', 'needs_decision']),
    evidence: z.string().min(1).max(4000),
    decisionKey: z.string().min(1).max(240).optional(),
  })).min(1).max(200),
  decisions: z.array(deliveryDecisionSchema).max(200).default([]),
  handoff: z.object({
    implementationGuidance: z.string().min(1).max(10000),
    guardrails: z.array(z.object({
      key: z.string().min(1).max(120),
      content: z.string().min(1).max(4000),
      rationale: z.string().min(1).max(4000),
    })).max(100).default([]),
    verificationFocus: z.array(z.object({
      key: z.string().min(1).max(120),
      expected: z.string().min(1).max(4000),
      oracle: z.string().min(1).max(4000),
    })).max(100).default([]),
  }),
}));

export const agentResultSchema = z.preprocess(omitNullObjectProperties, z.object({
  outcome: z.enum(['completed', 'needs_input', 'failed']),
  summary: z.string().min(1).max(4000),
  artifact: artifactSchema.optional(),
  questions: z.array(questionSchema).max(50).optional().default([]),
  runtimeInputs: z.array(runtimeInputSchema).max(50).optional().default([]),
  classification: z.enum(['feature', 'bug', 'tech', 'intake', 'other']).optional(),
  route: z.enum(['plan', 'repro']).optional(),
  reproVerdict: z.enum(['reproduced', 'not_reproduced']).optional(),
  deliveryUnits: z.array(deliveryUnitContractSchema).max(50).optional(),
  spec: deliverySpecSchema.optional(),
  // Read-only compatibility for results queued before the terminology change.
  stories: z.array(deliveryUnitContractSchema).max(50).optional(),
  verdict: z.enum(['passed', 'failed', 'report_ready', 'ready_for_approval', 'changes_requested']).optional(),
  failureKind: z.enum(['implementation', 'specification', 'environment', 'inconclusive']).optional(),
  rewindTo: z.enum(['plan', 'analysis', 'dev', 'test']).optional(),
  rewindDeliveryUnit: z.number().int().positive().optional(),
  rewindStory: z.number().int().positive().optional(),
  changedFiles: z.array(z.string().min(1).max(1000)).max(500).optional(),
  feedback: feedbackResultSchema.optional(),
  feedbackResolutions: z.array(z.object({
    commentId: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    evidence: z.array(z.string().min(1).max(2000)).max(50).default([]),
  })).max(50).optional().default([]),
  recoveryResolutions: z.array(z.object({
    recoveryId: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),
    evidence: z.array(z.string().min(1).max(2000)).max(50).default([]),
  })).max(50).optional().default([]),
  tests: z.array(z.object({
    command: z.string().min(1).max(2000),
    passed: z.boolean(),
    summary: z.string().max(4000).optional().default(''),
  })).max(100).optional(),
})).transform((result) => {
  const deliveryUnits = result.deliveryUnits || result.stories;
  const rewindDeliveryUnit = result.rewindDeliveryUnit || result.rewindStory;
  const verdict = result.verdict === 'ready_for_approval' ? 'report_ready' as const : result.verdict;
  return {
    ...result,
    ...(verdict ? { verdict } : {}),
    ...(deliveryUnits ? { deliveryUnits } : {}),
    ...(rewindDeliveryUnit ? { rewindDeliveryUnit } : {}),
  };
});

export type AgentResult = z.infer<typeof agentResultSchema>;
export type DeliverySpec = z.infer<typeof deliverySpecSchema>;

export class AgentResultContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentResultContractError';
  }
}

function duplicateKeys(keys: string[]) {
  const seen = new Set<string>();
  return [...new Set(keys.filter((key) => seen.has(key) || !seen.add(key)))];
}

export function assertDeliverySpecDecisionCoverage(spec: DeliverySpec, questions?: AgentResult['questions']) {
  const sourceKeys = spec.unit.sourceRefs.map((source) => source.key);
  const duplicateSourceKeys = duplicateKeys(sourceKeys);
  if (duplicateSourceKeys.length) throw new Error(`交付规格的 source key 不能重复：${duplicateSourceKeys.join(', ')}`);
  const duplicateImpactKeys = duplicateKeys(spec.impacts.map((impact) => impact.key));
  if (duplicateImpactKeys.length) throw new Error(`交付规格的 impact key 不能重复：${duplicateImpactKeys.join(', ')}`);
  const duplicateGuardrailKeys = duplicateKeys(spec.handoff.guardrails.map((guardrail) => guardrail.key));
  if (duplicateGuardrailKeys.length) throw new Error(`交付规格的 guardrail key 不能重复：${duplicateGuardrailKeys.join(', ')}`);
  const duplicateFocusKeys = duplicateKeys(spec.handoff.verificationFocus.map((focus) => focus.key));
  if (duplicateFocusKeys.length) throw new Error(`交付规格的 verification focus key 不能重复：${duplicateFocusKeys.join(', ')}`);
  if (spec.handoff.verificationFocus.some((focus) => focus.key === 'unit-acceptance')) {
    throw new Error('unit-acceptance 是系统保留的交付单元验收 key');
  }
  const decisionKeys = spec.decisions.map((decision) => decision.key);
  const repeated = duplicateKeys(decisionKeys);
  if (repeated.length) throw new Error(`交付规格的 decision key 不能重复：${repeated.join(', ')}`);

  const decisionKeySet = new Set(decisionKeys);
  const unresolvedKeySet = new Set(spec.decisions
    .filter((decision) => decision.status === 'needs_user_input')
    .map((decision) => decision.key));
  for (const decision of spec.decisions) {
    const optionIds = decision.options.map((option) => option.id);
    const duplicateOptions = duplicateKeys(optionIds);
    if (duplicateOptions.length) throw new Error(`决策 ${decision.key} 的选项 id 不能重复：${duplicateOptions.join(', ')}`);
    if (decision.status === 'resolved' && decision.selectedOption && !optionIds.includes(decision.selectedOption)) {
      throw new Error(`决策 ${decision.key} 的 selectedOption 不在候选选项中`);
    }
    if (decision.status === 'resolved' && optionIds.length && !decision.selectedOption) {
      throw new Error(`决策 ${decision.key} 已记录候选选项但缺少 selectedOption`);
    }
    if (decision.status === 'needs_user_input' && !optionIds.includes(decision.recommendationOption)) {
      throw new Error(`决策 ${decision.key} 的 recommendationOption 不在候选选项中`);
    }
  }

  for (const impact of spec.impacts) {
    if (impact.decisionKey && !decisionKeySet.has(impact.decisionKey)) {
      throw new Error(`影响 ${impact.key} 引用了不存在的决策：${impact.decisionKey}`);
    }
    if (impact.disposition === 'needs_decision' && !impact.decisionKey) {
      throw new Error(`待决策影响 ${impact.key} 必须关联 decisionKey`);
    }
    if (impact.disposition === 'needs_decision' && impact.decisionKey && !unresolvedKeySet.has(impact.decisionKey)) {
      throw new Error(`待决策影响 ${impact.key} 必须关联尚未解决的决策`);
    }
  }

  if (questions === undefined) return;
  const missingQuestionKeys = questions.filter((question) => !question.decisionKey);
  if (missingQuestionKeys.length) throw new Error('交付分析 Agent 的每个问题都必须包含 decisionKey');
  const questionKeys = questions.map((question) => question.decisionKey!);
  const invalidQuestionKeys = questionKeys.filter((key) => !unresolvedKeySet.has(key));
  if (invalidQuestionKeys.length) throw new Error(`questions 引用了非待确认决策：${invalidQuestionKeys.join(', ')}`);
  const questionKeySet = new Set(questionKeys);
  const missingQuestions = [...unresolvedKeySet].filter((key) => !questionKeySet.has(key));
  if (missingQuestions.length) {
    throw new Error(`待确认决策缺少对应问题：${missingQuestions.join(', ')}`);
  }
  for (const question of questions) {
    const decision = spec.decisions.find((item) => item.key === question.decisionKey);
    if (!decision) continue;
    const optionIds = new Set(decision.options.map((option) => option.id));
    const unknownOptions = question.alternatives.filter((option) => !optionIds.has(option.id));
    if (unknownOptions.length) throw new Error(`问题 ${question.decisionKey} 引用了不存在的选项`);
  }
}

export function assertAgentResultRoleContract(result: AgentResult, agent: string) {
  const canAskAlignmentQuestions = agent === 'backlog-agent'
    || agent === 'analyst-agent'
    || agent === 'repro-agent'
    || agent === 'feedback-agent';
  if (agent === 'feedback-agent' && result.runtimeInputs.length) {
    throw new Error('feedback-agent 不能创建运行信息请求；无法安全分组时使用 questions');
  }
  if (agent === 'feedback-agent' && result.questions.length && result.feedback) {
    throw new Error('feedback-agent 不能在同一结果中同时提问和提交反馈分组');
  }
  if (agent === 'repro-agent' && result.runtimeInputs.length) {
    throw new Error('repro-agent 未复现时必须通过 questions 请求人工对齐，不能使用 runtimeInputs');
  }
  if (result.questions.length && !canAskAlignmentQuestions) {
    throw new Error(`${agent} 不允许创建业务或交付决策问题；运行所需信息请使用 runtimeInputs`);
  }
  if (canAskAlignmentQuestions && result.questions.length && result.outcome !== 'needs_input') {
    throw new Error(`${agent} 创建业务或交付决策问题时 outcome 必须为 needs_input`);
  }
  if (result.questions.length && result.runtimeInputs.length) throw new Error('同一次结果不能混合业务/交付决策问题和运行信息请求');
  if (result.runtimeInputs.length) {
    if (result.outcome !== 'needs_input') throw new Error('包含 runtimeInputs 时 outcome 必须为 needs_input');
    return;
  }
  if (agent === 'repro-agent' && result.outcome === 'needs_input') {
    if (result.reproVerdict !== 'not_reproduced' || !result.artifact || !result.questions.length || result.route) {
      throw new Error('未复现问题时必须保存证据、请求人工对齐且不能进入后续路由');
    }
  }
  if (agent === 'analyst-agent' && result.outcome === 'needs_input' && !result.questions.length) {
    throw new Error('交付分析 Agent 返回 needs_input 时必须提供与未决决策一一对应的 questions');
  }
  if (result.outcome !== 'completed' && !(canAskAlignmentQuestions && result.questions.length)) return;

  switch (agent) {
    case 'backlog-agent':
      if (result.questions.length) break;
      if (!result.classification || !result.route) throw new Error('backlog-agent 结果缺少 classification 或 route');
      break;
    case 'story-splitter-agent':
      if (!result.deliveryUnits?.length) throw new Error('交付规划 Agent 结果缺少 deliveryUnits');
      break;
    case 'analyst-agent':
      if (!result.artifact) throw new Error('analyst-agent 结果缺少 artifact');
      if (!result.spec) throw new Error('交付分析 Agent 结果缺少结构化交付规格');
      assertDeliverySpecDecisionCoverage(result.spec, result.questions);
      break;
    case 'repro-agent':
      if (!result.artifact) throw new Error('repro-agent 结果缺少 artifact');
      if (result.reproVerdict === 'not_reproduced') {
        if (result.outcome !== 'needs_input' || !result.questions.length) throw new Error('未复现问题时必须请求人工对齐');
        if (result.route) throw new Error('未复现问题时不能进入后续路由');
        break;
      }
      if (result.reproVerdict !== 'reproduced') throw new Error('repro-agent 结果缺少 reproVerdict');
      if (result.outcome !== 'completed' || result.route !== 'plan') throw new Error('只有成功复现后才能 route=plan');
      break;
    case 'test-agent':
      if (!result.verdict) throw new Error('验证 Agent 结果缺少 verdict');
      break;
    case 'review-agent':
      if (!result.artifact) throw new Error('review-agent 结果缺少 artifact');
      if (result.verdict !== 'report_ready') throw new Error('Review Agent 只能返回 verdict=report_ready；反馈判断由 Feedback Agent 负责，Application 执行路由');
      if (result.rewindTo || result.rewindDeliveryUnit) throw new Error('Review Agent 不得返回回退决策');
      break;
    case 'feedback-agent':
      if (!result.questions.length && !result.feedback) throw new Error('feedback-agent 结果缺少 feedback');
      break;
  }
}

function extractJsonObjects(text: string) {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function parseAgentResult(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Agent 最终回复为空');

  const candidates = [
    trimmed,
    ...Array.from(trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi), (match) => match[1].trim()).reverse(),
    ...extractJsonObjects(trimmed).reverse(),
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      return agentResultSchema.parse(JSON.parse(candidate));
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}
