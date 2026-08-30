import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import type { DelegationEnvelope } from './tasks';

const put = (artifact: string, block: string, content: string, key?: string) => [
  'artifact', 'put', '--artifact', artifact, '--block', block,
  ...(key ? ['--key', key] : []), '--content', content,
];

const yaml = (value: Record<string, unknown>) => JSON.stringify(value);

async function startAgent(delegation: DelegationEnvelope, suffix: string) {
  const { issueAgentCommandToken, runAgentCommand } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-ba-yaml-${suffix}`,
    delegation,
    prompt: 'YAML command chain Business Analysis test',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  const run = (args: string[]) => runAgentCommand({
    executionId: started.attempt.execution_id,
    token,
    args,
  });
  assert.match(await run(['status']), /NEXT WORK PACKET/);
  return { started, run };
}

async function executeAgent(delegation: DelegationEnvelope, commands: string[][], suffix: string) {
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const { started, run } = await startAgent(delegation, suffix);
  for (const command of commands) await run(command);
  const result = await readAgentCommandSubmission(started.attempt.execution_id);
  assert.ok(result, `${delegation.agent} did not submit an Agent Result`);
  await applyAgentResult(`RUN-ba-yaml-${suffix}`, delegation, result, {
    executionId: started.attempt.execution_id,
  });
  await completeExecution(started.attempt.execution_id);
  return result;
}

function intentSynthesisCommands(summary: string) {
  return [
    put('requirement-intent', 'problem', `# 核心问题\n\n${summary}`),
    put('requirement-intent', 'actors', yaml({ name: '项目成员', role: '风险处理者', need: '尽早理解项目健康风险并采取行动' }), 'project-member'),
    put('requirement-intent', 'goals', yaml({ content: '在风险扩大前识别项目健康异常', source: '原始需求' }), 'early-risk'),
    put('requirement-intent', 'success', yaml({ outcome: '项目成员看到可解释的健康风险', measure: '每个风险均有依据与建议行动' }), 'observable-risk'),
    ['phase', 'complete'],
    ['phase', 'complete'],
  ];
}

function intentCommands(summary: string) {
  return [
    put('requirement-intent', 'discovery', `# 调查\n\n${summary}`),
    ['phase', 'complete'],
    put('requirement-intent', 'research-sources', yaml({
      claim: '项目健康风险需要在扩大前被识别。',
      sourceTitle: '项目健康指南',
      sourceUrl: 'https://example.com/project-health',
      applicability: '用于界定可观察的风险结果。',
      limitations: '不替代当前项目事实。',
      confidence: 'high',
    }), 'research-source-internal-key'),
    ['phase', 'complete'],
    ['phase', 'complete'],
    ['phase', 'complete'],
    put('requirement-intent', 'answer-review', '全部适用分支已经检查，没有新的需求意图问题。'),
    ['phase', 'complete'],
    ...intentSynthesisCommands(summary),
  ];
}

function designCommands(summary: string) {
  return [
    put('business-solution', 'exploration', '# 探索\n\n覆盖项目状态、风险信号、解释、异常与后续行动。'),
    ['phase', 'complete'],
    ['phase', 'complete'],
    ['phase', 'complete'],
    ['phase', 'complete'],
    put('business-solution', 'answer-review', '全部业务分支已经检查，没有新的业务决定。'),
    ['phase', 'complete'],
    put('business-solution', 'summary', summary),
    put('business-solution', 'actors', yaml({ name: '项目成员', responsibility: '发起体检并处理风险' }), 'project-member'),
    put('business-solution', 'scenarios', yaml({ kind: 'main', actor: '项目成员', trigger: '需要了解项目健康状态', outcome: summary }), 'main-flow'),
    put('business-solution', 'flows', yaml({ scenario: 'main-flow', action: '发起项目体检并阅读分项结果', result: summary }), 'inspect-health'),
    put('business-solution', 'rules', yaml({ content: '每个风险必须展示业务依据', rationale: '结果需要可解释且可行动' }), 'traceable-risk'),
    put('business-solution', 'scope', yaml({ direction: 'included', content: '项目级健康体检与风险解释' }), 'project-health'),
    put('business-solution', 'success', yaml({ outcome: summary, measure: '用户可以理解并采取行动' }), 'actionable-result'),
    ['phase', 'complete'],
    ['phase', 'complete'],
  ];
}

function specificationCommands(specification: string) {
  return [
    put('requirement-specification', 'draft', specification),
    ['phase', 'complete'],
    put('requirement-specification', 'verification', '已检查目标覆盖、决策继承、场景、规则、范围与验收一致性。'),
    put('requirement-specification', 'final', specification),
    ['phase', 'complete'],
    ['phase', 'complete'],
  ];
}

function reviewCommands(specification: string) {
  return [
    put('specification-review', 'findings', yaml({
      subject: '目标、场景、规则、范围、验收与来源追踪',
      verdict: 'passed',
      evidence: '需求意图、业务方案与最终规格逐项一致',
      reason: '没有发现阻断规格成立的缺口',
    }), 'complete-review'),
    ['phase', 'complete'],
    ['phase', 'complete'],
    put('specification-review', 'verdict-summary', '需求规格完整、一致、可追踪且可验证。'),
    put('specification-review', 'approved-specification', specification),
    ['phase', 'complete'],
    ['phase', 'complete'],
  ];
}

const specification = [
  '# AS IS', '', '项目成员缺少统一的健康风险视图。', '',
  '# TO BE', '', '项目成员可发起项目体检并查看分项状态、风险依据和建议行动。', '',
  '# ACTORS', '', '项目成员。', '',
  '# SCENARIOS', '', '发起体检并阅读结果；异常时展示无法取得的检查项。', '',
  '# BUSINESS RULES', '', '每个风险必须展示依据。', '',
  '# SCOPE', '', '项目级体检结果。', '',
  '# OUT OF SCOPE', '', '自动修复。', '',
  '# ACCEPTANCE', '', '用户可以看到分项状态、风险依据和建议行动。', '',
  '# DEPENDENCIES', '', '无。', '',
  '# ASSUMPTIONS', '', '用户可以访问目标项目。',
].join('\n');

test('declares every End-to-End Agent command chain in YAML', async () => {
  const { REQUIREMENT_PIPELINES } = await import('../domain/pipeline-catalog');
  const { agentCommandChains, agentCommandProfiles } = await import('../domain/agent-command-profile');
  const { commandChainCatalogItem } = await import('../domain/command-chain-catalog');
  const { loadCommandChainDefinition } = await import('../domain/command-chain-definition');
  const endToEnd = REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === 'end-to-end');
  assert.ok(endToEnd);
  const agents = endToEnd.stages.flatMap((stage) => stage.agentId ? [stage.agentId] : []);
  assert.deepEqual(agents, [
    'idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent',
    'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'dev-agent', 'test-agent', 'review-agent',
  ]);
  for (const agent of agents) {
    const profiles = agentCommandProfiles().filter((profile) => profile.agent === agent);
    assert.equal(profiles.length, 1, `${agent} must have exactly one End-to-End command profile`);
    assert.ok(profiles[0].commandChainId, `${agent} profile is not bound to YAML`);
    const catalog = commandChainCatalogItem(profiles[0].commandChainId!);
    assert.ok(catalog, `${agent} command chain is missing from the catalog`);
    assert.equal(catalog.agentId, agent);
    assert.match(catalog.fileName, new RegExp(`^${agent}\\.yaml$`));
    assert.equal(loadCommandChainDefinition(catalog.id).agent, agent);
    const chains = agentCommandChains(agent);
    assert.equal(chains.length, 1, `${agent} must expose one YAML command chain`);
    for (const chain of chains) {
      assert.equal(chain.entryCommand, 'status');
      assert.ok(chain.phases.length > 0);
    }
  }
  for (const id of ['idea-context', 'business-design', 'requirement-spec', 'spec-review']) {
    const definition = loadCommandChainDefinition(id);
    assert.equal(definition.phases[Object.keys(definition.phases).at(-1)!].builtin, 'business-analysis-finalize');
  }
});

test('rejects undeclared fields before an Artifact Block can enter the rendered document', async () => {
  const { createTask } = await import('./tasks');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const taskId = await createTask({
    title: '拒绝未声明的产物字段',
    itemType: 'end-to-end',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });
  const delegation = (await inspectTaskDispatch(taskId))[0];
  const { started, run } = await startAgent(delegation, `${taskId}-strict-artifact`);
  await run(put('requirement-intent', 'discovery', '已完成调查。'));
  await run(['phase', 'complete']);
  await assert.rejects(
    run(put('requirement-intent', 'research-sources', yaml({
      claim: '已查明事实。',
      sourceTitle: '来源',
      sourceUrl: 'https://example.com/source',
      applicability: '适用于当前需求。',
      limitations: '不替代项目证据。',
      confidence: 'high',
      debugOnly: '不能进入产物',
    }), 'source')),
    /包含未声明字段：debugOnly/,
  );
  for (const command of [
    ['phase', 'complete'],
    ['phase', 'complete'],
    ['phase', 'complete'],
    put('requirement-intent', 'answer-review', '没有新的问题。'),
    ['phase', 'complete'],
    ...intentSynthesisCommands('形成严格、可读的需求意图。'),
  ]) await run(command);
  const result = await readAgentCommandSubmission(started.attempt.execution_id);
  assert.ok(result);
  await applyAgentResult(`RUN-ba-yaml-${taskId}-strict-artifact`, delegation, result, {
    executionId: started.attempt.execution_id,
  });
  await completeExecution(started.attempt.execution_id);
});

test('runs the End-to-End Business Analysis front half through YAML command chains', async () => {
  const { createTask, getTask } = await import('./tasks');
  const taskId = await createTask({
    title: '从想法自动交付项目体检能力',
    description: '从模糊想法开始形成可执行需求规格，并自动进入开发交付。',
    itemType: 'end-to-end',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });

  let delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'idea-context-agent');
  const intent = await executeAgent(delegation, intentCommands('帮助项目成员在风险扩大前识别健康异常。'), `${taskId}-intent`);
  assert.equal(intent.businessAnalysis?.stage, 'intent');
  assert.match(intent.artifact?.content || '', /^# 需求意图简报/);
  assert.match(intent.artifact?.content || '', /## 调研依据/);
  assert.match(intent.artifact?.content || '', /项目健康风险需要在扩大前被识别。/);
  assert.match(intent.artifact?.content || '', /\*\*来源\*\*：\[项目健康指南\]\(https:\/\/example\.com\/project-health\)/);
  assert.match(intent.artifact?.content || '', /\*\*置信度\*\*：高/);
  assert.doesNotMatch(intent.artifact?.content || '', /research-source-internal-key/);
  assert.doesNotMatch(intent.artifact?.content || '', /## 意图调查|## 答案复查/);
  assert.match(intent.artifact?.content || '', /## 问题与背景\n\n### 核心问题/);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  const design = await executeAgent(delegation, designCommands('项目成员可发起体检，查看分项状态、风险依据和建议行动。'), `${taskId}-design`);
  assert.equal(design.businessAnalysis?.stage, 'business_design');
  assert.match(design.artifact?.content || '', /## 主流程与异常场景/);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'requirement-spec-agent');
  const spec = await executeAgent(delegation, specificationCommands(specification), `${taskId}-spec`);
  assert.equal(spec.artifact?.content, specification);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'spec-review-agent');
  const review = await executeAgent(delegation, reviewCommands(specification), `${taskId}-review`);
  assert.equal(review.businessAnalysis?.disposition, 'approved');

  const detail = await getTask(taskId);
  assert.equal(detail?.task.current_subagent, 'backlog-agent');
  assert.equal(detail?.task.run_state, 'runnable');
  assert.match(detail?.documents.find((document) => document.kind === 'ba_review')?.content || '', /# ACCEPTANCE/);
});

test('uses generic Decision commands for Business Analysis HUMAN clarification and resume', async () => {
  const { answerQuestion, createTask, getTask, submitClarificationAnswers } = await import('./tasks');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const taskId = await createTask({
    title: '确认项目体检的主要参与者',
    description: '需要明确体检首先帮助谁采取行动。',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'balanced' }],
  });
  let delegation = (await inspectTaskDispatch(taskId))[0];
  const first = await startAgent(delegation, `${taskId}-question-1`);
  await first.run(put('requirement-intent', 'discovery', '# 调查\n\n主要参与者会改变成功结果。'));
  await first.run(['phase', 'complete']);
  await first.run(['phase', 'complete']);
  await first.run([
    'decision', 'put', '--tree', 'decisions', '--key', 'primary-actor', '--content', yaml({
      type: 'business',
      title: '主要目标参与者',
      question: '项目体检首先帮助谁采取行动？',
      impact: '参与者不同会改变结果表达和成功标准。',
      options: [
        { id: 'lead', label: '项目负责人', consequence: '集中承担风险处置' },
        { id: 'team', label: '全体项目成员', consequence: '团队共同识别和处置风险' },
      ],
      recommendation: { option: 'team', reason: '项目健康风险需要团队共同消化和行动。', authority: 'agent_authority' },
      dependencies: [],
    }),
  ]);
  await first.run(['phase', 'complete']);
  await first.run(['decision', 'ask', '--tree', 'decisions', '--key', 'primary-actor']);
  await first.run(['phase', 'complete']);
  const waiting = await readAgentCommandSubmission(first.started.attempt.execution_id);
  assert.equal(waiting?.outcome, 'needs_input');
  assert.equal(waiting?.questions[0]?.decisionKey, 'primary-actor');
  await applyAgentResult(`RUN-ba-yaml-${taskId}-question-1`, delegation, waiting!, {
    executionId: first.started.attempt.execution_id,
  });
  await completeExecution(first.started.attempt.execution_id);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'primary-actor');
  assert.ok(question);
  await answerQuestion({ taskId, questionId: question.question_id, answer: '全体项目成员共同处理。' });
  await submitClarificationAnswers(taskId);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.pipeline, 'resume');
  const resumed = await startAgent(delegation, `${taskId}-question-2`);
  await resumed.run([
    'decision', 'resolve', '--tree', 'decisions', '--key', 'primary-actor', '--option', 'team',
    '--authority', 'user', '--decision', '全体项目成员共同处理', '--rationale', '继承用户回答', '--evidence', '用户澄清答案',
  ]);
  await resumed.run(['phase', 'complete']);
  await resumed.run(put('requirement-intent', 'answer-review', '用户答案没有引入新的需求意图分支。'));
  await resumed.run(['phase', 'complete']);
  for (const command of intentSynthesisCommands('帮助全体项目成员共同识别并处理项目健康风险。')) await resumed.run(command);
  const completed = await readAgentCommandSubmission(resumed.started.attempt.execution_id);
  assert.equal(completed?.businessAnalysis?.disposition, 'advance');
  await applyAgentResult(`RUN-ba-yaml-${taskId}-question-2`, delegation, completed!, {
    executionId: resumed.started.attempt.execution_id,
  });
  await completeExecution(resumed.started.attempt.execution_id);
  detail = await getTask(taskId);
  assert.equal(detail?.task.current_subagent, 'business-design-agent');
});

test('routes structured Business Analysis gaps without namespace-specific terminal commands', async () => {
  const { createTask, getTask } = await import('./tasks');
  const taskId = await createTask({
    title: '业务方案发现需求意图缺口',
    description: '先形成意图，再由业务方案判断是否足以唯一设计。',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });
  let delegation = (await inspectTaskDispatch(taskId))[0];
  await executeAgent(delegation, intentCommands('帮助项目成员理解项目健康。'), `${taskId}-intent`);
  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  const result = await executeAgent(delegation, [
    put('business-solution', 'exploration', '# 探索\n\n成功结果缺少可判断边界，不能形成唯一业务方案。'),
    ['phase', 'complete'],
    ['phase', 'complete'],
    ['phase', 'complete'],
    ['phase', 'complete'],
    put('business-solution', 'answer-review', '没有活动决策，但上游成功结果仍不足。'),
    ['phase', 'complete'],
    put('business-solution', 'upstream-gaps', yaml({ reason: '缺少成功结果的可判断边界', evidence: '需求意图只表达“理解健康”，没有定义何时算成功' }), 'success-boundary'),
    ['phase', 'complete'],
    ['phase', 'complete'],
  ], `${taskId}-gap`);
  assert.equal(result.businessAnalysis?.disposition, 'return_revision');
  assert.equal(result.businessAnalysis?.target, 'intent');
  assert.equal((await getTask(taskId))?.task.current_subagent, 'idea-context-agent');
});
