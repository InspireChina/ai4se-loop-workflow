import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

function backlogDelegation(taskId: string, pipeline = 'backlog'): DelegationEnvelope {
  return {
    taskId,
    lane: 'control',
    pipeline,
    agent: 'backlog-agent',
    storyIndex: null,
    resource: 'browser',
    description: pipeline === 'resume' ? '根据用户回答继续需求梳理' : '收集需求上下文并完成分类',
    title: '渐进式需求上下文',
    taskDescription: '支持将筛选结果导出。',
    itemType: 'intake',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'backlog',
    currentSubagent: 'backlog-agent',
    resumePending: pipeline === 'resume' ? 1 : 0,
    specResolvedIndex: 0,
    runState: 'runnable',
    closureStatus: 'none',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: 'human',
    analysisIndex: 0,
    devIndex: 0,
    testIndex: 0,
    totalStories: 0,
    nextStep: '收集上下文',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  };
}

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(taskId: string, pipeline = 'backlog') {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const delegation = backlogDelegation(taskId, pipeline);
  const started = await beginExecutionAttempt({
    runId: `RUN-command-${taskId}-${pipeline}`,
    delegation,
    prompt: 'role-specific command prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { delegation, executionId: started.attempt.execution_id, token };
}

async function beginDelegation(delegation: DelegationEnvelope, runSuffix = 'delivery-plan') {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginExecutionAttempt({
    runId: `RUN-command-${runSuffix}-${delegation.taskId}`,
    delegation,
    prompt: 'role-specific progressive command prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { delegation, executionId: started.attempt.execution_id, token };
}

async function taskReadyForSplit(title: string) {
  const { createTask, pipelineForTask } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { databaseConnection } = await import('../infrastructure/database');
  const taskId = await createTask({
    title,
    description: '管理员可以将当前筛选结果导出为 CSV，并且导出文件只包含当前筛选命中的字段。',
  });
  const db = await databaseConnection();
  const draftId = `DRAFT-context-${taskId}`;
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id, agent,
      status, terminal_action, submitted_at
    ) VALUES(?, ?, 1, 'requirement_context', ?, 'backlog-agent', 'submitted', 'complete', CURRENT_TIMESTAMP)
  `).run(draftId, `requirement-context:${taskId}`, taskId);
  db.prepare(`
    INSERT INTO requirement_context_drafts(draft_id, intent, change_summary, classification)
    VALUES(?, '管理员取得筛选结果文件', '从只能在线查看变为可以下载当前筛选结果', 'feature')
  `).run(draftId);
  db.prepare(`
    INSERT INTO requirement_context_impacts(
      draft_id, impact_key, statement, disposition, rationale, source, ordinal
    ) VALUES(?, 'filtered-export', '管理员可以下载当前筛选命中的结果', 'change', '目标业务结果', '用户输入', 1)
  `).run(draftId);
  db.prepare(`
    INSERT INTO requirement_context_acceptance_items(
      draft_id, acceptance_key, content, source, ordinal
    ) VALUES(?, 'download-matches-filter', '下载内容与当前筛选结果一致', '用户输入', 1)
  `).run(draftId);
  await applyAgentResult(
    `RUN-command-backlog-${taskId}`,
    backlogDelegation(taskId),
    {
      outcome: 'completed',
      summary: '需求上下文完整，可以进入交付拆分。',
      artifact: {
        title: '需求分类与上下文',
        content: '# 需求上下文\n\n管理员导出当前筛选结果。',
      },
      questions: [],
      runtimeInputs: [],
      classification: 'feature',
      route: 'plan',
      feedbackResolutions: [],
      recoveryResolutions: [],
    },
  );
  const delegation = (await pipelineForTask(taskId))[0] as DelegationEnvelope | undefined;
  assert.equal(delegation?.agent, 'story-splitter-agent');
  assert.equal(delegation?.pipeline, 'split');
  return { taskId, delegation: delegation! };
}

test('requires status first, accepts progressive edits, and submits a deterministic route without Agent JSON', async () => {
  const { createTask, getTask } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const taskId = await createTask({
    title: '渐进式需求上下文',
    description: '支持将筛选结果导出。',
  });
  const active = await begin(taskId);

  await assert.rejects(
    command(active.executionId, active.token!, [
      'requirement-context', 'intent', 'set', '--text', '支持用户导出当前筛选结果',
    ]),
    /尚未查看草稿状态/,
  );

  const initial = await command(active.executionId, active.token!, ['requirement-context', 'status']);
  assert.match(initial, /草稿 v1/);
  assert.match(initial, /Outcome: state_restored/);
  assert.match(initial, /## PHASE\s+as_is/);
  assert.match(initial, /缺少 Reported Intent/);
  assert.match(initial, /Status: not_ready/);
  assert.doesNotMatch(initial, /## SUBMIT/);

  const intentSet = await command(active.executionId, active.token!, [
    'requirement-context', 'intent', 'set', '--text', '支持用户导出当前筛选结果',
  ]);
  assert.match(intentSet, /Readiness: not_ready/);
  assert.match(intentSet, /AS-IS 至少需要一条可靠 Actual/);
  assert.doesNotMatch(intentSet, /Submit:/);
  const actualSet = await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'current-export',
    '--perspective', 'actual',
    '--statement', '列表已经支持组合筛选，但当前导出不继承筛选结果',
    '--evidence', 'observed',
    '--source', '仓库列表导出入口与筛选查询实现',
  ]);
  assert.match(actualSet, /Readiness: structurally_ready/);
  assert.match(actualSet, /Action: review_before_submit/);
  assert.match(actualSet, /Submit: `requirement-context as-is complete`/);
  await assert.rejects(
    command(active.executionId, active.token!, ['requirement-context', 'validate']),
    /当前 as_is 阶段不使用 validate/,
  );
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'filtered-export-target',
    '--perspective', 'target',
    '--statement', '下载文件与当前筛选列表一致',
    '--evidence', 'decided',
    '--source', '当前需求描述',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'change', 'set',
    '--text', '将列表导出从全量结果改变为继承当前筛选条件',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'impact', 'upsert',
    '--key', 'filtered-export-data',
    '--statement', '导出文件的数据范围必须随当前筛选结果改变',
    '--disposition', 'change',
    '--rationale', '否则目标业务行为无法成立',
    '--source', 'filtered-export-target',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'impact', 'upsert',
    '--key', 'export-permission',
    '--statement', '现有导出权限保持不变',
    '--disposition', 'preserve',
    '--rationale', '本次需求没有改变参与者权限',
    '--source', '当前需求描述',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'acceptance', 'upsert',
    '--key', 'filtered-file-matches-list',
    '--text', '下载文件中的记录与当前筛选列表一致',
    '--source', 'filtered-export-target',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'classification', 'set', 'feature',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'scope', 'include',
    '--key', 'filtered-data',
    '--text', '导出当前筛选条件命中的数据',
  ]);

  const populatedStatus = await command(active.executionId, active.token!, ['requirement-context', 'status']);
  assert.match(populatedStatus, /current-export · actual · observed · active/);
  assert.match(populatedStatus, /来源：仓库列表导出入口与筛选查询实现/);
  assert.match(populatedStatus, /filtered-export-data · change · active/);
  assert.match(populatedStatus, /依据：否则目标业务行为无法成立；来源：filtered-export-target/);

  const transition = async (args: string[], from: string, to: string) => {
    const output = await command(active.executionId, active.token!, args);
    assert.match(output, /# COMMAND RESULT/);
    assert.match(output, /Outcome: phase_completed/);
    assert.match(output, new RegExp(`From: ${from}`));
    assert.match(output, new RegExp(`To: ${to}`));
    assert.match(output, /# NEXT WORK PACKET/);
    assert.match(output, new RegExp(`## PHASE\\s+${to}`));
    assert.match(output, /## OBJECTIVE/);
    assert.match(output, /## REQUIRED/);
    assert.match(output, /## DO NOT/);
    assert.match(output, /## AVAILABLE COMMANDS/);
    assert.match(output, /## READINESS/);
    if (to === 'finalize') {
      assert.match(output, /## VALIDATE\s+`requirement-context validate`/);
      assert.doesNotMatch(output, /## SUBMIT/);
    } else {
      assert.match(output, /## SUBMIT/);
    }
  };

  await transition(['requirement-context', 'as-is', 'complete'], 'as_is', 'decision_tree');
  await transition(['requirement-context', 'decision-tree', 'complete'], 'decision_tree', 'to_be');
  await transition(['requirement-context', 'to-be', 'complete'], 'to_be', 'impact_scan');
  assert.match(
    await command(active.executionId, active.token!, [
      'requirement-context', 'impact-scan', 'reopen-decisions',
      '--reason', '影响扫描要求重新确认已有决策覆盖',
    ]),
    /Outcome: phase_completed.*From: impact_scan.*To: decision_tree.*# NEXT WORK PACKET.*## PHASE\s+decision_tree/s,
  );
  await transition(['requirement-context', 'decision-tree', 'complete'], 'decision_tree', 'to_be');
  await transition(['requirement-context', 'to-be', 'complete'], 'to_be', 'impact_scan');
  await transition(['requirement-context', 'impact-scan', 'complete'], 'impact_scan', 'scope');
  await transition(['requirement-context', 'scope', 'complete'], 'scope', 'acceptance');
  await transition(['requirement-context', 'acceptance', 'complete'], 'acceptance', 'finalize');
  const db = await databaseConnection();
  assert.deepEqual(
    (db.prepare(`
      SELECT from_phase, to_phase
      FROM requirement_context_phase_transitions transition_item
      JOIN agent_work_drafts draft ON draft.draft_id = transition_item.draft_id
      WHERE draft.task_id = ?
      ORDER BY transition_id
    `).all(taskId) as { from_phase: string; to_phase: string }[]),
    [
      { from_phase: 'as_is', to_phase: 'decision_tree' },
      { from_phase: 'decision_tree', to_phase: 'to_be' },
      { from_phase: 'to_be', to_phase: 'impact_scan' },
      { from_phase: 'impact_scan', to_phase: 'decision_tree' },
      { from_phase: 'decision_tree', to_phase: 'to_be' },
      { from_phase: 'to_be', to_phase: 'impact_scan' },
      { from_phase: 'impact_scan', to_phase: 'scope' },
      { from_phase: 'scope', to_phase: 'acceptance' },
      { from_phase: 'acceptance', to_phase: 'finalize' },
    ],
  );

  await assert.rejects(
    command(active.executionId, active.token!, ['requirement-context', 'complete']),
    /尚未通过当前草稿版本的 validate/,
  );
  assert.match(
    await command(active.executionId, active.token!, ['requirement-context', 'validate']),
    /Outcome: validation_passed.*Readiness: validated.*Action: `requirement-context complete`/s,
  );
  await command(active.executionId, active.token!, [
    'requirement-context', 'intent', 'set', '--text', '支持用户导出当前筛选结果',
  ]);
  await assert.rejects(
    command(active.executionId, active.token!, ['requirement-context', 'complete']),
    /尚未通过当前草稿版本的 validate/,
  );
  await command(active.executionId, active.token!, ['requirement-context', 'validate']);
  assert.match(
    await command(active.executionId, active.token!, ['requirement-context', 'complete']),
    /Outcome: completed.*Agent Action: end_execution/s,
  );
  assert.match(
    await command(active.executionId, active.token!, ['requirement-context', 'complete']),
    /Outcome: already_submitted.*Agent Action: end_execution/s,
  );

  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.classification, 'feature');
  assert.equal(result?.route, 'plan');
  assert.match(result?.artifact?.content || '', /状态：Aligned/);
  assert.match(result?.artifact?.content || '', /版本：v1/);
  assert.match(result?.artifact?.content || '', /需求类型：feature/);
  assert.match(result?.artifact?.content || '', /## BUSINESS INTENT/);
  assert.match(result?.artifact?.content || '', /## AS-IS\s+### Actual/);
  assert.match(result?.artifact?.content || '', /当前导出不继承筛选结果/);
  assert.match(result?.artifact?.content || '', /### Expected/);
  assert.match(result?.artifact?.content || '', /未识别到独立于本次 TO-BE 的既有 Expected/);
  assert.match(result?.artifact?.content || '', /## TO-BE/);
  assert.match(result?.artifact?.content || '', /## CHANGE/);
  assert.match(result?.artifact?.content || '', /## IMPACTS/);
  assert.match(result?.artifact?.content || '', /### Preserve/);
  assert.match(result?.artifact?.content || '', /## SCOPE/);
  assert.match(result?.artifact?.content || '', /导出当前筛选条件命中的数据/);
  assert.match(result?.artifact?.content || '', /## CONSTRAINTS/);
  assert.match(result?.artifact?.content || '', /## ACCEPTANCE/);
  assert.doesNotMatch(result?.artifact?.content || '', /## OPEN QUESTIONS/);
  assert.doesNotMatch(result?.artifact?.content || '', /证据状态：|来源：|依据：|decision：/);
  assert.doesNotMatch(result?.artifact?.content || '', /仓库列表导出入口与筛选查询实现|filtered-export-target/);

  await applyAgentResult('RUN-command-progressive', active.delegation, result!, {
    executionId: active.executionId,
  });
  await completeExecution(active.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.item_type, 'feature');
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.task.current_subagent, 'story-splitter-agent');
  const contextDocument = detail?.documents.find((document) => document.kind === 'context');
  assert.ok(contextDocument);
  assert.match(contextDocument.content, /列表已经支持组合筛选，但当前导出不继承筛选结果/);
  assert.doesNotMatch(contextDocument.content, /证据状态：|来源：|依据：|decision：/);
});

test('routes unresolved impact branches back to the decision tree instead of exposing impact completion', async () => {
  const { createTask } = await import('./tasks');
  const taskId = await createTask({
    title: '提醒方式需要在影响扫描时回流',
    description: '借阅记录快到期时提醒，渠道尚未确认。',
  });
  const active = await begin(taskId);
  await command(active.executionId, active.token!, ['requirement-context', 'status']);
  await command(active.executionId, active.token!, [
    'requirement-context', 'intent', 'set', '--text', '让读者及时获知借阅状态',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert', '--key', 'actual-no-reminder',
    '--perspective', 'actual', '--statement', '当前借阅到期前没有主动提醒',
    '--evidence', 'observed', '--source', '借阅业务代码与任务调度配置',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert', '--key', 'target-reminder',
    '--perspective', 'target', '--statement', '读者会在借阅到期前收到提醒',
    '--evidence', 'decided', '--source', '需求描述',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'change', 'set', '--text', '从无主动提醒变为到期前提醒读者',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'impact', 'upsert', '--key', 'reminder-state',
    '--statement', '借阅记录需要参与提醒判定', '--disposition', 'change',
    '--rationale', '目标提醒必须基于借阅到期状态', '--source', 'target-reminder',
  ]);
  await command(active.executionId, active.token!, ['requirement-context', 'as-is', 'complete']);
  await command(active.executionId, active.token!, [
    'requirement-context', 'question', 'add', '--key', 'reminder-channel',
    '--title', '提醒渠道', '--question', '使用站内提醒还是邮件？',
    '--impact', '渠道会改变用户触达结果', '--authority', 'agent',
  ]);
  for (const [id, label] of [['in-app', '站内提醒'], ['email', '邮件提醒']]) {
    await command(active.executionId, active.token!, [
      'requirement-context', 'question', 'option-add', '--key', 'reminder-channel',
      '--id', id, '--label', label, '--consequence', `${label}形成不同触达方式`,
    ]);
  }
  await command(active.executionId, active.token!, [
    'requirement-context', 'question', 'decide', '--key', 'reminder-channel',
    '--option', 'in-app', '--reason', '当前产品已有站内通知能力',
  ]);
  await command(active.executionId, active.token!, ['requirement-context', 'decision-tree', 'complete']);
  await command(active.executionId, active.token!, ['requirement-context', 'to-be', 'complete']);

  const unresolvedImpact = await command(active.executionId, active.token!, [
    'requirement-context', 'impact', 'upsert', '--key', 'channel-branch',
    '--statement', '触达渠道仍会形成不同业务结果', '--disposition', 'needs_decision',
    '--rationale', '影响扫描发现需求输入未授权固定渠道', '--source', '需求与现有通知能力对比',
    '--decision', 'reminder-channel',
  ]);
  assert.match(unresolvedImpact, /Readiness: decisions_required/);
  assert.match(unresolvedImpact, /Action: reopen_decision_tree/);
  assert.match(unresolvedImpact, /impact-scan reopen-decisions/);
  assert.doesNotMatch(unresolvedImpact, /impact-scan complete/);
  await assert.rejects(
    command(active.executionId, active.token!, ['requirement-context', 'impact-scan', 'complete']),
    /尚未关闭的业务分叉/,
  );
});

test('routes an evidence-backed Actual versus Expected deviation to reproduction', async () => {
  const { createTask } = await import('./tasks');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const taskId = await createTask({
    title: '筛选导出行为偏离现行业务规则',
    description: '筛选后导出仍然包含全部记录。',
  });
  const active = await begin(taskId);
  await command(active.executionId, active.token!, ['requirement-context', 'status']);
  await command(active.executionId, active.token!, [
    'requirement-context', 'intent', 'set', '--text', '恢复筛选列表的正确导出行为',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'actual-export-all',
    '--perspective', 'actual',
    '--statement', '筛选列表后导出仍然包含全部记录',
    '--evidence', 'reported',
    '--source', '用户问题报告',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'target-restore-rule',
    '--perspective', 'target',
    '--statement', '导出结果恢复为当前筛选命中的记录',
    '--evidence', 'decided',
    '--source', '用户问题报告',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'change', 'set',
    '--text', 'Actual 偏离现行 Expected，本次恢复而非改变业务规则',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'impact', 'upsert',
    '--key', 'restore-export-data',
    '--statement', '导出数据范围恢复为筛选命中记录',
    '--disposition', 'change',
    '--rationale', '修复 Actual 与 Expected 的偏差',
    '--source', 'actual-export-all 与 expected-filtered-export',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'acceptance', 'upsert',
    '--key', 'export-matches-filter',
    '--text', '导出文件只包含当前筛选命中的记录',
    '--source', 'expected-filtered-export',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'classification', 'set', 'bug',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'scope', 'include',
    '--key', 'restore-filtered-export',
    '--text', '恢复筛选结果导出行为',
  ]);
  await command(active.executionId, active.token!, ['requirement-context', 'as-is', 'complete']);
  await command(active.executionId, active.token!, ['requirement-context', 'decision-tree', 'complete']);
  await command(active.executionId, active.token!, ['requirement-context', 'to-be', 'complete']);
  await command(active.executionId, active.token!, ['requirement-context', 'impact-scan', 'complete']);
  await command(active.executionId, active.token!, ['requirement-context', 'scope', 'complete']);
  await assert.rejects(
    command(active.executionId, active.token!, ['requirement-context', 'acceptance', 'complete']),
    /Bug 必须具备可靠 Existing Expected/,
  );
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'expected-filtered-export',
    '--perspective', 'expected',
    '--statement', '既有需求规格要求导出继承当前筛选条件',
    '--evidence', 'decided',
    '--source', '变更前已经确认的需求规格',
  ]);
  await command(active.executionId, active.token!, ['requirement-context', 'acceptance', 'complete']);
  await command(active.executionId, active.token!, ['requirement-context', 'validate']);
  await command(active.executionId, active.token!, ['requirement-context', 'complete']);
  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.classification, 'bug');
  assert.equal(result?.route, 'repro');
  assert.match(result?.artifact?.content || '', /Actual 偏离现行 Expected/);
});

test('inherits a persisted clarification draft after resume and forces status again for the new execution', async () => {
  const {
    answerQuestion,
    createTask,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const taskId = await createTask({
    title: '需要确认导出受众',
    description: '增加导出入口，但没有说明哪些用户可以使用。',
  });
  const first = await begin(taskId);
  await command(first.executionId, first.token!, ['requirement-context', 'status']);
  await command(first.executionId, first.token!, [
    'requirement-context', 'intent', 'set', '--text', '为列表提供导出入口',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'current-export-audience',
    '--perspective', 'actual',
    '--statement', '当前输入没有说明导出入口面向哪些角色',
    '--evidence', 'reported',
    '--source', '需求描述',
  ]);
  await command(first.executionId, first.token!, ['requirement-context', 'as-is', 'complete']);
  await command(first.executionId, first.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'target-export-audience',
    '--perspective', 'target',
    '--statement', '目标用户可以下载列表数据，但目标角色尚未确认',
    '--evidence', 'conflicted',
    '--source', '需求描述',
    '--decision', 'export-audience',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'impact', 'upsert',
    '--key', 'export-audience-impact',
    '--statement', '导出入口的权限范围取决于目标角色',
    '--disposition', 'needs_decision',
    '--rationale', '不同角色会改变业务范围和验收结果',
    '--source', '需求描述',
    '--decision', 'export-audience',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'constraint', 'add',
    '--key', 'audience-must-be-confirmed',
    '--text', '目标用户必须由用户确认',
  ]);
  const incompleteHumanQuestion = await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'add',
    '--key', 'export-audience',
    '--title', '确认导出能力的目标用户',
    '--question', '只面向管理员还是同时面向普通成员？',
    '--impact', '目标用户会改变权限范围和交付边界',
  ]);
  assert.match(incompleteHumanQuestion, /Readiness: not_ready/);
  assert.match(incompleteHumanQuestion, /至少需要两个互斥选项/);
  assert.doesNotMatch(incompleteHumanQuestion, /request-clarification/);
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'option-add',
    '--key', 'export-audience',
    '--id', 'admin',
    '--label', '仅管理员',
    '--consequence', '保持较小权限范围',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'option-add',
    '--key', 'export-audience',
    '--id', 'all-members',
    '--label', '所有成员',
    '--consequence', '需要新增成员权限行为',
  ]);
  const completeHumanQuestion = await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'recommend',
    '--key', 'export-audience',
    '--option', 'admin',
    '--reason', '这是满足当前目标的最小范围',
  ]);
  assert.match(completeHumanQuestion, /Readiness: ready_for_human/);
  assert.match(completeHumanQuestion, /Submit: `requirement-context request-clarification`/);
  for (const child of [
    {
      key: 'admin-export-mode', title: '管理员导出方式', parentOption: 'admin',
      question: '管理员导出采用同步还是异步？', recommendation: 'async',
    },
    {
      key: 'member-permission-mode', title: '普通成员权限方式', parentOption: 'all-members',
      question: '普通成员导出权限如何开放？', recommendation: 'request',
    },
  ]) {
    await command(first.executionId, first.token!, [
      'requirement-context', 'question', 'add',
      '--key', child.key, '--title', child.title, '--question', child.question,
      '--impact', '不同选择会改变后续业务结果',
    ]);
    const options = child.key === 'admin-export-mode'
      ? [['sync', '同步生成'], ['async', '异步生成']]
      : [['automatic', '自动开放'], ['request', '申请后开放']];
    for (const [id, label] of options) {
      await command(first.executionId, first.token!, [
        'requirement-context', 'question', 'option-add',
        '--key', child.key, '--id', id, '--label', label,
        '--consequence', `${label}对应不同的业务流程`,
      ]);
    }
    await command(first.executionId, first.token!, [
      'requirement-context', 'question', 'recommend',
      '--key', child.key, '--option', child.recommendation, '--reason', '优先保持风险可控',
    ]);
    await command(first.executionId, first.token!, [
      'requirement-context', 'question', 'depends-on',
      '--key', child.key, '--parent', 'export-audience', '--option', child.parentOption,
    ]);
  }
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'add',
    '--key', 'audit-boundary', '--title', '审计边界表达',
    '--question', '是否把既有普通成员无权限规则作为 preserve？',
    '--impact', '决定影响扫描中的保持项表达', '--authority', 'agent',
  ]);
  for (const [id, label] of [['preserve', '记录为保持项'], ['ignore', '不记录']]) {
    await command(first.executionId, first.token!, [
      'requirement-context', 'question', 'option-add', '--key', 'audit-boundary',
      '--id', id, '--label', label, '--consequence', `${label}会改变后续影响表达`,
    ]);
  }
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'decide', '--key', 'audit-boundary',
    '--option', 'preserve', '--reason', 'Backlog 负责表达必须保持的既有业务边界',
  ]);
  assert.match(
    await command(first.executionId, first.token!, ['requirement-context', 'validate']),
    /Outcome: validation_passed.*Action: `requirement-context request-clarification`/s,
  );
  assert.match(
    await command(first.executionId, first.token!, [
      'requirement-context', 'request-clarification',
    ]),
    /Outcome: waiting_for_human.*Owner: Application.*Agent Action: end_execution.*Resume Entry: `requirement-context status`/s,
  );

  const questionResult = await readAgentCommandSubmission(first.executionId);
  assert.equal(questionResult?.outcome, 'needs_input');
  assert.equal(questionResult?.classification, undefined);
  assert.equal(questionResult?.route, undefined);
  assert.equal(questionResult?.questions[0]?.decisionKey, 'export-audience');
  assert.equal(questionResult?.questions.length, 3);
  assert.deepEqual(questionResult?.questions.find((item) => item.decisionKey === 'admin-export-mode')?.activation, [
    { decisionKey: 'export-audience', optionId: 'admin' },
  ]);
  assert.equal(questionResult?.questions.find((item) => item.decisionKey === 'admin-export-mode')?.initialStatus, 'conditional');
  assert.match(questionResult?.artifact?.content || '', /状态：Needs Clarification/);
  assert.match(questionResult?.artifact?.content || '', /需求类型：待确认/);
  assert.match(questionResult?.artifact?.content || '', /## OPEN QUESTIONS/);
  assert.match(questionResult?.artifact?.content || '', /决策影响：/);
  await applyAgentResult('RUN-command-question', first.delegation, questionResult!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'export-audience');
  assert.equal(detail?.task.run_state, 'waiting_for_answers');
  assert.ok(question);
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '本轮只面向管理员。',
    selectedOptionId: 'admin',
  });
  detail = await getTask(taskId);
  const activeChild = detail?.questions.find((item) => item.decision_key === 'admin-export-mode');
  const prunedChild = detail?.questions.find((item) => item.decision_key === 'member-permission-mode');
  assert.equal(activeChild?.status, 'pending');
  assert.equal(prunedChild?.status, 'not_applicable');
  await answerQuestion({
    taskId,
    questionId: activeChild!.question_id,
    selectedOptionId: 'async',
  });
  await submitClarificationAnswers(taskId);

  const resumeDelegation = (await pipelineForTask(taskId))[0];
  assert.equal(resumeDelegation?.pipeline, 'resume');
  const resumed = await begin(taskId, 'resume');
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['requirement-context', 'complete']),
    /尚未查看草稿状态/,
  );
  const inherited = await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'status',
  ]);
  assert.match(inherited, /草稿 v2/);
  assert.match(inherited, /分类：未填写/);
  assert.match(inherited, /## 确认导出能力的目标用户 · export-audience/);
  assert.match(inherited, /- Decision：仅管理员/);
  assert.match(inherited, /- Decided By：HUMAN/);
  assert.match(inherited, /## 管理员导出方式 · admin-export-mode/);
  assert.match(inherited, /- Decision：异步生成/);
  assert.match(inherited, /## 审计边界表达 · audit-boundary/);
  assert.match(inherited, /- Decided By：AGENT/);
  assert.doesNotMatch(inherited, /普通成员权限方式/);
  assert.match(inherited, /current-export-audience · actual · reported · active/);
  assert.match(inherited, /audience-must-be-confirmed：目标用户必须由用户确认/);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'current-export-rule',
    '--perspective', 'expected',
    '--statement', '现有产品没有面向普通成员的导出承诺',
    '--evidence', 'reported',
    '--source', '用户回答与当前需求描述',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'target-export-audience',
    '--perspective', 'target',
    '--statement', '本轮导出入口只面向管理员',
    '--evidence', 'decided',
    '--source', '用户对 export-audience 的回答',
    '--decision', 'export-audience',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'impact', 'upsert',
    '--key', 'export-audience-impact',
    '--statement', '新增管理员导出能力，同时保持普通成员无导出入口',
    '--disposition', 'change',
    '--rationale', '用户已确认本轮只面向管理员',
    '--source', '用户对 export-audience 的回答',
    '--decision', 'export-audience',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'change', 'set',
    '--text', '为管理员新增列表导出入口，普通成员行为保持不变',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'acceptance', 'upsert',
    '--key', 'admin-can-export',
    '--text', '管理员可以下载列表数据，普通成员看不到导出入口',
    '--source', '用户对 export-audience 的回答',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'constraint', 'add',
    '--key', 'audience-must-be-confirmed',
    '--text', '本轮导出能力只面向管理员',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'scope', 'include',
    '--key', 'admin-export',
    '--text', '管理员使用列表导出入口',
  ]);
  const revised = await command(resumed.executionId, resumed.token!, ['requirement-context', 'status']);
  assert.match(revised, /约束：1/);
  assert.match(revised, /audience-must-be-confirmed：本轮导出能力只面向管理员/);
  await command(resumed.executionId, resumed.token!, ['requirement-context', 'decision-tree', 'complete']);
  await command(resumed.executionId, resumed.token!, ['requirement-context', 'to-be', 'complete']);
  await command(resumed.executionId, resumed.token!, ['requirement-context', 'impact-scan', 'complete']);
  await command(resumed.executionId, resumed.token!, ['requirement-context', 'scope', 'complete']);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['requirement-context', 'acceptance', 'complete']),
    /缺少最终需求分类/,
  );
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'classification', 'set', 'feature',
  ]);
  await command(resumed.executionId, resumed.token!, ['requirement-context', 'acceptance', 'complete']);
  assert.match(
    await command(resumed.executionId, resumed.token!, ['requirement-context', 'validate']),
    /Outcome: validation_passed.*Action: `requirement-context complete`/s,
  );
  await command(resumed.executionId, resumed.token!, ['requirement-context', 'complete']);

  const completedResult = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(completedResult?.outcome, 'completed');
  assert.match(completedResult?.artifact?.content || '', /状态：Aligned/);
  assert.match(completedResult?.artifact?.content || '', /需求类型：feature/);
  assert.match(completedResult?.artifact?.content || '', /## DECISIONS/);
  assert.match(completedResult?.artifact?.content || '', /决定：仅管理员/);
  assert.doesNotMatch(completedResult?.artifact?.content || '', /## OPEN QUESTIONS/);
  await applyAgentResult('RUN-command-resume', resumed.delegation, completedResult!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.questions.find((item) => item.question_id === question?.question_id)?.status, 'resolved');
  assert.ok(detail?.documents.some((document) =>
    document.kind === 'context' && document.content.includes('决定：仅管理员')));
});

test('keeps corrected business conclusions traceable instead of deleting or silently reactivating them', async () => {
  const { createTask } = await import('./tasks');
  const taskId = await createTask({ title: '显式修订业务影响' });
  const active = await begin(taskId);
  await command(active.executionId, active.token!, ['requirement-context', 'status']);
  await command(active.executionId, active.token!, [
    'requirement-context', 'intent', 'set', '--text', '确认导出能力的真实业务影响',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'old-current-rule',
    '--perspective', 'actual',
    '--statement', '初步认为定时导出复用页面筛选',
    '--evidence', 'inferred',
    '--source', '初步仓库检索',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'upsert',
    '--key', 'verified-current-rule',
    '--perspective', 'actual',
    '--statement', '项目不存在定时导出业务入口',
    '--evidence', 'observed',
    '--source', '仓库入口和产品路由检索',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'assertion', 'supersede',
    '--key', 'old-current-rule',
    '--by', 'verified-current-rule',
    '--reason', '进一步调查推翻了初步推断',
  ]);
  await assert.rejects(
    command(active.executionId, active.token!, [
      'requirement-context', 'assertion', 'upsert',
      '--key', 'old-current-rule',
      '--perspective', 'actual',
      '--statement', '尝试无痕恢复旧结论',
      '--evidence', 'inferred',
      '--source', '无',
    ]),
    /已是 superseded/,
  );
  await command(active.executionId, active.token!, [
    'requirement-context', 'impact', 'upsert',
    '--key', 'scheduled-export',
    '--statement', '可能影响定时导出',
    '--disposition', 'needs_decision',
    '--rationale', '初步认为存在同类入口',
    '--source', '初步仓库检索',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'impact', 'dismiss',
    '--key', 'scheduled-export',
    '--reason', '确认项目不存在该业务场景',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'acceptance', 'upsert',
    '--key', 'obsolete-acceptance',
    '--text', '定时导出继承页面筛选',
    '--source', '初步推断',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'acceptance', 'dismiss',
    '--key', 'obsolete-acceptance',
    '--reason', '对应业务场景不存在',
  ]);
  const status = await command(active.executionId, active.token!, ['requirement-context', 'status']);
  assert.match(status, /old-current-rule · actual · inferred · superseded/);
  assert.match(status, /进一步调查推翻了初步推断/);
  assert.match(status, /scheduled-export · needs_decision · dismissed/);
  assert.match(status, /确认项目不存在该业务场景/);
  assert.match(status, /obsolete-acceptance · dismissed/);
  assert.match(status, /语义修订记录：7/);
});

test('exposes only the new business-context protocol and rejects every legacy context command', async () => {
  const { createTask } = await import('./tasks');
  const taskId = await createTask({ title: '只使用新业务上下文协议' });
  const active = await begin(taskId);
  await assert.rejects(
    command(active.executionId, active.token!, ['help']),
    /help 必须指定一个主题.*context\|assertion\|impact\|question\|scope\|finish/s,
  );

  const contextHelp = await command(active.executionId, active.token!, ['help', 'context']);
  assert.match(contextHelp, /只读上下文工具/);
  assert.match(contextHelp, /先执行当前角色的 status/);

  const assertionHelp = await command(active.executionId, active.token!, ['help', 'assertion']);
  assert.match(assertionHelp, /requirement-context intent set/);
  assert.match(assertionHelp, /requirement-context assertion upsert/);
  assert.match(assertionHelp, /Actual 和 Target 各至少需要一条.*Bug 还必须具备可靠 Expected/);
  assert.match(assertionHelp, /既有需求规格.*代码或运行证据显示不同的 Actual.*必须同时记录 Expected 与 Actual/s);
  assert.match(assertionHelp, /本次新增或改变后的结果.*属于 Target/s);
  assert.match(assertionHelp, /不写测试命令、测试步骤、技术验证形式或实现细节/);
  assert.match(assertionHelp, /observed\s+通过运行/);
  assert.match(assertionHelp, /dismiss.*supersede/s);
  assert.match(assertionHelp, /使用 supersede 前.*先创建同类型、不同 key 的 active 新结论/s);

  const impactHelp = await command(active.executionId, active.token!, ['help', 'impact']);
  assert.match(impactHelp, /requirement-context impact upsert/);
  assert.match(impactHelp, /needs_decision\s+是否改变属于新的业务选择/);
  assert.match(impactHelp, /technical\s+Analysis Obligation/);
  assert.match(impactHelp, /只定义 Analysis 必须回答什么/);

  const questionHelp = await command(active.executionId, active.token!, ['help', 'question']);
  assert.match(questionHelp, /全部当前已知 HUMAN · PENDING 节点/);
  assert.match(questionHelp, /最少交互轮次/);
  assert.match(questionHelp, /普通问题本身不要求 assertion 或 impact 反向引用/);
  assert.match(questionHelp, /逐字复用原 decision key/);

  const scopeHelp = await command(active.executionId, active.token!, ['help', 'scope']);
  assert.match(scopeHelp, /bug\s+Actual 偏离已有明确 Expected/);
  assert.match(scopeHelp, /约束与范围.*可选边界/s);
  assert.match(scopeHelp, /约束不用于提前记录技术设计/);

  const finishHelp = await command(active.executionId, active.token!, ['help', 'finish']);
  assert.match(finishHelp, /as-is complete → decision-tree complete → to-be complete/);
  assert.match(finishHelp, /影响扫描发现新的需求级业务分叉/);
  assert.match(finishHelp, /requirement-context request-clarification/);
  assert.match(finishHelp, /新的 resume execution 恢复 decision_tree/);

  const allTopicHelp = [contextHelp, assertionHelp, impactHelp, questionHelp, scopeHelp, finishHelp].join('\n');
  assert.doesNotMatch(allTopicHelp, /requirement-context goal set/);
  assert.doesNotMatch(allTopicHelp, /requirement-context outcome set/);
  assert.doesNotMatch(allTopicHelp, /requirement-context fact /);

  await assert.rejects(
    command(active.executionId, active.token!, ['help', 'unknown']),
    /可用主题：context、assertion、impact、question、scope、finish/,
  );
  await command(active.executionId, active.token!, ['requirement-context', 'status']);
  for (const args of [
    ['requirement-context', 'goal', 'set', '--text', 'legacy'],
    ['requirement-context', 'outcome', 'set', '--text', 'legacy'],
    ['requirement-context', 'fact', 'add', '--key', 'legacy', '--statement', 'legacy', '--source', 'legacy'],
  ]) {
    await assert.rejects(
      command(active.executionId, active.token!, args),
      /未知命令/,
    );
  }
});

test('rejects commands with another execution token', async () => {
  const { createTask } = await import('./tasks');
  const firstTask = await createTask({ title: 'Token scope A' });
  const secondTask = await createTask({ title: 'Token scope B' });
  const first = await begin(firstTask);
  const second = await begin(secondTask);
  await assert.rejects(
    command(first.executionId, second.token!, ['requirement-context', 'status']),
    /命令凭证无效/,
  );
});

test('exposes the same execution-scoped protocol through the cross-platform Node CLI', async () => {
  const { createTask } = await import('./tasks');
  const taskId = await createTask({ title: 'Node CLI command surface' });
  const active = await begin(taskId);
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.LOOP_TEST;
  delete env.LOOP_TEST_SETUP_PID;
  delete env.NODE_TEST_CONTEXT;
  env.LOOP_EXECUTION_ID = active.executionId;
  env.LOOP_EXECUTION_TOKEN = active.token!;
  env.LOOP_APP_ROOT = process.cwd();
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'loop', 'loop-agent.mjs'), 'requirement-context', 'status'],
    {
      cwd: process.env.LOOP_WORKSPACE_ROOT_OVERRIDE,
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /需求上下文草稿 v1/);
  assert.match(result.stdout, /Outcome: state_restored/);
  assert.match(result.stdout, /## PHASE\s+as_is/);
  assert.match(result.stdout, /缺少 Reported Intent/);

  const rejected = spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'loop', 'loop-agent.mjs'), 'requirement-context', 'as-is', 'complete'],
    {
      cwd: process.env.LOOP_WORKSPACE_ROOT_OVERRIDE,
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /# COMMAND RESULT/);
  assert.match(rejected.stderr, /Outcome: rejected/);
  assert.match(rejected.stderr, /Action: correct_and_retry/);
  assert.match(rejected.stderr, /缺少 Reported Intent/);

  const directory = mkdtempSync(join(tmpdir(), 'loop-agent-command-'));
  try {
    const goalPath = join(directory, 'intent.txt');
    writeFileSync(goalPath, '从 UTF-8 文件恢复一段较长的业务意图');
    const fileResult = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'loop', 'loop-agent.mjs'),
        'requirement-context', 'intent', 'set', '--text-file', goalPath,
      ],
      {
        cwd: process.env.LOOP_WORKSPACE_ROOT_OVERRIDE,
        env,
        encoding: 'utf8',
      },
    );
    assert.equal(fileResult.status, 0, fileResult.stderr);
    assert.match(fileResult.stdout, /Outcome: accepted/);
    assert.match(fileResult.stdout, /Changed: 业务意图/);
    assert.match(
      await command(active.executionId, active.token!, ['requirement-context', 'status']),
      /从 UTF-8 文件恢复一段较长的业务意图/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('story splitter help explains business units, source coverage, dependencies, and revisions', async () => {
  const { taskId, delegation } = await taskReadyForSplit('交付规划命令帮助');
  const active = await beginDelegation(delegation, `${taskId}-delivery-plan-help`);

  await assert.rejects(
    command(active.executionId, active.token!, ['help']),
    /help 必须指定一个主题.*context\|unit\|source\|dependency\|revision\|finish/s,
  );

  const unitHelp = await command(active.executionId, active.token!, ['help', 'unit']);
  assert.match(unitHelp, /不能按数据库、API、页面或测试等技术层拆分/);
  assert.match(unitHelp, /至少承接一项 change 或 acceptance/);

  const sourceHelp = await command(active.executionId, active.token!, ['help', 'source']);
  assert.match(sourceHelp, /Agent 不能创建或改写来源/);
  assert.match(sourceHelp, /preserve\s+相关单元必须继承的不变约束/);
  assert.match(sourceHelp, /所有冻结输入都必须被至少一个有效单元承接/);
  assert.match(sourceHelp, /不会自动迁移来源关联/);

  const dependencyHelp = await command(active.executionId, active.token!, ['help', 'dependency']);
  assert.match(dependencyHelp, /不能为了执行顺序被强行串联/);
  assert.match(dependencyHelp, /当前草稿中的 active 单元/);
  assert.match(dependencyHelp, /既有历史单元不能作为 --on/);
  assert.match(dependencyHelp, /多个有效单元时必须填写排序与依赖说明/);

  const revisionHelp = await command(active.executionId, active.token!, ['help', 'revision']);
  assert.match(revisionHelp, /补充或纠正同一个业务闭环时使用相同 key/);
  assert.match(revisionHelp, /不能重新激活/);
  assert.match(revisionHelp, /不会自动迁移来源、顺序或依赖/);

  const finishHelp = await command(active.executionId, active.token!, ['help', 'finish']);
  assert.match(finishHelp, /1 至 50 个有效交付单元/);
  assert.match(finishHelp, /交付规划 Agent 不向用户提问/);
  assert.match(finishHelp, /PLANNING BASIS.*DELIVERY UNITS.*COVERAGE & ORDER.*FINALIZE/s);
  assert.match(finishHelp, /验证后任何编辑都会使验证失效/);
  assert.match(finishHelp, /delivery-plan complete/);

  await assert.rejects(
    command(active.executionId, active.token!, ['help', 'unknown']),
    /可用主题：context、unit、source、dependency、revision、finish/,
  );
});

test('story splitter progressively restores, validates and submits an ordered delivery plan', async () => {
  const { getTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { applyAgentResult } = await import('./agent-results');
  const {
    completeExecution,
    failExecution,
  } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await taskReadyForSplit('渐进式交付拆分');
  const first = await beginDelegation(delegation, 'delivery-plan-first');

  await assert.rejects(
    command(first.executionId, first.token!, [
      'delivery-plan', 'rationale', 'set', '--text', '按用户可独立验收的业务闭环拆分',
    ]),
    /尚未查看草稿状态/,
  );
  const initial = await command(first.executionId, first.token!, ['delivery-plan', 'status']);
  assert.match(initial, /交付计划草稿 v1/);
  assert.match(initial, /PLANNING BASIS · planning_basis/);
  assert.match(initial, /Status: not_ready/);
  assert.match(initial, /缺少拆分依据/);
  assert.doesNotMatch(initial, /## SUBMIT/);
  const rationaleSet = await command(first.executionId, first.token!, [
    'delivery-plan', 'rationale', 'set', '--text', '按用户可独立验收的业务闭环拆分',
  ]);
  assert.match(rationaleSet, /Readiness: structurally_ready/);
  assert.match(rationaleSet, /Submit: `delivery-plan basis complete`/);
  const basisComplete = await command(first.executionId, first.token!, ['delivery-plan', 'basis', 'complete']);
  assert.match(basisComplete, /Outcome: phase_completed.*From: planning_basis.*To: delivery_units/s);
  assert.match(basisComplete, /DELIVERY UNITS · delivery_units/);
  await command(first.executionId, first.token!, [
    'delivery-plan', 'unit', 'upsert',
    '--key', 'download-filtered-csv',
    '--title', '管理员下载当前筛选结果',
    '--actor', '管理员',
    '--trigger', '管理员在已有筛选条件的列表页点击导出',
    '--outcome', '浏览器下载只包含筛选命中数据的 CSV 文件',
    '--acceptance', '下载文件的记录与字段均和当前筛选结果一致',
  ]);
  await failExecution(first.executionId, '模拟 Agent 进程中断');

  const resumed = await beginDelegation(delegation, 'delivery-plan-retry');
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-plan', 'validate']),
    /尚未查看草稿状态/,
  );
  const restored = await command(resumed.executionId, resumed.token!, ['delivery-plan', 'status']);
  assert.match(restored, /交付计划草稿 v1/);
  assert.match(restored, /DELIVERY UNITS · delivery_units/);
  assert.match(restored, /download-filtered-csv · active：管理员下载当前筛选结果/);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'upsert',
    '--key', 'configure-export-fields',
    '--title', '管理员确认导出字段',
    '--actor', '管理员',
    '--trigger', '管理员打开导出操作',
    '--outcome', '系统显示并采用当前列表可导出的字段',
    '--acceptance', '不在当前结果中的隐藏字段不会进入 CSV',
  ]);
  const unitsComplete = await command(resumed.executionId, resumed.token!, ['delivery-plan', 'units', 'complete']);
  assert.match(unitsComplete, /Outcome: phase_completed.*From: delivery_units.*To: coverage_order/s);
  assert.match(unitsComplete, /COVERAGE & ORDER · coverage_order/);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'coverage', 'set', '--text', '覆盖导出入口、筛选继承与 CSV 下载结果',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'ordering', 'set', '--text', '先确认导出字段，再执行文件下载',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'move', '--key', 'configure-export-fields', '--position', '1',
  ]);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-plan', 'coverage', 'complete']),
    /未关联任何规划输入|尚未由任何有效交付单元承接/,
  );
  for (const unitKey of ['configure-export-fields', 'download-filtered-csv']) {
    await command(resumed.executionId, resumed.token!, [
      'delivery-plan', 'unit', 'source', 'add',
      '--key', unitKey, '--source', 'impact:filtered-export',
    ]);
    await command(resumed.executionId, resumed.token!, [
      'delivery-plan', 'unit', 'source', 'add',
      '--key', unitKey, '--source', 'acceptance:download-matches-filter',
    ]);
  }
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'dependency', 'add',
    '--key', 'download-filtered-csv', '--on', 'configure-export-fields',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'dependency', 'add',
    '--key', 'configure-export-fields', '--on', 'download-filtered-csv',
  ]);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-plan', 'coverage', 'complete']),
    /前置.*必须排在它之前|依赖存在循环/,
  );
  const reopened = await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'coverage', 'reopen-units', '--reason', '来源映射暴露出一个技术步骤型候选',
  ]);
  assert.match(reopened, /Outcome: phase_completed.*From: coverage_order.*To: delivery_units/s);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'upsert',
    '--key', 'technical-only-candidate',
    '--title', '准备导出存储结构',
    '--actor', '系统',
    '--trigger', '开始实现导出',
    '--outcome', '内部结构已准备',
    '--acceptance', '内部结构存在',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'dismiss',
    '--key', 'technical-only-candidate', '--reason', '这是技术步骤，不是独立业务闭环',
  ]);
  await command(resumed.executionId, resumed.token!, ['delivery-plan', 'units', 'complete']);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'dependency', 'remove',
    '--key', 'configure-export-fields', '--on', 'download-filtered-csv',
  ]);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'delivery-plan', 'unit', 'remove', '--key', 'configure-export-fields',
    ]),
    /未知命令/,
  );
  const coverageComplete = await command(resumed.executionId, resumed.token!, ['delivery-plan', 'coverage', 'complete']);
  assert.match(coverageComplete, /Outcome: phase_completed.*From: coverage_order.*To: finalize/s);
  assert.match(coverageComplete, /FINALIZE · finalize.*## VALIDATE.*delivery-plan validate/s);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-plan', 'complete']),
    /尚未通过当前草稿版本的 validate/,
  );
  assert.match(
    await command(resumed.executionId, resumed.token!, ['delivery-plan', 'validate']),
    /Outcome: validation_passed.*Readiness: validated.*Action: `delivery-plan complete`/s,
  );
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'coverage', 'set', '--text', '覆盖导出入口、筛选继承与 CSV 下载结果',
  ]);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-plan', 'complete']),
    /尚未通过当前草稿版本的 validate/,
  );
  await command(resumed.executionId, resumed.token!, ['delivery-plan', 'validate']);
  assert.match(
    await command(resumed.executionId, resumed.token!, ['delivery-plan', 'complete']),
    /Outcome: completed.*Agent Action: end_execution/s,
  );
  assert.match(
    await command(resumed.executionId, resumed.token!, ['delivery-plan', 'complete']),
    /Outcome: already_submitted.*Agent Action: end_execution/s,
  );

  const db = await databaseConnection();
  assert.deepEqual(
    (db.prepare(`
      SELECT from_phase, to_phase
      FROM delivery_plan_phase_transitions transition_item
      JOIN agent_work_drafts draft ON draft.draft_id = transition_item.draft_id
      WHERE draft.task_id = ? AND draft.work_key LIKE 'delivery-plan:%'
      ORDER BY transition_id
    `).all(taskId) as { from_phase: string; to_phase: string }[]),
    [
      { from_phase: 'planning_basis', to_phase: 'delivery_units' },
      { from_phase: 'delivery_units', to_phase: 'coverage_order' },
      { from_phase: 'coverage_order', to_phase: 'delivery_units' },
      { from_phase: 'delivery_units', to_phase: 'coverage_order' },
      { from_phase: 'coverage_order', to_phase: 'finalize' },
    ],
  );

  const result = await readAgentCommandSubmission(resumed.executionId);
  assert.deepEqual(
    result?.deliveryUnits?.map((unit) => unit.title),
    ['管理员确认导出字段', '管理员下载当前筛选结果'],
  );
  assert.doesNotMatch(result?.artifact?.content || '', /稳定标识|configure-export-fields|impact:filtered-export|acceptance:download-matches-filter/);
  assert.match(result?.artifact?.content || '', /先确认导出字段，再执行文件下载/);
  assert.match(result?.artifact?.content || '', /准备导出存储结构：已排除；这是技术步骤，不是独立业务闭环/);
  assert.match(result?.artifact?.content || '', /业务变化：管理员可以下载当前筛选命中的结果/);
  assert.match(result?.artifact?.content || '', /验收语义：下载内容与当前筛选结果一致/);
  assert.deepEqual(result?.deliveryUnits?.[1]?.dependsOn, ['configure-export-fields']);
  await applyAgentResult(`RUN-command-split-${taskId}`, delegation, result!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  const detail = await getTask(taskId);
  assert.deepEqual(
    detail?.stories.map((story) => story.title),
    ['管理员确认导出字段', '管理员下载当前筛选结果'],
  );
  assert.equal(detail?.stories[0]?.unit_key, 'configure-export-fields');
  assert.equal(detail?.stories[1]?.depends_on_story_indexes[0], 1);
  assert.deepEqual(
    detail?.stories[1]?.context_links.map((link) => link.source_key),
    ['acceptance:download-matches-filter', 'impact:filtered-export'],
  );
  assert.equal(detail?.task.current_subagent, 'analyst-agent');
  assert.equal(detail?.task.agile_status, 'ready for dev');
});

test('feedback split uses the same progressive protocol with an isolated draft', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { taskId, delegation: splitDelegation } = await taskReadyForSplit('评论追加交付拆分');
  const feedbackDelegation: DelegationEnvelope = {
    ...splitDelegation,
    pipeline: 'feedback-split',
    description: '将范围新增评论拆为追加交付单元',
    feedbackBatchId: `FB-${taskId}`,
    feedbackGroupId: `FG-${taskId}`,
  };
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO feedback_batches(batch_id, task_id, status, batch_number)
    VALUES(?, ?, 'executing', 1)
  `).run(feedbackDelegation.feedbackBatchId, taskId);
  db.prepare(`
    INSERT INTO feedback_groups(
      group_id, batch_id, group_key, work_type, status, title, reason,
      acceptance_json, affected_story_indexes_json, group_order
    ) VALUES(?, ?, 'batch-delete-scope', 'scope_addition', 'waiting_for_plan',
      '批量删除范围', '新增批量删除能力', ?, '[]', 1)
  `).run(
    feedbackDelegation.feedbackGroupId,
    feedbackDelegation.feedbackBatchId,
    JSON.stringify(['仅选中记录被删除，失败项有明确提示']),
  );
  const active = await beginDelegation(feedbackDelegation, 'feedback-split');
  assert.match(
    await command(active.executionId, active.token!, ['help', 'unit']),
    /delivery-plan unit upsert/,
  );
  const status = await command(active.executionId, active.token!, ['delivery-plan', 'status']);
  assert.match(status, /交付计划草稿 v1/);
  assert.doesNotMatch(status, /download-filtered-csv/);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'rationale', 'set', '--text', '评论新增了一个可独立验收的业务范围',
  ]);
  await command(active.executionId, active.token!, ['delivery-plan', 'basis', 'complete']);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'unit', 'upsert',
    '--key', 'batch-delete',
    '--title', '管理员批量删除筛选结果',
    '--actor', '管理员',
    '--trigger', '管理员选择多条记录并确认删除',
    '--outcome', '选中记录被删除且列表刷新',
    '--acceptance', '仅选中记录被删除，失败项有明确提示',
  ]);
  await command(active.executionId, active.token!, ['delivery-plan', 'units', 'complete']);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'coverage', 'set', '--text', '只覆盖评论要求的批量删除能力',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'unit', 'source', 'add',
    '--key', 'batch-delete', '--source', 'change:feedback:batch-delete-scope',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'unit', 'source', 'add',
    '--key', 'batch-delete', '--source', 'acceptance:feedback:batch-delete-scope:1',
  ]);
  await command(active.executionId, active.token!, ['delivery-plan', 'coverage', 'complete']);
  await command(active.executionId, active.token!, ['delivery-plan', 'validate']);
  await command(active.executionId, active.token!, ['delivery-plan', 'complete']);
  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.deliveryUnits?.[0]?.key, 'batch-delete');
  assert.equal(result?.deliveryUnits?.[0]?.sourceRefs.length, 2);
});
