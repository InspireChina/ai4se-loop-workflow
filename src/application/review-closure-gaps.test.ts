import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectAllDispatch, inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { assertAgentResultRoleContract, parseAgentResult } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';
import { applyAgentResult, applyNextQueuedAgentResult } from './agent-results';
import { forwardReviewClosureGaps } from './review-closure-gaps';
import { createTask, getTask, type DelegationEnvelope } from './tasks';

async function reviewReadyRequirement(label: string) {
  const taskId = await createTask({ title: `Review closure gap · ${label} · ${randomUUID()}` });
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO stories(
      task_id, story_index, title, directory,
      unit_key, actor, trigger_condition, observable_outcome, acceptance
    ) VALUES(?, 1, '既有交付单元', 'story-001',
      'existing-unit', '用户', '用户执行既有流程', '既有结果可见', '既有结果已验证')
  `).run(taskId);
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in review',
        current_subagent = 'review-agent',
        analysis_index = 1,
        dev_index = 1,
        test_index = 1,
        total_stories = 1,
        spec_resolved_index = 1,
        run_state = 'runnable',
        closure_status = 'none',
        next_step = '等待最终事实对账'
    WHERE task_id = ?
  `).run(taskId);
  const delegation = (await inspectTaskDispatch(taskId))
    .find((item) => item.agent === 'review-agent' && item.pipeline === 'review');
  assert.ok(delegation);
  return {
    taskId,
    delegation: {
      ...delegation,
      agileStatus: 'in review',
      currentSubagent: 'review-agent',
      closureStatus: 'none',
      totalStories: 1,
      reviewRevision: 0,
      reviewDocumentId: '',
    } as DelegationEnvelope,
  };
}

function closureGapResult() {
  return parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '最终事实对账发现两个尚未闭合的交付义务。',
    verdict: 'closure_gap',
    closureGaps: [{
      key: 'visible-proof',
      subject: 'UNIT:1:visible-result',
      kind: 'missing_evidence',
      reason: '缺少从用户入口完成整条路径的独立黑盒证据。',
      boundary: '从用户入口完成流程后，最终结果可见且 Test 证据通过。',
    }, {
      key: 'terminal-state',
      subject: 'REQUIREMENT:terminal-state',
      kind: 'fact_conflict',
      reason: '实现记录与验证记录对最终状态的描述不一致。',
      boundary: '实现与独立验证对同一个可观察最终状态达成一致。',
    }],
    closureGapUnits: [{
      key: 'align-and-prove-final-result',
      title: '统一并验证用户可见的最终结果',
      actor: '用户',
      trigger: '用户从真实入口完成既有流程',
      observableOutcome: '用户看到与业务承诺一致且不存在冲突描述的最终结果',
      acceptance: '实现与独立验证对最终状态一致，且 Test Agent 从真实入口取得通过证据',
      gapKeys: ['visible-proof', 'terminal-state'],
      dependsOn: [],
    }],
  }));
}

test('Review forward delivery units reject cyclic dependencies at the Application boundary', async () => {
  const { taskId } = await reviewReadyRequirement('cyclic-units');
  const result = closureGapResult();
  const units = [{
    ...result.closureGapUnits![0],
    key: 'unit-a',
    gapKeys: ['visible-proof'],
    dependsOn: ['unit-b'],
  }, {
    ...result.closureGapUnits![0],
    key: 'unit-b',
    gapKeys: ['terminal-state'],
    dependsOn: ['unit-a'],
  }];
  await assert.rejects(
    forwardReviewClosureGaps({
      taskId,
      sourceResultId: `RESULT-${randomUUID()}`,
      gaps: result.closureGaps || [],
      units,
      expected: {
        totalStories: 1,
        reviewRevision: 0,
        reviewDocumentId: '',
      },
    }),
    /依赖不能形成环/,
  );
});

test('Review closure gaps become idempotent forward delivery units', async () => {
  const { taskId, delegation } = await reviewReadyRequirement('forward');
  const result = closureGapResult();
  assert.doesNotThrow(() => assertAgentResultRoleContract(result, 'review-agent'));

  const outcome = await applyAgentResult(`RUN-review-gap-${randomUUID()}`, delegation, result);
  assert.equal(outcome, 'advanced');

  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready for dev');
  assert.equal(detail?.task.current_subagent, 'analyst-agent');
  assert.equal(detail?.task.total_stories, 2);
  assert.deepEqual(
    [detail?.task.analysis_index, detail?.task.dev_index, detail?.task.test_index],
    [1, 1, 1],
  );
  assert.equal(detail?.task.review_revision, 0);
  assert.equal(detail?.task.review_document_id, null);

  const db = await databaseConnection();
  const mappings = db.prepare(`
    SELECT source_result_id, gap_key, story_index
    FROM review_gap_delivery_unit_links
    WHERE task_id = ?
    ORDER BY story_index, gap_key
  `).all(taskId) as { source_result_id: string; gap_key: string; story_index: number }[];
  assert.deepEqual(
    mappings.map((row) => [row.gap_key, row.story_index]),
    [['terminal-state', 2], ['visible-proof', 2]],
  );
  const context = db.prepare(`
    SELECT story_index, source_kind, content
    FROM delivery_unit_context_links
    WHERE task_id = ? AND story_index > 1
    ORDER BY story_index, source_key
  `).all(taskId) as { story_index: number; source_kind: string; content: string }[];
  assert.equal(context.length, 4);
  assert.equal(context.some((item) => item.content.includes('UNIT:1:visible-result')), true);
  assert.equal(context.some((item) => item.content.includes('缺少从用户入口')), true);
  assert.equal(context.some((item) => item.content.includes('完成边界')), true);
  assert.equal(new Set(mappings.map((row) => row.story_index)).size, 1);

  const lanes = db.prepare(`
    SELECT lane, status
    FROM task_lanes
    WHERE task_id = ?
    ORDER BY lane
  `).all(taskId) as { lane: string; status: string }[];
  assert.deepEqual(lanes, [
    { lane: 'analysis', status: 'runnable' },
    { lane: 'delivery', status: 'pending' },
  ]);

  const retried = await forwardReviewClosureGaps({
    taskId,
    sourceResultId: mappings[0].source_result_id,
    gaps: result.closureGaps || [],
    units: result.closureGapUnits || [],
    expected: {
      totalStories: 1,
      reviewRevision: 0,
      reviewDocumentId: '',
    },
  });
  assert.equal(retried, 'already_applied');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM stories WHERE task_id = ?').get(taskId) as { count: number }).count,
    2,
  );

  db.prepare(`
    UPDATE agent_results
    SET application_status = 'pending', effect_outcome = NULL, applied_at = NULL
    WHERE result_id = ?
  `).run(mappings[0].source_result_id);
  const reapplied = await applyNextQueuedAgentResult();
  assert.equal(reapplied.status, 'applied');
  if (reapplied.status === 'applied') {
    assert.equal(reapplied.resultId, mappings[0].source_result_id);
    assert.equal(reapplied.outcome, 'advanced');
  }
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM stories WHERE task_id = ?').get(taskId) as { count: number }).count,
    2,
  );
});

test('feedback-report rejects closure gaps instead of creating forward work', async () => {
  const { taskId, delegation } = await reviewReadyRequirement('feedback-report');
  const feedbackDelegation: DelegationEnvelope = {
    ...delegation,
    pipeline: 'feedback-report',
    feedbackBatchId: 'BATCH-stale',
    feedbackGroupId: 'GROUP-stale',
  };
  await assert.rejects(
    () => applyAgentResult(`RUN-review-gap-feedback-${randomUUID()}`, feedbackDelegation, closureGapResult()),
    /反馈报告修订只能返回 verdict=report_ready/,
  );
  const db = await databaseConnection();
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM stories WHERE task_id = ?').get(taskId) as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM review_gap_delivery_unit_links WHERE task_id = ?').get(taskId) as { count: number }).count,
    0,
  );
});

test('a stale ordinary Review result is discarded without publishing or forwarding', async () => {
  const { taskId, delegation } = await reviewReadyRequirement('stale');
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in feedback', current_subagent = 'feedback-agent'
    WHERE task_id = ?
  `).run(taskId);

  const outcome = await applyAgentResult(
    `RUN-review-gap-stale-${randomUUID()}`,
    delegation,
    closureGapResult(),
  );
  assert.equal(outcome, 'discarded');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM stories WHERE task_id = ?').get(taskId) as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM review_gap_delivery_units WHERE task_id = ?').get(taskId) as { count: number }).count,
    0,
  );
});

test('queued Review replay uses the original execution frontier instead of the current task', async () => {
  const { taskId, delegation } = await reviewReadyRequirement('queued-stale');
  const result = closureGapResult();
  const started = await beginTestExecutionAttempt({
    runId: `RUN-review-queued-${randomUUID()}`,
    delegation,
    prompt: 'queued Review replay',
  });
  const resultId = randomUUID();
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO agent_results(
      result_id, run_id, task_id, story_index, agent, pipeline,
      outcome, result_json, application_status, execution_id
    ) VALUES(?, ?, ?, NULL, 'review-agent', 'review',
      'completed', ?, 'pending', ?)
  `).run(
    resultId,
    `RUN-review-queued-${taskId}`,
    taskId,
    JSON.stringify(result),
    started.attempt.execution_id,
  );
  db.prepare(`
    INSERT INTO stories(
      task_id, story_index, title, directory,
      unit_key, actor, trigger_condition, observable_outcome, acceptance
    ) VALUES(?, 2, '新一轮已有交付单元', 'story-002',
      'new-cycle-unit', '用户', '新一轮流程', '新结果', '新结果已验证')
  `).run(taskId);
  db.prepare(`
    UPDATE tasks
    SET total_stories = 2, analysis_index = 2, dev_index = 2,
        test_index = 2, spec_resolved_index = 2,
        agile_status = 'in review', current_subagent = 'review-agent'
    WHERE task_id = ?
  `).run(taskId);

  const replayed = await applyNextQueuedAgentResult();
  assert.equal(replayed.status, 'applied');
  if (replayed.status === 'applied') {
    assert.equal(replayed.resultId, resultId);
    assert.equal(replayed.outcome, 'discarded');
  }
  const recorded = db.prepare(`
    SELECT application_status, effect_outcome
    FROM agent_results WHERE result_id = ?
  `).get(resultId) as {
    application_status: string;
    effect_outcome: string | null;
  };
  assert.deepEqual(recorded, {
    application_status: 'applied',
    effect_outcome: 'discarded',
  });
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count
      FROM review_gap_delivery_units WHERE task_id = ?
    `).get(taskId) as { count: number }).count,
    0,
  );
});
