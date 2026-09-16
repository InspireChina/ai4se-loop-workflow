import assert from 'node:assert/strict';
import test from 'node:test';

test('tries verification assistance three times before exposing it to a human', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, addRuntimeInputRequest, answerRuntimeInput, getTask, listTasks, submitRuntimeInputs } = await import('../test/legacy-task-fixtures');
  const {
    buildVerificationAssistancePrompt,
    claimNextVerificationAssistance,
    completeVerificationAssistanceExecution,
    runVerificationAssistanceCommand,
    verificationAssistanceJobStatus,
    VERIFICATION_ASSISTANCE_MIN_ATTEMPTS,
  } = await import('./verification-assistance');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'System-first verification assistance' });
  const requestId = await addRuntimeInputRequest({
    taskId,
    sourceAgent: 'test-agent',
    title: 'Need a reachable preview',
    question: 'Find a reachable preview URL and observe the primary flow.',
    why: 'The original test process did not find an active server.',
    recommendation: 'Inspect local scripts and start the documented preview command.',
  });

  let detail = await getTask(taskId);
  const queued = detail?.runtimeInputs.find((item) => item.request_id === requestId);
  assert.equal(queued?.assistance_status, 'pending');
  assert.equal(queued?.assistance_attempt_count, 0);
  assert.equal(queued?.assistance_max_attempts, VERIFICATION_ASSISTANCE_MIN_ATTEMPTS);
  assert.ok(queued?.intervention_id);
  await assert.rejects(
    () => answerRuntimeInput({ taskId, requestId, answer: 'Human should not pre-empt the automatic attempts.' }),
    /系统辅助 Agent 正在处理/,
  );
  const summary = (await listTasks()).find((task) => task.task_id === taskId)!;
  assert.equal(summary.verification_assistance_pending_count, 1);
  assert.equal(summary.verification_assistance_escalated_count, 0);

  for (let expectedAttempt = 1; expectedAttempt <= VERIFICATION_ASSISTANCE_MIN_ATTEMPTS; expectedAttempt += 1) {
    const claimed = await claimNextVerificationAssistance({
      runId: `run-assistance-${expectedAttempt}`,
      executorId: 'codex',
      executionOptions: { model: 'gpt-5.6-sol', reasoningEffort: 'high', webSearch: true },
    });
    assert.ok(claimed);
    assert.equal(claimed.attempt, expectedAttempt);
    assert.match(buildVerificationAssistancePrompt(claimed), /必须先执行 verification-assistance status/);
    assert.match(buildVerificationAssistancePrompt(claimed), new RegExp(`尝试：${expectedAttempt}/3`));
    const { getAgentCommandProgress } = await import('./agent-command-progress');
    const beforeStatus = await getAgentCommandProgress(taskId);
    const assistanceProgress = beforeStatus.find((item) => item.executionId === claimed.executionId);
    assert.equal(assistanceProgress?.agent, 'system-assistance-agent');
    assert.equal(assistanceProgress?.currentPhase, 'restore');
    assert.equal(assistanceProgress?.stateLabel, `系统辅助尝试 ${expectedAttempt}/3`);
    await runVerificationAssistanceCommand({
      jobId: claimed.jobId,
      sessionId: claimed.sessionId,
      token: claimed.token,
      args: ['verification-assistance', 'status'],
    });
    const afterStatus = await getAgentCommandProgress(taskId);
    assert.equal(afterStatus.find((item) => item.executionId === claimed.executionId)?.currentPhase, 'investigate');
    const output = await runVerificationAssistanceCommand({
      jobId: claimed.jobId,
      sessionId: claimed.sessionId,
      token: claimed.token,
      args: ['verification-assistance', 'defer', '--reason', `attempt ${expectedAttempt} exhausted safe local checks`],
    });
    await completeVerificationAssistanceExecution(claimed.executionId);
    assert.match(output, expectedAttempt === 3 ? /已转交人工/ : /下一次尝试/);
  }

  detail = await getTask(taskId);
  const escalated = detail?.runtimeInputs.find((item) => item.request_id === requestId);
  assert.equal(escalated?.assistance_status, 'escalated');
  assert.equal(escalated?.assistance_attempt_count, 3);
  assert.equal(escalated?.status, 'pending');
  assert.match(detail?.task.next_step || '', /等待人工验证协助/);
  assert.equal((await verificationAssistanceJobStatus(escalated!.assistance_job_id!))?.status, 'escalated');
  const escalatedSummary = (await listTasks()).find((task) => task.task_id === taskId)!;
  assert.equal(escalatedSummary.verification_assistance_escalated_count, 1);
  const mirrored = db.prepare(`
    SELECT intervention.status, intervention.attempt_count,
           (SELECT COUNT(*) FROM intervention_attempts attempt
            WHERE attempt.intervention_id = intervention.intervention_id) AS attempt_rows
    FROM interventions intervention
    WHERE intervention.dedupe_key = ?
  `).get(`verification-assistance:${requestId}`) as {
    status: string;
    attempt_count: number;
    attempt_rows: number;
  };
  assert.deepEqual(mirrored, { status: 'awaiting_human', attempt_count: 3, attempt_rows: 3 });
  assert.equal(queued?.intervention_id, (db.prepare(`
    SELECT intervention_id FROM verification_assistance_jobs WHERE request_id = ?
  `).get(requestId) as { intervention_id: string }).intervention_id);

  await answerRuntimeInput({ taskId, requestId, answer: 'Human supplied the unavailable device observation.' });
  assert.equal((db.prepare(`
    SELECT status FROM interventions WHERE intervention_id = ?
  `).get(queued!.intervention_id!) as { status: string }).status, 'resolved');
  assert.equal((db.prepare(`
    SELECT status FROM verification_assistance_jobs WHERE request_id = ?
  `).get(requestId) as { status: string }).status, 'resolved');
  await submitRuntimeInputs(taskId, 'delivery');
  detail = await getTask(taskId);
  assert.equal(detail?.runtimeInputs.find((item) => item.request_id === requestId)?.status, 'answered');
  assert.equal(detail?.lanes.find((lane) => lane.lane === 'delivery')?.status, 'runnable');
});

test('system assistance resolves a request and automatically resumes the verification lane', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, addRuntimeInputRequest, getTask } = await import('../test/legacy-task-fixtures');
  const {
    claimNextVerificationAssistance,
    completeVerificationAssistanceExecution,
    runVerificationAssistanceCommand,
  } = await import('./verification-assistance');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Automatic verification assistance resolution' });
  const requestId = await addRuntimeInputRequest({
    taskId,
    sourceAgent: 'test-agent',
    title: 'Locate test fixture',
    question: 'Which fixture can exercise the validation scenario?',
  });
  const claimed = await claimNextVerificationAssistance({
    runId: 'run-assistance-resolved',
    executorId: 'claude',
    executionOptions: {},
  });
  assert.ok(claimed);
  await assert.rejects(
    () => runVerificationAssistanceCommand({
      jobId: claimed.jobId,
      sessionId: claimed.sessionId,
      token: claimed.token,
      args: ['verification-assistance', 'resolve', '--answer', 'Use fixture B.'],
    }),
    /尚未查看验证协助状态/,
  );
  await runVerificationAssistanceCommand({
    jobId: claimed.jobId,
    sessionId: claimed.sessionId,
    token: claimed.token,
    args: ['verification-assistance', 'status'],
  });
  await runVerificationAssistanceCommand({
    jobId: claimed.jobId,
    sessionId: claimed.sessionId,
    token: claimed.token,
    args: ['verification-assistance', 'resolve', '--answer', 'Use fixture B; command `npm test -- fixture-b` passed and produced the required observation.'],
  });
  await completeVerificationAssistanceExecution(claimed.executionId);

  const detail = await getTask(taskId);
  const request = detail?.runtimeInputs.find((item) => item.request_id === requestId);
  assert.equal(request?.status, 'answered');
  assert.equal(request?.assistance_status, 'resolved');
  assert.match(request?.answer || '', /fixture B/);
  const lane = detail?.lanes.find((item) => item.lane === 'delivery');
  assert.equal(lane?.status, 'runnable');
  assert.equal(lane?.resume_pending, 1);
  assert.match(detail?.task.next_step || '', /交回 test-agent/);
  assert.ok(detail?.events.some((event) => event.event_type === 'VerificationAssistanceResolved'));
  assert.ok(detail?.events.some((event) => event.event_type === 'RuntimeInputsSubmitted' && event.actor === 'system'));
  const mirrored = db.prepare(`
    SELECT status, resolution, resolved_by FROM interventions WHERE dedupe_key = ?
  `).get(`verification-assistance:${requestId}`) as {
    status: string;
    resolution: string;
    resolved_by: string;
  };
  assert.equal(mirrored.status, 'resolved');
  assert.match(mirrored.resolution, /fixture B/);
  assert.equal(mirrored.resolved_by, 'system-assistance-agent');
});

test('runs verification assistance through the generic Intervention protocol and keeps legacy attempts read-only', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { addRuntimeInputRequest, createTask, getTask } = await import('../test/legacy-task-fixtures');
  const { buildInterventionPrompt, claimNextIntervention, runInterventionCommand } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Generic verification intervention' });
  const requestId = await addRuntimeInputRequest({
    taskId,
    sourceAgent: 'test-agent',
    title: 'Find the preview entry',
    question: 'Start the documented preview and report its reachable URL.',
  });
  const claimed = await claimNextIntervention({ runId: 'RUN-generic-verification', executorId: 'codex', executionOptions: {} });
  assert.equal(claimed?.taskId, taskId);
  assert.equal(claimed?.context.verificationRequestId, requestId);
  assert.match(buildInterventionPrompt(claimed!), /不得修改产品代码/);
  assert.equal((db.prepare('SELECT pipeline FROM execution_attempts WHERE execution_id = ?')
    .get(claimed!.executionId) as { pipeline: string }).pipeline, 'intervention');
  await runInterventionCommand({
    interventionId: claimed!.interventionId,
    sessionId: claimed!.sessionId,
    token: claimed!.token,
    args: ['intervention', 'status'],
  });
  await runInterventionCommand({
    interventionId: claimed!.interventionId,
    sessionId: claimed!.sessionId,
    token: claimed!.token,
    args: ['intervention', 'resolve', '--resolution', 'Started the documented preview; the primary page is reachable at http://localhost:4173. Logs: .tmp/preview.log.'],
  });
  const detail = await getTask(taskId);
  const request = detail?.runtimeInputs.find((item) => item.request_id === requestId);
  assert.equal(request?.status, 'answered');
  assert.equal(request?.intervention_status, 'resolved');
  assert.equal(request?.intervention_resolved_by, 'system-assistance-agent');
  assert.equal(detail?.lanes.find((lane) => lane.lane === 'delivery')?.status, 'runnable');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM verification_assistance_attempts legacy
    JOIN verification_assistance_jobs job ON job.job_id = legacy.job_id
    WHERE job.request_id = ?
  `).get(requestId) as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?')
    .get(claimed!.executionId) as { status: string }).status, 'applied');
});

test('system verification assistance shares the configured global Agent concurrency', async () => {
  const { createTask, addRuntimeInputRequest } = await import('../test/legacy-task-fixtures');
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    claimNextVerificationAssistance,
    completeVerificationAssistanceExecution,
    runVerificationAssistanceCommand,
  } = await import('./verification-assistance');
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO project_settings(setting_key, setting_value)
    VALUES('agent_concurrency', '1')
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = '1'
  `).run();
  const blockerTaskId = await createTask({ title: 'Global slot owner' });
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('execution-global-slot-owner', 'run-global-slot-owner', ?, 'backlog-agent', 'backlog',
      'global-slot-owner', 1, 'running', 'hash', '{}')
  `).run(blockerTaskId);
  const taskId = await createTask({ title: 'Assistance waits for global slot' });
  await addRuntimeInputRequest({
    taskId,
    sourceAgent: 'test-agent',
    title: 'Queued behind global concurrency',
    question: 'Inspect the local validation environment.',
  });
  assert.equal(await claimNextVerificationAssistance({
    runId: 'run-assistance-no-slot',
    executorId: 'codex',
    executionOptions: {},
  }), null);

  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = 'execution-global-slot-owner'").run();
  const claimed = await claimNextVerificationAssistance({
    runId: 'run-assistance-has-slot',
    executorId: 'codex',
    executionOptions: {},
  });
  assert.ok(claimed);
  await runVerificationAssistanceCommand({
    jobId: claimed.jobId,
    sessionId: claimed.sessionId,
    token: claimed.token,
    args: ['verification-assistance', 'status'],
  });
  await runVerificationAssistanceCommand({
    jobId: claimed.jobId,
    sessionId: claimed.sessionId,
    token: claimed.token,
    args: ['verification-assistance', 'defer', '--reason', 'No safe local path was available.'],
  });
  await completeVerificationAssistanceExecution(claimed.executionId);
  db.prepare(`
    INSERT INTO project_settings(setting_key, setting_value)
    VALUES('agent_concurrency', '4')
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = '4'
  `).run();
});

test('uses Intervention as the verification assistance queue and attempt source of truth', async () => {
  const { createTask, addRuntimeInputRequest, getTask } = await import('../test/legacy-task-fixtures');
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    claimNextVerificationAssistance,
    completeVerificationAssistanceExecution,
    runVerificationAssistanceCommand,
  } = await import('./verification-assistance');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Intervention-owned assistance queue' });
  const requestId = await addRuntimeInputRequest({
    taskId,
    sourceAgent: 'test-agent',
    title: 'Use the generic intervention queue',
    question: 'Can the local fixture provide the missing evidence?',
  });
  const detail = await getTask(taskId);
  const jobId = detail?.runtimeInputs.find((item) => item.request_id === requestId)?.assistance_job_id;
  assert.ok(jobId);
  const interventionId = (db.prepare(`
    SELECT intervention_id FROM verification_assistance_jobs WHERE job_id = ?
  `).get(jobId) as { intervention_id: string }).intervention_id;
  db.prepare(`
    UPDATE interventions SET status = 'cancelled'
    WHERE status = 'pending' AND intervention_id != ?
  `).run(interventionId);
  db.prepare(`
    UPDATE verification_assistance_jobs
    SET status = 'escalated', attempt_count = 99, max_attempts = 99
    WHERE job_id = ?
  `).run(jobId);

  const claimed = await claimNextVerificationAssistance({
    runId: 'RUN-intervention-authority',
    executorId: 'codex',
    executionOptions: {},
  });
  assert.equal(claimed?.jobId, jobId);
  assert.equal(claimed?.attempt, 1);
  assert.equal(claimed?.maxAttempts, 3);
  assert.deepEqual(
    db.prepare(`SELECT status, attempt_count, max_attempts FROM verification_assistance_jobs WHERE job_id = ?`).get(jobId),
    { status: 'running', attempt_count: 1, max_attempts: 3 },
  );
  await runVerificationAssistanceCommand({
    jobId: claimed!.jobId,
    sessionId: claimed!.sessionId,
    token: claimed!.token,
    args: ['verification-assistance', 'status'],
  });
  await runVerificationAssistanceCommand({
    jobId: claimed!.jobId,
    sessionId: claimed!.sessionId,
    token: claimed!.token,
    args: ['verification-assistance', 'defer', '--reason', 'The fixture is not available in this attempt.'],
  });
  await completeVerificationAssistanceExecution(claimed!.executionId);
});
