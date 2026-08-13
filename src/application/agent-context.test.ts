import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import type { DelegationEnvelope } from './tasks';

function delegation(taskId: string, overrides: Partial<DelegationEnvelope> = {}): DelegationEnvelope {
  return {
    taskId,
    lane: 'delivery',
    pipeline: 'resume',
    agent: 'dev-agent',
    storyIndex: 1,
    resources: ['code:workspace', 'browser:exclusive'],
    description: '继续实现当前交付单元',
    title: 'Context engineering',
    taskDescription: 'Implement one delivery unit.',
    itemType: 'feature',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'in dev',
    currentSubagent: 'dev-agent',
    resumePending: 1,
    specResolvedIndex: 1,
    runState: 'runnable',
    closureStatus: 'open',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: 'human',
    analysisIndex: 1,
    devIndex: 0,
    testIndex: 0,
    totalStories: 2,
    nextStep: 'Resume Dev',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
    ...overrides,
  };
}

test('renders only the hot Backlog context in the launch Prompt while retaining the full snapshot', async () => {
  const { createTask, getTaskContext } = await import('./tasks');
  const { buildAgentContextSnapshot, renderAgentWorkingContextPack } = await import('./agent-context');
  const taskId = await createTask({
    title: 'Borrowing reminder',
    description: 'Remind readers before a loan expires and handle overdue loans.',
    itemType: 'feature',
    priority: '5',
  });
  const full = await getTaskContext(taskId);
  const snapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, {
      agent: 'backlog-agent',
      lane: 'control',
      pipeline: 'backlog',
      storyIndex: null,
      title: 'Borrowing reminder',
      taskDescription: 'Remind readers before a loan expires and handle overdue loans.',
      description: '澄清业务变化上下文',
    }),
    full,
    activeFeedback: [],
    activeRecovery: [],
    repositoryBaseCommit: 'abc123',
  });

  const pack = renderAgentWorkingContextPack(snapshot);
  assert.match(pack, new RegExp(taskId));
  assert.match(pack, /Borrowing reminder/);
  assert.match(pack, /Remind readers before a loan expires/);
  assert.match(pack, /Repository Base Commit: `abc123`/);
  assert.match(pack, /当前没有需要直接内联的恢复决策包/);
  assert.doesNotMatch(pack, /lifecycle|lanes|progress|deliveryUnits|currentDeliverySpec|recentExecutionEvidence/);
  assert.doesNotMatch(pack, /\[\]|null/);

  assert.equal(snapshot.authoritativeFacts.lifecycle.progress.total, 0);
  assert.deepEqual(snapshot.authoritativeFacts.deliveryUnits, []);
  assert.deepEqual(snapshot.recentExecutionEvidence, []);
});

test('builds a compact execution snapshot while preserving full context for just-in-time reads', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    addQuestion,
    addRuntimeInputRequest,
    answerQuestion,
    answerRuntimeInput,
    createTask,
    getTaskContext,
    upsertDocument,
  } = await import('./tasks');
  const {
    buildAgentContextSnapshot,
    getExecutionAgentContextSnapshot,
    renderAgentContextList,
    renderAgentContextResource,
    renderAgentContextSearch,
  } = await import('./agent-context');
  const { beginExecutionAttempt } = await import('./executions');
  const db = await databaseConnection();
  const taskId = await createTask({
    title: 'Context engineering',
    description: 'Implement one delivery unit.',
    metadata: [{ key: 'workflow.analysis_decision_mode', value: 'autonomous' }],
  });
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Current unit', 'unit-001'), (?, 2, 'Future unit', 'unit-002')").run(taskId, taskId);
  db.prepare(`
    UPDATE stories
    SET unit_key = 'current-unit', actor = '管理员',
        trigger_condition = '管理员提交当前操作',
        observable_outcome = '管理员看到当前业务结果',
        acceptance = '当前业务结果可以独立验收'
    WHERE task_id = ? AND story_index = 1
  `).run(taskId);
  db.prepare(`
    INSERT INTO delivery_unit_context_links(
      task_id, story_index, source_key, source_kind, content, source_ref
    ) VALUES(?, 1, 'impact:current-result', 'change', '产生当前业务结果', 'TEST:current-result')
  `).run(taskId);
  db.prepare(`
    INSERT INTO delivery_unit_dependencies(task_id, story_index, depends_on_story_index)
    VALUES(?, 2, 1)
  `).run(taskId);
  db.prepare('UPDATE tasks SET total_stories = 2, analysis_index = 1, spec_resolved_index = 1 WHERE task_id = ?').run(taskId);
  const currentContent = `${'Current analysis details. '.repeat(20)}FULL-CONTEXT-TAIL`;
  const currentDocumentId = await upsertDocument({
    taskId, storyIndex: 1, kind: 'analysis', title: 'Current analysis', content: currentContent, actor: 'analyst-agent',
  });
  await upsertDocument({
    taskId, storyIndex: 2, kind: 'analysis', title: 'Future analysis', content: 'FUTURE-UNIT-ONLY', actor: 'analyst-agent',
  });
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-context-unit-1', ?, 1, 1, 'resolved', ?)
  `).run(taskId, JSON.stringify(deliverySpecFixture()));
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-context-unit-2', ?, 2, 1, 'resolved', ?)
  `).run(taskId, JSON.stringify(deliverySpecFixture({
    handoff: {
      implementationGuidance: 'Preserve the future behavior.',
      guardrails: [],
      verificationFocus: [{
        key: 'AC-2',
        expected: 'Works later',
        oracle: 'Future assertion passes',
      }],
    },
  })));
  const questionId = await addQuestion({
    taskId, storyIndex: 1, actor: 'analyst-agent', kind: 'analysis', title: 'Retry policy',
    question: 'Which configuration should retry use?', decisionKey: 'retry-policy',
  });
  await answerQuestion({ taskId, questionId, answer: 'Reuse the original configuration.' });
  const requestId = await addRuntimeInputRequest({
    taskId, storyIndex: 1, sourceAgent: 'dev-agent', title: 'Local fixture',
    question: 'Which local fixture should be used?', recommendation: 'Use fixture A.',
  });
  await answerRuntimeInput({ taskId, requestId, answer: 'Use fixture B.' });

  const full = await getTaskContext(taskId);
  const snapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId), full, activeFeedback: [], activeRecovery: [], repositoryBaseCommit: 'abc123',
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /analysisDecisionMode|workflow\.analysis_decision_mode/);
  const startup = JSON.stringify({
    authoritativeFacts: snapshot.authoritativeFacts,
    activeObligations: snapshot.activeObligations,
    startupIndex: snapshot.startupIndex,
  });
  assert.equal(startup.includes('FULL-CONTEXT-TAIL'), false);
  assert.equal(startup.includes('FUTURE-UNIT-ONLY'), false);
  assert.match(startup, /Reuse the original configuration/);
  assert.deepEqual(snapshot.authoritativeFacts.answeredDecisionKeys, ['retry-policy']);
  assert.equal(snapshot.authoritativeFacts.currentDeliveryUnit?.key, 'current-unit');
  assert.equal(snapshot.authoritativeFacts.currentDeliveryUnit?.actor, '管理员');
  assert.equal(snapshot.authoritativeFacts.currentDeliveryUnit?.sourceRefs[0]?.key, 'impact:current-result');
  assert.deepEqual(snapshot.authoritativeFacts.deliveryUnits[1]?.dependsOn, [1]);
  assert.match(startup, /Use fixture B/);
  assert.equal(snapshot.resourceCount > snapshot.startupIndex.length, true);
  assert.equal(snapshot.requiredContextRefs.includes(`DOC:${currentDocumentId}`), true);
  assert.match(renderAgentContextResource(snapshot, `DOC:${currentDocumentId}`), /FULL-CONTEXT-TAIL/);
  assert.match(renderAgentContextSearch(snapshot, 'FUTURE-UNIT-ONLY'), /Future analysis/);
  assert.doesNotMatch(renderAgentContextList(snapshot, { scope: 'current' }), /Future analysis/);

  const reviewSnapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, { agent: 'review-agent', lane: 'control', pipeline: 'review', storyIndex: null }),
    full, activeFeedback: [], activeRecovery: [], repositoryBaseCommit: 'abc123',
  });
  assert.equal(reviewSnapshot.requiredContextRefs.some((ref) => ref.startsWith('SPEC:SPEC-context-unit-1')), true);
  assert.equal(reviewSnapshot.requiredContextRefs.some((ref) => ref.startsWith('SPEC:SPEC-context-unit-2')), true);

  const analystSnapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, {
      agent: 'analyst-agent',
      lane: 'analysis',
      pipeline: 'analysis',
      storyIndex: 2,
      description: '收敛第二个交付单元的实际影响、关键决策与冻结交付契约',
    }),
    full,
    activeFeedback: [],
    activeRecovery: [],
    repositoryBaseCommit: 'abc123',
  });
  assert.equal(
    analystSnapshot.requiredContextRefs.includes('SPEC:SPEC-context-unit-1:r1'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(analystSnapshot), /analysisDecisionMode|workflow\.analysis_decision_mode/);

  const testSnapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, {
      agent: 'test-agent',
      lane: 'delivery',
      pipeline: 'test',
      storyIndex: 1,
      description: '独立验证当前交付单元',
    }),
    full,
    activeFeedback: [],
    activeRecovery: [],
    repositoryBaseCommit: 'abc123',
  });
  assert.doesNotMatch(JSON.stringify(testSnapshot), /analysisDecisionMode|workflow\.analysis_decision_mode/);

  const started = await beginExecutionAttempt({
    runId: 'RUN-agent-context', delegation: delegation(taskId), prompt: 'compact prompt', contextSnapshot: snapshot,
  });
  const stored = await getExecutionAgentContextSnapshot(started.attempt.execution_id);
  assert.equal(stored.snapshotId, snapshot.snapshotId);
  assert.match(renderAgentContextResource(stored, `DOC:${currentDocumentId}`), /FULL-CONTEXT-TAIL/);
});

test('injects a semantic backlog resume packet while excluding pruned decision branches', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { addQuestion, answerQuestion, createTask, getTaskContext, upsertDocument } = await import('./tasks');
  const { buildAgentContextSnapshot, renderAgentWorkingContextPack } = await import('./agent-context');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Conditional export', description: 'Align the export decision tree.' });
  await upsertDocument({
    taskId,
    kind: 'context',
    title: '业务变化上下文',
    actor: 'backlog-agent',
    content: [
      '# 业务变化上下文',
      '## BUSINESS INTENT',
      '管理员需要导出审计结果。',
      '## AS-IS',
      '- 当前只能在线查看。',
      '## OPEN QUESTIONS',
      '- 旧的待答展示不应进入恢复基线。',
      '## TO-BE',
      '- 尚未形成。',
    ].join('\n'),
  });
  const rootId = await addQuestion({
    taskId,
    actor: 'backlog-agent',
    title: '导出受众',
    question: '导出面向谁？',
    decisionKey: 'audience',
    alternatives: [
      { id: 'admin', label: '仅管理员', consequences: ['普通成员没有导出入口'] },
      { id: 'all', label: '所有成员', consequences: ['需要成员权限设计'] },
    ],
  });
  await answerQuestion({ taskId, questionId: rootId, selectedOptionId: 'admin' });
  const prunedId = await addQuestion({
    taskId,
    actor: 'backlog-agent',
    title: '普通成员权限',
    question: '普通成员如何获得权限？',
    decisionKey: 'member-permission',
    alternatives: [
      { id: 'auto', label: '自动开放', consequences: ['所有成员可用'] },
      { id: 'request', label: '申请开放', consequences: ['增加申请流程'] },
    ],
    activation: [{ decisionKey: 'audience', optionId: 'all' }],
    dependsOn: ['audience'],
    initialStatus: 'not_applicable',
  });
  db.prepare(`
    UPDATE questions
    SET answer = '这个废弃答案不能进入 Agent', selected_option_id = 'auto', status = 'not_applicable'
    WHERE question_id = ?
  `).run(prunedId);

  const full = await getTaskContext(taskId);
  const snapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, {
      agent: 'backlog-agent', lane: 'control', pipeline: 'resume', storyIndex: null,
    }),
    full,
    activeFeedback: [],
    activeRecovery: [],
  });
  const serialized = JSON.stringify(snapshot);
  const launchPack = renderAgentWorkingContextPack(snapshot);
  const resume = snapshot.authoritativeFacts.requirementContextResume as {
    businessContext: string;
    activeDecisionTree: { decisionKey: string; selectedOption: { label: string; consequences: string[] } }[];
  };
  assert.match(resume.businessContext, /当前只能在线查看/);
  assert.doesNotMatch(resume.businessContext, /旧的待答展示/);
  assert.equal(resume.activeDecisionTree[0]?.decisionKey, 'audience');
  assert.equal(resume.activeDecisionTree[0]?.selectedOption.label, '仅管理员');
  assert.deepEqual(resume.activeDecisionTree[0]?.selectedOption.consequences, ['普通成员没有导出入口']);
  assert.match(launchPack, /Resumed Requirement Context/);
  assert.match(launchPack, /当前只能在线查看/);
  assert.match(launchPack, /audience/);
  assert.doesNotMatch(launchPack, /lifecycle|lanes|progress/);
  assert.doesNotMatch(serialized, /这个废弃答案不能进入 Agent/);
  assert.doesNotMatch(serialized, /普通成员权限/);
  assert.doesNotMatch(launchPack, /这个废弃答案不能进入 Agent|普通成员权限/);
});

test('hard-isolates Test context from Dev narratives while preserving the frozen verification contract', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginExecutionAttempt } = await import('./executions');
  const {
    createOrReopenRecoveryItem,
    listRecoveryItemsForStage,
    recordRecoveryClaims,
  } = await import('./recovery-items');
  const {
    addRuntimeInputRequest,
    createTask,
    getTaskContext,
    saveDeliverySpec,
    upsertDocument,
  } = await import('./tasks');
  const {
    agentContextProtocol,
    buildAgentContextSnapshot,
    renderAgentContextEvidence,
    renderAgentContextList,
    renderAgentContextOverview,
    renderAgentContextResource,
    renderAgentContextSearch,
  } = await import('./agent-context');
  const db = await databaseConnection();
  const taskId = await createTask({
    title: 'Independent verification context',
    description: 'Verify one frozen delivery contract without Dev narration.',
  });
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'Independent verification unit', 'unit-001')
  `).run(taskId);
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent',
        total_stories = 1, analysis_index = 1, spec_resolved_index = 1,
        dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  await saveDeliverySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: deliverySpecFixture({
      summary: 'BUSINESS-CONTRACT-SENTINEL',
      impacts: [{
        key: 'visible-impact',
        area: 'Visible business behavior',
        finding: 'BUSINESS-IMPACT-SENTINEL',
        disposition: 'change',
        evidence: 'Confirmed by the frozen Analyst contract.',
      }],
      decisions: [{
        key: 'visible-decision',
        title: 'Visible decision',
        type: 'business',
        question: 'Which behavior is authoritative?',
        impact: 'The observable result changes.',
        status: 'resolved',
        options: [],
        authority: 'project_evidence',
        decision: 'BUSINESS-DECISION-SENTINEL',
        rationale: 'The project contract is explicit.',
        evidence: 'Frozen Analyst evidence.',
      }],
      handoff: {
        implementationGuidance: 'IMPL-GUIDANCE-SENTINEL',
        guardrails: [{
          key: 'visible-guardrail',
          content: 'GUARDRAIL-SENTINEL',
          rationale: 'Preserve the adjacent behavior.',
        }],
        verificationFocus: [{
          key: 'visible-focus',
          expected: 'FOCUS-EXPECTED-SENTINEL',
          oracle: 'FOCUS-ORACLE-SENTINEL',
        }],
      },
    }),
  });
  db.prepare(`
    INSERT INTO story_specs(
      spec_id, task_id, story_index, revision, status, spec_json
    ) VALUES(?, ?, 1, 2, 'draft', ?)
  `).run(
    `SPEC-unresolved-${taskId}`,
    taskId,
    JSON.stringify(deliverySpecFixture({
      summary: 'PENDING-SPEC-SENTINEL',
      handoff: {
        implementationGuidance: 'PENDING-IMPL-GUIDANCE-SENTINEL',
        guardrails: [],
        verificationFocus: [],
      },
    })),
  );
  const analysisDocumentId = await upsertDocument({
    taskId,
    storyIndex: 1,
    kind: 'analysis',
    title: 'Analyst rendering with implementation direction',
    content: 'ANALYSIS-DOC-SENTINEL IMPL-GUIDANCE-SENTINEL',
    actor: 'analyst-agent',
  });
  const devDocumentId = await upsertDocument({
    taskId,
    storyIndex: 1,
    kind: 'dev_note',
    title: 'Dev implementation result',
    content: 'DEV-NOTE-SENTINEL',
    actor: 'dev-agent',
  });
  const testDocumentId = await upsertDocument({
    taskId,
    storyIndex: 1,
    kind: 'test_result',
    title: 'Prior independent verification',
    content: 'TEST-RESULT-SENTINEL',
    actor: 'test-agent',
  });
  await addRuntimeInputRequest({
    taskId,
    storyIndex: 1,
    sourceAgent: 'dev-agent',
    title: 'Dev-only runtime input',
    question: 'DEV-RUNTIME-SENTINEL',
  });
  await addRuntimeInputRequest({
    taskId,
    storyIndex: 1,
    sourceAgent: 'test-agent',
    title: 'Test runtime input',
    question: 'TEST-RUNTIME-SENTINEL',
  });
  const recovery = await createOrReopenRecoveryItem({
    taskId,
    storyIndex: 1,
    kind: 'test_failure',
    sourceAgent: 'test-agent',
    targetStage: 'dev',
    summary: 'ORIGINAL-FAILURE-SUMMARY-SENTINEL',
    details: {
      expected: 'ORIGINAL-FAILURE-EXPECTED-SENTINEL',
      actual: 'ORIGINAL-FAILURE-ACTUAL-SENTINEL',
    },
    sourceExecutionId: `EXEC-original-test-${taskId}`,
  });
  await recordRecoveryClaims({
    taskId,
    storyIndex: 1,
    agent: 'dev-agent',
    executionId: `EXEC-dev-claim-${taskId}`,
    claims: [{
      recoveryId: recovery.recovery_id,
      summary: 'DEV-RECOVERY-CLAIM-SENTINEL',
      evidence: ['DEV-RECOVERY-EVIDENCE-SENTINEL'],
    }],
  });

  const devAttempt = await beginExecutionAttempt({
    runId: `RUN-dev-context-${taskId}`,
    delegation: delegation(taskId, {
      agent: 'dev-agent',
      pipeline: 'dev',
      currentSubagent: 'dev-agent',
    }),
    prompt: 'Dev context sentinel',
    baseCommit: 'DEV-BASE-COMMIT-SENTINEL',
  });
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'applied', result_json = ?, code_commit = ?,
        finished_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(
    JSON.stringify({ outcome: 'completed', summary: 'DEV-EXEC-SENTINEL' }),
    'DEV-CODE-COMMIT-SENTINEL',
    devAttempt.attempt.execution_id,
  );
  const testAttempt = await beginExecutionAttempt({
    runId: `RUN-test-context-${taskId}`,
    delegation: delegation(taskId, {
      agent: 'test-agent',
      pipeline: 'test',
      resources: ['code:workspace', 'browser:exclusive'],
      currentSubagent: 'test-agent',
      devIndex: 1,
    }),
    prompt: 'Test context sentinel',
    baseCommit: 'TEST-BASE-COMMIT-SENTINEL',
  });
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'applied', result_json = ?, finished_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(
    JSON.stringify({ outcome: 'completed', summary: 'TEST-EXEC-SENTINEL' }),
    testAttempt.attempt.execution_id,
  );

  const full = await getTaskContext(taskId);
  const activeRecovery = await listRecoveryItemsForStage({
    taskId,
    storyIndex: 1,
    stage: 'test',
  });
  const snapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, {
      agent: 'test-agent',
      pipeline: 'test',
      resources: ['code:workspace', 'browser:exclusive'],
      currentSubagent: 'test-agent',
      devIndex: 1,
    }),
    full,
    activeFeedback: [],
    activeRecovery,
    repositoryBaseCommit: 'TEST-CURRENT-HEAD-SENTINEL',
  });

  assert.equal(agentContextProtocol, 'loop-agent-context/v2');
  assert.equal(snapshot.protocol, 'loop-agent-context/v2');
  const serialized = JSON.stringify(snapshot);
  for (const hidden of [
    'ANALYSIS-DOC-SENTINEL',
    'IMPL-GUIDANCE-SENTINEL',
    'DEV-NOTE-SENTINEL',
    'DEV-RUNTIME-SENTINEL',
    'DEV-EXEC-SENTINEL',
    'DEV-BASE-COMMIT-SENTINEL',
    'DEV-CODE-COMMIT-SENTINEL',
    'DEV-RECOVERY-CLAIM-SENTINEL',
    'DEV-RECOVERY-EVIDENCE-SENTINEL',
    'PENDING-SPEC-SENTINEL',
    'PENDING-IMPL-GUIDANCE-SENTINEL',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(hidden));
    assert.equal(
      renderAgentContextSearch(snapshot, hidden),
      `No context resources matched: ${hidden}`,
    );
  }
  for (const visible of [
    'BUSINESS-CONTRACT-SENTINEL',
    'BUSINESS-IMPACT-SENTINEL',
    'BUSINESS-DECISION-SENTINEL',
    'GUARDRAIL-SENTINEL',
    'FOCUS-EXPECTED-SENTINEL',
    'FOCUS-ORACLE-SENTINEL',
    'ORIGINAL-FAILURE-SUMMARY-SENTINEL',
    'ORIGINAL-FAILURE-EXPECTED-SENTINEL',
    'ORIGINAL-FAILURE-ACTUAL-SENTINEL',
    'TEST-RUNTIME-SENTINEL',
    'TEST-EXEC-SENTINEL',
    'TEST-RESULT-SENTINEL',
  ]) {
    assert.match(serialized, new RegExp(visible));
  }
  assert.deepEqual(
    snapshot.recentExecutionEvidence.map((item) => (item as { agent: string }).agent),
    ['test-agent'],
  );
  assert.equal(snapshot.resources.some((resource) => resource.ref === `DOC:${analysisDocumentId}`), false);
  assert.equal(snapshot.resources.some((resource) => resource.ref === `DOC:${devDocumentId}`), false);
  assert.equal(snapshot.resources.some((resource) => resource.ref === `DOC:${testDocumentId}`), true);
  assert.throws(
    () => renderAgentContextResource(snapshot, `DOC:${devDocumentId}`),
    /Context reference not found/,
  );
  assert.doesNotMatch(renderAgentContextList(snapshot), /dev_note|DEV-NOTE-SENTINEL/);
  assert.doesNotMatch(renderAgentContextEvidence(snapshot, 'dev'), /DEV-/);
  assert.doesNotMatch(renderAgentContextOverview(snapshot), /DEV-/);
  assert.equal(
    snapshot.requiredContextRefs.every((ref) =>
      snapshot.resources.some((resource) => resource.ref === ref)),
    true,
  );
  const projectedSpec = snapshot.authoritativeFacts.currentDeliverySpec as {
    spec: { handoff: Record<string, unknown> };
  };
  assert.equal('implementationGuidance' in projectedSpec.spec.handoff, false);
  assert.deepEqual(
    snapshot.activeObligations.recovery.map((item) => 'resolution' in (item as object)),
    [false],
  );
  assert.deepEqual(
    snapshot.activeObligations.recovery.map((item) => (item as { status: string }).status),
    ['pending_verification'],
  );
  assert.equal(
    snapshot.resources.find((resource) => resource.ref === `RECOVERY:${recovery.recovery_id}`)?.status,
    'pending_verification',
  );
});

test('prioritizes the latest forward feedback group while keeping old documents as historical execution context', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    addDocumentComment,
    createTask,
    getTaskContext,
    upsertDocument,
  } = await import('./tasks');
  const { buildAgentContextSnapshot } = await import('./agent-context');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Forward feedback context priority' });
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory, origin_type)
    VALUES(?, 1, 'Original delivery', 'story-001', 'original'),
          (?, 2, 'Keyboard-accessible empty state', 'story-002', 'feedback_behavior')
  `).run(taskId, taskId);
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in feedback', total_stories = 2,
        analysis_index = 1, dev_index = 1, test_index = 1
    WHERE task_id = ?
  `).run(taskId);
  const documentId = await upsertDocument({
    taskId,
    storyIndex: 1,
    kind: 'review_v1',
    title: 'Historical closure report',
    content: 'OLD-HISTORICAL-CONTENT: the first delivery only supported pointer input.',
    actor: 'review-agent',
  });
  const commentId = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    content: 'The empty-state action must also support keyboard input.',
    intent: 'change_request',
  });
  const firstBatchId = 'BATCH-context-priority-1';
  const secondBatchId = 'BATCH-context-priority-2';
  const firstGroupId = 'GROUP-context-priority-1';
  const secondGroupId = 'GROUP-context-priority-2';
  db.prepare(`
    INSERT INTO feedback_batches(batch_id, task_id, batch_number, status, summary)
    VALUES(?, ?, 1, 'completed', 'First attempt'),
          (?, ?, 2, 'executing', 'Current correction')
  `).run(firstBatchId, taskId, secondBatchId, taskId);
  db.prepare(`
    INSERT INTO feedback_groups(
      group_id, batch_id, group_order, group_key, work_type, status, title, reason,
      acceptance_json, affected_story_indexes_json
    ) VALUES
      (?, ?, 1, 'empty-state-v1', 'behavior_change', 'reopened',
       'First pointer-only attempt', 'This is no longer the active correction',
       '["Pointer input works"]', '[1]'),
      (?, ?, 1, 'empty-state-v2', 'behavior_change', 'executing',
       'Add keyboard input', 'The latest user feedback requires keyboard support',
       '["Keyboard input works"]', '[1]')
  `).run(firstGroupId, firstBatchId, secondGroupId, secondBatchId);
  db.prepare(`
    INSERT INTO feedback_group_comments(group_id, comment_id)
    VALUES(?, ?), (?, ?)
  `).run(firstGroupId, commentId, secondGroupId, commentId);
  db.prepare(`
    INSERT INTO feedback_group_delivery_units(group_id, task_id, story_index)
    VALUES(?, ?, 2), (?, ?, 2)
  `).run(firstGroupId, taskId, secondGroupId, taskId);
  db.prepare(`
    UPDATE document_comments
    SET feedback_status = 'in_progress', feedback_batch_id = ?,
        triage_reason = 'The latest user feedback requires keyboard support'
    WHERE comment_id = ?
  `).run(secondBatchId, commentId);

  const full = await getTaskContext(taskId);
  const snapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, {
      agent: 'analyst-agent',
      lane: 'analysis',
      pipeline: 'analysis',
      storyIndex: 2,
      description: 'Analyze the appended keyboard correction only.',
      agileStatus: 'in feedback',
      analysisIndex: 1,
      devIndex: 1,
      testIndex: 1,
      totalStories: 2,
    }),
    full,
    activeFeedback: [],
    activeRecovery: [],
    repositoryBaseCommit: 'feedback-base',
  });

  assert.equal(snapshot.authoritativeFacts.currentDeliveryUnit?.index, 2);
  assert.doesNotMatch(JSON.stringify(snapshot.authoritativeFacts), /OLD-HISTORICAL-CONTENT/);
  assert.equal(snapshot.activeObligations.feedback.length, 1);
  assert.deepEqual(snapshot.activeObligations.feedback[0], {
    commentId,
    documentId,
    documentRevision: 1,
    content: 'The empty-state action must also support keyboard input.',
    quotedText: null,
    intent: 'change_request',
    feedbackStatus: 'in_progress',
    batchId: secondBatchId,
    groupId: secondGroupId,
    groupKey: 'empty-state-v2',
    workType: 'behavior_change',
    groupStatus: 'executing',
    affectedDeliveryUnits: [1],
    appendedDeliveryUnits: [2],
    reason: 'The latest user feedback requires keyboard support',
    acceptance: ['Keyboard input works'],
    response: null,
    verification: null,
  });
  const feedbackResource = snapshot.resources.find((resource) => resource.ref === `FEEDBACK:${commentId}`);
  assert.equal(feedbackResource?.authority, 'active_obligation');
  const oldDocument = snapshot.resources.find((resource) => resource.ref === `DOC:${documentId}`);
  assert.equal(oldDocument?.authority, 'execution_evidence');
  assert.match(JSON.stringify(oldDocument?.content), /OLD-HISTORICAL-CONTENT/);
});
