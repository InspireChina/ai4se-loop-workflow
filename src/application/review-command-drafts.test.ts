import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectAllDispatch, inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(
  delegation: DelegationEnvelope,
  suffix: string,
  resources: unknown[],
) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-review-${suffix}`,
    delegation,
    prompt: 'progressive review prompt',
  });
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT input_json FROM execution_attempts WHERE execution_id = ?
  `).get(started.attempt.execution_id) as { input_json: string };
  const input = JSON.parse(row.input_json);
  input.contextSnapshot = { resources };
  db.prepare(`
    UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?
  `).run(JSON.stringify(input), started.attempt.execution_id);
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token: token! };
}

async function reviewDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, upsertDocument } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'cancelled', run_state = 'idle', current_subagent = NULL
    WHERE agile_status NOT IN ('done', 'cancelled')
  `).run();
  const taskId = await createTask({
    title,
    description: '确认现有状态映射并完成独立验证。',
  });
  db.prepare(`
    INSERT INTO stories(
      task_id, story_index, title, directory, unit_key, actor,
      trigger_condition, observable_outcome, acceptance
    ) VALUES(
      ?, 1, '确认状态映射', 'story-001', 'state-mapping',
      '用户', '用户完成状态变更', '页面显示正确的最终状态',
      '独立黑盒验证最终状态'
    )
  `).run(taskId);
  const specId = randomUUID();
  db.prepare(`
    INSERT INTO story_specs(
      spec_id, task_id, story_index, revision, status, spec_json, resolved_at
    ) VALUES(?, ?, 1, 1, 'resolved', ?, CURRENT_TIMESTAMP)
  `).run(specId, taskId, JSON.stringify(deliverySpecFixture({
    handoff: {
      implementationGuidance: '保持现有状态映射。',
      guardrails: [],
      verificationFocus: [{
        key: 'AC-1',
        expected: '完成状态正确',
        oracle: '黑盒断言通过',
      }],
    },
  })));
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in review', current_subagent = 'review-agent',
        total_stories = 1, analysis_index = 1, dev_index = 1, test_index = 1,
        spec_resolved_index = 1, run_state = 'runnable',
        next_step = '生成结卡报告'
    WHERE task_id = ?
  `).run(taskId);
  await upsertDocument({
    taskId,
    storyIndex: 1,
    actor: 'dev-agent',
    kind: 'dev_note',
    title: '开发实现结果',
    content: '走查确认现有实现符合规格，没有生产代码变更。',
    format: 'markdown',
  });
  const testDocumentId = await upsertDocument({
    taskId,
    storyIndex: 1,
    actor: 'test-agent',
    kind: 'test_result',
    title: '验证报告',
    content: '从用户入口完成独立黑盒验证，AC-1 通过。',
    format: 'markdown',
  });
  const delegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.agent === 'review-agent' && item.pipeline === 'review');
  assert.ok(delegation);
  const testRef = `DOC:${testDocumentId}`;
  const specRef = `SPEC:${specId}:r1`;
  const passedTestExecutionRef = `EXEC:passed-test-${taskId}`;
  const failedTestExecutionRef = `EXEC:failed-test-${taskId}`;
  const resources = [{
    ref: testRef,
    kind: 'document',
    status: 'active',
    revision: 1,
    deliveryUnit: 1,
    content: {
      kind: 'test_result',
      sourceAgent: 'test-agent',
      content: '从用户入口完成独立黑盒验证，AC-1 通过。',
    },
  }, {
    ref: specRef,
    kind: 'delivery_spec',
    status: 'resolved',
    revision: 1,
    deliveryUnit: 1,
    content: deliverySpecFixture(),
  }, {
    ref: passedTestExecutionRef,
    kind: 'execution',
    status: 'applied',
    revision: 1,
    deliveryUnit: 1,
    content: {
      agent: 'test-agent',
      status: 'applied',
      outcome: 'completed',
      verdict: 'passed',
    },
  }, {
    ref: failedTestExecutionRef,
    kind: 'execution',
    status: 'applied',
    revision: 1,
    deliveryUnit: 1,
    content: {
      agent: 'test-agent',
      status: 'applied',
      outcome: 'completed',
      verdict: 'failed',
    },
  }];
  return {
    taskId,
    delegation: {
      ...delegation!,
      agileStatus: 'in review',
      currentSubagent: 'review-agent',
      closureStatus: 'none',
      totalStories: 1,
      reviewRevision: 0,
      reviewDocumentId: '',
    } as DelegationEnvelope,
    testRef,
    specRef,
    passedTestExecutionRef,
    failedTestExecutionRef,
    resources,
  };
}

async function draftSubjects(executionId: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  return db.prepare(`
    SELECT subject_ref, subject_kind
    FROM review_required_subjects
    WHERE draft_id = (
      SELECT draft_id FROM agent_work_drafts
      WHERE last_execution_id = ? AND draft_type = 'review'
      ORDER BY draft_version DESC LIMIT 1
    )
    ORDER BY ordinal
  `).all(executionId) as {
    subject_ref: string;
    subject_kind: string;
  }[];
}

async function reconcileAll(
  executionId: string,
  token: string,
  passedTestExecutionRef: string,
  specRef: string,
  exceptSubject?: string,
) {
  const subjects = await draftSubjects(executionId);
  for (const [index, subject] of subjects.entries()) {
    if (subject.subject_ref === exceptSubject) continue;
    await command(executionId, token, [
      'review', 'reconciliation', 'upsert',
      '--key', `subject-${index + 1}`,
      '--subject', subject.subject_ref,
      '--result', `已确认 ${subject.subject_kind} 的最终用户可观察结果与承诺一致。`,
      '--evidence', `${passedTestExecutionRef},${specRef}`,
    ]);
  }
}

async function writeCoreReport(executionId: string, token: string) {
  const status = await command(executionId, token, ['review', 'status']);
  if (/FACT RECONCILIATION/.test(status)) {
    await command(executionId, token, ['review', 'reconciliation', 'complete']);
  }
  const afterReconciliation = await command(executionId, token, ['review', 'status']);
  if (/CLOSURE ASSESSMENT/.test(afterReconciliation)) {
    await command(executionId, token, [
      'review', 'assessment', 'record',
      '--summary', '全部逐项事实组合后支持原始需求目标，跨单元结果与历史修订一致。',
      '--evidence-boundary', '结论仅覆盖冻结规格、当前最终实现事实和独立 Test Agent 已通过的业务证据。',
      '--risk', '没有影响本次结卡成立的已知风险。',
    ]);
    await command(executionId, token, ['review', 'assessment', 'complete']);
  }
  const sections = [
    ['outcome', '原始业务目标已经实现，用户可观察状态与需求一致。'],
    ['scope', '实际交付包含状态映射走查和独立黑盒验证，不包含新增 API。'],
    ['implementation', '现有实现已经满足冻结规格，本轮不为制造差异而修改代码。'],
    ['verification', 'Test Agent 已从用户入口完成独立验证，验收与相邻回归通过。'],
    ['risks', '没有阻止结卡的已知限制；残余风险已明确记录。'],
  ];
  for (const [kind, content] of sections) {
    await command(executionId, token, [
      'review', 'report', 'section-upsert',
      '--kind', kind,
      '--content', content,
    ]);
  }
}

async function finishReport(executionId: string, token: string) {
  await command(executionId, token, ['review', 'report', 'complete']);
  await command(executionId, token, ['review', 'validate']);
  return command(executionId, token, ['review', 'complete']);
}

test('Review Agent progressively reconciles every required fact and publishes one report', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask } = await import('./tasks');
  const fixture = await reviewDelegation('渐进式最终事实对账');
  const started = await begin(
    fixture.delegation,
    `${fixture.taskId}-complete`,
    fixture.resources,
  );

  await assert.rejects(
    command(started.executionId, started.token, [
      'review', 'report', 'section-upsert',
      '--kind', 'outcome',
      '--content', '不能跳过 status。',
    ]),
    /review status/,
  );
  const initial = await command(
    started.executionId,
    started.token,
    ['review', 'status'],
  );
  assert.match(initial, /最终事实对账草稿 v1/);
  assert.match(initial, /必需对账对象：2/);
  assert.match(initial, new RegExp(`DELIVERY_UNIT:${fixture.taskId}:1`));

  const firstSubject = (await draftSubjects(started.executionId))[0];
  await assert.rejects(
    command(started.executionId, started.token, [
      'review', 'reconciliation', 'upsert',
      '--key', 'spec-only',
      '--subject', firstSubject.subject_ref,
      '--result', '仅查看了规格。',
      '--evidence', fixture.specRef,
    ]),
    /独立 Test Agent/,
  );
  await assert.rejects(
    command(started.executionId, started.token, [
      'review', 'reconciliation', 'upsert',
      '--key', 'failed-test',
      '--subject', firstSubject.subject_ref,
      '--result', '错误地把失败验证当成通过证据。',
      '--evidence', fixture.failedTestExecutionRef,
    ]),
    /独立 Test Agent/,
  );

  await reconcileAll(
    started.executionId,
    started.token,
    fixture.passedTestExecutionRef,
    fixture.specRef,
  );
  const [, secondSubject] = await draftSubjects(started.executionId);
  await assert.rejects(
    command(started.executionId, started.token, [
      'review', 'reconciliation', 'upsert',
      '--key', 'subject-1',
      '--subject', secondSubject.subject_ref,
      '--result', '不能复用其他对象的稳定 key。',
      '--evidence', `${fixture.passedTestExecutionRef},${fixture.specRef}`,
    ]),
    /不能改绑/,
  );
  await writeCoreReport(started.executionId, started.token);
  await command(started.executionId, started.token, ['review', 'report', 'complete']);
  await assert.rejects(
    command(started.executionId, started.token, [
      'review', 'finalize', 'reopen-forward-units', '--reason', '错误回到缺口分支',
    ]),
    /只能回流 REPORT/,
  );
  await command(started.executionId, started.token, ['review', 'validate']);
  await command(started.executionId, started.token, ['review', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.verdict, 'report_ready');
  assert.equal(result?.closureGaps?.length || 0, 0);
  assert.match(result?.artifact?.content || '', /## 最终事实对账/);
  assert.doesNotMatch(result?.artifact?.content || '', /EXEC:|SPEC:|DELIVERY_UNIT:|REQUIREMENT:/);
  assert.match(result?.artifact?.content || '', /证据边界：已绑定 2 项冻结证据/);

  await applyAgentResult(
    `RUN-review-complete-${fixture.taskId}`,
    fixture.delegation,
    result!,
    { executionId: started.executionId },
  );
  await completeExecution(started.executionId);
  const detail = await getTask(fixture.taskId);
  assert.equal(detail?.task.agile_status, 'ready_to_close');
  assert.equal(detail?.task.closure_status, 'awaiting_read');
  assert.equal(detail?.task.review_revision, 1);
  assert.match(
    detail?.documents.find((item) => item.kind === 'review_v1')?.content || '',
    /渐进式最终事实对账 · 结卡报告/,
  );
});

test('Review binds reconciliations to the exact evidence revision and content', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const fixture = await reviewDelegation('证据版本冻结');
  const started = await begin(
    fixture.delegation,
    `${fixture.taskId}-evidence-version`,
    fixture.resources,
  );
  await command(started.executionId, started.token, ['review', 'status']);
  await reconcileAll(
    started.executionId,
    started.token,
    fixture.passedTestExecutionRef,
    fixture.specRef,
  );
  await writeCoreReport(started.executionId, started.token);

  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT input_json FROM execution_attempts WHERE execution_id = ?
  `).get(started.executionId) as { input_json: string };
  const input = JSON.parse(row.input_json);
  const testEvidence = input.contextSnapshot.resources.find(
    (resource: { ref: string }) =>
      resource.ref === fixture.passedTestExecutionRef,
  );
  testEvidence.revision = 2;
  testEvidence.content.content = '同一个文档引用现在承载了另一版验证结论。';
  db.prepare(`
    UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?
  `).run(JSON.stringify(input), started.executionId);

  await assert.rejects(
    command(started.executionId, started.token, ['review', 'report', 'complete']),
    /证据版本或内容已变化/,
  );
});

test('Review rejects an execution whose delivery-unit snapshot is stale', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const fixture = await reviewDelegation('过期 Review 上下文');
  const started = await begin(
    fixture.delegation,
    `${fixture.taskId}-stale-context`,
    fixture.resources,
  );
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks SET total_stories = 2 WHERE task_id = ?
  `).run(fixture.taskId);
  await assert.rejects(
    command(started.executionId, started.token, ['review', 'status']),
    /Review execution 已过期/,
  );
});

test('Review closure gap is submitted as forward work instead of a block or question', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, upsertDocument } = await import('./tasks');
  const fixture = await reviewDelegation('结卡缺口前向补齐');
  const started = await begin(
    fixture.delegation,
    `${fixture.taskId}-gap`,
    fixture.resources,
  );
  await command(started.executionId, started.token, ['review', 'status']);
  const subjects = await draftSubjects(started.executionId);
  const gapSubject = subjects[0].subject_ref;
  await reconcileAll(
    started.executionId,
    started.token,
    fixture.passedTestExecutionRef,
    fixture.specRef,
    gapSubject,
  );
  await command(started.executionId, started.token, [
    'review', 'gap', 'upsert',
    '--key', 'missing-end-to-end-proof',
    '--subject', gapSubject,
    '--kind', 'missing_evidence',
    '--reason', '当前验证只覆盖交付单元，没有覆盖需求级端到端目标。',
    '--boundary', '从用户入口完成完整流程，并由 Test Agent 保存独立证据。',
  ]);
  await command(started.executionId, started.token, ['review', 'reconciliation', 'complete']);
  await command(started.executionId, started.token, [
    'review', 'assessment', 'record',
    '--summary', '需求级目标仍缺少端到端闭环证据，不能生成结卡报告。',
    '--evidence-boundary', '现有证据只覆盖单个交付单元，没有证明需求级完整流程。',
  ]);
  const forwardPacket = await command(started.executionId, started.token, ['review', 'assessment', 'complete']);
  assert.match(forwardPacket, /FORWARD DELIVERY UNITS/);
  await command(started.executionId, started.token, [
    'review', 'forward-unit', 'upsert',
    '--key', 'prove-end-to-end-result',
    '--title', '补齐需求级端到端结果证据',
    '--actor', '用户',
    '--trigger', '用户从真实入口完成完整业务流程',
    '--outcome', '用户能够观察到符合原始需求的最终结果',
    '--acceptance', 'Test Agent 从真实用户入口取得完整流程的独立通过证据',
    '--gaps', 'missing-end-to-end-proof',
  ]);
  await command(started.executionId, started.token, ['review', 'forward-units', 'complete']);
  await assert.rejects(
    command(started.executionId, started.token, [
      'review', 'finalize', 'reopen-report', '--reason', '错误回到无缺口分支',
    ]),
    /只能回流 FORWARD DELIVERY UNITS/,
  );
  await command(started.executionId, started.token, ['review', 'validate']);
  const output = await command(
    started.executionId,
    started.token,
    ['review', 'complete'],
  );
  assert.match(output, /forward_work_submitted/);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.verdict, 'closure_gap');
  assert.equal(result?.artifact, undefined);
  assert.equal(result?.questions.length, 0);
  assert.equal(result?.runtimeInputs.length, 0);
  assert.equal(result?.closureGaps?.[0]?.key, 'missing-end-to-end-proof');
  assert.equal(result?.closureGapUnits?.[0]?.key, 'prove-end-to-end-result');

  const applied = await applyAgentResult(
    `RUN-review-gap-${fixture.taskId}`,
    fixture.delegation,
    result!,
    { executionId: started.executionId },
  );
  assert.equal(applied, 'advanced');
  const detail = await getTask(fixture.taskId);
  assert.equal(detail?.task.agile_status, 'ready for dev');
  assert.equal(detail?.task.current_subagent, 'analyst-agent');
  assert.equal(detail?.task.total_stories, 2);
  assert.equal(detail?.task.analysis_index, 1);
  assert.equal(detail?.task.dev_index, 1);
  assert.equal(detail?.task.test_index, 1);
  assert.equal(detail?.task.review_revision, 0);
  assert.equal(detail?.questions.length, 0);

  const db = await databaseConnection();
  const newSpecId = randomUUID();
  db.prepare(`
    INSERT INTO story_specs(
      spec_id, task_id, story_index, revision, status, spec_json, resolved_at
    ) VALUES(?, ?, 2, 1, 'resolved', ?, CURRENT_TIMESTAMP)
  `).run(newSpecId, fixture.taskId, JSON.stringify(deliverySpecFixture()));
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in review', current_subagent = 'review-agent',
        analysis_index = 2, dev_index = 2, test_index = 2,
        spec_resolved_index = 2, run_state = 'runnable'
    WHERE task_id = ?
  `).run(fixture.taskId);
  const newTestDocumentId = await upsertDocument({
    taskId: fixture.taskId,
    storyIndex: 2,
    actor: 'test-agent',
    kind: 'test_result',
    title: '补齐结卡证据验证报告',
    content: '新增交付单元已经从用户入口独立验证通过。',
    format: 'markdown',
  });
  const resumedDelegation: DelegationEnvelope = {
    ...fixture.delegation,
    agileStatus: 'in review',
    analysisIndex: 2,
    devIndex: 2,
    testIndex: 2,
    specResolvedIndex: 2,
    totalStories: 2,
  };
  const resumed = await begin(
    resumedDelegation,
    `${fixture.taskId}-after-gap`,
    [...fixture.resources, {
      ref: `DOC:${newTestDocumentId}`,
      kind: 'document',
      status: 'active',
      content: {
        kind: 'test_result',
        sourceAgent: 'test-agent',
        content: '新增交付单元已经从用户入口独立验证通过。',
      },
    }, {
      ref: `SPEC:${newSpecId}:r1`,
      kind: 'delivery_spec',
      status: 'resolved',
      content: deliverySpecFixture(),
    }],
  );
  const resumedStatus = await command(
    resumed.executionId,
    resumed.token,
    ['review', 'status'],
  );
  assert.match(resumedStatus, /最终事实对账草稿 v2/);
  assert.match(resumedStatus, /必需对账对象：3/);
  assert.match(resumedStatus, /missing-end-to-end-proof · missing_evidence · forwarded/);
  assert.match(resumedStatus, new RegExp(`DELIVERY_UNIT:${fixture.taskId}:2`));
  await assert.rejects(
    command(resumed.executionId, resumed.token, [
      'review', 'gap', 'upsert',
      '--key', 'missing-end-to-end-proof',
      '--subject', gapSubject,
      '--kind', 'missing_evidence',
      '--reason', '不能把已经前向追加的缺口重新激活。',
      '--boundary', '必须由新增交付单元产生新的最终事实。',
    ]),
    /已形成前向交付单元/,
  );
});

test('Review help exposes only the new minimal command protocol', async () => {
  const fixture = await reviewDelegation('Review 命令帮助');
  const started = await begin(
    fixture.delegation,
    `${fixture.taskId}-help`,
    fixture.resources,
  );
  await assert.rejects(command(started.executionId, started.token, ['help']), /help 必须指定一个主题/);
  const reconciliationHelp = await command(started.executionId, started.token, ['help', 'reconciliation']);
  assert.match(reconciliationHelp, /review reconciliation complete/);
  const gapHelp = await command(
    started.executionId,
    started.token,
    ['help', 'gap'],
  );
  assert.match(gapHelp, /Harness 会把缺口前向追加为新交付单元/);
  const assessmentHelp = await command(started.executionId, started.token, ['help', 'assessment']);
  assert.match(assessmentHelp, /review assessment complete/);
  const forwardHelp = await command(started.executionId, started.token, ['help', 'forward']);
  assert.match(forwardHelp, /不经过 Story Splitter/);
});

test('feedback report correction inherits the current structured report and cannot route closure gaps', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask } = await import('./tasks');
  const fixture = await reviewDelegation('结卡报告表达更正');
  const closure = await begin(
    fixture.delegation,
    `${fixture.taskId}-baseline`,
    fixture.resources,
  );
  await command(closure.executionId, closure.token, ['review', 'status']);
  await reconcileAll(
    closure.executionId,
    closure.token,
    fixture.passedTestExecutionRef,
    fixture.specRef,
  );
  await writeCoreReport(closure.executionId, closure.token);
  await finishReport(closure.executionId, closure.token);
  const baseline = await readAgentCommandSubmission(closure.executionId);
  await applyAgentResult(
    `RUN-review-baseline-${fixture.taskId}`,
    fixture.delegation,
    baseline!,
    { executionId: closure.executionId },
  );

  const detail = await getTask(fixture.taskId);
  assert.ok(detail?.task.review_document_id);
  const db = await databaseConnection();
  const batchId = `BATCH-${randomUUID()}`;
  const groupId = `GROUP-${randomUUID()}`;
  db.prepare(`
    INSERT INTO feedback_batches(
      batch_id, task_id, status, summary
    ) VALUES(?, ?, 'reporting', '修正报告表达')
  `).run(batchId, fixture.taskId);
  db.prepare(`
    INSERT INTO feedback_groups(
      group_id, batch_id, group_key, group_order, work_type, status,
      title, reason, acceptance_json
    ) VALUES(
      ?, ?, 'wording-correction', 1, 'report_correction', 'executing',
      '修正验证环境表述', '原报告把本地环境写成生产环境',
      '["验证章节必须准确说明本地测试环境"]'
    )
  `).run(groupId, batchId);
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in feedback', current_subagent = 'review-agent',
        run_state = 'runnable', closure_status = 'none'
    WHERE task_id = ?
  `).run(fixture.taskId);

  const reportRef = `DOC:${detail!.task.review_document_id}`;
  const correctionDelegation: DelegationEnvelope = {
    ...fixture.delegation,
    pipeline: 'feedback-report',
    feedbackBatchId: batchId,
    feedbackGroupId: groupId,
    agileStatus: 'in feedback',
    reviewRevision: 1,
    reviewDocumentId: detail!.task.review_document_id || '',
  };
  const correction = await begin(
    correctionDelegation,
    `${fixture.taskId}-correction`,
    [{
      ref: reportRef,
      kind: 'document',
      status: 'active',
      content: {
        kind: 'review_v1',
        sourceAgent: 'review-agent',
        content: baseline?.artifact?.content,
      },
    }],
  );
  const restored = await command(
    correction.executionId,
    correction.token,
    ['review', 'status'],
  );
  assert.match(restored, /模式：报告表达更正/);
  assert.match(restored, /报告基线：revision 1/);
  assert.match(restored, /报告章节：5\/8/);
  const [subject] = await draftSubjects(correction.executionId);
  assert.equal(subject.subject_ref, `FEEDBACK_GROUP:${groupId}:report_correction`);
  await assert.rejects(
    command(correction.executionId, correction.token, [
      'review', 'gap', 'upsert',
      '--key', 'wrong-route',
      '--subject', subject.subject_ref,
      '--kind', 'fact_conflict',
      '--reason', '不应由报告更正处理。',
      '--boundary', '重新分流。',
    ]),
    /报告表达更正不能创建结卡缺口/,
  );
  await command(correction.executionId, correction.token, [
    'review', 'reconciliation', 'upsert',
    '--key', 'wording-correction',
    '--subject', subject.subject_ref,
    '--result', '候选报告已把验证环境准确修订为本地测试环境。',
    '--evidence', reportRef,
  ]);
  await command(correction.executionId, correction.token, ['review', 'reconciliation', 'complete']);
  await command(correction.executionId, correction.token, [
    'review', 'assessment', 'record',
    '--summary', '候选报告只修正验证环境表述，既有交付事实保持不变。',
    '--evidence-boundary', '仅以当前报告基线和冻结的表达更正要求为依据。',
  ]);
  await command(correction.executionId, correction.token, ['review', 'assessment', 'complete']);
  await command(correction.executionId, correction.token, [
    'review', 'report', 'section-upsert',
    '--kind', 'verification',
    '--content', 'Test Agent 已在本地测试环境从用户入口完成独立验证。',
  ]);
  await command(correction.executionId, correction.token, ['review', 'report', 'complete']);
  await command(correction.executionId, correction.token, ['review', 'validate']);
  db.prepare(`
    UPDATE tasks SET review_revision = 2 WHERE task_id = ?
  `).run(fixture.taskId);
  await assert.rejects(
    command(correction.executionId, correction.token, ['review', 'complete']),
    /结卡报告基线已变化/,
  );
  db.prepare(`
    UPDATE tasks SET review_revision = 1 WHERE task_id = ?
  `).run(fixture.taskId);
  await command(correction.executionId, correction.token, ['review', 'complete']);
  const corrected = await readAgentCommandSubmission(correction.executionId);
  assert.equal(corrected?.verdict, 'report_ready');
  assert.match(corrected?.artifact?.content || '', /本地测试环境/);
  assert.doesNotMatch(corrected?.artifact?.content || '', /生产环境/);
});

test('ordinary Review freezes business intent, TO-BE, impact, acceptance, and each delivery unit as subjects', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const fixture = await reviewDelegation('需求级对账对象');
  const db = await databaseConnection();
  const contextDraftId = randomUUID();
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, terminal_action, submitted_at
    ) VALUES(
      ?, ?, 1, 'requirement_context', ?,
      'backlog-agent', 'submitted', 'complete', CURRENT_TIMESTAMP
    )
  `).run(
    contextDraftId,
    `requirement-context:${fixture.taskId}`,
    fixture.taskId,
  );
  db.prepare(`
    INSERT INTO requirement_context_drafts(
      draft_id, intent, change_summary, classification
    ) VALUES(
      ?, '让用户看到准确的最终状态',
      '状态变化必须在页面可观察', 'feature'
    )
  `).run(contextDraftId);
  db.prepare(`
    INSERT INTO requirement_context_assertions(
      draft_id, assertion_key, perspective, statement, evidence_status,
      source, lifecycle_status, ordinal
    ) VALUES(
      ?, 'visible-state', 'target', '页面展示准确的最终状态',
      'decided', '用户需求', 'active', 1
    )
  `).run(contextDraftId);
  db.prepare(`
    INSERT INTO requirement_context_impacts(
      draft_id, impact_key, statement, disposition, rationale,
      source, lifecycle_status, ordinal
    ) VALUES(
      ?, 'status-view', '状态展示必须同步更新', 'change',
      '否则用户无法判断操作是否完成', '业务分析', 'active', 1
    )
  `).run(contextDraftId);
  db.prepare(`
    INSERT INTO requirement_context_acceptance_items(
      draft_id, acceptance_key, content, source, lifecycle_status, ordinal
    ) VALUES(
      ?, 'visible-final-state', '用户完成操作后看到准确最终状态',
      '用户验收', 'active', 1
    )
  `).run(contextDraftId);

  const started = await begin(
    fixture.delegation,
    `${fixture.taskId}-subjects`,
    fixture.resources,
  );
  const status = await command(
    started.executionId,
    started.token,
    ['review', 'status'],
  );
  assert.match(status, /必需对账对象：5/);
  const subjects = await draftSubjects(started.executionId);
  assert.deepEqual(
    subjects.map((item) => item.subject_kind),
    ['intent', 'target', 'impact', 'acceptance', 'delivery_unit'],
  );
  assert.match(subjects[0].subject_ref, new RegExp(`REQUIREMENT_CONTEXT:${contextDraftId}:intent`));
  assert.equal(
    subjects.at(-1)?.subject_ref,
    `DELIVERY_UNIT:${fixture.taskId}:1`,
  );
});
