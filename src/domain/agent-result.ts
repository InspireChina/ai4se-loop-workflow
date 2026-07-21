import { z } from 'zod';
import { omitNullObjectProperties } from './schema-normalization';

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
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().default(''),
  recommendation: z.string().max(2000).optional().default(''),
});

const deliveryUnitSchema = z.object({ title: z.string().min(1).max(200) });

const feedbackResultSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('triage'),
    commentId: z.string().min(1).max(200),
    disposition: z.enum(['no_change', 'reply', 'revise', 'rewind', 'learning_only']),
    targetStage: z.enum(['plan', 'analysis', 'dev', 'test', 'review']).optional(),
    targetAgent: z.string().min(1).max(120).optional(),
    targetDeliveryUnit: z.number().int().positive().optional(),
    reason: z.string().min(1).max(4000),
    acceptance: z.array(z.string().min(1).max(2000)).max(30).default([]),
  }),
  z.object({
    mode: z.literal('verify'),
    commentId: z.string().min(1).max(200),
    verdict: z.enum(['resolved', 'reopened']),
    reason: z.string().min(1).max(4000),
    evidence: z.array(z.string().min(1).max(2000)).max(50).default([]),
  }),
]);

const verificationStepBase = {
  criterionId: z.string().min(1).max(120),
  instruction: z.string().min(1).max(4000),
};

const decisionOptionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(240),
  consequences: z.array(z.string().min(1).max(1000)).min(1).max(20),
});

const decisionPointBase = {
  key: z.string().min(1).max(240),
  question: z.string().min(1).max(4000),
  impact: z.string().min(1).max(4000),
  options: z.array(decisionOptionSchema).min(2).max(20),
};

const decisionPointSchema = z.discriminatedUnion('status', [
  z.object({
    ...decisionPointBase,
    status: z.literal('resolved_from_context'),
    selectedOption: z.string().min(1).max(100),
    source: z.enum(['code', 'user', 'convention']),
    evidence: z.array(z.string().min(1).max(2000)).min(1).max(20),
  }),
  z.object({
    ...decisionPointBase,
    status: z.literal('needs_user_input'),
  }),
]);

export const sliceSpecSchema = z.preprocess(omitNullObjectProperties, z.object({
  goal: z.string().min(1).max(4000),
  scope: z.object({
    included: z.array(z.string().min(1).max(2000)).min(1).max(100),
    excluded: z.array(z.string().min(1).max(2000)).max(100).default([]),
  }),
  behaviors: z.array(z.object({
    scenario: z.string().min(1).max(2000),
    expected: z.string().min(1).max(4000),
  })).min(1).max(100),
  decisions: z.array(z.object({
    key: z.string().min(1).max(240),
    decision: z.string().min(1).max(4000),
    rationale: z.string().min(1).max(4000),
    source: z.enum(['code', 'user', 'convention', 'safe_default']),
  })).max(200).default([]),
  decisionTree: z.array(decisionPointSchema).max(200).default([]),
  ambiguities: z.array(z.object({
    key: z.string().min(1).max(240),
    description: z.string().min(1).max(4000),
  })).max(50).default([]),
  acceptanceCriteria: z.array(z.object({
    id: z.string().min(1).max(120),
    description: z.string().min(1).max(4000),
    oracle: z.string().min(1).max(4000),
  })).min(1).max(100),
  verificationPlan: z.array(z.discriminatedUnion('kind', [
    z.object({
      ...verificationStepBase,
      kind: z.literal('command'),
      command: z.string().min(1).max(2000),
    }),
    z.object({
      ...verificationStepBase,
      kind: z.literal('browser'),
      command: z.string().min(1).max(2000).optional(),
    }),
    z.object({
      ...verificationStepBase,
      kind: z.literal('inspection'),
      command: z.string().min(1).max(2000).optional(),
    }),
  ])).min(1).max(100),
  dependencies: z.array(z.string().min(1).max(1000)).max(100).default([]),
  changeBudget: z.object({
    capabilities: z.array(z.string().min(1).max(500)).max(100).default([]),
    paths: z.array(z.string().min(1).max(1000)).max(200).default([]),
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
  deliveryUnits: z.array(deliveryUnitSchema).max(50).optional(),
  spec: sliceSpecSchema.optional(),
  // Read-only compatibility for results queued before the terminology change.
  stories: z.array(deliveryUnitSchema).max(50).optional(),
  verdict: z.enum(['passed', 'failed', 'report_ready', 'ready_for_approval', 'changes_requested']).optional(),
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
export type SliceSpec = z.infer<typeof sliceSpecSchema>;

function duplicateKeys(keys: string[]) {
  const seen = new Set<string>();
  return [...new Set(keys.filter((key) => seen.has(key) || !seen.add(key)))];
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((key) => right.includes(key));
}

export function assertSliceSpecDecisionCoverage(spec: SliceSpec, questions?: AgentResult['questions']) {
  if (!spec.decisionTree.length) throw new Error('Slice Spec 必须包含完整 decisionTree，不能省略关键设计决策覆盖');

  const treeKeys = spec.decisionTree.map((point) => point.key);
  const decisionKeys = spec.decisions.map((decision) => decision.key);
  const ambiguityKeys = spec.ambiguities.map((ambiguity) => ambiguity.key);
  const repeated = [...new Set([
    ...duplicateKeys(treeKeys),
    ...duplicateKeys(decisionKeys),
    ...duplicateKeys(ambiguityKeys),
  ])];
  if (repeated.length) throw new Error(`Slice Spec 决策键不能重复：${repeated.join(', ')}`);

  const resolvedKeys = spec.decisionTree.filter((point) => point.status === 'resolved_from_context').map((point) => point.key);
  const unresolvedKeys = spec.decisionTree.filter((point) => point.status === 'needs_user_input').map((point) => point.key);
  if (!sameKeys(decisionKeys, resolvedKeys)) throw new Error('decisions 必须与 decisionTree 中 resolved_from_context 的决策一一对应');
  if (!sameKeys(ambiguityKeys, unresolvedKeys)) throw new Error('ambiguities 必须与 decisionTree 中 needs_user_input 的决策一一对应');

  const unsafeDefaults = spec.decisions.filter((decision) => decision.source === 'safe_default');
  if (unsafeDefaults.length) throw new Error(`关键设计决策不能使用 safe_default：${unsafeDefaults.map((decision) => decision.key).join(', ')}`);

  for (const point of spec.decisionTree) {
    const optionIds = point.options.map((option) => option.id);
    const duplicateOptions = duplicateKeys(optionIds);
    if (duplicateOptions.length) throw new Error(`决策 ${point.key} 的选项 id 不能重复：${duplicateOptions.join(', ')}`);
    if (point.status !== 'resolved_from_context') continue;
    if (!optionIds.includes(point.selectedOption)) throw new Error(`决策 ${point.key} 的 selectedOption 不在候选选项中`);
    const decision = spec.decisions.find((item) => item.key === point.key);
    if (!decision || decision.source !== point.source) throw new Error(`决策 ${point.key} 的结论来源与 decisionTree 不一致`);
  }

  if (questions === undefined) return;
  const missingQuestionKeys = questions.filter((question) => !question.decisionKey);
  if (missingQuestionKeys.length) throw new Error('方案分析 Agent 的每个问题都必须包含 decisionKey');
  const questionKeys = questions.map((question) => question.decisionKey!);
  const repeatedQuestions = duplicateKeys(questionKeys);
  if (repeatedQuestions.length) throw new Error(`方案分析 Agent 的问题 decisionKey 不能重复：${repeatedQuestions.join(', ')}`);
  if (!sameKeys(questionKeys, unresolvedKeys)) throw new Error('questions 必须与 decisionTree 中 needs_user_input 的决策一一对应');
  for (const question of questions) {
    const point = spec.decisionTree.find((item) => item.key === question.decisionKey)!;
    const questionOptionIds = question.alternatives.map((option) => option.id);
    const treeOptionIds = point.options.map((option) => option.id);
    if (!sameKeys(questionOptionIds, treeOptionIds)) throw new Error(`问题 ${question.decisionKey} 的选项必须与 decisionTree 一致`);
    for (const treeOption of point.options) {
      const questionOption = question.alternatives.find((option) => option.id === treeOption.id)!;
      if (questionOption.label !== treeOption.label || !sameKeys(questionOption.consequences, treeOption.consequences)) {
        throw new Error(`问题 ${question.decisionKey} 的选项说明和后果必须与 decisionTree 一致`);
      }
    }
  }
}

export function assertAgentResultRoleContract(result: AgentResult, agent: string) {
  const canAskAlignmentQuestions = agent === 'backlog-agent' || agent === 'analyst-agent';
  if (agent === 'feedback-agent' && (result.questions.length || result.runtimeInputs.length)) {
    throw new Error('feedback-agent 不能创建设计问题或运行信息请求');
  }
  if (result.questions.length && !canAskAlignmentQuestions) {
    throw new Error(`${agent} 不允许创建设计澄清问题；运行所需信息请使用 runtimeInputs`);
  }
  if (canAskAlignmentQuestions && result.questions.length && result.outcome !== 'needs_input') {
    throw new Error(`${agent} 创建设计澄清问题时 outcome 必须为 needs_input`);
  }
  if (result.questions.length && result.runtimeInputs.length) throw new Error('同一次结果不能混合设计澄清问题和运行信息请求');
  if (result.runtimeInputs.length) {
    if (result.outcome !== 'needs_input') throw new Error('包含 runtimeInputs 时 outcome 必须为 needs_input');
    return;
  }
  if (agent === 'analyst-agent' && result.outcome === 'needs_input' && !result.questions.length) {
    throw new Error('方案分析 Agent 返回 needs_input 时必须提供与未决决策一一对应的 questions');
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
      if (!result.spec) throw new Error('方案分析 Agent 结果缺少结构化 Slice Spec');
      assertSliceSpecDecisionCoverage(result.spec, result.questions);
      break;
    case 'repro-agent':
      if (!result.artifact) throw new Error('repro-agent 结果缺少 artifact');
      if (result.route !== 'plan') throw new Error('repro-agent 完成后必须 route=plan');
      break;
    case 'test-agent':
      if (!result.verdict) throw new Error('验证 Agent 结果缺少 verdict');
      break;
    case 'review-agent':
      if (!result.artifact) throw new Error('review-agent 结果缺少 artifact');
      if (result.verdict === 'changes_requested') {
        if (!result.rewindTo) throw new Error('Review Agent 请求修改时必须提供 rewindTo');
        if (result.rewindTo !== 'plan' && !result.rewindDeliveryUnit) throw new Error('Review Agent 回退单元阶段时必须提供 rewindDeliveryUnit');
      } else if (result.verdict !== 'report_ready') {
        throw new Error('Review Agent 必须返回 verdict=report_ready 或 changes_requested');
      }
      break;
    case 'feedback-agent':
      if (!result.feedback) throw new Error('feedback-agent 结果缺少 feedback');
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
