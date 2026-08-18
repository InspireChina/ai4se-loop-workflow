import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import type { DelegationEnvelope } from './tasks';

test('Direct Pipeline runs and submits one result before completing the requirement', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { applyAgentResult } = await import('./agent-results');
  const { issueAgentCommandToken, readAgentCommandSubmission, runAgentCommand } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { createTask, getTask } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'cancelled', run_state = 'idle', current_subagent = NULL
    WHERE agile_status NOT IN ('done', 'cancelled')
  `).run();

  const taskId = await createTask({
    title: '生成每日运营摘要',
    description: '读取现有资料并输出一份 Markdown 摘要。',
    itemType: 'direct',
  });
  const delegation = (await inspectTaskDispatch(taskId))[0] as DelegationEnvelope | undefined;
  assert.ok(delegation);
  assert.equal(delegation.agent, 'direct-agent');
  assert.equal(delegation.pipeline, 'direct');
  assert.deepEqual(delegation.resources, ['code:workspace', 'browser:exclusive']);

  const runId = `RUN-direct-${taskId}`;
  const started = await beginTestExecutionAttempt({
    runId,
    delegation,
    prompt: 'Direct Agent executes the requirement and submits one result.',
  });
  const executionId = started.attempt.execution_id;
  const token = await issueAgentCommandToken(executionId);
  assert.ok(token);

  await assert.rejects(
    runAgentCommand({
      executionId,
      token,
      args: ['direct', 'submit', '--summary', '摘要已生成'],
    }),
    /必须先执行 direct run/,
  );
  const ready = await runAgentCommand({
    executionId,
    token,
    args: ['direct', 'run'],
  });
  assert.match(ready, /Outcome: ready/);
  const submitted = await runAgentCommand({
    executionId,
    token,
    args: [
      'direct', 'submit',
      '--summary', '每日运营摘要已生成',
      '--result', '# 每日运营摘要\n\n- 今日无阻塞项。',
    ],
  });
  assert.match(submitted, /Outcome: submitted/);

  const result = await readAgentCommandSubmission(executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.summary, '每日运营摘要已生成');
  assert.equal(result?.artifact?.title, '直接执行结果');
  assert.match(result?.artifact?.content || '', /今日无阻塞项/);

  assert.equal(await applyAgentResult(runId, delegation, result!, { executionId }), 'advanced');
  await completeExecution(executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'done');
  assert.equal(detail?.task.run_state, 'idle');
  assert.equal(detail?.task.current_subagent, null);
  assert.equal(detail?.task.closure_status, 'acknowledged');
  assert.equal(detail?.task.next_step, '每日运营摘要已生成');
  assert.equal(detail?.documents.find((document) => document.kind === 'direct_result')?.content, '# 每日运营摘要\n\n- 今日无阻塞项。');
  assert.equal((await inspectTaskDispatch(taskId)).length, 0);
});
