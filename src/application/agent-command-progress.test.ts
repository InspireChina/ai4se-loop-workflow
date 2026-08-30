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
      agent, status, change_seq, last_execution_id, status_viewed_execution_id, command_chain_id
    ) VALUES(?, ?, 1, 'verification', ?, 1, 'test-agent', 'editing', 4, ?, ?, 'verification')
  `).run(draftId, `verification:${taskId}:1`, taskId, executionId, executionId);
  db.prepare(`
    INSERT INTO command_chain_drafts(draft_id, command_chain_id, definition_version, workflow_phase)
    VALUES(?, 'verification', 1, 'execute')
  `).run(draftId);

  const command = `node "/app/scripts/loop/loop-agent.mjs" artifact put --artifact verification --block results --key smoke`;
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
    ['FROZEN VERIFICATION INPUTS', 'completed'],
    ['PLAN', 'completed'],
    ['EXECUTE', 'current'],
    ['EVIDENCE REVIEW', 'pending'],
    ['FINALIZE', 'pending'],
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
      agent, status, change_seq, last_execution_id, status_viewed_execution_id, command_chain_id
    ) VALUES(?, ?, 1, 'verification', ?, 1, 'test-agent', 'waiting_for_answers', 8, ?, ?, 'verification')
  `).run(draftId, `verification:${taskId}:1`, taskId, executionId, executionId);
  db.prepare(`
    INSERT INTO command_chain_drafts(draft_id, command_chain_id, definition_version, workflow_phase)
    VALUES(?, 'verification', 1, 'finalize')
  `).run(draftId);

  assert.deepEqual(agentCommandProgressInDb(db, taskId), []);
});

test('keeps every Agent domain command as one lifecycle record in execution audit', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('./tasks');
  const { agentCommandAuditInDb } = await import('./agent-command-progress');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Command audit projection' });
  const executionId = randomUUID();
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline,
      delegation_key, attempt, status, input_hash, input_json, started_at
    ) VALUES(?, 'RUN-command-audit', ?, 1, 'test-agent', 'test', ?, 1, 'running', 'hash', '{}', CURRENT_TIMESTAMP)
  `).run(executionId, taskId, `test:${taskId}:1`);

  const domainCommand = (command: string) => `node "/app/scripts/loop/loop-agent.mjs" ${command}`;
  const insertReceipt = db.prepare(`
    INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
    VALUES(?, ?, 'tool_event', ?, ?)
  `);
  insertReceipt.run(randomUUID(), executionId, '00000001', JSON.stringify({
    phase: 'started', toolCallId: 'call-1', commandHash: 'hash-1', summary: '恢复命令链草稿',
    input: { command: domainCommand('status') },
  }));
  insertReceipt.run(randomUUID(), executionId, '00000002', JSON.stringify({
    phase: 'completed', toolCallId: 'call-1', commandHash: 'hash-1', success: true,
    input: { command: domainCommand('status') },
  }));
  insertReceipt.run(randomUUID(), executionId, '00000003', JSON.stringify({
    phase: 'started', toolCallId: 'call-2', commandHash: 'hash-2', summary: '登记交付物',
    input: { command: domainCommand('artifact put') },
  }));
  insertReceipt.run(randomUUID(), executionId, '00000004', JSON.stringify({
    phase: 'completed', toolCallId: 'call-2', commandHash: 'hash-2', success: false,
    input: { command: domainCommand('artifact put') },
  }));
  insertReceipt.run(randomUUID(), executionId, '00000005', JSON.stringify({
    phase: 'started', toolCallId: 'call-3', commandHash: 'hash-3', summary: '完成命令链阶段',
    input: { command: domainCommand('phase complete') },
  }));
  insertReceipt.run(randomUUID(), executionId, '00000006', JSON.stringify({
    phase: 'started', toolCallId: 'call-ignored', summary: '读取普通项目文件',
    input: { command: 'rg -n TODO src' },
  }));

  const records = agentCommandAuditInDb(db, taskId);
  assert.deepEqual(records.map((record) => ({
    executionId: record.executionId,
    label: record.label,
    status: record.status,
    finished: Boolean(record.finishedAt),
  })), [
    { executionId, label: '恢复命令链草稿', status: 'success', finished: true },
    { executionId, label: '登记交付物', status: 'error', finished: true },
    { executionId, label: '完成命令链阶段', status: 'running', finished: false },
  ]);
});
