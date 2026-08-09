import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

async function executeBusinessAnalysisAgent(
  delegation: DelegationEnvelope,
  commands: string[][],
  suffix: string,
) {
  const { beginExecutionAttempt, completeExecution } = await import('./executions');
  const {
    issueAgentCommandToken,
    readAgentCommandSubmission,
    runAgentCommand,
  } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const started = await beginExecutionAttempt({
    runId: `RUN-ba-${suffix}`,
    delegation,
    prompt: 'Business Analysis progressive command test',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  const run = (args: string[]) => runAgentCommand({
    executionId: started.attempt.execution_id,
    token,
    args,
  });
  assert.match(await run([delegation.agent === 'idea-context-agent' ? 'idea-context'
    : delegation.agent === 'business-design-agent' ? 'business-design'
      : delegation.agent === 'requirement-spec-agent' ? 'requirement-spec'
        : 'spec-review', 'status']), /NEXT WORK PACKET/);
  for (const command of commands) await run(command);
  const result = await readAgentCommandSubmission(started.attempt.execution_id);
  assert.ok(result);
  await applyAgentResult(`RUN-ba-${suffix}`, delegation, result, {
    executionId: started.attempt.execution_id,
  });
  await completeExecution(started.attempt.execution_id);
  return result;
}

test('runs Business Analysis from a raw idea to an independently approved requirement specification', async () => {
  const { acknowledgeClosure, createTask, getTask, pipelineForTask } = await import('./tasks');
  const taskId = await createTask({
    title: '让团队更早发现项目健康风险',
    description: '希望有一个项目体检能力，但目标用户、检查内容和结果形态尚未确定。',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });

  let delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'idea-context-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['idea-context', 'discovery', 'complete', '--artifact', '# 调查\n\n团队需要更早识别项目健康风险。'],
    ['idea-context', 'clarification-proposal', 'complete', '--artifact', JSON.stringify({ summary: '目标可以从现有想法唯一归纳', questions: [] })],
    ['idea-context', 'synthesis', 'complete', '--artifact', '# 需求意图简报\n\n帮助项目团队在风险扩大前识别健康异常，并获得可采取行动的解释。'],
    ['idea-context', 'complete'],
  ], `${taskId}-intent`);

  delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  const designStatus = await executeBusinessAnalysisAgent(delegation, [
    ['business-design', 'exploration', 'complete', '--artifact', '# 探索\n\n覆盖项目状态、风险信号、解释与后续行动。'],
    ['business-design', 'decision-proposal', 'complete', '--artifact', JSON.stringify({ summary: '当前没有必须分叉的业务决定', questions: [] })],
    ['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify({ notes: '没有活动决策节点', agentDecisions: [], humanDecisionKeys: [] })],
    ['business-design', 'solution', 'complete', '--artifact', '# 业务方案\n\n项目成员可发起体检，查看分项状态、风险依据和建议行动。'],
    ['business-design', 'complete'],
  ], `${taskId}-design`);
  assert.equal(designStatus.businessAnalysis?.stage, 'business_design');

  const specification = '# AS IS\n\n项目成员缺少统一的健康风险视图。\n\n# TO BE\n\n项目成员可发起项目体检并查看分项状态、风险依据和建议行动。\n\n# ACTORS\n\n项目成员。\n\n# SCENARIOS\n\n发起体检并阅读结果。\n\n# BUSINESS RULES\n\n每个风险必须展示依据。\n\n# SCOPE\n\n项目级体检结果。\n\n# OUT OF SCOPE\n\n自动修复。\n\n# ACCEPTANCE\n\n用户可以看到分项状态、风险依据和建议行动。\n\n# DEPENDENCIES\n\n无。\n\n# ASSUMPTIONS\n\n用户可以访问目标项目。';
  delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'requirement-spec-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['requirement-spec', 'composition', 'complete', '--artifact', specification],
    ['requirement-spec', 'verification', 'complete', '--artifact', specification],
    ['requirement-spec', 'complete'],
  ], `${taskId}-spec`);

  delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'spec-review-agent');
  const review = await executeBusinessAnalysisAgent(delegation, [
    ['spec-review', 'inspection', 'complete', '--artifact', '# 独立审查\n\n规格忠实继承需求意图和业务方案。'],
    ['spec-review', 'classification', 'complete', '--artifact', JSON.stringify({ summary: '没有阻断缺口', gaps: [] })],
    ['spec-review', 'approve', '--artifact', specification],
  ], `${taskId}-review`);
  assert.equal(review.businessAnalysis?.disposition, 'approved');

  const ready = await getTask(taskId);
  assert.equal(ready?.task.agile_status, 'ready_to_close');
  assert.equal(ready?.task.closure_status, 'awaiting_read');
  assert.equal((await pipelineForTask(taskId)).length, 0);
  assert.match(ready?.documents.find((document) => document.document_id === ready.task.review_document_id)?.content || '', /# ACCEPTANCE/);

  await acknowledgeClosure({ taskId, reviewRevision: ready!.task.review_revision });
  assert.equal((await getTask(taskId))?.task.agile_status, 'done');
});

test('resumes the same Business Design decision packet after one batched human alignment', async () => {
  const {
    answerQuestion,
    createTask,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
    updateTask,
  } = await import('./tasks');
  const { beginExecutionAttempt, completeExecution } = await import('./executions');
  const {
    issueAgentCommandToken,
    readAgentCommandSubmission,
    runAgentCommand,
  } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const taskId = await createTask({
    title: '确定项目体检结果对谁可见',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'balanced' }],
  });
  await updateTask(taskId, 'human', { current_subagent: 'business-design-agent' });
  const proposal = {
    summary: '结果可见范围会改变隐私边界，需要用户决定',
    questions: [{
      key: 'result-visibility',
      title: '体检结果可见范围',
      question: '项目体检结果默认对谁可见？',
      impact: '这会改变团队透明度和敏感信息暴露范围。',
      options: [{ id: 'initiator', label: '仅发起人', consequences: ['隐私更强'] }, { id: 'members', label: '项目成员', consequences: ['团队可共同处理风险'] }],
      recommendationOption: 'members',
      recommendationReason: '体检目标是让团队共同识别并处理风险。',
      proposedAuthority: 'human',
      activation: [],
    }],
  };
  const resolution = {
    notes: '该节点改变用户可观察权限边界，交给 HUMAN。',
    agentDecisions: [],
    humanDecisionKeys: ['result-visibility'],
  };

  let delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  const first = await beginExecutionAttempt({ runId: `RUN-ba-human-${taskId}-1`, delegation, prompt: 'Business decision proposal' });
  const firstToken = await issueAgentCommandToken(first.attempt.execution_id);
  assert.ok(firstToken);
  const firstRun = (args: string[]) => runAgentCommand({ executionId: first.attempt.execution_id, token: firstToken, args });
  const initialStatus = await firstRun(['business-design', 'status']);
  assert.doesNotMatch(initialStatus, /Decision Mode/);
  await firstRun(['business-design', 'exploration', 'complete', '--artifact', '# 探索\n\n体检结果需要明确可见边界。']);
  const resolutionPacket = await firstRun(['business-design', 'decision-proposal', 'complete', '--artifact', JSON.stringify(proposal)]);
  assert.match(resolutionPacket, /Decision Mode: balanced/);
  assert.match(resolutionPacket, /Policy Scope: 仅在当前 DECISION RESOLUTION/);
  const requestNext = await firstRun(['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify(resolution)]);
  assert.match(requestNext, /business-design request-clarification/);
  await firstRun(['business-design', 'request-clarification']);
  const needsInput = await readAgentCommandSubmission(first.attempt.execution_id);
  assert.equal(needsInput?.outcome, 'needs_input');
  await applyAgentResult(`RUN-ba-human-${taskId}-1`, delegation, needsInput!, { executionId: first.attempt.execution_id });
  await completeExecution(first.attempt.execution_id);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'result-visibility');
  assert.equal(question?.status, 'pending');
  await answerQuestion({ taskId, questionId: question!.question_id, selectedOptionId: 'members' });
  await submitClarificationAnswers(taskId);

  delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.pipeline, 'resume');
  const resumed = await beginExecutionAttempt({ runId: `RUN-ba-human-${taskId}-2`, delegation, prompt: 'Business decision resume' });
  const resumedToken = await issueAgentCommandToken(resumed.attempt.execution_id);
  assert.ok(resumedToken);
  const resumedRun = (args: string[]) => runAgentCommand({ executionId: resumed.attempt.execution_id, token: resumedToken, args });
  const restored = await resumedRun(['business-design', 'status']);
  assert.match(restored, /Phase: decision_resolution/);
  const advanced = await resumedRun(['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify(resolution)]);
  assert.match(advanced, /To: solution/);
  await resumedRun(['business-design', 'solution', 'complete', '--artifact', '# 业务方案\n\n项目成员默认可以共同查看体检结果。']);
  await resumedRun(['business-design', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.attempt.execution_id);
  assert.equal(completed?.businessAnalysis?.disposition, 'advance');
  await applyAgentResult(`RUN-ba-human-${taskId}-2`, delegation, completed!, { executionId: resumed.attempt.execution_id });
  await completeExecution(resumed.attempt.execution_id);
  detail = await getTask(taskId);
  assert.equal(detail?.task.current_subagent, 'requirement-spec-agent');
  assert.equal(detail?.questions.find((item) => item.decision_key === 'result-visibility')?.selected_option_id, 'members');
});
