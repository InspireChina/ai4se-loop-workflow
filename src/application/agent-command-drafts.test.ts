import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import type { DelegationEnvelope } from './tasks';

function backlogDelegation(taskId: string): DelegationEnvelope {
  return {
    taskId, lane: 'control', pipeline: 'backlog', agent: 'backlog-agent', storyIndex: null,
    resources: ['browser:exclusive'], description: '收集需求上下文', title: '需求上下文',
    taskDescription: '管理员可以导出当前筛选结果。', itemType: 'feature', priority: '', link: '',
    externalId: '', externalStatus: '', agileStatus: 'backlog', currentSubagent: 'backlog-agent',
    resumePending: 0, specResolvedIndex: 0, runState: 'runnable', closureStatus: 'none',
    reviewRevision: 0, reviewDocumentId: '', lastActor: 'human', analysisIndex: 0, devIndex: 0,
    testIndex: 0, totalStories: 0, nextStep: '收集上下文', blockedReason: '', owner: '', evidence: '', risk: '',
  };
}

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-delivery-plan-chain-${suffix}`,
    delegation,
    prompt: 'YAML delivery plan command chain',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function taskReadyForSplit(title: string) {
  const { createTask } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { databaseConnection } = await import('../infrastructure/database');
  const taskId = await createTask({ title, description: '管理员可以导出当前筛选结果。' });
  const db = await databaseConnection();
  const draftId = `DRAFT-context-${taskId}`;
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id, agent,
      status, terminal_action, submitted_at, command_chain_id
    ) VALUES(?, ?, 1, 'requirement_context', ?, 'backlog-agent',
      'submitted', 'complete', CURRENT_TIMESTAMP, 'requirement-context')
  `).run(draftId, `requirement-context:${taskId}`, taskId);
  db.prepare(`
    INSERT INTO command_chain_drafts(draft_id, command_chain_id, definition_version, workflow_phase)
    VALUES(?, 'requirement-context', 1, 'finalize')
  `).run(draftId);
  db.prepare(`
    INSERT INTO command_chain_artifact_blocks(
      draft_id, artifact_id, block_id, item_key, content_format, content, ordinal
    ) VALUES
      (?, 'requirement-context', 'intent', '', 'markdown', '管理员取得筛选结果文件', 1),
      (?, 'requirement-context', 'impacts', 'filtered-export', 'yaml',
       'statement: 管理员可以下载当前筛选命中的结果\ndisposition: change\nrationale: 目标业务结果\nsource: 用户输入', 2)
  `).run(draftId, draftId);
  db.prepare(`
    INSERT INTO command_chain_acceptance_items(
      draft_id, acceptance_key, statement, oracle, source, ordinal
    ) VALUES(?, 'download-matches-filter', '下载内容与当前筛选结果一致',
      '真实下载记录集合等于筛选结果集合', '用户输入', 3)
  `).run(draftId);
  db.prepare(`
    INSERT INTO acceptances(
      acceptance_id, task_id, acceptance_key, scope_type, statement, oracle,
      source_ref, source_command_chain_draft_id
    ) VALUES(?, ?, 'download-matches-filter', 'requirement',
      '下载内容与当前筛选结果一致', '真实下载记录集合等于筛选结果集合', ?, ?)
  `).run(
    `ACCEPTANCE-${taskId}`,
    taskId,
    `REQUIREMENT:${taskId}:acceptance:download-matches-filter`,
    draftId,
  );
  await applyAgentResult(`RUN-context-${taskId}`, backlogDelegation(taskId), {
    outcome: 'completed',
    summary: '需求上下文完整，可以进入交付拆分。',
    artifact: { title: '需求上下文', content: '管理员导出当前筛选结果。' },
    questions: [], runtimeInputs: [], feedbackResolutions: [], recoveryResolutions: [],
  });
  const delegation = (await inspectTaskDispatch(taskId)).find((item) => item.agent === 'story-splitter-agent');
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function put(executionId: string, token: string, block: string, content: string, key?: string) {
  return command(executionId, token, [
    'artifact', 'put', '--artifact', 'delivery-plan', '--block', block,
    ...(key ? ['--key', key] : []), '--content', content,
  ]);
}

test('Story Splitter uses only the YAML command chain and compiles delivery units', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { getTask } = await import('./tasks');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { taskId, delegation } = await taskReadyForSplit('YAML 交付拆分');
  const active = await begin(delegation, taskId);

  assert.match(await command(active.executionId, active.token!, ['help']), /通用命令链/);
  await assert.rejects(command(active.executionId, active.token!, ['delivery-plan', 'status']), /只允许 YAML 命令链协议/);
  const status = await command(active.executionId, active.token!, ['status']);
  assert.match(status, /Phase: inputs/);
  assert.match(status, /impact:filtered-export/);
  assert.match(status, /acceptance:download-matches-filter/);

  await command(active.executionId, active.token!, ['phase', 'complete']);
  await put(active.executionId, active.token!, 'rationale', '按管理员获得可独立验收结果的业务闭环拆分。');
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await put(active.executionId, active.token!, 'units', [
    'title: 管理员下载当前筛选结果', 'actor: 管理员', 'trigger: 管理员在结果页发起导出',
    'observableOutcome: 管理员获得与当前筛选一致的文件',
    'acceptance: 下载文件中的记录与发起导出时的筛选结果一致',
    'sourceRefs:', '  - impact:filtered-export', '  - acceptance:download-matches-filter',
    'dependsOn: []',
  ].join('\n'), 'download-filtered-results');
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await put(active.executionId, active.token!, 'coverage', '唯一单元承接全部业务变化和需求级验收语义。');
  await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(await command(active.executionId, active.token!, ['phase', 'complete']), /Outcome: completed/);

  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.deliveryUnits?.[0]?.key, 'download-filtered-results');
  assert.deepEqual(result?.deliveryUnits?.[0]?.sourceRefs.map((source) => source.key), [
    'impact:filtered-export', 'acceptance:download-matches-filter',
  ]);
  await applyAgentResult(`RUN-delivery-plan-chain-${taskId}`, delegation, result!, { executionId: active.executionId });
  await completeExecution(active.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.stories[0]?.unit_key, 'download-filtered-results');
  assert.deepEqual(detail?.stories[0]?.context_links.map((link) => link.source_key), [
    'acceptance:download-matches-filter', 'impact:filtered-export',
  ]);

  const db = await databaseConnection();
  const unitAcceptances = db.prepare(`
    SELECT acceptance.acceptance_key, link.relation
    FROM delivery_unit_acceptances link
    JOIN acceptances acceptance ON acceptance.acceptance_id = link.acceptance_id
    WHERE link.task_id = ? AND link.story_index = 1
    ORDER BY link.relation, acceptance.acceptance_key
  `).all(taskId) as { acceptance_key: string; relation: string }[];
  assert.deepEqual(unitAcceptances, [
    { acceptance_key: 'download-matches-filter', relation: 'assigned' },
    { acceptance_key: 'unit:download-filtered-results', relation: 'unit' },
  ]);
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'delivery_plan_%'`).all(), []);
  const columns = db.prepare('PRAGMA table_info(stories)').all() as { name: string }[];
  assert.equal(columns.some((column) => column.name === 'source_delivery_plan_draft_id'), false);
  assert.equal(columns.some((column) => column.name === 'source_command_chain_draft_id'), true);
});

test('Delivery Plan final gate rejects uncovered sources and invalid dependencies', async () => {
  const { taskId, delegation } = await taskReadyForSplit('交付拆分门禁');
  const active = await begin(delegation, `${taskId}-gate`);
  await command(active.executionId, active.token!, ['status']);
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await put(active.executionId, active.token!, 'rationale', '按可独立验收闭环拆分。');
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await put(active.executionId, active.token!, 'units', [
    'title: 不完整导出单元', 'actor: 管理员', 'trigger: 发起导出',
    'observableOutcome: 获得导出文件', 'acceptance: 文件可以下载',
    'sourceRefs: [impact:filtered-export]', 'dependsOn: [missing-unit]',
  ].join('\n'), 'incomplete-export');
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await put(active.executionId, active.token!, 'coverage', '候选覆盖说明。');
  await command(active.executionId, active.token!, ['phase', 'complete']);
  await assert.rejects(command(active.executionId, active.token!, ['phase', 'complete']), /依赖了不存在的单元 missing-unit[\s\S]*acceptance:download-matches-filter 尚未由任何交付单元承接/);
});

test('feedback split freezes only the current feedback group in the generic chain', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { taskId, delegation } = await taskReadyForSplit('反馈追加拆分');
  const feedbackDelegation: DelegationEnvelope = {
    ...delegation, pipeline: 'feedback-split', feedbackBatchId: `FB-${taskId}`, feedbackGroupId: `FG-${taskId}`,
  };
  const db = await databaseConnection();
  db.prepare(`INSERT INTO feedback_batches(batch_id, task_id, status, batch_number) VALUES(?, ?, 'executing', 1)`)
    .run(feedbackDelegation.feedbackBatchId, taskId);
  db.prepare(`
    INSERT INTO feedback_groups(
      group_id, batch_id, group_key, work_type, status, title, reason,
      acceptance_json, affected_story_indexes_json, group_order
    ) VALUES(?, ?, 'batch-delete', 'scope_addition', 'waiting_for_plan',
      '批量删除', '新增批量删除能力', ?, '[]', 1)
  `).run(feedbackDelegation.feedbackGroupId, feedbackDelegation.feedbackBatchId, JSON.stringify(['仅选中记录被删除，失败项有明确提示']));
  const active = await begin(feedbackDelegation, `${taskId}-feedback`);
  const status = await command(active.executionId, active.token!, ['status']);
  assert.match(status, /change:feedback:batch-delete/);
  assert.match(status, /acceptance:feedback:batch-delete:1/);
  assert.doesNotMatch(status, /impact:filtered-export/);
});
