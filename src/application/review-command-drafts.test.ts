import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import type { DelegationEnvelope } from '../test/legacy-task-fixtures';

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

test('native Review draft inputs ignore poisoned compatibility labels and cursors but reject a cancelled source', async () => {
  const { adoptNativeWorkflowInDb } = await import('./work-item-transitions');
  const { getTask, getTaskContext, pauseTask, resumeTask } = await import('./tasks');
  const { toEnvelope } = await import('./dispatch-planner');
  const { buildAgentContextSnapshot } = await import('./agent-context');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const fixture = await reviewFixture('Native Review draft authority');
  const db = await databaseConnection();
  const item = adoptNativeWorkflowInDb(db, fixture.taskId).find(work => work.work_key === 'delivery:review')!;
  const detail = (await getTask(fixture.taskId))!;
  const envelope = toEnvelope(detail.task, { taskId: fixture.taskId, lane: 'control', agent: 'review-agent', pipeline: 'review',
    storyIndex: null, resources: [], description: 'Freeze actual native Review inputs', workItemId: item.item_id,
    workItemRevision: item.revision, workItemEpoch: item.dispatch_epoch });
  const full = await getTaskContext(fixture.taskId);
  const contextSnapshot = buildAgentContextSnapshot({ delegation: envelope, full, activeFeedback: [], activeRecovery: [] });
  const started = await beginTestExecutionAttempt({ runId: 'RUN-native-review-input-authority', delegation: envelope,
    prompt: 'Native draft authority fixture', contextSnapshot });
  const executionId = started.attempt.execution_id;
  const token = (await issueAgentCommandToken(executionId))!;
  const frozen = db.prepare('SELECT input_json,input_hash FROM execution_attempts WHERE execution_id = ?').get(executionId);
  db.prepare(`UPDATE tasks SET agile_status = 'done', current_subagent = 'test-agent', closure_status = 'acknowledged',
    total_stories = 999, analysis_index = 0, dev_index = 0, test_index = 0, run_state = 'idle' WHERE task_id = ?`).run(fixture.taskId);
  assert.match(await command(executionId, token, ['status']), /FROZEN REVIEW INPUTS/);
  await command(executionId, token, ['phase', 'complete']);
  assert.deepEqual(db.prepare('SELECT input_json,input_hash FROM execution_attempts WHERE execution_id = ?').get(executionId), frozen);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(item.item_id) as { status: string }).status, 'running');
  await pauseTask({ taskId: fixture.taskId, reason: 'Reject further commands after explicit cancellation' });
  await assert.rejects(command(executionId, token, ['phase', 'complete']), /状态为 cancelled/);
  assert.deepEqual(db.prepare('SELECT input_json,input_hash FROM execution_attempts WHERE execution_id = ?').get(executionId), frozen);
  const oldDraft = db.prepare('SELECT * FROM agent_work_drafts WHERE last_execution_id = ?').get(executionId) as { draft_id: string; draft_version: number };
  const oldBlocks = db.prepare('SELECT * FROM command_chain_artifact_blocks WHERE draft_id = ? ORDER BY ordinal').all(oldDraft.draft_id);
  await resumeTask({ taskId: fixture.taskId });
  const resumedFull = await getTaskContext(fixture.taskId);
  const resumedItem = resumedFull.nativeWorkflow!.items.find(work => work.item_id === item.item_id)!;
  const resumedEnvelope = { ...envelope, workItemEpoch: resumedItem.dispatch_epoch };
  const resumedSnapshot = buildAgentContextSnapshot({ delegation: resumedEnvelope, full: resumedFull, activeFeedback: [], activeRecovery: [] });
  assert.ok(resumedSnapshot.resources.some(resource => resource.ref === `EXEC:${executionId}`));
  const resumed = await beginTestExecutionAttempt({ runId: 'RUN-native-review-resume', delegation: resumedEnvelope,
    prompt: 'Resume Review after normal cancellation', contextSnapshot: resumedSnapshot });
  assert.notEqual(resumed.attempt.execution_id, executionId);
  const resumedToken = (await issueAgentCommandToken(resumed.attempt.execution_id))!;
  await command(resumed.attempt.execution_id, resumedToken, ['status']);
  const newDraft = db.prepare('SELECT * FROM agent_work_drafts WHERE last_execution_id = ?').get(resumed.attempt.execution_id) as { draft_id: string; draft_version: number };
  assert.notEqual(newDraft.draft_id, oldDraft.draft_id);
  assert.equal(newDraft.draft_version, oldDraft.draft_version + 1);
  await command(resumed.attempt.execution_id, resumedToken, ['phase', 'complete']);
  assert.deepEqual(db.prepare('SELECT * FROM agent_work_drafts WHERE draft_id = ?').get(oldDraft.draft_id), oldDraft);
  assert.deepEqual(db.prepare('SELECT * FROM command_chain_artifact_blocks WHERE draft_id = ? ORDER BY ordinal').all(oldDraft.draft_id), oldBlocks);
  assert.deepEqual(db.prepare('SELECT input_json,input_hash FROM execution_attempts WHERE execution_id = ?').get(executionId), frozen);
});

for (const { agent, otherUnit } of [
  { agent: 'test-agent', otherUnit: false }, { agent: 'dev-agent', otherUnit: false }, { agent: 'test-agent', otherUnit: true },
] as const) test(`native Review preserves an explicit ${agent} arbitration exception without fabricating Test success${otherUnit ? ' across unit boundaries' : ''}`, async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { adoptNativeWorkflowInDb, transitionWorkItemInDb } = await import('./work-item-transitions');
  const { getTaskContext } = await import('./tasks');
  const { toEnvelope } = await import('./dispatch-planner');
  const { buildAgentContextSnapshot } = await import('./agent-context');
  const { openIntervention, claimNextIntervention, finishInterventionAttempt, runHumanArbitrationCommand } = await import('./interventions');
  const { issueAgentCommandToken, readAgentCommandSubmission } = await import('./agent-command-drafts');
  const fixture = await reviewFixture(`Native ${agent} arbitration closure`);
  const db = await databaseConnection();
  db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = ?, dev_index = ?, test_index = 0 WHERE task_id = ?`)
    .run(agent, agent === 'test-agent' ? 1 : 0, fixture.taskId);
  if (otherUnit) {
    db.prepare(`INSERT INTO stories(task_id, story_index, title, directory, unit_key, actor, trigger_condition, observable_outcome, acceptance)
      SELECT task_id, 2, 'Second independent unit', 'story-002', 'second-unit', actor, trigger_condition, observable_outcome, acceptance
      FROM stories WHERE task_id = ? AND story_index = 1`).run(fixture.taskId);
    db.prepare(`INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
      VALUES(?, ?, 2, 1, 'resolved', ?, CURRENT_TIMESTAMP)`).run(randomUUID(), fixture.taskId, JSON.stringify(deliverySpecFixture()));
    db.prepare(`UPDATE tasks SET total_stories = 2, analysis_index = 2, spec_resolved_index = 2, dev_index = 2, test_index = 1 WHERE task_id = ?`).run(fixture.taskId);
  }
  const items = adoptNativeWorkflowInDb(db, fixture.taskId);
  const target = items.filter(item => item.agent === agent && item.story_index === (otherUnit ? 2 : 1)
    && !['superseded','cancelled'].includes(item.status)).sort((a, b) => b.revision - a.revision)[0]!;
  const intervention = await openIntervention({ taskId: fixture.taskId, itemId: target.item_id,
    requestedBy: agent, dedupeKey: `closure:${fixture.taskId}`, summary: 'Resolve a frozen unit contract conflict',
    authority: 'arbitration', resolverStrategy: 'system_then_human', maxSystemAttempts: 3 });
  for (let index = 0; index < 3; index++) {
    assert.equal((await claimNextIntervention({ runId: 'RUN-review-arbitration', executorId: 'claude', executionOptions: {} }))?.interventionId, intervention.intervention_id);
    await finishInterventionAttempt({ interventionId: intervention.intervention_id, reason: 'Cannot safely resolve this contract conflict', outcome: 'deferred' });
  }
  const reason = 'This unit acceptance is explicitly waived after reviewing the conflicting ownership;\n\nthe original failure remains unverified.';
  // Reproduce a real Agent's folded YAML result: the full decision survives,
  // but the original paragraph breaks are folded into presentation whitespace.
  const foldedReason = (parse('result: >-\n  This unit acceptance is explicitly waived after reviewing the conflicting ownership;\n  the original failure remains unverified.\n') as { result: string }).result;
  assert.notEqual(foldedReason, reason);
  await runHumanArbitrationCommand({ taskId: fixture.taskId, interventionId: intervention.intervention_id,
    args: ['intervention', 'work-item-complete', '--reason', reason] });
  if (agent === 'dev-agent') {
    // A completed Test node alone is not a passed Test receipt. Dev arbitration
    // must not waive Test merely because the graph permits Review dispatch.
    const testItem = items.filter(item => item.agent === 'test-agent' && !['superseded','cancelled'].includes(item.status)).sort((a,b) => b.revision - a.revision)[0]!;
    transitionWorkItemInDb(db, { itemId: testItem.item_id, action: 'complete', eventKey: 'domain-test-complete', actor: 'test-agent', authority: 'agent', reason: 'Completion without a passed receipt must not waive evidence' });
  }
  const full = await getTaskContext(fixture.taskId);
  const review = full.nativeWorkflow!.items.find(item => item.work_key === 'delivery:review')!;
  const envelope = toEnvelope(full.task, { taskId: fixture.taskId, lane: 'control', agent: 'review-agent', pipeline: 'review',
    storyIndex: null, resources: [], description: 'Review arbitration without rewriting observed facts', workItemId: review.item_id,
    workItemRevision: review.revision, workItemEpoch: review.dispatch_epoch });
  const snapshot = buildAgentContextSnapshot({ delegation: envelope, full, activeFeedback: [], activeRecovery: [] });
  const wrongScopeRef = `EXEC:domain-unit-two-passed-${fixture.taskId}`;
  if (otherUnit) snapshot.resources.push({ ref: wrongScopeRef, kind: 'execution', title: 'Domain-only passed evidence for unit 2',
    deliveryUnit: 2, scope: 'unit:2', revision: 1, status: 'applied', authority: 'execution_evidence', updatedAt: null,
    summary: 'This fixture must not prove unit 1', content: { agent: 'test-agent', status: 'applied', outcome: 'completed', verdict: 'passed', deliveryUnit: 2 } });
  const started = await beginTestExecutionAttempt({ runId: 'RUN-native-review-arbitration', delegation: envelope, prompt: 'Domain arbitration closure', contextSnapshot: snapshot });
  const executionId = started.attempt.execution_id;
  const token = (await issueAgentCommandToken(executionId))!;
  const itemRef = `WORKITEM:${target.item_id}:r${target.revision}`;
  const interventionRef = `INTERVENTION:${intervention.intervention_id}`;
  const frozen = db.prepare('SELECT input_json,input_hash FROM execution_attempts WHERE execution_id = ?').get(executionId);
  await command(executionId, token, ['status']);
  await command(executionId, token, ['phase', 'complete']);
  const subjects = await reviewSubjects(executionId);
  for (const [index, subjectRef] of subjects.entries()) await putArtifact(executionId, token, 'reconciliations', {
    subjectRef, result: foldedReason, evidenceRefs: [itemRef, interventionRef, fixture.specRef, ...(otherUnit ? [wrongScopeRef] : [])],
  }, `subject-${index + 1}`);
  if (agent === 'dev-agent' || otherUnit) {
    await assert.rejects(command(executionId, token, ['phase', 'complete']), /缺少独立 Test 通过证据/);
    if (otherUnit) {
      const unitTwoIndex = subjects.indexOf(`DELIVERY_UNIT:${fixture.taskId}:2`);
      assert.ok(unitTwoIndex >= 0);
      await assert.rejects(command(executionId, token, ['phase', 'complete']), error => {
        // Unit 2's explicit Test exception is valid, but cannot satisfy unit 1
        // or requirement-level subjects without independent Test evidence.
        assert.ok(!String(error).includes(`对账 subject-${unitTwoIndex + 1} 缺少独立 Test`));
        return /缺少独立 Test 通过证据/.test(String(error));
      });
    }
    assert.deepEqual(db.prepare('SELECT input_json,input_hash FROM execution_attempts WHERE execution_id = ?').get(executionId), frozen);
    return;
  }
  await putArtifact(executionId, token, 'reconciliations', { subjectRef: subjects[0], result: reason, evidenceRefs: [itemRef] }, 'subject-1');
  await assert.rejects(command(executionId, token, ['phase', 'complete']), /必须引用仲裁工作项/);
  await putArtifact(executionId, token, 'reconciliations', { subjectRef: subjects[1], result: reason.replace(/\n/g, '\r\n\t'), evidenceRefs: [itemRef, interventionRef] }, 'subject-2');
  // A faithful summary is not the authority. The Harness retains the complete
  // original decision without asking the Agent to transcribe long Markdown.
  await putArtifact(executionId, token, 'reconciliations', { subjectRef: subjects[0], result: 'Workflow progress is explicitly arbitrated; the original failure is still unverified.', evidenceRefs: [itemRef, interventionRef] }, 'subject-1');
  db.prepare("UPDATE interventions SET authority = 'standard' WHERE intervention_id = ?").run(intervention.intervention_id);
  await assert.rejects(command(executionId, token, ['phase', 'complete']), /仲裁证据未完整冻结/);
  db.prepare("UPDATE interventions SET authority = 'arbitration' WHERE intervention_id = ?").run(intervention.intervention_id);
  db.prepare('UPDATE interventions SET resolution = ? WHERE intervention_id = ?').run(reason.split(';')[0], intervention.intervention_id);
  await assert.rejects(command(executionId, token, ['phase', 'complete']), /仲裁证据未完整冻结/);
  db.prepare('UPDATE interventions SET resolution = ? WHERE intervention_id = ?').run(reason, intervention.intervention_id);
  const completionKey = `intervention:${intervention.intervention_id}:complete`;
  db.prepare('UPDATE workflow_item_events SET reason = ? WHERE item_id = ? AND event_key = ?').run('A forged Test passed claim', target.item_id, completionKey);
  await assert.rejects(command(executionId, token, ['phase', 'complete']), /仲裁证据未完整冻结/);
  db.prepare('UPDATE workflow_item_events SET reason = ? WHERE item_id = ? AND event_key = ?').run(reason, target.item_id, completionKey);
  await command(executionId, token, ['phase', 'complete']);
  await putArtifact(executionId, token, 'assessment', { summary: 'Explicit arbitration allows workflow progress, not a Test passed verdict.',
    evidenceBoundary: `Unverified exception: ${itemRef}; ${interventionRef}`, residualRisk: reason });
  await command(executionId, token, ['phase', 'complete']);
  await writeCoreReport(executionId, token);
  await assert.rejects(command(executionId, token, ['phase', 'complete']), /仲裁放行及未验证边界/);
  for (const kind of ['verification', 'risks']) await putArtifact(executionId, token, 'report-sections', { kind, content: `${itemRef}: ${reason}` }, kind);
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['phase', 'complete']);
  const result = await readAgentCommandSubmission(executionId);
  assert.equal(result?.verdict, 'report_ready');
  assert.match(result!.artifact!.content, /remains unverified/);
  assert.ok(result!.artifact!.content.includes(reason), 'the complete canonical reason must be retained verbatim, not the summary or folded text');
  assert.match(result!.artifact!.content, /仲裁处置记录（Harness 权威证据）/);
  assert.ok(result!.artifact!.content.includes(itemRef) && result!.artifact!.content.includes(interventionRef));
  assert.deepEqual(db.prepare('SELECT input_json,input_hash FROM execution_attempts WHERE execution_id = ?').get(executionId), frozen);
  const evidence = db.prepare(`SELECT content FROM command_chain_artifact_blocks WHERE draft_id = (SELECT draft_id FROM agent_work_drafts WHERE last_execution_id = ?)
    AND block_id = 'evidence-sources'`).all(executionId) as { content: string }[];
  assert.ok(evidence.every(row => !row.content.includes('independentTest: yes')));
});

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
  db.prepare(`
    INSERT INTO command_chain_acceptance_items(
      draft_id, acceptance_key, statement, oracle, source, ordinal
    ) VALUES(?, 'visible-final-state', '用户完成操作后看到准确最终状态',
      '从真实用户入口观察到与最终业务状态一致的展示', '用户验收', 4)
  `).run(draftId);
  db.prepare(`
    INSERT INTO acceptances(
      acceptance_id, task_id, acceptance_key, scope_type, statement, oracle,
      source_ref, source_command_chain_draft_id
    ) VALUES(?, ?, 'visible-final-state', 'requirement',
      '用户完成操作后看到准确最终状态',
      '从真实用户入口观察到与最终业务状态一致的展示', ?, ?)
  `).run(
    `ACCEPTANCE-requirement-${taskId}`,
    taskId,
    `REQUIREMENT:${taskId}:acceptance:visible-final-state`,
    draftId,
  );
}

async function reviewFixture(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, upsertDocument } = await import('../test/legacy-task-fixtures');
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
  db.prepare(`
    INSERT INTO acceptances(
      acceptance_id, task_id, acceptance_key, scope_type, story_index,
      statement, oracle, source_ref
    ) VALUES(?, ?, 'unit:state-mapping', 'delivery_unit', 1,
      '独立黑盒验证最终状态', '页面显示正确的最终状态', ?)
  `).run(
    `ACCEPTANCE-unit-${taskId}`,
    taskId,
    `DELIVERY_UNIT:${taskId}:state-mapping:acceptance`,
  );
  db.prepare(`
    INSERT INTO delivery_unit_acceptances(task_id, story_index, acceptance_id, relation)
    VALUES(?, 1, ?, 'unit')
  `).run(taskId, `ACCEPTANCE-unit-${taskId}`);
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
  const { getTask } = await import('../test/legacy-task-fixtures');
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
