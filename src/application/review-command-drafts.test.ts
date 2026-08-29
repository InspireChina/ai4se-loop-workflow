import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { stringify } from 'yaml';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string, resources: unknown[]) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const started = await beginTestExecutionAttempt({ runId: `RUN-review-${suffix}`, delegation, prompt: 'generic review prompt' });
  const db = await databaseConnection();
  const row = db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?')
    .get(started.attempt.execution_id) as { input_json: string };
  const input = JSON.parse(row.input_json);
  input.contextSnapshot = { resources };
  db.prepare('UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?')
    .run(JSON.stringify(input), started.attempt.execution_id);
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token: token! };
}

async function insertRequirementContext(taskId: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const draftId = randomUUID();
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id,
      agent, status, terminal_action, submitted_at, command_chain_id
    ) VALUES(?, ?, 1, 'requirement_context', ?, 'backlog-agent',
      'submitted', 'complete', CURRENT_TIMESTAMP, 'requirement-context')
  `).run(draftId, `requirement-context:${taskId}`, taskId);
  db.prepare(`
    INSERT INTO command_chain_drafts(draft_id, command_chain_id, definition_version, workflow_phase)
    VALUES(?, 'requirement-context', 1, 'finalize')
  `).run(draftId);
  const insert = db.prepare(`
    INSERT INTO command_chain_artifact_blocks(
      draft_id, artifact_id, block_id, item_key, content_format, content, ordinal
    ) VALUES(?, 'requirement-context', ?, ?, ?, ?, ?)
  `);
  insert.run(draftId, 'intent', '', 'markdown', '让用户看到准确的最终状态', 1);
  insert.run(draftId, 'assertions', 'visible-state', 'yaml', stringify({
    perspective: 'target', statement: '页面展示准确的最终状态', evidence: 'decided', source: '用户需求',
  }).trim(), 2);
  insert.run(draftId, 'impacts', 'status-view', 'yaml', stringify({
    statement: '状态展示必须同步更新', disposition: 'change', rationale: '用户需要判断操作是否完成', source: '业务分析',
  }).trim(), 3);
  insert.run(draftId, 'acceptance', 'visible-final-state', 'yaml', stringify({
    content: '用户完成操作后看到准确最终状态', source: '用户验收',
  }).trim(), 4);
}

async function reviewFixture(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, upsertDocument } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`UPDATE tasks SET agile_status = 'cancelled', run_state = 'idle', current_subagent = NULL WHERE agile_status NOT IN ('done', 'cancelled')`).run();
  const taskId = await createTask({ title, description: '确认现有状态映射并完成独立验证。' });
  await insertRequirementContext(taskId);
  db.prepare(`
    INSERT INTO stories(
      task_id, story_index, title, directory, unit_key, actor,
      trigger_condition, observable_outcome, acceptance
    ) VALUES(?, 1, '确认状态映射', 'story-001', 'state-mapping',
      '用户', '用户完成状态变更', '页面显示正确的最终状态', '独立黑盒验证最终状态')
  `).run(taskId);
  const specId = randomUUID();
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 1, 'resolved', ?, CURRENT_TIMESTAMP)
  `).run(specId, taskId, JSON.stringify(deliverySpecFixture()));
  db.prepare(`
    UPDATE tasks SET agile_status = 'in review', current_subagent = 'review-agent',
      total_stories = 1, analysis_index = 1, dev_index = 1, test_index = 1,
      spec_resolved_index = 1, run_state = 'runnable', next_step = '生成结卡报告'
    WHERE task_id = ?
  `).run(taskId);
  await upsertDocument({
    taskId, storyIndex: 1, actor: 'test-agent', kind: 'test_result',
    title: '验证报告', content: '从用户入口完成独立黑盒验证。', format: 'markdown',
  });
  const delegation = (await inspectTaskDispatch(taskId)).find((item) => item.agent === 'review-agent' && item.pipeline === 'review');
  assert.ok(delegation);
  const specRef = `SPEC:${specId}:r1`;
  const passedRef = `EXEC:passed-test-${taskId}`;
  const resources = [{
    ref: specRef, kind: 'delivery_spec', status: 'resolved', revision: 1, deliveryUnit: 1, content: deliverySpecFixture(),
  }, {
    ref: passedRef, kind: 'execution', status: 'applied', revision: 1, deliveryUnit: 1,
    content: { agent: 'test-agent', status: 'applied', outcome: 'completed', verdict: 'passed' },
  }];
  return {
    taskId,
    delegation: {
      ...delegation!, agileStatus: 'in review', currentSubagent: 'review-agent', closureStatus: 'none',
      totalStories: 1, reviewRevision: 0, reviewDocumentId: '',
    } as DelegationEnvelope,
    specRef, passedRef, resources,
  };
}

async function reviewSubjects(executionId: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  return db.prepare(`
    SELECT item_key FROM command_chain_artifact_blocks
    WHERE draft_id = (
      SELECT draft_id FROM agent_work_drafts WHERE last_execution_id = ? AND command_chain_id = 'review'
      ORDER BY draft_version DESC LIMIT 1
    ) AND artifact_id = 'review' AND block_id = 'subjects' ORDER BY ordinal
  `).all(executionId).map((row) => (row as { item_key: string }).item_key);
}

async function putArtifact(executionId: string, token: string, block: string, value: Record<string, unknown>, key?: string) {
  return command(executionId, token, [
    'artifact', 'put', '--artifact', 'review', '--block', block,
    ...(key ? ['--key', key] : []), '--content', stringify(value).trim(),
  ]);
}

async function reconcileAll(executionId: string, token: string, passedRef: string, specRef: string, except?: string) {
  for (const [index, subjectRef] of (await reviewSubjects(executionId)).entries()) {
    if (subjectRef === except) continue;
    await putArtifact(executionId, token, 'reconciliations', {
      subjectRef, result: '最终用户可观察结果与冻结承诺一致。', evidenceRefs: [passedRef, specRef],
    }, `subject-${index + 1}`);
  }
}

async function writeAssessment(executionId: string, token: string) {
  await putArtifact(executionId, token, 'assessment', {
    summary: '全部逐项事实组合后支持需求级结论。',
    evidenceBoundary: '仅覆盖冻结规格和独立 Test Agent 已通过的业务证据。',
    residualRisk: '没有影响本次结论的已知风险。',
  });
}

async function writeCoreReport(executionId: string, token: string) {
  const sections: Record<string, string> = {
    outcome: '原始业务目标已经实现，用户可观察状态与需求一致。',
    scope: '实际交付覆盖冻结范围，不包含额外 API。',
    implementation: '实现满足冻结规格。',
    verification: 'Test Agent 已从用户入口完成独立验证。',
    risks: '没有阻止结卡的已知限制。',
  };
  for (const [kind, content] of Object.entries(sections)) {
    await putArtifact(executionId, token, 'report-sections', { kind, content }, kind);
  }
}

async function completeReportFlow(executionId: string, token: string, passedRef: string, specRef: string) {
  await command(executionId, token, ['status']);
  await command(executionId, token, ['phase', 'complete']);
  await reconcileAll(executionId, token, passedRef, specRef);
  await command(executionId, token, ['phase', 'complete']);
  await writeAssessment(executionId, token);
  await command(executionId, token, ['phase', 'complete']);
  await writeCoreReport(executionId, token);
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['phase', 'complete']);
}

test('Review generic chain requires independent Test evidence and publishes a report', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const fixture = await reviewFixture('通用最终事实对账');
  const started = await begin(fixture.delegation, `${fixture.taskId}-complete`, fixture.resources);
  await assert.rejects(putArtifact(started.executionId, started.token, 'reconciliations', {
    subjectRef: 'unknown', result: '不能跳过 status', evidenceRefs: [fixture.specRef],
  }, 'early'), /先执行 status/);
  const status = await command(started.executionId, started.token, ['status']);
  assert.match(status, /FROZEN REVIEW INPUTS/);
  assert.match(status, /REQUIREMENT_CONTEXT:/);
  await command(started.executionId, started.token, ['phase', 'complete']);
  const [first, second] = await reviewSubjects(started.executionId);
  await putArtifact(started.executionId, started.token, 'reconciliations', {
    subjectRef: first, result: '只有规格证据。', evidenceRefs: [fixture.specRef],
  }, 'stable');
  await assert.rejects(putArtifact(started.executionId, started.token, 'reconciliations', {
    subjectRef: second, result: '错误改绑。', evidenceRefs: [fixture.passedRef],
  }, 'stable'), /不能改绑/);
  await reconcileAll(started.executionId, started.token, fixture.passedRef, fixture.specRef, first);
  await assert.rejects(command(started.executionId, started.token, ['phase', 'complete']), /缺少独立 Test 通过证据/);
  await putArtifact(started.executionId, started.token, 'reconciliations', {
    subjectRef: first, result: '最终事实已有独立验证。', evidenceRefs: [fixture.passedRef, fixture.specRef],
  }, 'stable');
  await command(started.executionId, started.token, ['phase', 'complete']);
  await writeAssessment(started.executionId, started.token);
  await command(started.executionId, started.token, ['phase', 'complete']);
  await writeCoreReport(started.executionId, started.token);
  await command(started.executionId, started.token, ['phase', 'complete']);
  await command(started.executionId, started.token, ['phase', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.verdict, 'report_ready');
  assert.equal(result?.questions.length, 0);
  assert.match(result?.artifact?.content || '', /## 最终事实对账/);
  assert.doesNotMatch(result?.artifact?.content || '', /EXEC:|SPEC:|REQUIREMENT_CONTEXT:/);
});

test('Review generic chain rejects changed frozen evidence', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const fixture = await reviewFixture('冻结 Review 证据');
  const started = await begin(fixture.delegation, `${fixture.taskId}-evidence`, fixture.resources);
  await command(started.executionId, started.token, ['status']);
  const db = await databaseConnection();
  const row = db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?').get(started.executionId) as { input_json: string };
  const input = JSON.parse(row.input_json);
  input.contextSnapshot.resources.find((item: { ref: string }) => item.ref === fixture.passedRef).revision = 2;
  db.prepare('UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?').run(JSON.stringify(input), started.executionId);
  await assert.rejects(command(started.executionId, started.token, ['phase', 'complete']), /冻结证据版本或内容已变化/);
});

test('Review generic chain compiles closure gaps into forward delivery units', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const fixture = await reviewFixture('结卡缺口前向补齐');
  const started = await begin(fixture.delegation, `${fixture.taskId}-gap`, fixture.resources);
  await command(started.executionId, started.token, ['status']);
  await command(started.executionId, started.token, ['phase', 'complete']);
  const [gapSubject] = await reviewSubjects(started.executionId);
  await reconcileAll(started.executionId, started.token, fixture.passedRef, fixture.specRef, gapSubject);
  await putArtifact(started.executionId, started.token, 'gaps', {
    subjectRef: gapSubject, kind: 'missing_evidence', reason: '缺少需求级端到端证据。',
    boundary: '从用户入口完成完整流程并保存独立证据。',
  }, 'missing-end-to-end-proof');
  await command(started.executionId, started.token, ['phase', 'complete']);
  await writeAssessment(started.executionId, started.token);
  await command(started.executionId, started.token, ['phase', 'complete']);
  await putArtifact(started.executionId, started.token, 'forward-units', {
    title: '补齐需求级端到端结果证据', actor: '用户', trigger: '用户从真实入口完成完整业务流程',
    observableOutcome: '用户观察到符合原始需求的最终结果', acceptance: 'Test Agent 取得完整流程的独立通过证据',
    gapKeys: ['missing-end-to-end-proof'], dependsOn: [],
  }, 'prove-end-to-end-result');
  await command(started.executionId, started.token, ['phase', 'complete']);
  await command(started.executionId, started.token, ['phase', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.verdict, 'closure_gap');
  assert.equal(result?.artifact, undefined);
  assert.equal(result?.closureGaps?.[0]?.key, 'missing-end-to-end-proof');
  assert.equal(result?.closureGapUnits?.[0]?.key, 'prove-end-to-end-result');
});

test('feedback report correction inherits generic report sections and remains version-bound', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask } = await import('./tasks');
  const fixture = await reviewFixture('结卡报告表达更正');
  const closure = await begin(fixture.delegation, `${fixture.taskId}-baseline`, fixture.resources);
  await completeReportFlow(closure.executionId, closure.token, fixture.passedRef, fixture.specRef);
  const baseline = await readAgentCommandSubmission(closure.executionId);
  await applyAgentResult(`RUN-review-baseline-${fixture.taskId}`, fixture.delegation, baseline!, { executionId: closure.executionId });
  const detail = await getTask(fixture.taskId);
  assert.ok(detail?.task.review_document_id);
  const db = await databaseConnection();
  const batchId = `BATCH-${randomUUID()}`;
  const groupId = `GROUP-${randomUUID()}`;
  db.prepare(`INSERT INTO feedback_batches(batch_id, task_id, status, summary) VALUES(?, ?, 'reporting', '修正报告表达')`).run(batchId, fixture.taskId);
  db.prepare(`
    INSERT INTO feedback_groups(
      group_id, batch_id, group_key, group_order, work_type, status, title, reason, acceptance_json
    ) VALUES(?, ?, 'wording-correction', 1, 'report_correction', 'executing',
      '修正验证环境表述', '原报告环境表述错误', '["验证章节必须准确说明本地测试环境"]')
  `).run(groupId, batchId);
  db.prepare(`UPDATE tasks SET agile_status = 'in feedback', current_subagent = 'review-agent', run_state = 'runnable', closure_status = 'none' WHERE task_id = ?`).run(fixture.taskId);
  const reportRef = `DOC:${detail!.task.review_document_id}`;
  const delegation: DelegationEnvelope = {
    ...fixture.delegation, pipeline: 'feedback-report', feedbackBatchId: batchId, feedbackGroupId: groupId,
    agileStatus: 'in feedback', reviewRevision: 1, reviewDocumentId: detail!.task.review_document_id || '',
  };
  const correction = await begin(delegation, `${fixture.taskId}-correction`, [{
    ref: reportRef, kind: 'document', status: 'active', revision: 1,
    content: { kind: 'review_v1', sourceAgent: 'review-agent', content: baseline?.artifact?.content },
  }]);
  const status = await command(correction.executionId, correction.token, ['status']);
  assert.match(status, /mode: report_correction/);
  assert.match(status, /report-sections: 5/);
  await command(correction.executionId, correction.token, ['phase', 'complete']);
  const [subjectRef] = await reviewSubjects(correction.executionId);
  await assert.rejects(putArtifact(correction.executionId, correction.token, 'gaps', {
    subjectRef, kind: 'fact_conflict', reason: '错误分流', boundary: '重新分流',
  }, 'wrong-route'), /报告表达更正不能创建结卡缺口/);
  await putArtifact(correction.executionId, correction.token, 'reconciliations', {
    subjectRef, result: '报告表述已修正。', evidenceRefs: [reportRef],
  }, 'wording-correction');
  await command(correction.executionId, correction.token, ['phase', 'complete']);
  await writeAssessment(correction.executionId, correction.token);
  await command(correction.executionId, correction.token, ['phase', 'complete']);
  await putArtifact(correction.executionId, correction.token, 'report-sections', {
    kind: 'verification', content: 'Test Agent 已在本地测试环境完成独立验证。',
  }, 'verification');
  await command(correction.executionId, correction.token, ['phase', 'complete']);
  db.prepare('UPDATE tasks SET review_revision = 2 WHERE task_id = ?').run(fixture.taskId);
  await assert.rejects(command(correction.executionId, correction.token, ['phase', 'complete']), /结卡报告基线已变化/);
  db.prepare('UPDATE tasks SET review_revision = 1 WHERE task_id = ?').run(fixture.taskId);
  await command(correction.executionId, correction.token, ['phase', 'complete']);
  const corrected = await readAgentCommandSubmission(correction.executionId);
  assert.equal(corrected?.verdict, 'report_ready');
  assert.match(corrected?.artifact?.content || '', /本地测试环境/);
});
