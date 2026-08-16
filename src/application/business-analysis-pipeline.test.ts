import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectAllDispatch, inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

async function executeBusinessAnalysisAgent(
  delegation: DelegationEnvelope,
  commands: string[][],
  suffix: string,
) {
  const { completeExecution } = await import('./executions');
  const {
    issueAgentCommandToken,
    readAgentCommandSubmission,
    runAgentCommand,
  } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const started = await beginTestExecutionAttempt({
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
  const { acknowledgeClosure, createTask, getTask } = await import('./tasks');
  const taskId = await createTask({
    title: '让团队更早发现项目健康风险',
    description: '希望有一个项目体检能力，但目标用户、检查内容和结果形态尚未确定。',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });

  let delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'idea-context-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['idea-context', 'discovery', 'complete', '--artifact', '# 调查\n\n团队需要更早识别项目健康风险。'],
    ['idea-context', 'clarification-proposal', 'complete', '--artifact', JSON.stringify({ summary: '目标可以从现有想法唯一归纳', questions: [] })],
    ['idea-context', 'synthesis', 'complete', '--artifact', '# 需求意图简报\n\n帮助项目团队在风险扩大前识别健康异常，并获得可采取行动的解释。'],
    ['idea-context', 'complete'],
  ], `${taskId}-intent`);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  const designStatus = await executeBusinessAnalysisAgent(delegation, [
    ['business-design', 'exploration', 'complete', '--artifact', '# 探索\n\n覆盖项目状态、风险信号、解释与后续行动。'],
    ['business-design', 'decision-proposal', 'complete', '--artifact', JSON.stringify({ summary: '当前没有必须分叉的业务决定', questions: [] })],
    ['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify({ notes: '没有活动决策节点', agentDecisions: [], humanDecisionKeys: [] })],
    ['business-design', 'decision-resolution', 'audit-complete', '--artifact', '# 答案审查\n\n当前没有活动决策节点，也没有新增业务语义。'],
    ['business-design', 'solution', 'complete', '--artifact', '# 业务方案\n\n项目成员可发起体检，查看分项状态、风险依据和建议行动。'],
    ['business-design', 'complete'],
  ], `${taskId}-design`);
  assert.equal(designStatus.businessAnalysis?.stage, 'business_design');

  const specification = '# AS IS\n\n项目成员缺少统一的健康风险视图。\n\n# TO BE\n\n项目成员可发起项目体检并查看分项状态、风险依据和建议行动。\n\n# ACTORS\n\n项目成员。\n\n# SCENARIOS\n\n发起体检并阅读结果。\n\n# BUSINESS RULES\n\n每个风险必须展示依据。\n\n# SCOPE\n\n项目级体检结果。\n\n# OUT OF SCOPE\n\n自动修复。\n\n# ACCEPTANCE\n\n用户可以看到分项状态、风险依据和建议行动。\n\n# DEPENDENCIES\n\n无。\n\n# ASSUMPTIONS\n\n用户可以访问目标项目。';
  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'requirement-spec-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['requirement-spec', 'composition', 'complete', '--artifact', specification],
    ['requirement-spec', 'verification', 'complete', '--artifact', specification],
    ['requirement-spec', 'complete'],
  ], `${taskId}-spec`);

  delegation = (await inspectTaskDispatch(taskId))[0];
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
  assert.equal((await inspectTaskDispatch(taskId)).length, 0);
  assert.match(ready?.documents.find((document) => document.document_id === ready.task.review_document_id)?.content || '', /# ACCEPTANCE/);

  await acknowledgeClosure({ taskId, reviewRevision: ready!.task.review_revision });
  assert.equal((await getTask(taskId))?.task.agile_status, 'done');
});

test('hands an approved End to End specification directly to Develop without human acknowledgement', async () => {
  const { createTask, getTask } = await import('./tasks');
  const taskId = await createTask({
    title: '从想法自动交付项目体检能力',
    description: '从模糊想法开始完成业务分析，并自动进入开发交付。',
    itemType: 'end-to-end',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });

  let delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'idea-context-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['idea-context', 'discovery', 'complete', '--artifact', '# 调查\n\n团队需要更早识别项目健康风险。'],
    ['idea-context', 'clarification-proposal', 'complete', '--artifact', JSON.stringify({ summary: '目标可以唯一归纳', questions: [] })],
    ['idea-context', 'synthesis', 'complete', '--artifact', '# 需求意图简报\n\n帮助项目团队在风险扩大前识别健康异常。'],
    ['idea-context', 'complete'],
  ], `${taskId}-intent`);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['business-design', 'exploration', 'complete', '--artifact', '# 探索\n\n覆盖状态、风险依据和建议行动。'],
    ['business-design', 'decision-proposal', 'complete', '--artifact', JSON.stringify({ summary: '没有必须分叉的决定', questions: [] })],
    ['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify({ notes: '没有活动决策节点', agentDecisions: [], humanDecisionKeys: [] })],
    ['business-design', 'decision-resolution', 'audit-complete', '--artifact', '# 答案审查\n\n没有新增业务语义。'],
    ['business-design', 'solution', 'complete', '--artifact', '# 业务方案\n\n项目成员可发起体检并查看风险依据和建议行动。'],
    ['business-design', 'complete'],
  ], `${taskId}-design`);

  const specification = '# AS IS\n\n缺少统一健康风险视图。\n\n# TO BE\n\n项目成员可查看体检结果。\n\n# ACTORS\n\n项目成员。\n\n# SCENARIOS\n\n发起并阅读体检。\n\n# BUSINESS RULES\n\n风险必须展示依据。\n\n# SCOPE\n\n项目级体检。\n\n# OUT OF SCOPE\n\n自动修复。\n\n# ACCEPTANCE\n\n展示状态、依据和建议行动。\n\n# DEPENDENCIES\n\n无。\n\n# ASSUMPTIONS\n\n用户可访问项目。';
  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'requirement-spec-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['requirement-spec', 'composition', 'complete', '--artifact', specification],
    ['requirement-spec', 'verification', 'complete', '--artifact', specification],
    ['requirement-spec', 'complete'],
  ], `${taskId}-spec`);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'spec-review-agent');
  await executeBusinessAnalysisAgent(delegation, [
    ['spec-review', 'inspection', 'complete', '--artifact', '# 独立审查\n\n规格完整继承需求意图和业务方案。'],
    ['spec-review', 'classification', 'complete', '--artifact', JSON.stringify({ summary: '没有阻断缺口', gaps: [] })],
    ['spec-review', 'approve', '--artifact', specification],
  ], `${taskId}-review`);

  const handedOff = await getTask(taskId);
  assert.equal(handedOff?.task.item_type, 'end-to-end');
  assert.equal(handedOff?.task.agile_status, 'backlog');
  assert.equal(handedOff?.task.current_subagent, 'backlog-agent');
  assert.equal(handedOff?.task.run_state, 'runnable');
  assert.equal(handedOff?.task.closure_status, 'none');
  assert.equal(handedOff?.task.review_document_id, null);
  assert.match(handedOff?.documents.find((document) => document.kind === 'ba_review')?.content || '', /# ACCEPTANCE/);

  const developEntry = (await inspectTaskDispatch(taskId))[0];
  assert.equal(developEntry.pipeline, 'backlog');
  assert.equal(developEntry.agent, 'backlog-agent');
});

test('dynamically inserts Research for intent and business design and requires current web-search evidence', async () => {
  const { createTask } = await import('./tasks');
  const { completeExecution, recordExecutionReceipt } = await import('./executions');
  const { issueAgentCommandToken, readAgentCommandSubmission, runAgentCommand } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const taskId = await createTask({
    title: '定义对 Agent 友好的项目',
    description: '希望识别项目是否适合由 Agent 持续开发。',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });
  const research = JSON.stringify({
    summary: '官方资料强调可定位指令、可运行验证和明确项目上下文。',
    questions: [{ question: '什么条件让项目更适合由编码 Agent 持续处理？', reason: '该定义会影响需求目标和方案评价标准。' }],
    findings: [{
      claim: '项目应向 Agent 提供可定位的持久指令和可执行验证路径。',
      sourceTitle: 'OpenAI Codex documentation',
      sourceUrl: 'https://developers.openai.com/codex/',
      sourceType: 'official',
      applicability: '可用于定义项目对 Agent 友好的外部背景，但不能替代用户对成功结果的决定。',
      limitations: '官方文档不定义当前产品必须采用的具体体检规则。',
      confidence: 'high',
    }],
    unresolved: [],
  });

  let delegation = (await inspectTaskDispatch(taskId))[0];
  const intent = await beginTestExecutionAttempt({
    runId: `RUN-ba-research-${taskId}-intent`,
    delegation,
    prompt: 'Intent research',
    executorId: 'codex',
    webSearchEnabled: true,
  });
  const intentToken = await issueAgentCommandToken(intent.attempt.execution_id);
  assert.ok(intentToken);
  const runIntent = (args: string[]) => runAgentCommand({ executionId: intent.attempt.execution_id, token: intentToken, args });
  const intentStatus = await runIntent(['idea-context', 'status']);
  assert.match(intentStatus, /Live Research: enabled/);
  const intentResearchPacket = await runIntent(['idea-context', 'discovery', 'complete', '--artifact', '# DISCOVERY\n\n需要定义 Agent 友好的项目条件。']);
  assert.match(intentResearchPacket, /Phase: RESEARCH/);
  await assert.rejects(
    runIntent(['idea-context', 'research', 'complete', '--artifact', research]),
    /必须至少成功完成一次 Web Search/,
  );
  await recordExecutionReceipt(intent.attempt.execution_id, 'tool_event', '00000001', {
    name: 'loop.agent.tool', phase: 'completed', executor: 'codex', tool: 'web_search', success: true,
  });
  const intentProposal = await runIntent(['idea-context', 'research', 'complete', '--artifact', research]);
  assert.match(intentProposal, /Phase: CLARIFICATION PROPOSAL/);
  await runIntent(['idea-context', 'clarification-proposal', 'complete', '--artifact', JSON.stringify({ summary: '没有目标歧义', questions: [] })]);
  await assert.rejects(
    runIntent(['idea-context', 'synthesis', 'complete', '--artifact', '# 需求意图简报\n\n定义项目对 Agent 的友好程度。']),
    /必须包含 RESEARCH BASIS/,
  );
  await runIntent(['idea-context', 'synthesis', 'complete', '--artifact', '# 需求意图简报\n\n定义项目对 Agent 的友好程度。\n\n# RESEARCH BASIS\n\n采用官方资料作为外部背景，同时保留用户目标决定权：https://developers.openai.com/codex/']);
  await runIntent(['idea-context', 'complete']);
  const intentResult = await readAgentCommandSubmission(intent.attempt.execution_id);
  await applyAgentResult(`RUN-ba-research-${taskId}-intent`, delegation, intentResult!, { executionId: intent.attempt.execution_id });
  await completeExecution(intent.attempt.execution_id);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  const design = await beginTestExecutionAttempt({
    runId: `RUN-ba-research-${taskId}-design`,
    delegation,
    prompt: 'Business design research',
    executorId: 'codex',
    webSearchEnabled: true,
  });
  const designToken = await issueAgentCommandToken(design.attempt.execution_id);
  assert.ok(designToken);
  const runDesign = (args: string[]) => runAgentCommand({ executionId: design.attempt.execution_id, token: designToken, args });
  await runDesign(['business-design', 'status']);
  const designResearchPacket = await runDesign(['business-design', 'exploration', 'complete', '--artifact', '# EXPLORATION\n\n探索项目上下文、验证路径和持续维护模式。']);
  assert.match(designResearchPacket, /Phase: RESEARCH/);
  await recordExecutionReceipt(design.attempt.execution_id, 'tool_event', '00000001', {
    name: 'loop.agent.tool', phase: 'completed', executor: 'codex', tool: 'web_search', success: true,
  });
  await runDesign(['business-design', 'research', 'complete', '--artifact', research]);
  await runDesign(['business-design', 'decision-proposal', 'complete', '--artifact', JSON.stringify({ summary: '当前没有必须分叉的业务决定', questions: [] })]);
  await runDesign(['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify({ notes: '没有活动节点', agentDecisions: [], humanDecisionKeys: [] })]);
  await runDesign(['business-design', 'decision-resolution', 'audit-complete', '--artifact', '# 答案审查\n\n没有新增语义。']);
  await runDesign(['business-design', 'solution', 'complete', '--artifact', '# 业务方案\n\n从项目上下文、验证能力和维护反馈三个方面形成体检结果。\n\n# RESEARCH BASIS\n\n外部资料用于补充评价维度，不替代产品决定：https://developers.openai.com/codex/']);
  await runDesign(['business-design', 'complete']);
  const designResult = await readAgentCommandSubmission(design.attempt.execution_id);
  await applyAgentResult(`RUN-ba-research-${taskId}-design`, delegation, designResult!, { executionId: design.attempt.execution_id });
  await completeExecution(design.attempt.execution_id);
  assert.equal((await inspectTaskDispatch(taskId))[0]?.agent, 'requirement-spec-agent');
});

test('injects decision strength only while Idea Context answers and audits fully autonomous decisions before synthesis', async () => {
  const { createTask, getTask } = await import('./tasks');
  const { completeExecution } = await import('./executions');
  const {
    issueAgentCommandToken,
    readAgentCommandSubmission,
    runAgentCommand,
  } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const taskId = await createTask({
    title: '想办法让项目风险更早暴露',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'fully_autonomous' }],
  });
  const delegation = (await inspectTaskDispatch(taskId))[0];
  const started = await beginTestExecutionAttempt({ runId: `RUN-ba-intent-mode-${taskId}`, delegation, prompt: 'Intent answer policy' });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  const run = (args: string[]) => runAgentCommand({ executionId: started.attempt.execution_id, token, args });

  const discoveryStatus = await run(['idea-context', 'status']);
  assert.doesNotMatch(discoveryStatus, /Decision Mode|fully_autonomous/);
  await run(['idea-context', 'discovery', 'complete', '--artifact', '# 调查\n\n目标用户可能是项目负责人或全体项目成员。']);
  const proposal = {
    summary: '目标参与者存在会改变成功结果的歧义',
    questions: [{
      key: 'primary-actor',
      title: '主要目标参与者',
      question: '项目体检首先帮助谁采取行动？',
      impact: '参与者不同会改变结果表达和成功标准。',
      options: [{ id: 'lead', label: '项目负责人', consequences: ['集中承担风险处置'] }, { id: 'team', label: '全体项目成员', consequences: ['团队共同识别和处置风险'] }],
      recommendationOption: 'team',
      recommendationReason: '项目健康风险通常需要团队共同消化和行动。',
      proposedAuthority: 'human',
      activation: [],
    }],
  };
  const answerPacket = await run(['idea-context', 'clarification-proposal', 'complete', '--artifact', JSON.stringify(proposal)]);
  assert.match(answerPacket, /Phase: CLARIFICATION RESOLUTION/);
  assert.match(answerPacket, /Decision Mode: fully_autonomous/);
  assert.match(answerPacket, /Policy Scope: 仅在当前 CLARIFICATION RESOLUTION/);
  const resolved = await run(['idea-context', 'clarification-resolution', 'complete', '--artifact', JSON.stringify({
    notes: '根据需求目标选择能共同识别并处理风险的参与者。',
    agentDecisions: [{ key: 'primary-actor', optionId: 'team', reason: '团队共同处理更符合提前暴露风险的目标。' }],
    humanDecisionKeys: [],
  })]);
  assert.match(resolved, /Outcome: answer_audit_required/);
  assert.match(resolved, /Agent Answers: 1/);
  assert.match(resolved, /HUMAN Answers: 0/);
  assert.doesNotMatch(resolved, /Decision Mode|fully_autonomous/);
  const audited = await run(['idea-context', 'clarification-resolution', 'audit-complete', '--artifact', '# 答案审查\n\n参与者选择没有引入当前问题树外的新语义。']);
  assert.match(audited, /To: synthesis/);
  await run(['idea-context', 'synthesis', 'complete', '--artifact', '# 需求意图简报\n\n帮助全体项目成员更早识别并共同处理项目健康风险。']);
  await run(['idea-context', 'complete']);
  const result = await readAgentCommandSubmission(started.attempt.execution_id);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.questions.length, 0);
  await applyAgentResult(`RUN-ba-intent-mode-${taskId}`, delegation, result!, { executionId: started.attempt.execution_id });
  await completeExecution(started.attempt.execution_id);
  const detail = await getTask(taskId);
  const decision = detail?.questions.find((question) => question.decision_key === 'primary-actor');
  assert.equal(decision?.decision_authority, 'agent');
  assert.equal(decision?.selected_option_id, 'team');
  assert.equal(detail?.task.current_subagent, 'business-design-agent');
});

test('audits an Idea Context custom answer and returns to clarification proposal for incremental questions', async () => {
  const { answerQuestion, createTask, getTask, submitClarificationAnswers } = await import('./tasks');
  const { completeExecution } = await import('./executions');
  const { issueAgentCommandToken, readAgentCommandSubmission, runAgentCommand } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const taskId = await createTask({
    title: '定义项目体检是否成功',
    itemType: 'business-analysis',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'balanced' }],
  });
  const proposal = {
    summary: '成功结果存在不同解释，需要用户明确',
    questions: [{
      key: 'success-outcome',
      title: '需求成功结果',
      question: '项目体检首先要带来什么成功结果？',
      impact: '它决定后续业务方案优化的目标。',
      options: [{ id: 'awareness', label: '风险被及时看见', consequences: ['关注风险发现'] }, { id: 'closure', label: '风险被持续关闭', consequences: ['关注后续行动'] }],
      recommendationOption: 'closure',
      recommendationReason: '只有形成行动闭环才能持续改善项目健康。',
      proposedAuthority: 'human',
      activation: [],
    }],
  };
  const resolution = {
    notes: '成功结果属于需求意图核心，按平衡策略交给 HUMAN。',
    agentDecisions: [],
    humanDecisionKeys: ['success-outcome'],
  };

  let delegation = (await inspectTaskDispatch(taskId))[0];
  const first = await beginTestExecutionAttempt({ runId: `RUN-ba-intent-expand-${taskId}-1`, delegation, prompt: 'Intent clarification proposal' });
  const firstToken = await issueAgentCommandToken(first.attempt.execution_id);
  assert.ok(firstToken);
  const firstRun = (args: string[]) => runAgentCommand({ executionId: first.attempt.execution_id, token: firstToken, args });
  await firstRun(['idea-context', 'status']);
  await firstRun(['idea-context', 'discovery', 'complete', '--artifact', '# 调查\n\n成功可能表示发现风险，也可能表示关闭风险。']);
  await firstRun(['idea-context', 'clarification-proposal', 'complete', '--artifact', JSON.stringify(proposal)]);
  await firstRun(['idea-context', 'clarification-resolution', 'complete', '--artifact', JSON.stringify(resolution)]);
  await firstRun(['idea-context', 'request-clarification']);
  const needsInput = await readAgentCommandSubmission(first.attempt.execution_id);
  await applyAgentResult(`RUN-ba-intent-expand-${taskId}-1`, delegation, needsInput!, { executionId: first.attempt.execution_id });
  await completeExecution(first.attempt.execution_id);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'success-outcome');
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '30 天内至少关闭 80% 的阻断风险。',
  });
  await submitClarificationAnswers(taskId);

  delegation = (await inspectTaskDispatch(taskId))[0];
  const resumed = await beginTestExecutionAttempt({ runId: `RUN-ba-intent-expand-${taskId}-2`, delegation, prompt: 'Intent answer audit' });
  const resumedToken = await issueAgentCommandToken(resumed.attempt.execution_id);
  assert.ok(resumedToken);
  const resumedRun = (args: string[]) => runAgentCommand({ executionId: resumed.attempt.execution_id, token: resumedToken, args });
  const restored = await resumedRun(['idea-context', 'status']);
  assert.match(restored, /clarification-resolution expand/);
  const expanded = await resumedRun([
    'idea-context', 'clarification-resolution', 'expand', '--artifact',
    '# 答案审查\n\n自定义答案引入了“阻断风险”的判定口径，需要增量确认。',
  ]);
  assert.match(expanded, /To: clarification_proposal/);
  const followUp = {
    summary: '只补充阻断风险的判定口径',
    questions: [{
      key: 'blocking-risk-definition',
      title: '阻断风险定义',
      question: '什么风险计入阻断风险？',
      impact: '它决定 80% 成功指标的统计口径。',
      options: [{ id: 'delivery-blocked', label: '已阻止关键交付', consequences: ['口径客观'] }, { id: 'high-probability', label: '高概率将阻止交付', consequences: ['可以更早预警'] }],
      recommendationOption: 'delivery-blocked',
      recommendationReason: '已发生阻断更容易形成一致统计口径。',
      proposedAuthority: 'agent',
      activation: [],
    }],
  };
  await resumedRun(['idea-context', 'clarification-proposal', 'complete', '--artifact', JSON.stringify(followUp)]);
  const closed = await resumedRun(['idea-context', 'clarification-resolution', 'complete', '--artifact', JSON.stringify({
    notes: '增量口径可以按平衡策略由 Agent 关闭。',
    agentDecisions: [{ key: 'blocking-risk-definition', optionId: 'delivery-blocked', reason: '客观且便于审计。' }],
    humanDecisionKeys: [],
  })]);
  assert.match(closed, /Outcome: answer_audit_required/);
  const followUpAudited = await resumedRun([
    'idea-context', 'clarification-resolution', 'audit-complete', '--artifact',
    '# 答案审查\n\n阻断风险定义已经闭合，没有引入新的需求意图分支。',
  ]);
  assert.match(followUpAudited, /To: synthesis/);
  await resumedRun(['idea-context', 'synthesis', 'complete', '--artifact', '# 需求意图简报\n\n帮助团队在 30 天内关闭至少 80% 已阻止关键交付的风险。']);
  await resumedRun(['idea-context', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.attempt.execution_id);
  await applyAgentResult(`RUN-ba-intent-expand-${taskId}-2`, delegation, completed!, { executionId: resumed.attempt.execution_id });
  await completeExecution(resumed.attempt.execution_id);
  detail = await getTask(taskId);
  assert.equal(detail?.questions.find((item) => item.decision_key === 'success-outcome')?.answer, '30 天内至少关闭 80% 的阻断风险。');
  assert.equal(detail?.questions.find((item) => item.decision_key === 'blocking-risk-definition')?.decision_authority, 'agent');
  assert.equal(detail?.task.current_subagent, 'business-design-agent');
});

test('audits a Business Design custom answer and expands only the newly introduced decision branch', async () => {
  const {
    answerQuestion,
    createTask,
    getTask,
    submitClarificationAnswers,
    updateTask,
  } = await import('./tasks');
  const { completeExecution } = await import('./executions');
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

  let delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.agent, 'business-design-agent');
  const first = await beginTestExecutionAttempt({ runId: `RUN-ba-human-${taskId}-1`, delegation, prompt: 'Business decision proposal' });
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
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '普通风险对项目成员可见，严重风险仅对项目负责人可见。',
  });
  await submitClarificationAnswers(taskId);

  delegation = (await inspectTaskDispatch(taskId))[0];
  assert.equal(delegation.pipeline, 'resume');
  const resumed = await beginTestExecutionAttempt({ runId: `RUN-ba-human-${taskId}-2`, delegation, prompt: 'Business decision resume' });
  const resumedToken = await issueAgentCommandToken(resumed.attempt.execution_id);
  assert.ok(resumedToken);
  const resumedRun = (args: string[]) => runAgentCommand({ executionId: resumed.attempt.execution_id, token: resumedToken, args });
  const restored = await resumedRun(['business-design', 'status']);
  assert.match(restored, /Phase: decision_resolution/);
  assert.match(restored, /decision-resolution expand/);
  await assert.rejects(
    resumedRun(['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify({
      notes: '尝试覆盖已经回答的 HUMAN 节点。',
      agentDecisions: [{ key: 'result-visibility', optionId: 'members', reason: '不应被接受。' }],
      humanDecisionKeys: [],
    })]),
    /已经发布给 HUMAN 的节点不能改由 Agent 回答/,
  );
  const auditRequired = await resumedRun(['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify(resolution)]);
  assert.match(auditRequired, /Outcome: answer_audit_required/);
  const expanded = await resumedRun([
    'business-design', 'decision-resolution', 'expand', '--artifact',
    '# 答案审查\n\n自定义答案引入严重程度边界，需要增量确认其判定方式。',
  ]);
  assert.match(expanded, /To: decision_proposal/);
  await assert.rejects(
    resumedRun(['business-design', 'decision-proposal', 'complete', '--artifact', JSON.stringify(proposal)]),
    /不得重问或改名覆盖已有节点：result-visibility/,
  );
  const followUpProposal = {
    summary: '只补充自定义答案新引入的严重程度边界',
    questions: [{
      key: 'severe-risk-boundary',
      title: '严重风险边界',
      question: '什么条件下体检风险属于严重风险？',
      impact: '该边界决定结果可见范围。',
      options: [{ id: 'any-blocker', label: '存在阻断项', consequences: ['边界明确且易于解释'] }, { id: 'score-threshold', label: '综合评分达到阈值', consequences: ['可综合多个风险信号'] }],
      recommendationOption: 'any-blocker',
      recommendationReason: '阻断项是更直接且可解释的严重风险信号。',
      proposedAuthority: 'agent',
      activation: [],
    }],
  };
  await resumedRun(['business-design', 'decision-proposal', 'complete', '--artifact', JSON.stringify(followUpProposal)]);
  const advanced = await resumedRun(['business-design', 'decision-resolution', 'complete', '--artifact', JSON.stringify({
    notes: '增量节点可以按平衡策略由 Agent 关闭。',
    agentDecisions: [{ key: 'severe-risk-boundary', optionId: 'any-blocker', reason: '阻断项边界直接、透明且符合风险解释目标。' }],
    humanDecisionKeys: [],
  })]);
  assert.match(advanced, /Outcome: answer_audit_required/);
  const followUpAudited = await resumedRun([
    'business-design', 'decision-resolution', 'audit-complete', '--artifact',
    '# 答案审查\n\n严重风险边界已经闭合，没有引入新的业务方案分支。',
  ]);
  assert.match(followUpAudited, /To: solution/);
  await resumedRun(['business-design', 'solution', 'complete', '--artifact', '# 业务方案\n\n普通风险对项目成员可见；存在阻断项时仅项目负责人可查看严重风险。']);
  await resumedRun(['business-design', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.attempt.execution_id);
  assert.equal(completed?.businessAnalysis?.disposition, 'advance');
  await applyAgentResult(`RUN-ba-human-${taskId}-2`, delegation, completed!, { executionId: resumed.attempt.execution_id });
  await completeExecution(resumed.attempt.execution_id);
  detail = await getTask(taskId);
  assert.equal(detail?.task.current_subagent, 'requirement-spec-agent');
  assert.equal(detail?.questions.find((item) => item.decision_key === 'result-visibility')?.answer, '普通风险对项目成员可见，严重风险仅对项目负责人可见。');
  assert.equal(detail?.questions.find((item) => item.decision_key === 'severe-risk-boundary')?.decision_authority, 'agent');
});
