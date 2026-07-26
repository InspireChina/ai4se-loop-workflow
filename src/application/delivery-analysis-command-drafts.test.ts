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

async function deliveryAnalysisDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, pipelineForTask } = await import('./tasks');
  const taskId = await createTask({
    title,
    description: '导出完成后用户需要选择下载 CSV，或在页面直接查看结果。',
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
    'delivery-analysis', 'impact', 'upsert', '--key', 'export-engine',
    '--area', '导出计算与调度', '--finding', '结果交付不需要改变现有计算和任务状态机',
    '--disposition', 'preserve', '--evidence', '现有状态模型已独立覆盖计算、completed 和 failed',
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

async function recordOutputDecision(executionId: string, token: string) {
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'upsert', '--key', 'output-mode', '--type', 'business',
    '--title', '选择结果呈现模式',
    '--question', '导出成功后应直接下载 CSV，还是在页面展示结果？',
    '--impact', '决定用户可观察流程和结果契约',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'option-upsert', '--key', 'output-mode',
    '--id', 'download', '--label', '下载 CSV',
    '--consequence', '结果以文件形式交付，需要稳定的下载入口',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'option-upsert', '--key', 'output-mode',
    '--id', 'inline', '--label', '页面内展示',
    '--consequence', '结果成为页面能力，需要处理渲染与数据量边界',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'decision', 'ask', '--key', 'output-mode',
    '--option', 'download', '--reason', '现有项目以文件交付导出结果，下载方式改变更小',
  ]);
  await command(executionId, token, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-entry',
    '--area', '导出完成后的用户入口', '--finding', '下载与页面展示会形成不同的业务结果契约',
    '--disposition', 'needs_decision', '--evidence', '当前需求同时描述了两个互斥呈现方向',
    '--decision', 'output-mode',
  ]);
}

test('delivery analysis help explains context tools, command semantics, and standard paths', async () => {
  const { taskId, delegation } = await deliveryAnalysisDelegation('交付分析命令帮助');
  const active = await begin(delegation, `${taskId}-help`);

  const help = await command(active.executionId, active.token!, ['help']);
  assert.match(help, /公共诊断命令/);
  assert.match(help, /whoami/);
  assert.match(help, /agent-context overview/);
  assert.match(help, /agent-context search/);
  assert.match(help, /无关键决策：status → summary\/contract\/impact → validate → complete/);
  assert.match(help, /用户决策：decision upsert/);
  assert.match(help, /help decision/);
  assert.doesNotMatch(help, /implementation complete/);
  assert.match(
    await command(active.executionId, active.token!, ['whoami']),
    new RegExp(`analyst-agent · analysis · execution=${active.executionId}`),
  );

  const contextHelp = await command(active.executionId, active.token!, ['help', 'context']);
  assert.match(contextHelp, /Prompt 已给出 required refs 时优先使用 get/);
  assert.match(contextHelp, /核对前序执行时使用 evidence/);
  assert.match(contextHelp, /完成上述调查后仍无法唯一确定/);

  const impactHelp = await command(active.executionId, active.token!, ['help', 'impact']);
  assert.match(impactHelp, /change\s+本轮必须改变/);
  assert.match(impactHelp, /needs_decision/);

  const decisionHelp = await command(active.executionId, active.token!, ['help', 'decision']);
  assert.match(decisionHelp, /Agent 自主关闭路径/);
  assert.match(decisionHelp, /project_evidence/);
  assert.match(decisionHelp, /至少两次 option-upsert/);

  const contractHelp = await command(active.executionId, active.token!, ['help', 'contract']);
  assert.match(contractHelp, /共同依赖的冻结上游事实/);
  assert.match(contractHelp, /unit-acceptance 是 Application 自动注入/);

  const finishHelp = await command(active.executionId, active.token!, ['help', 'finish']);
  assert.match(finishHelp, /delivery-analysis complete/);
  assert.match(finishHelp, /delivery-analysis request-clarification/);
  assert.match(finishHelp, /手写 JSON 都不会结束 execution/);

  await assert.rejects(
    command(active.executionId, active.token!, ['help', 'unknown']),
    /可用主题：context、impact、decision、contract、finish/,
  );
});

test('delivery analysis progressively closes real impacts and resumes the same user decision', async () => {
  const {
    answerQuestion,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await deliveryAnalysisDelegation('轻量交付分析');
  const first = await begin(delegation, `${taskId}-first`);

  await assert.rejects(
    command(first.executionId, first.token!, [
      'delivery-analysis', 'summary', 'set', '--text', '不能跳过 status',
    ]),
    /delivery-analysis status/,
  );
  await assert.rejects(
    command(first.executionId, first.token!, ['analysis', 'status']),
    /不允许命令/,
  );

  const initial = await command(first.executionId, first.token!, ['delivery-analysis', 'status']);
  assert.match(initial, /交付分析草稿 v1/);
  assert.match(initial, /export-result · 用户获得可用的导出结果/);
  assert.match(initial, /上游来源：3/);
  await assert.rejects(
    command(first.executionId, first.token!, ['delivery-analysis', 'walkthrough', 'set', '--text', '旧命令']),
    /未知命令/,
  );
  await recordContract(first.executionId, first.token!);
  await recordOutputDecision(first.executionId, first.token!);
  assert.equal(
    await command(first.executionId, first.token!, ['delivery-analysis', 'validate']),
    '交付分析草稿结构校验通过。',
  );
  await command(first.executionId, first.token!, ['delivery-analysis', 'request-clarification']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.outcome, 'needs_input');
  assert.equal(pending?.questions[0]?.decisionKey, 'output-mode');
  assert.match(pending?.artifact?.content || '', /# 交付分析/);
  await applyAgentResult(`RUN-delivery-analysis-pending-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'output-mode');
  assert.ok(question);
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '使用下载 CSV；不要在页面渲染完整结果。',
  });
  await submitClarificationAnswers(taskId);

  const resumedDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'analyst-agent' && item.pipeline === 'resume')! as DelegationEnvelope;
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['delivery-analysis', 'status']);
  assert.match(restored, /交付分析草稿 v2/);
  assert.match(restored, /output-mode.*已回答=使用下载 CSV/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'delivery-analysis', 'decision', 'remove', '--key', 'output-mode',
    ]),
    /不能删除或改名/,
  );
  await command(resumed.executionId, resumed.token!, [
    'delivery-analysis', 'decision', 'resolve', '--key', 'output-mode',
    '--option', 'download', '--authority', 'user',
    '--decision', '导出完成后提供 CSV 下载，不在页面渲染完整结果',
    '--rationale', '用户明确选择文件型结果并排除页面内完整展示',
    '--evidence', '人工回答：使用下载 CSV；不要在页面渲染完整结果。',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-entry',
    '--area', '导出完成后的用户入口', '--finding', '结果以 CSV 下载入口交付',
    '--disposition', 'change', '--evidence', '用户已选择下载 CSV',
    '--decision', 'output-mode',
  ]);
  await command(resumed.executionId, resumed.token!, ['delivery-analysis', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(completed?.outcome, 'completed');
  assert.equal(completed?.questions.length, 0);
  assert.equal(completed?.spec?.impacts.find((item) => item.key === 'result-entry')?.disposition, 'change');
  assert.equal(completed?.spec?.handoff.verificationFocus[0]?.key, 'result-entry');
  await applyAgentResult(`RUN-delivery-analysis-completed-${taskId}`, resumedDelegation, completed!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  detail = await getTask(taskId);
  assert.deepEqual(
    detail?.deliverySpecs.map((spec) => [spec.revision, spec.status]),
    [[1, 'superseded'], [2, 'resolved']],
  );
  assert.equal(detail?.task.analysis_index, 1);
});

test('delivery analysis completes without manufacturing a decision or explicit verification form', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await deliveryAnalysisDelegation('无关键决策的交付分析');
  const active = await begin(delegation, `${taskId}-no-decision`);
  await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'summary', 'set', '--text', '现有完成态只缺少结果入口。',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'contract', 'set', '--text', '复用现有完成态补齐结果入口。',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-entry',
    '--area', '导出完成态', '--finding', '现有完成态缺少用户可使用的入口',
    '--disposition', 'change', '--evidence', '完成态模型与页面走查',
  ]);
  await command(active.executionId, active.token!, ['delivery-analysis', 'complete']);
  const completed = await readAgentCommandSubmission(active.executionId);
  assert.equal(completed?.outcome, 'completed');
  assert.deepEqual(completed?.spec?.decisions, []);
  assert.deepEqual(completed?.spec?.handoff.verificationFocus, []);
  assert.match(completed?.artifact?.content || '', /没有需要单独记录的关键决策/);
  assert.match(completed?.artifact?.content || '', /unit-acceptance/);
});

test('resolved technical decisions do not require manufactured options', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await deliveryAnalysisDelegation('核心技术决策');
  const active = await begin(delegation, `${taskId}-technical-decision`);
  await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'summary', 'set', '--text', '现有结果记录已有稳定扩展字段。',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'contract', 'set', '--text', '在既有结果记录上新增可空字段，不建立平行表。',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'upsert', '--key', 'result-storage', '--type', 'technical',
    '--title', '结果入口存储方式', '--question', '新增字段还是建立新表？',
    '--impact', '影响数据一致性与迁移复杂度',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'decision', 'resolve', '--key', 'result-storage',
    '--authority', 'project_evidence',
    '--decision', '在现有结果记录上增加可空字段',
    '--rationale', '结果入口与结果记录同生命周期且没有一对多语义',
    '--evidence', '结果表唯一约束和现有迁移模式',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-analysis', 'impact', 'upsert', '--key', 'result-record',
    '--area', '结果持久化', '--finding', '结果入口与现有结果记录同生命周期',
    '--disposition', 'change', '--evidence', '数据模型和唯一约束',
    '--decision', 'result-storage',
  ]);
  await command(active.executionId, active.token!, ['delivery-analysis', 'complete']);
  const completed = await readAgentCommandSubmission(active.executionId);
  const decision = completed?.spec?.decisions[0];
  assert.equal(decision?.status, 'resolved');
  assert.deepEqual(decision?.options, []);
  assert.equal(decision && 'selectedOption' in decision, false);
});

test('delivery analysis cannot complete while an impact still needs a decision', async () => {
  const { taskId, delegation } = await deliveryAnalysisDelegation('影响处置必须闭环');
  const active = await begin(delegation, `${taskId}-unresolved-impact`);
  await command(active.executionId, active.token!, ['delivery-analysis', 'status']);
  await recordContract(active.executionId, active.token!);
  await recordOutputDecision(active.executionId, active.token!);
  await assert.rejects(
    command(active.executionId, active.token!, ['delivery-analysis', 'complete']),
    /待用户确认|尚未确定处理方式/,
  );
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

test('delivery analysis migration keeps only the lightweight active model', async () => {
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
      'delivery_analysis_scope_gaps', 'delivery_analysis_source_coverage',
      'delivery_analysis_decision_dependencies'
    )
    ORDER BY name
  `).all() as { name: string }[];
  assert.deepEqual(removedNames, []);
  const activeNames = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'delivery_analysis_drafts', 'delivery_analysis_impacts',
      'delivery_analysis_decisions', 'delivery_analysis_decision_options',
      'delivery_analysis_guardrails', 'delivery_analysis_verification_focus'
    )
    ORDER BY name
  `).all() as { name: string }[];
  assert.equal(activeNames.length, 6);
});
