import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

test('projects the current structured phase and latest Agent domain command', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('./tasks');
  const { agentCommandProgressInDb } = await import('./agent-command-progress');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Command chain progress projection' });
  const executionId = randomUUID();
  const draftId = randomUUID();

  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline,
      delegation_key, attempt, status, input_hash, input_json, started_at
    ) VALUES(?, 'RUN-command-progress', ?, 1, 'test-agent', 'test', ?, 1, 'running', 'hash', '{}', CURRENT_TIMESTAMP)
  `).run(executionId, taskId, `test:${taskId}:1`);
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id, story_index,
      agent, status, change_seq, last_execution_id, status_viewed_execution_id
    ) VALUES(?, ?, 1, 'verification', ?, 1, 'test-agent', 'editing', 4, ?, ?)
  `).run(draftId, `verification:${taskId}:1`, taskId, executionId, executionId);
  db.prepare(`INSERT INTO verification_drafts(draft_id, workflow_phase) VALUES(?, 'execute')`).run(draftId);

  const command = `node "/app/scripts/loop/loop-agent.mjs" verification result record --key smoke`;
  db.prepare(`
    INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
    VALUES(?, ?, 'tool_event', '00000001', ?), (?, ?, 'tool_event', '00000002', ?)
  `).run(
    randomUUID(), executionId, JSON.stringify({ phase: 'started', commandHash: 'command-hash', summary: '记录场景验证结果', input: { command } }),
    randomUUID(), executionId, JSON.stringify({ phase: 'completed', commandHash: 'command-hash', success: true, input: { command } }),
  );

  const progress = agentCommandProgressInDb(db, taskId);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].agent, 'test-agent');
  assert.equal(progress[0].currentPhase, 'execute');
  assert.deepEqual(progress[0].stages.map((stage) => [stage.label, stage.status]), [
    ['验证计划', 'completed'],
    ['执行验证', 'current'],
    ['证据复核', 'pending'],
    ['最终提交', 'pending'],
  ]);
  assert.deepEqual(progress[0].latestCommand && {
    label: progress[0].latestCommand.label,
    status: progress[0].latestCommand.status,
  }, { label: '记录场景验证结果', status: 'success' });
});

test('does not expose a historical draft after its Agent has stopped running', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('./tasks');
  const { agentCommandProgressInDb } = await import('./agent-command-progress');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Waiting command chain progress' });
  const executionId = randomUUID();
  const draftId = randomUUID();

  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline,
      delegation_key, attempt, status, input_hash, input_json
    ) VALUES(?, 'RUN-command-waiting', ?, 1, 'test-agent', 'test', ?, 1, 'applied', 'hash', '{}')
  `).run(executionId, taskId, `test:${taskId}:1`);
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id, story_index,
      agent, status, change_seq, last_execution_id, status_viewed_execution_id
    ) VALUES(?, ?, 1, 'verification', ?, 1, 'test-agent', 'waiting_for_answers', 8, ?, ?)
  `).run(draftId, `verification:${taskId}:1`, taskId, executionId, executionId);
  db.prepare(`INSERT INTO verification_drafts(draft_id, workflow_phase) VALUES(?, 'finalize')`).run(draftId);

  assert.deepEqual(agentCommandProgressInDb(db, taskId), []);
});
