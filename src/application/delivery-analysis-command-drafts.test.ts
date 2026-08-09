import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginExecutionAttempt({
    runId: `RUN-delivery-analysis-${suffix}`,
    delegation,
    prompt: 'progressive delivery analysis prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function deliveryAnalysisDelegation(
  title: string,
  analysisDecisionMode?: 'conservative' | 'balanced' | 'autonomous' | 'fully_autonomous',
) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, pipelineForTask } = await import('./tasks');
  const taskId = await createTask({
    title,
    description: '导出完成后用户需要选择下载 CSV，或在页面直接查看结果。',
    metadata: analysisDecisionMode ? [{
      key: 'workflow.analysis_decision_mode',
      value: analysisDecisionMode,
    }] : [],
  });
  const db = await databaseConnection();
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET item_type = 'feature', agile_status = 'ready for dev',
          current_subagent = 'analyst-agent', total_stories = 1,
          analysis_index = 0, dev_index = 0, test_index = 0,
          next_step = '分析导出结果交付的影响和决策'
      WHERE task_id = ?
    `).run(taskId);
    db.prepare(`
      INSERT INTO stories(
        task_id, story_index, title, directory, unit_key, actor,
        trigger_condition, observable_outcome, acceptance
      ) VALUES(
        ?, 1, '用户获得可用的导出结果', 'story-001', 'export-result',
        '导出用户', '用户提交的导出任务成功完成',
        '用户获得与业务选择一致且可使用的导出结果',
        '导出完成后结果入口与确认的呈现方式一致'
      )
    `).run(taskId);
    db.prepare(`
      INSERT INTO delivery_unit_context_links(
        task_id, story_index, source_key, source_kind, content, source_ref
      ) VALUES
        (?, 1, 'change:result-delivery', 'change',
         '导出完成后向用户交付明确结果', 'TEST:change:result-delivery'),
        (?, 1, 'preserve:export-engine', 'preserve',
         '保持既有导出计算和任务调度语义', 'TEST:preserve:export-engine'),
        (?, 1, 'acceptance:usable-result', 'acceptance',
         '用户可以识别并使用导出结果', 'TEST:acceptance:usable-result')
    `).run(taskId, taskId, taskId);
  })();
  const delegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'analyst-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function recordPreservedImpact(executionId: string, token: string) {
  await command(executionId, token, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'export-engine',
    '--area', '导出计算与调度', '--finding', '结果交付不需要改变现有计算和任务状态机',
    '--disposition', 'preserve', '--evidence', '现有状态模型已独立覆盖计算、completed 和 failed',
  ]);
}

async function recordContract(executionId: string, token: string) {
  await command(executionId, token, [
    'delivery-analysis', 'summary', 'set', '--text',
    '导出结果交付会影响完成态入口，但不得改变导出计算、调度和失败语义。',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'contract', 'set', '--text',
    '开发时复用现有导出完成态，在结果交付边界内补齐入口；验证时从用户入口确认结果可识别和使用。',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'guardrail', 'upsert', '--key', 'failed-export',
    '--content', '失败任务不得出现可用结果入口', '--rationale', '避免把失败状态伪装为成功交付',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'verification-focus', 'upsert', '--key', 'result-entry',
    '--expected', '成功导出后出现与最终决策一致的结果入口',
    '--oracle', '从用户入口完成导出并实际使用该结果',
  ]);
}

async function recordOutputDecisionSkeletons(executionId: string, token: string) {
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'propose', '--key', 'output-mode', '--type', 'business',
    '--title', '选择结果呈现模式',
    '--question', '导出成功后应直接下载 CSV，还是在页面展示结果？',
    '--impact', '决定用户可观察流程和结果契约',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'propose', '--key', 'inline-pagination', '--type', 'business',
    '--title', '选择页面结果分页方式',
    '--question', '若页面展示结果，应一次加载还是分页加载？',
    '--impact', '仅在页面展示分支中决定大结果集的交互边界',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-entry',
    '--area', '导出完成后的用户入口', '--finding', '下载与页面展示会形成不同的业务结果契约',
    '--disposition', 'needs_decision', '--evidence', '当前需求同时描述了两个互斥呈现方向',
    '--decision', 'output-mode',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'inline-result-loading',
    '--area', '页面结果加载', '--finding', '页面展示分支需要确定大结果集加载边界',
    '--disposition', 'needs_decision', '--evidence', '现有页面没有完整结果展示约定',
    '--decision', 'inline-pagination',
  ]);
}

async function proposeOutputDecisionTree(executionId: string, token: string) {
  for (const option of [
    ['output-mode', 'download', '下载 CSV', '结果以文件形式交付，需要稳定的下载入口'],
    ['output-mode', 'inline', '页面内展示', '结果成为页面能力，需要处理渲染与数据量边界'],
    ['inline-pagination', 'all', '一次加载', '交互简单，但大结果集可能阻塞页面'],
    ['inline-pagination', 'paged', '分页加载', '需要分页状态与结果导航能力'],
  ]) {
    await command(executionId, token, [
      'delivery-analysis', 'decision', 'option-upsert', '--key', option[0],
      '--id', option[1], '--label', option[2], '--consequence', option[3],
    ]);
  }
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'depends-on', '--key', 'inline-pagination',
    '--parent', 'output-mode', '--option', 'inline',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'recommend', '--key', 'output-mode',
    '--option', 'download', '--authority', 'needs_user_input',
    '--reason', '现有项目以文件交付导出结果，下载方式改变更小',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'recommend', '--key', 'inline-pagination',
    '--option', 'paged', '--authority', 'needs_user_input',
    '--reason', '如果选择页面展示，分页对大结果集更稳妥',
  ]);
}

async function markOutputDecisionTreeForHuman(executionId: string, token: string) {
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'ask', '--key', 'output-mode',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'ask', '--key', 'inline-pagination',
  ]);
}

async function closeContractAndFinalize(executionId: string, token: string) {
  await recordContract(executionId, token);
  await command(executionId, token, ['delivery-analysis', 'contract', 'complete']);
  await command(executionId, token, ['delivery-analysis', 'validate']);
  await command(executionId, token, ['delivery-analysis', 'complete']);
}

test('delivery analysis help separates proposal and resolution in the five-stage chain', async () => {
  const { taskId, delegation } = await deliveryAnalysisDelegation('交付分析命令帮助');
  const active = await begin(delegation, `${taskId}-help`);

  await assert.rejects(
    command(active.executionId, active.token!, ['help']),
    /必须指定一个主题|至少跟一个参数/,
  );
  assert.match(
    await command(active.executionId, active.token!, ['whoami']),
    new RegExp(`analyst-agent · analysis · execution=${active.executionId}`),
  );

  const contextHelp = await command(active.executionId, active.token!, ['help', 'context']);
  assert.match(contextHelp, /Prompt 已给出 required refs 时优先使用 get/);
  assert.match(contextHelp, /核对前序执行时使用 evidence/);

  const impactHelp = await command(active.executionId, active.token!, ['help', 'impact']);
  assert.match(impactHelp, /change\s+本轮必须改变/);
  assert.match(impactHelp, /needs_decision/);

  const proposalHelp = await command(active.executionId, active.token!, ['help', 'decision-proposal']);
  assert.match(proposalHelp, /禁止 resolve、ask/);
  assert.match(proposalHelp, /decision recommend/);
  const resolutionHelp = await command(active.executionId, active.token!, ['help', 'decision-resolution']);
  assert.match(resolutionHelp, /具体指令只出现在当前 DECISION TREE · RESOLVE 工作包/);
  assert.match(resolutionHelp, /impact resolve/);

  const contractHelp = await command(active.executionId, active.token!, ['help', 'contract']);
  assert.match(contractHelp, /共同依赖的冻结上游事实/);
  assert.match(contractHelp, /unit-acceptance 是 Application 自动注入/);

  const finishHelp = await command(active.executionId, active.token!, ['help', 'finish']);
  assert.match(finishHelp, /AS-IS & IMPACT SCAN → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → DELIVERY CONTRACT → FINALIZE/);
  assert.match(finishHelp, /impact-scan complete/);
  assert.match(finishHelp, /request-clarification/);
  assert.match(finishHelp, /validate 绑定当前草稿变更版本/);

  await assert.rejects(
    command(active.executionId, active.token!, ['help', 'unknown']),
    /可用主题：context、impact、decision-proposal、decision-resolution、contract、finish/,
  );
});

test('delivery analysis walks a conditional human decision tree and resumes the same keys', async () => {
  const {
    answerQuestion,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { taskId, delegation } = await deliveryAnalysisDelegation('轻量交付分析');
  const first = await begin(delegation, `${taskId}-first`);

  await assert.rejects(
    command(first.executionId, first.token!, [
      'delivery-analysis', 'impact', 'upsert', '--key', 'blocked', '--area', 'x',
      '--finding', 'x', '--disposition', 'change', '--evidence', 'x',
    ]),
    /delivery-analysis status/,
  );
  const initial = await command(first.executionId, first.token!, ['delivery-analysis', 'status']);
  assert.match(initial, /Phase: impact_scan/);
  assert.match(initial, /AS-IS & IMPACT SCAN/);
  assert.match(initial, /Status: not_ready/);
  assert.doesNotMatch(initial, /Submit: `delivery-analysis impact-scan complete`/);
  assert.match(initial, /export-result · 用户获得可用的导出结果/);
  assert.match(initial, /上游来源：3/);
  assert.doesNotMatch(initial, /Analysis 自动决策强度|ANALYSIS DECISION POLICY|Mode: `balanced`/);

  await recordPreservedImpact(first.executionId, first.token!);
  await recordOutputDecisionSkeletons(first.executionId, first.token!);
  const phaseTwo = await command(first.executionId, first.token!, [
    'delivery-analysis', 'impact-scan', 'complete',
  ]);
  assert.match(phaseTwo, /From: impact_scan/);
  assert.match(phaseTwo, /To: decision_proposal/);
  assert.match(phaseTwo, /DECISION TREE · PROPOSE/);
  assert.doesNotMatch(phaseTwo, /ANALYSIS DECISION POLICY|Mode: `balanced`/);

  await proposeOutputDecisionTree(first.executionId, first.token!);
  await assert.rejects(
    command(first.executionId, first.token!, [
      'delivery-analysis', 'decision', 'resolve', '--key', 'output-mode', '--option', 'download',
      '--authority', 'agent_authority', '--decision', '下载', '--rationale', '推荐', '--evidence', '当前实现',
    ]),
    /不属于当前 decision_proposal 工作包/,
  );
  const resolutionPacket = await command(first.executionId, first.token!, ['delivery-analysis', 'decision-proposal', 'complete']);
  assert.match(resolutionPacket, /DECISION TREE · RESOLVE/);
  assert.match(resolutionPacket, /ANALYSIS DECISION POLICY/);
  assert.match(resolutionPacket, /Mode: `balanced` · 平衡/);
  await markOutputDecisionTreeForHuman(first.executionId, first.token!);
  const readyForQuestions = await command(first.executionId, first.token!, ['delivery-analysis', 'status']);
  assert.match(readyForQuestions, /Status: decisions_required/);
  assert.match(readyForQuestions, /`delivery-analysis validate`/);
  assert.match(
    await command(first.executionId, first.token!, ['delivery-analysis', 'validate']),
    /Outcome: validation_passed[\s\S]*Action: `delivery-analysis request-clarification`/,
  );
  await command(first.executionId, first.token!, ['delivery-analysis', 'request-clarification']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.outcome, 'needs_input');
  assert.equal(pending?.spec, undefined);
  assert.deepEqual(
    pending?.questions.map((question) => [question.decisionKey, question.initialStatus]),
    [['output-mode', 'pending'], ['inline-pagination', 'conditional']],
  );
  assert.deepEqual(pending?.questions[1]?.activation, [
    { decisionKey: 'output-mode', optionId: 'inline' },
  ]);
  await applyAgentResult(`RUN-delivery-analysis-pending-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  assert.deepEqual(detail?.deliverySpecs, []);
  const root = detail?.questions.find((item) => item.decision_key === 'output-mode');
  const child = detail?.questions.find((item) => item.decision_key === 'inline-pagination');
  assert.ok(root);
  assert.equal(root?.status, 'pending');
  assert.equal(child?.status, 'conditional');
  await answerQuestion({
    taskId,
    questionId: root!.question_id,
    selectedOptionId: 'download',
    answer: '使用下载 CSV；不要在页面渲染完整结果。',
  });
  detail = await getTask(taskId);
  assert.equal(detail?.questions.find((item) => item.decision_key === 'inline-pagination')?.status, 'not_applicable');
  await submitClarificationAnswers(taskId);

  const resumedDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'analyst-agent' && item.pipeline === 'resume')! as DelegationEnvelope;
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['delivery-analysis', 'status']);
  assert.match(restored, /交付分析草稿 v2/);
  assert.match(restored, /Phase: decision_resolution/);
  assert.match(restored, /output-mode.*已回答=使用下载 CSV/);
  assert.match(restored, /未命中的决策分支：1 个/);
  assert.doesNotMatch(restored, /inline-pagination · business/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'delivery-analysis', 'decision', 'remove', '--key', 'output-mode',
    ]),
    /不属于当前 decision_resolution 工作包/,
  );
  await command(resumed.executionId, resumed.token!, [
    'delivery-analysis', 'decision', 'resolve', '--key', 'output-mode',
    '--option', 'download', '--authority', 'user',
    '--decision', '导出完成后提供 CSV 下载，不在页面渲染完整结果',
    '--rationale', '用户明确选择文件型结果并排除页面内完整展示',
    '--evidence', '人工回答：使用下载 CSV；不要在页面渲染完整结果。',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-analysis', 'impact', 'resolve', '--key', 'result-entry',
    '--disposition', 'change', '--finding', '结果以 CSV 下载入口交付',
    '--evidence', '用户明确选择下载 CSV',
  ]);
  const contractPacket = await command(resumed.executionId, resumed.token!, [
    'delivery-analysis', 'decision-resolution', 'complete',
  ]);
  assert.match(contractPacket, /DELIVERY CONTRACT/);
  assert.doesNotMatch(contractPacket, /ANALYSIS DECISION POLICY|Mode: `balanced`/);
  await recordContract(resumed.executionId, resumed.token!);
  await command(resumed.executionId, resumed.token!, ['delivery-analysis', 'contract', 'complete']);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-analysis', 'complete']),
    /尚未通过 validate/,
  );
  await command(resumed.executionId, resumed.token!, [
    'delivery-analysis', 'finalize', 'reopen-contract', '--reason', '最终复核时需要收紧实现表述',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-analysis', 'summary', 'set', '--text',
    '导出结果以 CSV 下载入口交付，计算、调度和失败语义保持不变。',
  ]);
  await command(resumed.executionId, resumed.token!, ['delivery-analysis', 'contract', 'complete']);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-analysis', 'complete']),
    /尚未通过 validate/,
  );
  await command(resumed.executionId, resumed.token!, ['delivery-analysis', 'validate']);
  await command(resumed.executionId, resumed.token!, ['delivery-analysis', 'complete']);

  const completed = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(completed?.outcome, 'completed');
  assert.equal(completed?.questions.length, 0);
  assert.equal(completed?.spec?.impacts.find((item) => item.key === 'result-entry')?.disposition, 'change');
  assert.equal(completed?.spec?.impacts.some((item) => item.key === 'inline-result-loading'), false);
  assert.equal(completed?.spec?.decisions.some((item) => item.key === 'inline-pagination'), false);
  assert.doesNotMatch(
    completed?.artifact?.content || '',
    /export-result|output-mode|inline-pagination|result-entry|failed-export/,
  );
  await applyAgentResult(`RUN-delivery-analysis-completed-${taskId}`, resumedDelegation, completed!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  detail = await getTask(taskId);
  assert.deepEqual(
    detail?.deliverySpecs.map((spec) => [spec.revision, spec.status]),
    [[1, 'resolved']],
  );
  assert.equal(detail?.task.analysis_index, 1);

  const db = await databaseConnection();
  const transitions = db.prepare(`
    SELECT transition.from_phase, transition.to_phase
    FROM delivery_analysis_phase_transitions transition
    JOIN agent_work_drafts draft ON draft.draft_id = transition.draft_id
    WHERE draft.task_id = ? AND draft.story_index = 1
    ORDER BY transition.transition_id
  `).all(taskId) as { from_phase: string; to_phase: string }[];
  assert.deepEqual(transitions.map((item) => [item.from_phase, item.to_phase]), [
    ['impact_scan', 'decision_proposal'],
    ['decision_proposal', 'decision_resolution'],
    ['decision_resolution', 'delivery_contract'],
    ['delivery_contract', 'finalize'],
    ['finalize', 'delivery_contract'],
    ['delivery_contract', 'finalize'],
  ]);
});

test('delivery analysis completes the no-decision path through every phase', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await deliveryAnalysisDelegation('无关键决策的交付分析');
  const active = await begin(delegation, `${taskId}-no-decision`);
  await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-entry',
    '--area', '导出完成态', '--finding', '现有完成态缺少用户可使用的入口',
    '--disposition', 'change', '--evidence', '完成态模型与页面走查',
  ]);
  await command(active.executionId, active.token!, ['delivery-analysis', 'impact-scan', 'complete']);
  await command(active.executionId, active.token!, ['delivery-analysis', 'decision-proposal', 'complete']);
  await command(active.executionId, active.token!, ['delivery-analysis', 'decision-resolution', 'complete']);
  await closeContractAndFinalize(active.executionId, active.token!);
  const completed = await readAgentCommandSubmission(active.executionId);
  assert.equal(completed?.outcome, 'completed');
  assert.deepEqual(completed?.spec?.decisions, []);
  assert.match(completed?.artifact?.content || '', /没有需要单独记录的关键决策/);
  assert.match(completed?.artifact?.content || '', /验收语义/);
});

test('resolved technical decisions are proposed with alternatives before project evidence closes them', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await deliveryAnalysisDelegation('核心技术决策');
  const active = await begin(delegation, `${taskId}-technical-decision`);
  await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'propose', '--key', 'result-storage', '--type', 'technical',
    '--title', '结果入口存储方式', '--question', '新增字段还是建立新表？',
    '--impact', '影响数据一致性与迁移复杂度',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-record',
    '--area', '结果持久化', '--finding', '结果入口与现有结果记录同生命周期',
    '--disposition', 'needs_decision', '--evidence', '数据模型和唯一约束',
    '--decision', 'result-storage',
  ]);
  await command(active.executionId, active.token!, ['delivery-analysis', 'impact-scan', 'complete']);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'option-upsert', '--key', 'result-storage',
    '--id', 'existing-record', '--label', '扩展现有记录', '--consequence', '保持结果与记录同生命周期',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'option-upsert', '--key', 'result-storage',
    '--id', 'new-table', '--label', '建立新表', '--consequence', '引入独立生命周期和关联约束',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'recommend', '--key', 'result-storage',
    '--option', 'existing-record', '--authority', 'project_evidence',
    '--reason', '现有模型证明结果入口与结果记录具有相同生命周期',
  ]);
  await command(active.executionId, active.token!, ['delivery-analysis', 'decision-proposal', 'complete']);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'resolve', '--key', 'result-storage',
    '--option', 'existing-record',
    '--authority', 'project_evidence',
    '--decision', '在现有结果记录上增加可空字段',
    '--rationale', '结果入口与结果记录同生命周期且没有一对多语义',
    '--evidence', '结果表唯一约束和现有迁移模式',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'resolve', '--key', 'result-record',
    '--disposition', 'change', '--evidence', '项目数据模型唯一确定存储方式',
  ]);
  await command(active.executionId, active.token!, ['delivery-analysis', 'decision-resolution', 'complete']);
  await closeContractAndFinalize(active.executionId, active.token!);
  const completed = await readAgentCommandSubmission(active.executionId);
  const decision = completed?.spec?.decisions[0];
  assert.equal(decision?.status, 'resolved');
  assert.equal(decision?.options.length, 2);
  assert.equal(decision && 'selectedOption' in decision ? decision.selectedOption : null, 'existing-record');
});

test('delivery analysis cannot leave decision tree while an active impact needs a decision', async () => {
  const { taskId, delegation } = await deliveryAnalysisDelegation('影响处置必须闭环');
  const active = await begin(delegation, `${taskId}-unresolved-impact`);
  await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'propose', '--key', 'output-mode', '--type', 'business',
    '--title', '选择结果呈现模式', '--question', '下载还是页面展示？',
    '--impact', '决定用户可观察结果',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-entry',
    '--area', '结果入口', '--finding', '存在互斥方向', '--disposition', 'needs_decision',
    '--evidence', '需求同时给出下载与页面展示', '--decision', 'output-mode',
  ]);
  await command(active.executionId, active.token!, ['delivery-analysis', 'impact-scan', 'complete']);
  await assert.rejects(
    command(active.executionId, active.token!, ['delivery-analysis', 'decision-proposal', 'complete']),
    /至少需要两个真实互斥选项|缺少推荐选项/,
  );
  await assert.rejects(
    command(active.executionId, active.token!, ['delivery-analysis', 'complete']),
    /只能在 finalize 阶段执行/,
  );
});

test('conservative metadata is injected only into the decision resolution work packet', async () => {
  const { taskId, delegation } = await deliveryAnalysisDelegation('审慎交付分析', 'conservative');
  const active = await begin(delegation, `${taskId}-conservative`);
  const initial = await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  assert.doesNotMatch(initial, /conservative|ANALYSIS DECISION POLICY|审慎对齐/);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'propose', '--key', 'storage-shape', '--type', 'technical',
    '--title', '结果存储边界', '--question', '扩展现有记录还是建立新记录？',
    '--impact', '影响内部数据一致性边界',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'storage-impact',
    '--area', '结果存储', '--finding', '存在两个内部存储方向', '--disposition', 'needs_decision',
    '--evidence', '仓库模型调查', '--decision', 'storage-shape',
  ]);
  const proposalPacket = await command(active.executionId, active.token!, ['delivery-analysis', 'impact-scan', 'complete']);
  assert.doesNotMatch(proposalPacket, /conservative|ANALYSIS DECISION POLICY|审慎对齐/);
  for (const option of [
    ['existing', '扩展现有记录', '生命周期保持一致'],
    ['separate', '建立独立记录', '形成新的关联边界'],
  ]) {
    await command(active.executionId, active.token!, [
      'delivery-analysis', 'decision', 'option-upsert', '--key', 'storage-shape',
      '--id', option[0], '--label', option[1], '--consequence', option[2],
    ]);
  }
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'recommend', '--key', 'storage-shape',
    '--option', 'existing', '--authority', 'agent_authority', '--reason', '更符合当前生命周期',
  ]);
  const resolutionPacket = await command(active.executionId, active.token!, ['delivery-analysis', 'decision-proposal', 'complete']);
  assert.match(resolutionPacket, /ANALYSIS DECISION POLICY/);
  assert.match(resolutionPacket, /Mode: `conservative` · 审慎对齐/);
  assert.match(resolutionPacket, /不要使用 agent_authority/);
  assert.match(await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'ask', '--key', 'storage-shape',
  ]), /marked_for_human/);
});

test('fully autonomous analysis resolves product decisions without a HUMAN batch', async () => {
  const { taskId, delegation } = await deliveryAnalysisDelegation('完全自主交付分析', 'fully_autonomous');
  const active = await begin(delegation, `${taskId}-fully-autonomous`);
  const initial = await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  assert.doesNotMatch(initial, /fully_autonomous|ANALYSIS DECISION POLICY|完全自主/);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'propose', '--key', 'output-presentation', '--type', 'business',
    '--title', '结果呈现方式', '--question', '只显示结论还是同时显示评估依据？',
    '--impact', '选择会改变用户可观察的信息层级',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'presentation-impact',
    '--area', '结果页面', '--finding', '呈现方式尚未由上游唯一确定', '--disposition', 'needs_decision',
    '--evidence', '冻结需求与当前页面调查', '--decision', 'output-presentation',
  ]);
  const proposalPacket = await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact-scan', 'complete',
  ]);
  assert.doesNotMatch(proposalPacket, /fully_autonomous|ANALYSIS DECISION POLICY|完全自主/);
  for (const option of [
    ['summary', '只显示结论', '页面保持简洁'],
    ['explanation', '显示结论及依据', '用户可以审查评估理由'],
  ]) {
    await command(active.executionId, active.token!, [
      'delivery-analysis', 'decision', 'option-upsert', '--key', 'output-presentation',
      '--id', option[0], '--label', option[1], '--consequence', option[2],
    ]);
  }
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'recommend', '--key', 'output-presentation',
    '--option', 'explanation', '--authority', 'needs_user_input',
    '--reason', '这是会改变用户可观察结果的产品决定',
  ]);
  const resolutionPacket = await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision-proposal', 'complete',
  ]);
  assert.match(resolutionPacket, /Mode: `fully_autonomous` · 完全自主/);
  assert.match(resolutionPacket, /不得使用 decision ask，也不得形成 HUMAN 决策批次/);
  assert.match(resolutionPacket, /产品行为、公共契约、数据语义、兼容策略和工程边界/);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'resolve', '--key', 'output-presentation',
    '--option', 'explanation', '--authority', 'agent_authority',
    '--decision', '显示结论及评估依据',
    '--rationale', '评估依据让用户核验结论；主要代价是页面信息增加，未选纯结论以避免不可解释结果',
    '--evidence', '冻结目标、候选后果与现有页面信息结构',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'resolve', '--key', 'presentation-impact',
    '--disposition', 'change', '--finding', '页面显示结论及评估依据',
    '--evidence', '完全自主决策已关闭 output-presentation',
  ]);
  const resolved = await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  assert.match(resolved, /关键决策：1（已关闭 1 \/ 待确认 0）/);
  assert.match(resolved, /## SUBMIT[\s\S]*`delivery-analysis decision-resolution complete`/);
});

test('delivery analysis work keys isolate delivery units while resume preserves one draft identity', async () => {
  const { agentCommandWorkKey } = await import('../domain/agent-command-profile');
  assert.equal(
    agentCommandWorkKey('analyst-agent', 'analysis', 'REQ-1', 2, 'analysis:2'),
    'delivery-analysis:REQ-1:2',
  );
  assert.equal(
    agentCommandWorkKey('analyst-agent', 'resume', 'REQ-1', 2, 'resume:analysis:2'),
    'delivery-analysis:REQ-1:2',
  );
  assert.equal(
    agentCommandWorkKey('analyst-agent', 'analysis', 'REQ-1', 3, 'analysis:3'),
    'delivery-analysis:REQ-1:3',
  );
});

test('delivery analysis migration exposes only the active workflow model', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const removedNames = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'analysis_drafts', 'analysis_scope_items', 'analysis_behaviors',
      'analysis_decisions', 'analysis_decision_options',
      'analysis_acceptance_criteria', 'analysis_verification_steps',
      'analysis_dependencies', 'analysis_budget_items',
      'delivery_analysis_facts', 'delivery_analysis_scenarios',
      'delivery_analysis_boundaries', 'delivery_analysis_criteria',
      'delivery_analysis_verification_steps', 'delivery_analysis_external_dependencies',
      'delivery_analysis_scope_gaps', 'delivery_analysis_source_coverage'
    )
    ORDER BY name
  `).all() as { name: string }[];
  assert.deepEqual(removedNames, []);
  const activeNames = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'delivery_analysis_drafts', 'delivery_analysis_impacts',
      'delivery_analysis_decisions', 'delivery_analysis_decision_options',
      'delivery_analysis_decision_dependencies',
      'delivery_analysis_guardrails', 'delivery_analysis_verification_focus',
      'delivery_analysis_phase_transitions'
    )
    ORDER BY name
  `).all() as { name: string }[];
  assert.equal(activeNames.length, 8);
  const decisionColumns = db.prepare('PRAGMA table_info(delivery_analysis_decisions)').all() as { name: string }[];
  assert.equal(decisionColumns.some((column) => column.name === 'proposed_authority'), true);
  assert.equal(decisionColumns.some((column) => column.name === 'human_requested'), true);
});
