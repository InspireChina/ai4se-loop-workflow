import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

test('migrates an existing verification assistance job and its attempts into Intervention', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY);
    CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY);
    CREATE TABLE runtime_input_requests(
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      source_execution_id TEXT,
      title TEXT NOT NULL
    );
    CREATE TABLE verification_assistance_jobs(
      job_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      story_index INTEGER,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      active_session_id TEXT,
      command_token_hash TEXT,
      status_viewed_session_id TEXT,
      current_execution_id TEXT,
      answer TEXT,
      last_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      escalated_at TEXT
    );
    CREATE TABLE verification_assistance_attempts(
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      execution_id TEXT NOT NULL UNIQUE,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      answer TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    INSERT INTO tasks(task_id) VALUES('REQ-upgrade');
    INSERT INTO execution_attempts(execution_id) VALUES('EXEC-upgrade');
    INSERT INTO runtime_input_requests(
      request_id, task_id, source_agent, source_execution_id, title
    ) VALUES('RIR-upgrade', 'REQ-upgrade', 'test-agent', 'EXEC-upgrade', 'Existing assistance');
    INSERT INTO verification_assistance_jobs(
      job_id, request_id, task_id, story_index, status, attempt_count,
      max_attempts, current_execution_id, last_reason, created_at, updated_at
    ) VALUES(
      'VA-upgrade', 'RIR-upgrade', 'REQ-upgrade', 1, 'pending', 1,
      3, NULL, 'first attempt deferred', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO verification_assistance_attempts(
      attempt_id, job_id, execution_id, attempt, status, reason, started_at, finished_at
    ) VALUES(
      'VAA-upgrade', 'VA-upgrade', 'EXEC-upgrade', 1, 'deferred',
      'first attempt deferred', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  `);

  db.exec(readFileSync(resolve(process.cwd(), 'migrations/113_work_items_and_interventions.sql'), 'utf8'));
  const intervention = db.prepare(`
    SELECT intervention_id, status, attempt_count, max_system_attempts,
           requested_by, source_execution_id, last_error
    FROM interventions WHERE dedupe_key = 'verification-assistance:RIR-upgrade'
  `).get() as Record<string, unknown>;
  assert.deepEqual(intervention, {
    intervention_id: 'INT-VA-upgrade',
    status: 'pending',
    attempt_count: 1,
    max_system_attempts: 3,
    requested_by: 'test-agent',
    source_execution_id: 'EXEC-upgrade',
    last_error: 'first attempt deferred',
  });
  assert.equal(
    (db.prepare(`
      SELECT intervention_id FROM verification_assistance_jobs WHERE job_id = 'VA-upgrade'
    `).get() as { intervention_id: string }).intervention_id,
    'INT-VA-upgrade',
  );
  assert.deepEqual(
    db.prepare(`
      SELECT intervention_id, execution_id, attempt, status, reason
      FROM intervention_attempts WHERE execution_id = 'EXEC-upgrade'
    `).get(),
    {
      intervention_id: 'INT-VA-upgrade',
      execution_id: 'EXEC-upgrade',
      attempt: 1,
      status: 'deferred',
      reason: 'first attempt deferred',
    },
  );
  db.close();
});

test('backfills legacy human questions and runtime inputs into Intervention without duplicating verification assistance', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY);
    CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY);
    CREATE TABLE runtime_input_requests(
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      story_index INTEGER,
      source_agent TEXT NOT NULL,
      source_execution_id TEXT,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      why TEXT,
      recommendation TEXT,
      answer TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE verification_assistance_jobs(
      job_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      story_index INTEGER,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      active_session_id TEXT,
      command_token_hash TEXT,
      status_viewed_session_id TEXT,
      current_execution_id TEXT,
      answer TEXT,
      last_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      escalated_at TEXT
    );
    CREATE TABLE verification_assistance_attempts(
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      execution_id TEXT NOT NULL UNIQUE,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      answer TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    INSERT INTO tasks(task_id) VALUES('REQ-human-upgrade');
  `);
  db.exec(readFileSync(resolve(process.cwd(), 'migrations/113_work_items_and_interventions.sql'), 'utf8'));
  db.exec(`
    CREATE TABLE questions(
      question_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      source_agent TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      answer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO questions(
      question_id, task_id, source_agent, title, status, answer, created_at, updated_at
    ) VALUES
      ('Q-pending', 'REQ-human-upgrade', 'analyst-agent', 'Pending decision', 'pending', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('Q-answered', 'REQ-human-upgrade', 'backlog-agent', 'Answered decision', 'answered', 'Keep scope', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('Q-conditional', 'REQ-human-upgrade', 'backlog-agent', 'Conditional decision', 'conditional', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('Q-superseded', 'REQ-human-upgrade', 'backlog-agent', 'Old decision', 'superseded', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO runtime_input_requests(
      request_id, task_id, story_index, source_agent, title, question, status, created_at, updated_at
    ) VALUES
      ('RI-human', 'REQ-human-upgrade', 1, 'dev-agent', 'Need a value', 'Which value?', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('RI-verification', 'REQ-human-upgrade', 1, 'test-agent', 'Need a preview', 'Which URL?', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO interventions(
      intervention_id, task_id, dedupe_key, status, resolver_strategy,
      authority, requested_by, summary, context_json, context_hash
    ) VALUES(
      'INT-existing-verification', 'REQ-human-upgrade', 'verification-assistance:RI-verification',
      'pending', 'system_then_human', 'standard', 'test-agent', 'Need a preview', '{}', 'existing-verification'
    );
    INSERT INTO verification_assistance_jobs(
      job_id, request_id, task_id, story_index, status, attempt_count,
      max_attempts, created_at, updated_at, intervention_id
    ) VALUES(
      'VA-existing', 'RI-verification', 'REQ-human-upgrade', 1, 'pending', 0,
      3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'INT-existing-verification'
    );
  `);

  db.exec(readFileSync(resolve(process.cwd(), 'migrations/116_human_input_interventions.sql'), 'utf8'));

  assert.deepEqual(db.prepare(`
    SELECT question.question_id, intervention.status, intervention.resolution
    FROM questions question
    JOIN interventions intervention ON intervention.intervention_id = question.intervention_id
    ORDER BY question.question_id
  `).all(), [
    { question_id: 'Q-answered', status: 'resolved', resolution: 'Keep scope' },
    { question_id: 'Q-conditional', status: 'pending', resolution: null },
    { question_id: 'Q-pending', status: 'awaiting_human', resolution: null },
    { question_id: 'Q-superseded', status: 'superseded', resolution: null },
  ]);
  assert.deepEqual(db.prepare(`
    SELECT request.request_id, request.intervention_id, intervention.resolver_strategy,
           intervention.status
    FROM runtime_input_requests request
    JOIN interventions intervention ON intervention.intervention_id = request.intervention_id
    ORDER BY request.request_id
  `).all(), [
    {
      request_id: 'RI-human',
      intervention_id: 'INT-RI-RI-human',
      resolver_strategy: 'human_only',
      status: 'awaiting_human',
    },
    {
      request_id: 'RI-verification',
      intervention_id: 'INT-existing-verification',
      resolver_strategy: 'system_then_human',
      status: 'pending',
    },
  ]);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM interventions
    WHERE dedupe_key = 'verification-assistance:RI-verification'
  `).get() as { count: number }).count, 1);
  db.close();
});

test('creates one immutable intervention per dedupe fingerprint and waits the linked work item', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { listWorkflowItems, syncLegacyDeliveryWorkItems } = await import('./work-items');
  const { listInterventions, openIntervention } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Intervention identity' });
  db.prepare(`
    UPDATE tasks SET agile_status = 'in plan', current_subagent = 'story-splitter-agent'
    WHERE task_id = ?
  `).run(taskId);
  await syncLegacyDeliveryWorkItems(taskId);
  const plan = (await listWorkflowItems(taskId)).find((item) => item.work_key === 'delivery:plan');
  assert.equal(plan?.status, 'ready');

  const input = {
    taskId,
    itemId: plan!.item_id,
    dedupeKey: 'same-state:contract-conflict',
    summary: 'The frozen contract cannot be satisfied by the assigned unit.',
    context: { contractRevision: 3, repositoryFingerprint: 'abc' },
    requestedBy: 'dev-agent',
    authority: 'arbitration' as const,
    resolverStrategy: 'human_only' as const,
  };
  const first = await openIntervention(input);
  const repeated = await openIntervention(input);
  assert.equal(repeated.intervention_id, first.intervention_id);
  assert.equal((await listInterventions(taskId)).length, 1);
  assert.equal((await listWorkflowItems(taskId)).find((item) => item.item_id === plan!.item_id)?.status, 'waiting');
  await assert.rejects(
    () => openIntervention({ ...input, summary: 'A different problem reused the same fingerprint.' }),
    /幂等键冲突/,
  );
});

test('gives system assistance exactly three durable attempts before human fallback', async () => {
  const { createTask } = await import('../test/legacy-task-fixtures');
  const {
    claimNextIntervention,
    finishInterventionAttempt,
    listInterventions,
    openIntervention,
  } = await import('./interventions');
  const taskId = await createTask({ title: 'Three intervention attempts' });
  const opened = await openIntervention({
    taskId,
    dedupeKey: 'three-attempts',
    summary: 'Try every safe automatic path before asking a person.',
    context: { frozen: true },
    requestedBy: 'test-agent',
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await claimNextIntervention({
      runId: `RUN-intervention-${attempt}`,
      executorId: 'codex',
      executionOptions: {},
    });
    assert.ok(claimed);
    assert.equal(claimed.interventionId, opened.intervention_id);
    assert.equal(claimed.attempt, attempt);
    assert.equal(claimed.maxAttempts, 3);
    assert.deepEqual(claimed.context, { frozen: true });
    const result = await finishInterventionAttempt({
      interventionId: opened.intervention_id,
      reason: `attempt ${attempt} could not safely resolve the issue`,
      outcome: attempt === 2 ? 'deferred' : 'failed',
    });
    assert.equal(result.escalated, attempt === 3);
  }

  const final = (await listInterventions(taskId))[0];
  assert.equal(final.status, 'awaiting_human');
  assert.equal(final.attempt_count, 3);
  assert.equal(final.last_error, 'attempt 3 could not safely resolve the issue');
  assert.equal(await claimNextIntervention({
    runId: 'RUN-intervention-exhausted',
    executorId: 'codex',
    executionOptions: {},
  }), null);
});

test('preserves stopped and paused Intervention attempts without consuming the three-attempt budget', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, getTask, pauseTask, resumeTask, cancelTask } = await import('../test/legacy-task-fixtures');
  const { cancelInterventionAttempt, claimNextIntervention, finishInterventionAttempt, openIntervention } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Interruptible system intervention' });
  const opened = await openIntervention({
    taskId,
    dedupeKey: 'interruptible-assistance',
    summary: 'Inspect a local dependency',
    requestedBy: 'system',
  });
  const claim = () => claimNextIntervention({ runId: 'RUN-interruptible', executorId: 'codex', executionOptions: {} });
  const first = await claim();
  assert.equal(first?.attempt, 1);
  assert.equal(first?.attemptSequence, 1);
  await cancelInterventionAttempt(opened.intervention_id, 'Manual Loop stop');

  const second = await claim();
  assert.equal(second?.attempt, 1);
  assert.equal(second?.attemptSequence, 2);
  await pauseTask({ taskId });
  assert.equal((db.prepare('SELECT status FROM interventions WHERE intervention_id = ?')
    .get(opened.intervention_id) as { status: string }).status, 'pending');
  await resumeTask({ taskId });

  for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
    const current = await claim();
    assert.equal(current?.attempt, expectedAttempt);
    assert.equal(current?.attemptSequence, expectedAttempt + 2);
    const finished = await finishInterventionAttempt({
      interventionId: opened.intervention_id,
      outcome: expectedAttempt === 2 ? 'failed' : 'deferred',
      reason: 'Completed safe checks but the dependency remained unavailable',
    });
    assert.equal(finished.escalated, expectedAttempt === 3);
  }
  assert.deepEqual(db.prepare(`
    SELECT attempt, status FROM intervention_attempts WHERE intervention_id = ? ORDER BY attempt
  `).all(opened.intervention_id), [
    { attempt: 1, status: 'cancelled' },
    { attempt: 2, status: 'cancelled' },
    { attempt: 3, status: 'deferred' },
    { attempt: 4, status: 'failed' },
    { attempt: 5, status: 'deferred' },
  ]);
  const detail = await getTask(taskId);
  assert.equal(detail?.interventions.find((item) => item.intervention_id === opened.intervention_id)?.system_attempt_count, 3);
  assert.equal(detail?.interventions.find((item) => item.intervention_id === opened.intervention_id)?.status, 'awaiting_human');
  await cancelTask({ taskId, reason: 'Withdraw the requirement' });
  assert.equal((db.prepare('SELECT status FROM interventions WHERE intervention_id = ?')
    .get(opened.intervention_id) as { status: string }).status, 'cancelled');
});

test('resolves an intervention atomically and returns its waiting item to readiness', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { listWorkflowItems, syncLegacyDeliveryWorkItems } = await import('./work-items');
  const {
    buildInterventionPrompt,
    claimNextIntervention,
    interventionStatus,
    openIntervention,
    runInterventionCommand,
  } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Resolved intervention' });
  db.prepare(`
    UPDATE tasks SET agile_status = 'in plan', current_subagent = 'story-splitter-agent'
    WHERE task_id = ?
  `).run(taskId);
  await syncLegacyDeliveryWorkItems(taskId);
  const plan = (await listWorkflowItems(taskId)).find((item) => item.work_key === 'delivery:plan')!;
  const opened = await openIntervention({
    taskId,
    itemId: plan.item_id,
    dedupeKey: 'resolved-by-system',
    summary: 'Resolve this intervention using the frozen evidence.',
    context: { evidence: 'receipt-1' },
    requestedBy: 'story-splitter-agent',
  });
  const claimed = await claimNextIntervention({
    runId: 'RUN-intervention-resolved',
    executorId: 'codex',
    executionOptions: {},
  });
  assert.equal(claimed?.interventionId, opened.intervention_id);
  assert.match(buildInterventionPrompt(claimed!), /必须先执行 intervention status/);
  await assert.rejects(
    () => runInterventionCommand({
      interventionId: opened.intervention_id,
      sessionId: claimed!.sessionId,
      token: claimed!.token,
      args: ['intervention', 'resolve', '--resolution', 'Premature resolution'],
    }),
    /请先执行 intervention status/,
  );
  const status = await runInterventionCommand({
    interventionId: opened.intervention_id,
    sessionId: claimed!.sessionId,
    token: claimed!.token,
    args: ['intervention', 'status'],
  });
  assert.match(status, /# INTERVENTION/);
  assert.match(status, /delivery:plan r1/);
  await runInterventionCommand({
    interventionId: opened.intervention_id,
    sessionId: claimed!.sessionId,
    token: claimed!.token,
    args: ['intervention', 'resolve', '--resolution', 'The existing evidence is sufficient and the work may resume.'],
  });
  const resolved = await interventionStatus(opened.intervention_id);
  assert.equal(resolved?.status, 'resolved');
  assert.equal(resolved?.resolved_by, 'system-assistance-agent');
  assert.equal((await listWorkflowItems(taskId)).find((item) => item.item_id === plan.item_id)?.status, 'ready');
  assert.equal(
    (db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(claimed!.executionId) as { status: string }).status,
    'applied',
  );
  assert.equal(
    (db.prepare('SELECT work_item_id FROM execution_attempts WHERE execution_id = ?').get(claimed!.executionId) as { work_item_id: string }).work_item_id,
    plan.item_id,
  );
});

for (const native of [false, true]) test(`new Agent faults cannot be claimed or completed by ordinary arbitration before Admin linkage (${native ? 'native' : 'legacy'})`, async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, getTask } = await import('../test/legacy-task-fixtures');
  const { listWorkflowItems, syncLegacyDeliveryWorkItems } = await import('./work-items');
  const {
    claimNextIntervention,
    openIntervention,
    runInterventionCommand,
  } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Arbitrated Test completion' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent', total_stories = 1,
        analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'Arbitrated unit', 'arbitrated-unit')
  `).run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 1, 'resolved', '{}', CURRENT_TIMESTAMP)
  `).run(`SPEC-${taskId}`, taskId);
  db.prepare(`
    UPDATE task_lanes SET status = 'completed', current_agent = NULL, current_story_index = NULL
    WHERE task_id = ? AND lane = 'analysis'
  `).run(taskId);
  db.prepare(`
    UPDATE task_lanes SET status = 'runnable', current_agent = NULL, current_story_index = NULL
    WHERE task_id = ? AND lane = 'delivery'
  `).run(taskId);
  await syncLegacyDeliveryWorkItems(taskId);
  if (native) {
    const { adoptNativeWorkflowInDb } = await import('./work-item-transitions');
    adoptNativeWorkflowInDb(db, taskId);
  }
  const testItem = (await listWorkflowItems(taskId)).find((item) => item.work_key === 'delivery:test:1')!;
  if (native) db.prepare(`UPDATE tasks SET analysis_index = 0, dev_index = 0, test_index = 0, total_stories = 99
    WHERE task_id = ?`).run(taskId);
  const opened = await openIntervention({
    taskId,
    itemId: testItem.item_id,
    dedupeKey: 'arbitrate-test-completion',
    summary: 'Frozen acceptance belongs to another unit; decide whether this Test step may advance.',
    context: { originalFailureExecutionId: 'EXEC-failed-test' },
    requestedBy: 'test-agent',
    authority: 'arbitration',
  });
  const claimed = await claimNextIntervention({
    runId: 'RUN-arbitration-complete',
    executorId: 'codex',
    executionOptions: {},
  });
  assert.equal(claimed, null);
  assert.equal(opened.source_kind, 'agent-fault');
  assert.equal(opened.repair_case_id, null, 'ownership begins before asynchronous linkage');
  assert.ok(db.prepare('SELECT 1 FROM repair_observation_outbox WHERE intervention_id=?').get(opened.intervention_id));
  const detail = await getTask(taskId);
  assert.equal(detail?.task.test_index, 0);
  const completed = (await listWorkflowItems(taskId)).find((item) => item.item_id === testItem.item_id);
  assert.equal(completed?.status, 'waiting');
  assert.equal(completed?.completion_reason, null);
  assert.equal(
    (db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(opened.intervention_id) as { status: string }).status,
    'pending',
  );
});

for (const native of [false, true]) test(`explicit human arbitration retains scoped rewind semantics without an automatic Agent claim (${native ? 'native' : 'legacy'})`, async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, getTask } = await import('../test/legacy-task-fixtures');
  const { listWorkflowItems, syncLegacyDeliveryWorkItems } = await import('./work-items');
  const { claimNextIntervention, openIntervention, runHumanArbitrationCommand } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Arbitrated specification rewind' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent', total_stories = 1,
        analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'Conflicting unit', 'conflicting-unit')
  `).run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 1, 'resolved', '{}', CURRENT_TIMESTAMP)
  `).run(`SPEC-${taskId}`, taskId);
  await syncLegacyDeliveryWorkItems(taskId);
  if (native) {
    const { adoptNativeWorkflowInDb } = await import('./work-item-transitions');
    adoptNativeWorkflowInDb(db, taskId);
  }
  const testItem = (await listWorkflowItems(taskId)).find((item) => item.work_key === 'delivery:test:1')!;
  const opened = await openIntervention({
    taskId,
    itemId: testItem.item_id,
    dedupeKey: 'arbitrate-spec-rewind',
    resolverStrategy: 'human_only',
    summary: 'The frozen unit boundary conflicts with the observable acceptance.',
    context: {},
    requestedBy: 'dev-agent',
    authority: 'arbitration',
  });
  const claimed = await claimNextIntervention({ runId: 'RUN-arbitration-rewind', executorId: 'codex', executionOptions: {} });
  assert.equal(claimed, null);
  const rewind = () => runHumanArbitrationCommand({
    taskId, interventionId: opened.intervention_id,
    args: ['intervention', 'task-rewind', '--to', 'analysis', '--reason', 'Rebuild the delivery-unit boundary from the frozen acceptance ownership.'],
  });
  if (!native) {
    await assert.rejects(rewind(), /仅适用于原生工作图/);
    assert.equal((await getTask(taskId))?.task.test_index, 0);
    return;
  }
  await rewind();
  const detail = await getTask(taskId);
  assert.equal(detail?.task.analysis_index, 0);
  assert.equal(detail?.task.dev_index, 0);
  assert.equal(detail?.task.test_index, 0);
  assert.equal(detail?.task.current_subagent, 'analyst-agent');
  assert.equal(
    (db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(opened.intervention_id) as { status: string }).status,
    'resolved',
  );
});

test('explicit human arbitration can rewind a non-Dev/Test native Work Item and continue at its new revision', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { adoptNativeWorkflowInDb } = await import('./work-item-transitions');
  const { claimNextIntervention, openIntervention, runHumanArbitrationCommand } = await import('./interventions');
  const { inspectTaskDispatchEnvelope } = await import('../test/dispatch-inspection-fixtures');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Business outcome arbitration', itemType: 'business-analysis' });
  db.prepare("UPDATE tasks SET current_subagent = 'spec-review-agent' WHERE task_id = ?").run(taskId);
  const items = adoptNativeWorkflowInDb(db, taskId);
  const source = items.find((item) => item.work_key === 'ba:review')!;
  const otherTaskId = await createTask({ title: 'Unrelated Direct', itemType: 'direct' });
  adoptNativeWorkflowInDb(db, otherTaskId);
  const opened = await openIntervention({ taskId, itemId: source.item_id, dedupeKey: 'generic-ba-rewind',
    resolverStrategy: 'human_only',
    summary: 'The review cannot reconcile the business outcome', requestedBy: 'spec-review-agent', authority: 'arbitration' });
  const claim = await claimNextIntervention({ runId: 'RUN-generic-BA', executorId: 'codex', executionOptions: {} });
  assert.equal(claim, null);
  const run = (args: string[]) => runHumanArbitrationCommand({ taskId, interventionId: opened.intervention_id, args });
  assert.match(await run(['intervention', 'status']), /ba:design/);
  await assert.rejects(run(['intervention', 'task-rewind', '--to', 'direct:execute', '--reason', 'Wrong task']), /当前需求/);
  await run(['intervention', 'task-rewind', '--to', 'ba:design', '--reason', 'Reconcile the observable business outcome']);
  const nodes = db.prepare('SELECT work_key, revision, status FROM workflow_items WHERE task_id = ? ORDER BY work_key, revision')
    .all(taskId) as { work_key: string; revision: number; status: string }[];
  assert.deepEqual(nodes.filter((item) => item.work_key === 'ba:intent').map((item) => [item.revision, item.status]), [[1, 'completed']]);
  assert.deepEqual(nodes.filter((item) => item.work_key === 'ba:design').map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'ready']]);
  assert.deepEqual(nodes.filter((item) => item.work_key === 'ba:review').map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'pending']]);
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'business-design-agent');
  assert.equal((db.prepare('SELECT current_subagent FROM tasks WHERE task_id = ?').get(taskId) as { current_subagent: string }).current_subagent, 'business-design-agent');
});

test('an interrupted explicit human arbitration replays its existing graph rewind instead of creating a third revision', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { adoptNativeWorkflowInDb, rewindWorkItemsInDb } = await import('./work-item-transitions');
  const { claimNextIntervention, openIntervention, runHumanArbitrationCommand } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Restarted arbitration', itemType: 'business-analysis' });
  db.prepare("UPDATE tasks SET current_subagent = 'spec-review-agent' WHERE task_id = ?").run(taskId);
  const nodes = adoptNativeWorkflowInDb(db, taskId);
  const opened = await openIntervention({ taskId, itemId: nodes.find((item) => item.work_key === 'ba:review')!.item_id,
    resolverStrategy: 'human_only',
    dedupeKey: 'recover-arbitration-decision', summary: 'Reconsider design', requestedBy: 'spec-review-agent', authority: 'arbitration' });
  const first = await claimNextIntervention({ runId: 'RUN-before-crash', executorId: 'codex', executionOptions: {} });
  assert.equal(first, null);
  const reason = 'Reconcile business outcome';
  rewindWorkItemsInDb(db, { taskId, targetItemId: nodes.find((item) => item.work_key === 'ba:design')!.item_id,
    eventKey: `intervention:${opened.intervention_id}:rewind`, actor: 'human', authority: 'arbitration',
    reason, preserveInterventionId: opened.intervention_id });
  const second = await claimNextIntervention({ runId: 'RUN-after-crash', executorId: 'codex', executionOptions: {} });
  assert.equal(second, null);
  const run = (args: string[]) => runHumanArbitrationCommand({ taskId, interventionId: opened.intervention_id, args });
  await run(['intervention', 'status']);
  await assert.rejects(run(['intervention', 'task-rewind', '--to', 'ba:intent', '--reason', reason]), /不能改写目标/);
  await assert.rejects(run(['intervention', 'task-rewind', '--to', 'ba:design', '--reason', 'Changed decision']), /幂等键冲突/);
  await run(['intervention', 'task-rewind', '--to', 'ba:design', '--reason', reason]);
  assert.equal((db.prepare("SELECT MAX(revision) AS revision FROM workflow_items WHERE task_id = ? AND work_key = 'ba:design'")
    .get(taskId) as { revision: number }).revision, 2);
});

test('explicit human arbitration plan reset atomically removes old units before replacement without consuming system attempts', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, addStory } = await import('../test/legacy-task-fixtures');
  const { adoptNativeWorkflowInDb } = await import('./work-item-transitions');
  const { claimNextIntervention, openIntervention, runHumanArbitrationCommand } = await import('./interventions');
  const { inspectTaskDispatchEnvelope } = await import('../test/dispatch-inspection-fixtures');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Arbitration replans units' });
  db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = 'test-agent', total_stories = 1,
    analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0 WHERE task_id = ?`).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Old unit', 'old-unit')").run(taskId);
  const nodes = adoptNativeWorkflowInDb(db, taskId);
  const opened = await openIntervention({ taskId, itemId: nodes.find((item) => item.work_key === 'delivery:test:1')!.item_id,
    resolverStrategy: 'human_only',
    dedupeKey: 'replan-units', summary: 'Unit boundary contradiction', requestedBy: 'test-agent', authority: 'arbitration' });
  const claim = await claimNextIntervention({ runId: 'RUN-replan-units', executorId: 'codex', executionOptions: {} });
  assert.equal(claim, null);
  const run = (args: string[]) => runHumanArbitrationCommand({ taskId, interventionId: opened.intervention_id, args });
  await run(['intervention', 'status']);
  const graphBeforeDecision = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  const storiesBeforeDecision = db.prepare('SELECT * FROM stories WHERE task_id = ?').all(taskId);
  db.exec(`CREATE TRIGGER reject_plan_arbitration_resolution BEFORE UPDATE OF status ON interventions
    WHEN NEW.intervention_id = '${opened.intervention_id}' AND NEW.status = 'resolved'
    BEGIN SELECT RAISE(ABORT, 'arbitration receipt rejected'); END`);
  try {
    await assert.rejects(run(['intervention', 'task-rewind', '--to', 'delivery:plan', '--reason', 'Reassign UI acceptance to a UI unit']),
      (error) => /arbitration receipt rejected/.test(String((error as { message: string }).message)));
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graphBeforeDecision);
    assert.deepEqual(db.prepare('SELECT * FROM stories WHERE task_id = ?').all(taskId), storiesBeforeDecision);
    assert.equal((db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(opened.intervention_id) as { status: string }).status, 'awaiting_human');
  } finally { db.exec('DROP TRIGGER reject_plan_arbitration_resolution'); }
  await run(['intervention', 'task-rewind', '--to', 'delivery:plan', '--reason', 'Reassign UI acceptance to a UI unit']);
  assert.equal((db.prepare("SELECT MAX(revision) AS revision FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:plan'").get(taskId) as { revision: number }).revision, 2);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ?
    AND work_key GLOB 'delivery:analysis:*' AND status NOT IN ('superseded', 'cancelled')`).get(taskId) as { count: number }).count, 0);
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'story-splitter-agent');
  await addStory({ taskId, title: 'Replacement UI unit', actor: 'human' });
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ?
    AND work_key = 'delivery:analysis:1' AND status NOT IN ('superseded', 'cancelled')`).get(taskId) as { count: number }).count, 1);
});
