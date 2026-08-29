import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-command-chain-${suffix}`,
    delegation,
    prompt: 'YAML command chain prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function deliveryAnalysisDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('./tasks');
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
         '保持既有导出计算和任务调度语义', 'TEST:preserve:export-engine')
    `).run(taskId, taskId);
  })();
  const delegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.agent === 'analyst-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

test('delivery analysis work keys isolate units while resume keeps one command-chain draft', async () => {
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

test('analyst drafts have only the YAML command-chain protocol', async () => {
  const { taskId, delegation } = await deliveryAnalysisDelegation('单轨通用命令链交付分析');
  const active = await begin(delegation, taskId);

  const help = await command(active.executionId, active.token!, ['help']);
  assert.match(help, /通用命令链不绑定 Agent namespace/);
  await assert.rejects(
    command(active.executionId, active.token!, ['delivery-analysis', 'status']),
    /当前草稿使用通用命令链/,
  );

  const status = await command(active.executionId, active.token!, ['status']);
  assert.match(status, /Phase: delivery_unit/);
  assert.match(status, /## COMPLETE[\s\S]*phase complete/);
  assert.match(status, /## ARTIFACTS[\s\S]*None/);

  const impactPacket = await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(impactPacket, /IMPACT SCAN · artifact/);
  await assert.rejects(
    command(active.executionId, active.token!, ['phase', 'complete']),
    /缺少必需的 Artifact Block：delivery-analysis\.impacts/,
  );
  await command(active.executionId, active.token!, [
    'artifact', 'put', '--artifact', 'delivery-analysis', '--block', 'impacts', '--key', 'export-engine',
    '--content', [
      'area: 导出计算与调度',
      'finding: 结果交付不需要改变现有计算和任务状态机',
      'disposition: preserve',
      'evidence: 现有状态模型已覆盖计算、完成和失败',
    ].join('\n'),
  ]);
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await command(active.executionId, active.token!, [
    'artifact', 'put', '--artifact', 'delivery-analysis', '--block', 'answer-review',
    '--content', '已复查上游、项目证据与 Agent 结论，没有新增问题。',
  ]);
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await command(active.executionId, active.token!, [
    'artifact', 'put', '--artifact', 'delivery-analysis', '--block', 'summary',
    '--content', '导出结果交付不得改变既有计算、调度和失败语义。',
  ]);
  await command(active.executionId, active.token!, [
    'artifact', 'put', '--artifact', 'delivery-analysis', '--block', 'contract',
    '--content', '复用现有导出完成态提供结果入口，并从用户入口验证结果可使用。',
  ]);
  await command(active.executionId, active.token!, ['phase', 'complete']);
  const submitted = await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(submitted, /Outcome: completed/);

  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.spec?.unit.key, 'export-result');
  assert.equal(result?.spec?.impacts[0]?.key, 'export-engine');

  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const draft = db.prepare(`
    SELECT draft_id, command_chain_id FROM agent_work_drafts
    WHERE terminal_execution_id = ?
  `).get(active.executionId) as { draft_id: string; command_chain_id: string };
  assert.equal(draft.command_chain_id, 'delivery-analysis');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM command_chain_drafts WHERE draft_id = ?')
      .get(draft.draft_id) as { count: number }).count,
    1,
  );
});

test('the command-chain migration removes the Analyst domain draft model', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const oldTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'delivery_analysis_%'
    ORDER BY name
  `).all() as { name: string }[];
  assert.deepEqual(oldTables, []);

  const genericTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'command_chain_drafts', 'command_chain_artifact_blocks',
      'command_chain_decisions', 'command_chain_phase_transitions'
    ) ORDER BY name
  `).all() as { name: string }[];
  assert.equal(genericTables.length, 4);

  const draftColumns = db.prepare('PRAGMA table_info(agent_work_drafts)').all() as { name: string }[];
  assert.equal(draftColumns.some((column) => column.name === 'command_chain_id'), true);
  assert.equal(draftColumns.some((column) => column.name === 'engine_version'), false);
});
