import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope as inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import type { DelegationEnvelope } from '../test/legacy-task-fixtures';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function developmentDelegation(title: string, requirementCardId?: string, native = false) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, saveDeliverySpec } = await import('../test/legacy-task-fixtures');
  const taskId = await createTask({
    title,
    description: '用户需要在结果页看到明确的完成状态。',
    metadata: requirementCardId
      ? [{ key: 'tracking.requirement_card_id', value: requirementCardId }]
      : [],
  });
  const acceptanceId = `ACCEPTANCE-${taskId}`;
  const db = await databaseConnection();
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET item_type = 'feature', agile_status = 'ready for dev',
          current_subagent = 'dev-agent', total_stories = 1,
          analysis_index = 1, spec_resolved_index = 1,
          dev_index = 0, test_index = 0,
          next_step = '实现结果页完成状态'
      WHERE task_id = ?
    `).run(taskId);
    db.prepare(`
      INSERT INTO stories(task_id, story_index, title, directory)
      VALUES(?, 1, '用户看到结果页完成状态', 'story-001')
    `).run(taskId);
    db.prepare(`
      INSERT INTO acceptances(
        acceptance_id, task_id, acceptance_key, scope_type, story_index,
        statement, oracle, source_ref
      ) VALUES(?, ?, 'unit:fixture-unit', 'delivery_unit', 1,
        '结果页从触发到完成状态形成可观察闭环',
        '页面存在可识别的完成状态', 'TEST:acceptance:fixture')
    `).run(acceptanceId, taskId);
  })();
  await saveDeliverySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: deliverySpecFixture({
      acceptances: [{
        id: acceptanceId,
        key: 'unit:fixture-unit',
        scope: 'delivery_unit',
        statement: '结果页从触发到完成状态形成可观察闭环',
        oracle: '页面存在可识别的完成状态',
        sourceRef: 'TEST:acceptance:fixture',
        revision: 1,
      }],
      handoff: {
        implementationGuidance: '复用现有结果状态组件。',
        guardrails: [],
        verificationFocus: [{
          key: 'AC-status',
          expected: '结果完成后页面展示完成状态',
          oracle: '页面存在可识别的完成状态',
        }],
      },
    }),
  });
  if (native) {
    const { adoptNativeWorkflowInDb } = await import('./work-item-transitions');
    adoptNativeWorkflowInDb(db, taskId);
  }
  const delegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.agent === 'dev-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-development-chain-${suffix}`,
    delegation,
    prompt: 'YAML development command chain',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

for (const native of [false, true]) test(`Dev can hand off a contract conflict without fake completion (${native ? 'native' : 'legacy'})`, async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { taskId, delegation } = await developmentDelegation('Contract conflict handoff', undefined, native);
  const active = await begin(delegation, taskId);
  const db = await databaseConnection();
  await assert.rejects(command(active.executionId, active.token!, ['intervention', 'request',
    '--summary', '前端验收错误归属后端单元', '--reason', '契约范围矛盾', '--evidence', '前端实现属于下一单元']), /先执行 status/);
  assert.match(await command(active.executionId, active.token!, ['status']), /intervention request/);
  const args = ['intervention', 'request', '--summary', '前端验收错误归属后端单元',
    '--reason', '契约范围矛盾', '--evidence', '前端实现属于下一单元，当前后端实现不能闭合 Tab 验收'];
  assert.match(await command(active.executionId, active.token!, args), /Outcome: submitted/);
  assert.match(await command(active.executionId, active.token!, args), /already_submitted/);
  await assert.rejects(command(active.executionId, active.token!, ['phase', 'complete']), /已提交介入请求/);
  const result = await readAgentCommandSubmission(active.executionId);
  assert.ok(result?.intervention);
  assert.equal(result.outcome, 'needs_input');
  assert.equal(await applyAgentResult('RUN-handoff', delegation, result, { executionId: active.executionId }), 'blocked');
  await completeExecution(active.executionId);
  const state = db.prepare('SELECT dev_index FROM tasks WHERE task_id = ?').get(taskId) as { dev_index: number };
  assert.equal(state.dev_index, 0);
  assert.equal((db.prepare('SELECT dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?')
    .get(active.executionId) as { dispatch_retry_consumed: number }).dispatch_retry_consumed, 0);
  assert.equal((db.prepare('SELECT status FROM agent_work_drafts WHERE last_execution_id = ?')
    .get(active.executionId) as { status: string }).status, 'editing');
  const intervention = db.prepare('SELECT status, authority, item_id FROM interventions WHERE source_execution_id = ?')
    .get(active.executionId) as { status: string; authority: string; item_id: string | null };
  assert.equal(intervention.status, 'pending');
  assert.equal(intervention.authority, 'arbitration');
  if (native) {
    assert.equal(intervention.item_id, delegation.workItemId);
    assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?')
      .get(intervention.item_id) as { status: string }).status, 'waiting');
    assert.equal((await inspectTaskDispatch(taskId)).some((item) => item.agent === 'test-agent'), false);
  }
});

async function recordCapturedCommand(executionId: string, actualCommand: string, passed = true) {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const current = db.prepare(`
    SELECT COALESCE(MAX(CAST(receipt_key AS INTEGER)), 0) AS sequence
    FROM execution_receipts WHERE execution_id = ? AND kind = 'tool_event'
  `).get(executionId) as { sequence: number };
  const sequence = current.sequence + 1;
  const receiptKey = String(sequence).padStart(8, '0');
  const commandHash = createHash('sha256').update(actualCommand).digest('hex');
  db.prepare(`
    INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
    VALUES(?, ?, 'tool_event', ?, ?)
  `).run(randomUUID(), executionId, receiptKey, JSON.stringify({
    name: 'loop.agent.tool',
    phase: 'completed',
    toolClass: 'shell',
    summary: passed ? '检查通过' : '检查失败',
    level: passed ? 'DEFAULT' : 'ERROR',
    success: passed,
    input: actualCommand,
    commandHash,
  }));
  return receiptKey;
}

async function enterImplement(executionId: string, token: string) {
  const status = await command(executionId, token, ['status']);
  assert.match(status, /Phase: delivery_spec/);
  assert.match(status, /delivery-spec current/);
  const spec = await command(executionId, token, ['delivery-spec', 'current']);
  assert.match(spec, /AC-status/);
  const packet = await command(executionId, token, ['phase', 'complete']);
  assert.match(packet, /IMPLEMENT · builtin/);
}

async function recordCriteria(executionId: string, token: string) {
  await command(executionId, token, [
    'acceptance', 'assess', '--key', 'unit:fixture-unit', '--result', 'claimed',
    '--evidence', '结果页从触发到完成状态形成可观察闭环。',
  ]);
}

for (const native of [false, true]) test(`Dev Agent runs only through the YAML command chain and trusted command receipts (${native ? 'native' : 'legacy'})`, async () => {
  const { taskId, delegation } = await developmentDelegation('通用命令链开发实现', 'CARD-DEV-001', native);
  const active = await begin(delegation, taskId);

  assert.match(await command(active.executionId, active.token!, ['help']), /通用命令链/);
  await assert.rejects(
    command(active.executionId, active.token!, ['implementation', 'status']),
    /只允许 YAML 命令链协议/,
  );
  await enterImplement(active.executionId, active.token!);
  await assert.rejects(
    command(active.executionId, active.token!, ['phase', 'complete']),
    /unit:fixture-unit/,
  );
  await assert.rejects(command(active.executionId, active.token!, [
    'artifact', 'put', '--artifact', 'development', '--block', 'code-review',
    '--content', 'summary: 不能提前审查\nevidence: 当前还在实现阶段',
  ]), /不属于当前 implement Phase/);
  await recordCriteria(active.executionId, active.token!);

  const review = await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(review, /REVIEW · artifact/);
  await command(active.executionId, active.token!, [
    'artifact', 'put', '--artifact', 'development', '--block', 'code-review',
    '--content', 'summary: 实现符合组件边界和仓库规范。\nevidence: 结果状态组件、相邻模式和当前 diff。',
  ]);
  const verification = await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(verification, /DEVELOPER VERIFY · builtin/);
  assert.match(verification, /CAPTURED COMMANDS/);

  const failed = await recordCapturedCommand(active.executionId, 'npm test -- result-status', false);
  await assert.rejects(command(active.executionId, active.token!, [
    'check', 'record', '--key', 'status-component', '--receipt', failed, '--summary', '失败不能登记。',
  ]), /没有明确成功/);
  const passed = await recordCapturedCommand(active.executionId, 'npm test -- result-status');
  await command(active.executionId, active.token!, [
    'check', 'record', '--key', 'status-component', '--receipt', passed,
    '--summary', '完成状态分支回归通过。',
  ]);
  await command(active.executionId, active.token!, [
    'artifact', 'put', '--artifact', 'development', '--block', 'risks', '--key', 'browser-matrix',
    '--content', 'content: 尚未覆盖全部旧版浏览器组合。',
  ]);

  const commit = await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(commit, /COMMIT · confirmation/);
  assert.match(commit, /PHASE INPUTS/);
  assert.match(commit, /需求卡号.*CARD-DEV-001/);
  assert.match(await command(active.executionId, active.token!, ['phase', 'complete']), /FINALIZE · confirmation/);
  const submitted = await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(submitted, /Outcome: completed/);

  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.tests?.[0]?.command, 'npm test -- result-status');
  assert.equal(result?.tests?.[0]?.passed, true);
  assert.match(result?.artifact?.content || '', /代码审查/);
  assert.match(result?.artifact?.content || '', /尚未覆盖全部旧版浏览器组合/);

  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const draft = db.prepare(`
    SELECT command_chain_id FROM agent_work_drafts WHERE terminal_execution_id = ?
  `).get(active.executionId) as { command_chain_id: string };
  assert.equal(draft.command_chain_id, 'development');
  const assessment = db.prepare(`
    SELECT kind, result, evidence FROM acceptance_assessments
    WHERE execution_id = ?
  `).get(active.executionId) as { kind: string; result: string; evidence: string };
  assert.equal(assessment.kind, 'implementation');
  assert.equal(assessment.result, 'claimed');
  assert.match(assessment.evidence, /可观察闭环/);
  if (native) {
    db.prepare(`UPDATE tasks SET agile_status = 'in plan', current_subagent = 'backlog-agent', total_stories = 0,
      analysis_index = 0, spec_resolved_index = 0, dev_index = 0, test_index = 0 WHERE task_id = ?`).run(taskId);
    const { applyAgentResult } = await import('./agent-results');
    const { completeExecution } = await import('./executions');
    const { getTask } = await import('../test/legacy-task-fixtures');
    assert.equal(await applyAgentResult(`RUN-native-dev-result-${taskId}`, delegation, result!, { executionId: active.executionId }), 'advanced');
    await completeExecution(active.executionId);
    assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(delegation.workItemId) as { status: string }).status, 'completed');
    assert.equal((await getTask(taskId))?.task.dev_index, 1);
    const { cancelTask } = await import('../test/legacy-task-fixtures');
    await cancelTask({ taskId, reason: 'Release this completed fixture code claim' });
  }
});

for (const native of [false, true]) test(`Dev runtime input pauses phase complete and resumes the same generic entities (${native ? 'native' : 'legacy'})`, async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { answerRuntimeInput, getTask, submitRuntimeInputs } = await import('../test/legacy-task-fixtures');
  const { taskId, delegation } = await developmentDelegation('通用开发运行信息', undefined, native);
  const first = await begin(delegation, `${taskId}-input`);
  await enterImplement(first.executionId, first.token!);
  await command(first.executionId, first.token!, [
    'runtime-input', 'put', '--key', 'preview-url', '--title', '本地预览地址',
    '--question', '应使用哪个已经配置好的本地预览地址？',
    '--why', '需要检查页面完成状态', '--recommendation', '使用现有开发服务器地址',
  ]);
  const waiting = await command(first.executionId, first.token!, ['phase', 'complete']);
  assert.match(waiting, /Outcome: waiting_for_human/);
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.runtimeInputs[0]?.key, 'preview-url');
  await applyAgentResult(`RUN-development-chain-${taskId}-input`, delegation, pending!, { executionId: first.executionId });
  await completeExecution(first.executionId);

  const detail = await getTask(taskId);
  const request = detail?.runtimeInputs.find((item) => item.request_key === 'preview-url');
  assert.ok(request);
  await answerRuntimeInput({ taskId, requestId: request!.request_id, answer: 'http://localhost:3000/results' });
  await submitRuntimeInputs(taskId);
  const resumedDelegation = (await inspectTaskDispatch(taskId)).find((item) => item.agent === 'dev-agent');
  assert.ok(resumedDelegation);
  const resumed = await begin(resumedDelegation! as DelegationEnvelope, `${taskId}-resume`);
  const status = await command(resumed.executionId, resumed.token!, ['status']);
  assert.match(status, /Phase: implement/);
  assert.match(status, /preview-url.*answered/);
  if (native) {
    const { databaseConnection } = await import('../infrastructure/database');
    const { rewindWorkItemsInDb } = await import('./work-item-transitions');
    const db = await databaseConnection();
    rewindWorkItemsInDb(db, { taskId, targetItemId: resumedDelegation!.workItemId!, eventKey: 'fresh-runtime-question',
      actor: 'human', authority: 'human', reason: 'New revision must not inherit an old answer just because the key matches' });
    const freshWork = (await inspectTaskDispatch(taskId)).find((item) => item.agent === 'dev-agent')!;
    assert.notEqual(freshWork.workItemId, resumedDelegation!.workItemId);
    const fresh = await begin(freshWork, `${taskId}-new-revision`);
    await enterImplement(fresh.executionId, fresh.token!);
    await command(fresh.executionId, fresh.token!, ['runtime-input', 'put', '--key', 'preview-url',
      '--title', '新版本预览地址', '--question', '新版本使用哪个地址？', '--why', '新版本需要独立运行信息',
      '--recommendation', '提供新版本的实际地址']);
    const freshStatus = await command(fresh.executionId, fresh.token!, ['status']);
    assert.match(freshStatus, /preview-url.*waiting/);
    assert.doesNotMatch(freshStatus, /preview-url.*answered/);
    assert.match(await command(fresh.executionId, fresh.token!, ['phase', 'complete']), /waiting_for_human/);
    const submission = await readAgentCommandSubmission(fresh.executionId);
    assert.equal(submission?.runtimeInputs[0]?.key, 'preview-url');
  }
});

test('Metadata Phase only writes declared Metadata and enforces required inputs', async () => {
  const {
    activateAgentConfiguration,
    createAgentConfiguration,
    listAgentConfigurations,
    saveAgentConfigurationDocument,
  } = await import('./agent-configurations');
  const original = listAgentConfigurations('dev-agent').find((configuration) => configuration.active)!;
  const originalDocument = original.documents.find((document) => document.commandChainId === 'development')!;
  const configurationId = createAgentConfiguration({
    agentId: 'dev-agent',
    name: 'Metadata Phase test',
    fromConfigurationId: original.configurationId,
  });
  const yaml = originalDocument.yaml
    .replace(
      '    metadata: tracking.requirement_card_id',
      '    metadata: tracking.requirement_card_id\n    required: true',
    )
    .replace(
      'phases:\n',
      'phases:\n  metadata_setup:\n    type: metadata\n    inputs: [requirement-card]\n    instructions: 登记提交追溯所需的需求卡号。\n\n',
    );
  saveAgentConfigurationDocument({
    agentId: 'dev-agent',
    configurationId,
    commandChainId: 'development',
    yaml,
  });
  activateAgentConfiguration({ agentId: 'dev-agent', configurationId });

  try {
    const { taskId, delegation } = await developmentDelegation('Metadata Phase 写入');
    const active = await begin(delegation, `${taskId}-metadata`);
    const status = await command(active.executionId, active.token!, ['status']);
    assert.match(status, /Phase: metadata_setup/);
    assert.match(status, /需求卡号.*未设置/);
    await assert.rejects(
      command(active.executionId, active.token!, ['phase', 'complete']),
      /缺少必需的 Metadata Input：requirement-card/,
    );
    await assert.rejects(
      command(active.executionId, active.token!, [
        'metadata', 'set', '--key', 'source.reference_url', '--value', 'https://example.test',
      ]),
      /不属于当前 metadata_setup Phase/,
    );
    await command(active.executionId, active.token!, [
      'metadata', 'set', '--key', 'tracking.requirement_card_id', '--value', 'CARD-META-001',
    ]);
    const { databaseConnection } = await import('../infrastructure/database');
    const db = await databaseConnection();
    const stored = db.prepare(`
      SELECT metadata_value FROM requirement_metadata
      WHERE task_id = ? AND metadata_key = 'tracking.requirement_card_id'
    `).get(taskId) as { metadata_value: string };
    assert.equal(stored.metadata_value, 'CARD-META-001');
    const next = await command(active.executionId, active.token!, ['phase', 'complete']);
    assert.match(next, /DELIVERY SPEC · builtin/);
  } finally {
    activateAgentConfiguration({ agentId: 'dev-agent', configurationId: original.configurationId });
  }
});

test('the command-chain migration removes the old Development draft model', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const oldTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'development_%'
    ORDER BY name
  `).all() as { name: string }[];
  assert.deepEqual(oldTables, []);
  const genericTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('command_chain_checks', 'command_chain_runtime_inputs')
    ORDER BY name
  `).all() as { name: string }[];
  assert.deepEqual(genericTables.map((row) => row.name), [
    'command_chain_checks',
    'command_chain_runtime_inputs',
  ]);
});
