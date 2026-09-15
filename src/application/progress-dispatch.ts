import { randomUUID } from 'node:crypto';
import { resourcesForAgent, resourcesRequiringClaims, type ResourceKey } from '../domain/resource';
import { databaseConnection, hash } from '../infrastructure/database';
import { acquireResourceClaimsInDb, releaseResourceClaimInDb, resourceClaimInDb } from './resource-claims';
import { releaseExecutionResourceClaimsInDb } from './resource-claims';
import { laneForAgent, markTaskLaneRunningInDb, settleTaskLaneInDb, setTaskLaneStateInDb, type TaskLaneKind } from './task-lanes';
import { inspectDispatchInDb, planDispatchInDb } from './dispatch-planner';
import type { DelegationEnvelope, Task } from './tasks';
import {
  EXECUTION_FAILURE_MAX_RETRIES,
  recordExecutionFailureActivityInDb,
  settleNativeExecutionFailureInDb,
  type ExecutionAttempt,
} from './executions';
import { retryNotBeforeForFailure } from './execution-retry-policy';
import { requirementDependencyGateOpenInDb } from './task-dependencies';
import { isActiveProjectOverlayCandidateInDb } from './agent-profiles';
import type { WorkflowItemRow } from './work-items';
import { agentCommandProfile } from '../domain/agent-command-profile';
import { reconcileNativeWorkItemExecutionsInDb, transitionWorkItemInDb } from './work-item-transitions';
import { workflowEndedInDb, workflowBlockedInDb, nativeTaskHoldInDb, workflowResultHeldInDb } from './work-item-controls';
import { restoreExecutionDelegationInDb } from './execution-delegation';
import { openInterventionInDb } from './interventions';

export type DispatchWaitReason =
  | 'active-execution'
  | 'pending-result'
  | 'resources-busy'
  | 'paused-only'
  | 'waiting-for-input'
  | 'system-blocked'
  | 'dependencies-pending'
  | 'lower-priority'
  | 'no-runnable-work'
  | 'migration-required';

export type DispatchWakeInstruction =
  | { kind: 'execution-completion' }
  | { kind: 'retry-after'; notBefore: string }
  | { kind: 'external-change' };

export type ReservedExecution = {
  reservationId: string;
  executionId: string;
  runId: string;
  attempt: number;
  work: DelegationEnvelope;
  claimedResources: readonly ResourceKey[];
};

export type RecoverableExecution = {
  attempt: ExecutionAttempt;
  work: DelegationEnvelope;
};

export type ReserveNextResult =
  | { kind: 'reserved'; reservations: readonly ReservedExecution[] }
  | { kind: 'wait'; reason: DispatchWaitReason; wake: DispatchWakeInstruction }
  | { kind: 'run-stopped' };

export type DispatchDecision = {
  lane: TaskLaneKind | 'control';
  state: 'selected' | 'active' | 'waiting' | 'completed';
  reason?: DispatchWaitReason;
  executionId?: string;
  reservationId?: string;
  workItemId?: string;
  work?: DelegationEnvelope;
};

export type DispatchExplanation = {
  requirementId: string;
  decisions: DispatchDecision[];
};

export type PreparedExecution = {
  prompt: string;
  contextSnapshot: unknown;
  recovery: { mode: string; label: string; retryNumber: number };
  baseCommit?: string | null;
  promptMetadata: { version: number; templateVersion: number; hash: string };
  memory: { revision: number; hash: string };
  evolutionCandidateId?: string | null;
  runtime: {
    executorId: string;
    model?: string;
    reasoningEffort?: string;
    webSearchEnabled: boolean;
  };
};

export type ActivateResult =
  | { kind: 'running'; attempt: ExecutionAttempt }
  | { kind: 'invalidated'; reason: 'run-stopped' | 'requirement-paused' | 'requirement-terminal' | 'superseded' | 'canary-deferred' };

type InvalidationReason = Extract<ActivateResult, { kind: 'invalidated' }>['reason'];

type StoredReservation = ReservedExecution & {
  generationKey: string;
  resourceAcquisitions: Record<ResourceKey, 'acquired' | 'inherited'>;
};

function releaseAcquiredReservationClaims(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  reservation: StoredReservation,
) {
  for (const [resourceKey, acquisition] of Object.entries(reservation.resourceAcquisitions) as [ResourceKey, 'acquired' | 'inherited'][]) {
    const current = resourceClaimInDb(db, resourceKey, reservation.work.taskId);
    if (acquisition === 'acquired' && current?.owner_execution_id === reservation.executionId) {
      releaseResourceClaimInDb(db, resourceKey, reservation.work.taskId);
    }
  }
}

function dispatchGenerationKey(work: DelegationEnvelope) {
  if (work.workItemId) return hash(JSON.stringify({ itemId: work.workItemId, epoch: work.workItemEpoch || 1 }));
  return hash(JSON.stringify({
    taskId: work.taskId,
    lane: work.lane,
    agent: work.agent,
    pipeline: work.pipeline,
    storyIndex: work.storyIndex,
    feedbackId: work.feedbackId || null,
    feedbackIds: work.feedbackIds || [],
    feedbackBatchId: work.feedbackBatchId || null,
    feedbackGroupId: work.feedbackGroupId || null,
    analysisIndex: work.analysisIndex,
    devIndex: work.devIndex,
    testIndex: work.testIndex,
    specResolvedIndex: work.specResolvedIndex,
    reviewRevision: work.reviewRevision,
    resumePending: work.resumePending,
    ...(work.retryCycle && work.retryCycle > 1 ? { retryCycle: work.retryCycle } : {}),
  }));
}

function waitResult(db: Awaited<ReturnType<typeof databaseConnection>>): ReserveNextResult {
  const active = db.prepare(`
    SELECT 1 FROM execution_attempts
    WHERE status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
    LIMIT 1
  `).get();
  if (active) {
    return { kind: 'wait', reason: 'active-execution', wake: { kind: 'execution-completion' } };
  }
  const pending = db.prepare("SELECT 1 FROM agent_results WHERE application_status = 'pending' LIMIT 1").get();
  if (pending) {
    return { kind: 'wait', reason: 'pending-result', wake: { kind: 'execution-completion' } };
  }
  return { kind: 'wait', reason: 'no-runnable-work', wake: { kind: 'external-change' } };
}

type DispatchPlanner = typeof planDispatchInDb;
type WorkBinding = (db: Awaited<ReturnType<typeof databaseConnection>>, work: DelegationEnvelope) => WorkflowItemRow | undefined;

function nativeWorkBinding(db: Awaited<ReturnType<typeof databaseConnection>>, work: DelegationEnvelope): WorkflowItemRow {
  const item = db.prepare(`SELECT item.* FROM workflow_items item JOIN tasks task ON task.task_id = item.task_id
    WHERE item.item_id = ? AND item.task_id = ? AND item.origin = 'native' AND task.workflow_engine = 'native'`)
    .get(work.workItemId || null, work.taskId) as WorkflowItemRow | undefined;
  if (!item || item.revision !== work.workItemRevision || item.dispatch_epoch !== work.workItemEpoch
    || item.agent !== work.agent || item.story_index !== work.storyIndex
    || (item.pipeline !== work.pipeline && !(work.pipeline === 'resume' && agentCommandProfile(work.agent, 'resume')))) {
    throw new Error(`需求 ${work.taskId} 的工作项派发快照缺失或不一致，不得从旧游标重建`);
  }
  return item;
}

async function reserveNext(input: { runId: string }, planner: DispatchPlanner = planDispatchInDb, bindWork: WorkBinding = nativeWorkBinding): Promise<ReserveNextResult> {
  const db = await databaseConnection();
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare('SELECT status FROM loop_runs WHERE run_id = ?').get(input.runId) as { status: string } | undefined;
    if (!run || !['starting', 'running'].includes(run.status)) {
      db.exec('ROLLBACK');
      return { kind: 'run-stopped' };
    }

    const workItems = planner(db);
    if (!workItems.length) {
      const result = waitResult(db);
      db.exec('COMMIT');
      return result;
    }

    const reservations: ReservedExecution[] = [];
    let earliestRetryNotBefore: string | null = null;
    for (const work of workItems) {
      const workItem = bindWork(db, work);
      const executionId = randomUUID();
      const reservationId = executionId;
      const generationKey = dispatchGenerationKey(work);
      const retryWindow = db.prepare(`
        SELECT retry_not_before
        FROM execution_attempts
        WHERE dispatch_generation_key = ? AND status = 'retryable_failed' AND retry_not_before IS NOT NULL
        ORDER BY attempt DESC LIMIT 1
      `).get(generationKey) as { retry_not_before: string } | undefined;
      if (retryWindow && Date.parse(retryWindow.retry_not_before) > Date.now()) {
        if (!earliestRetryNotBefore || retryWindow.retry_not_before < earliestRetryNotBefore) {
          earliestRetryNotBefore = retryWindow.retry_not_before;
        }
        continue;
      }
      const previous = db.prepare(`
        SELECT ${workItem?.origin === 'native' ? 'COUNT(*)' : 'MAX(attempt)'} AS attempt
        FROM execution_attempts
        WHERE dispatch_generation_key = ? AND dispatch_retry_consumed = 1 AND status != 'cancelled'
          ${workItem?.origin === 'native' ? "AND status IN ('retryable_failed', 'system_blocked')" : ''}
      `).get(generationKey) as { attempt: number | null };
      const attempt = (previous.attempt || 0) + 1;
      const workItemAttempt = workItem
        ? ((db.prepare(`
          SELECT COALESCE(MAX(work_item_attempt), 0) AS attempt
          FROM execution_attempts WHERE work_item_id = ?
        `).get(workItem.item_id) as { attempt: number }).attempt + 1)
        : null;
      const claimedResources = resourcesRequiringClaims(work.resources);
      const resourceAcquisitions = Object.fromEntries(claimedResources.map((resourceKey) => {
        const claim = resourceClaimInDb(db, resourceKey, work.taskId);
        return [resourceKey, claim?.owner_task_id === work.taskId ? 'inherited' : 'acquired'];
      })) as Record<ResourceKey, 'acquired' | 'inherited'>;
      const reservation: StoredReservation = {
        reservationId,
        executionId,
        runId: input.runId,
        attempt,
        work,
        claimedResources,
        generationKey,
        resourceAcquisitions,
      };
      const reservationJson = JSON.stringify(reservation);
      const reservationHash = hash(reservationJson);
      db.prepare(`
        INSERT INTO execution_attempts(
          execution_id, work_item_id, work_item_attempt, run_id, task_id, story_index, agent, pipeline, lane,
          delegation_key, dispatch_generation_key, attempt, status,
          input_hash, input_json, dispatch_reservation_json, dispatch_retry_consumed, heartbeat_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, 0, CURRENT_TIMESTAMP)
      `).run(
        executionId,
        workItem?.item_id || null,
        workItemAttempt,
        input.runId,
        work.taskId,
        work.storyIndex,
        work.agent,
        work.pipeline,
        work.lane,
        `dispatch:${generationKey}:${executionId}`,
        generationKey,
        attempt,
        reservationHash,
        reservationJson,
        reservationJson,
      );
      acquireResourceClaimsInDb(db, {
        resourceKeys: claimedResources,
        taskId: work.taskId,
        lane: work.lane,
        storyIndex: work.storyIndex,
        executionId,
      });
      if (workItem?.origin === 'native') {
        if (work.workItemId !== workItem.item_id || work.workItemRevision !== workItem.revision
          || work.workItemEpoch !== workItem.dispatch_epoch) throw new Error('工作项派发快照已失效');
        transitionWorkItemInDb(db, { itemId: workItem.item_id, action: 'start', eventKey: `reserve:${executionId}`,
          actor: 'system', authority: 'system', executionId, reason: '已保留并绑定 Agent 执行' });
      }
      if (work.lane !== 'control' && workItem?.origin !== 'native') {
        markTaskLaneRunningInDb(db, {
          taskId: work.taskId,
          lane: work.lane,
          agent: work.agent,
          storyIndex: work.storyIndex,
        });
      }
      reservations.push({ reservationId, executionId, runId: input.runId, attempt, work, claimedResources });
    }
    db.exec('COMMIT');
    if (!reservations.length && earliestRetryNotBefore) {
      return { kind: 'wait', reason: 'no-runnable-work', wake: { kind: 'retry-after', notBefore: earliestRetryNotBefore } };
    }
    return { kind: 'reserved', reservations };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

type UnadoptedInspection = (db: Awaited<ReturnType<typeof databaseConnection>>, requirementId: string, active: DispatchDecision[]) => DispatchExplanation;

async function inspect(input: { requirementId: string }, planner: DispatchPlanner = inspectDispatchInDb, unadoptedInspection?: UnadoptedInspection): Promise<DispatchExplanation> {
  const db = await databaseConnection();
  const active = db.prepare(`
    SELECT execution_id, lane, agent, work_item_id, dispatch_reservation_json,
      (SELECT origin FROM workflow_items WHERE item_id = execution_attempts.work_item_id) AS work_item_origin
    FROM execution_attempts
    WHERE task_id = ?
      AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
    ORDER BY created_at, execution_id
  `).all(input.requirementId) as {
    execution_id: string;
    lane: string | null;
    agent: string;
    work_item_id: string | null;
    work_item_origin: string | null;
    dispatch_reservation_json: string | null;
  }[];
  const decisions: DispatchDecision[] = active.map((row) => {
    const reservation = row.dispatch_reservation_json
      ? JSON.parse(row.dispatch_reservation_json) as StoredReservation
      : undefined;
    return {
      lane: reservation?.work.lane || (row.lane as TaskLaneKind | 'control' | null) || laneForAgent(row.agent),
      state: 'active',
      reason: 'active-execution',
      executionId: row.execution_id,
      reservationId: reservation?.reservationId || row.execution_id,
      ...(row.work_item_origin === 'native' && row.work_item_id ? { workItemId: row.work_item_id } : {}),
    };
  });
  const task = db.prepare('SELECT workflow_engine, is_paused FROM tasks WHERE task_id = ?').get(input.requirementId) as
    { workflow_engine: string; is_paused: number } | undefined;
  if (!task) return { requirementId: input.requirementId, decisions: [] };
  if (task.workflow_engine !== 'native') {
    if (unadoptedInspection) return unadoptedInspection(db, input.requirementId, decisions);
    return { requirementId: input.requirementId,
      decisions: [...decisions, { lane: 'control', state: 'waiting', reason: 'migration-required' }] };
  }
  if (workflowEndedInDb(db, input.requirementId)) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'completed' }] };
  }
  if (task.is_paused) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'waiting', reason: 'paused-only' }] };
  }
  if (workflowBlockedInDb(db, input.requirementId)) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'waiting', reason: 'system-blocked' }] };
  }
  if (!requirementDependencyGateOpenInDb(db, input.requirementId)) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'waiting', reason: 'dependencies-pending' }] };
  }
  let selected: DelegationEnvelope[] = [];
  const legacyFixture = planner !== inspectDispatchInDb;
  if (legacyFixture) db.exec('SAVEPOINT dispatch_inspect');
  try {
    selected = planner(db).filter((work) => work.taskId === input.requirementId);
  } finally {
    if (legacyFixture) {
      db.exec('ROLLBACK TO dispatch_inspect');
      db.exec('RELEASE dispatch_inspect');
    }
  }
  for (const work of selected) {
    decisions.push({ lane: work.lane, state: 'selected', work, workItemId: work.workItemId });
  }
  const covered = new Set(decisions.map(decision => decision.workItemId));
  const items = db.prepare(`SELECT item_id, lane, agent, status FROM workflow_items WHERE task_id = ?
    AND origin = 'native' AND status NOT IN ('cancelled', 'superseded') AND agent IS NOT NULL
    ORDER BY created_at, item_id`).all(input.requirementId) as {
    item_id: string; lane: TaskLaneKind | 'control'; agent: string; status: string;
  }[];
  for (const item of items) {
    if (covered.has(item.item_id)) continue;
    const source = db.prepare(`SELECT status FROM execution_attempts WHERE work_item_id = ? AND pipeline != 'intervention'
      ORDER BY work_item_attempt DESC, rowid DESC LIMIT 1`).get(item.item_id) as { status: string } | undefined;
    const pending = db.prepare(`SELECT 1 FROM agent_results result JOIN execution_attempts execution
      ON execution.execution_id = result.execution_id WHERE execution.work_item_id = ?
        AND execution.status != 'cancelled' AND result.application_status = 'pending' LIMIT 1`).get(item.item_id);
    const resourceBusy = resourcesRequiringClaims(resourcesForAgent(item.agent)).some(key => {
      const claim = resourceClaimInDb(db, key, input.requirementId);
      return claim && (claim.owner_task_id !== input.requirementId || Boolean(claim.owner_execution_id
        && db.prepare(`SELECT 1 FROM execution_attempts WHERE execution_id = ?
          AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')`).get(claim.owner_execution_id)));
    });
    decisions.push({ lane: item.lane, workItemId: item.item_id,
      state: item.status === 'completed' ? 'completed' : 'waiting',
      ...(item.status !== 'completed' ? { reason: pending ? 'pending-result' as const
        : source?.status === 'system_blocked' ? 'system-blocked' as const
          : item.status === 'waiting' ? 'waiting-for-input' as const
            : item.status === 'ready' ? resourceBusy ? 'resources-busy' as const : 'lower-priority' as const
              : 'no-runnable-work' as const } : {}) });
  }
  return { requirementId: input.requirementId, decisions };
}

async function inspectAll(planner: DispatchPlanner = inspectDispatchInDb) {
  const db = await databaseConnection();
  let selected: DelegationEnvelope[] = [];
  const legacyFixture = planner !== inspectDispatchInDb;
  if (legacyFixture) db.exec('SAVEPOINT dispatch_inspect_all');
  try {
    selected = planner(db);
  } finally {
    if (legacyFixture) {
      db.exec('ROLLBACK TO dispatch_inspect_all');
      db.exec('RELEASE dispatch_inspect_all');
    }
  }
  return selected.map((work) => ({
    requirementId: work.taskId,
    lane: work.lane,
    state: 'selected' as const,
    work,
  }));
}

async function activate(input: { reservationId: string; prepared: PreparedExecution }): Promise<ActivateResult> {
  const db = await databaseConnection();
  return db.transaction(() => {
    const attempt = db.prepare(`
      SELECT execution_attempts.*, tasks.workflow_engine AS task_workflow_engine, tasks.is_paused AS task_is_paused,
             tasks.project_id AS task_project_id, loop_runs.status AS run_status
      FROM execution_attempts
      JOIN tasks ON tasks.task_id = execution_attempts.task_id
      LEFT JOIN loop_runs ON loop_runs.run_id = execution_attempts.run_id
      WHERE execution_attempts.execution_id = ?
        AND execution_attempts.dispatch_reservation_json IS NOT NULL
    `).get(input.reservationId) as (ExecutionAttempt & {
      dispatch_reservation_json: string;
      task_workflow_engine: string;
      task_is_paused: number;
      task_project_id: string;
      run_status: string | null;
    }) | undefined;
    if (!attempt) return { kind: 'invalidated', reason: 'superseded' } as const;
    let reservation: StoredReservation | undefined;
    try {
      const parsed = JSON.parse(attempt.dispatch_reservation_json) as StoredReservation | null;
      if (parsed?.work && parsed.executionId === attempt.execution_id && parsed.reservationId === input.reservationId
        && parsed.work.taskId === attempt.task_id && parsed.resourceAcquisitions) reservation = parsed;
    } catch { /* A damaged planned snapshot is cancelled below, not reconstructed. */ }
    if (attempt.status !== 'planned') {
      if (attempt.status === 'running') return { kind: 'running', attempt } as const;
      if (!['output_received', 'verifying', 'applying'].includes(attempt.status)) {
        if (reservation) releaseAcquiredReservationClaims(db, reservation);
      }
      return { kind: 'invalidated', reason: 'superseded' } as const;
    }

    const invalidate = (reason: InvalidationReason, detail?: string) => {
      db.prepare(`
        UPDATE execution_attempts
        SET status = 'cancelled', last_error = ?, finished_at = CURRENT_TIMESTAMP,
            heartbeat_at = CURRENT_TIMESTAMP, dispatch_settled_at = CURRENT_TIMESTAMP
        WHERE execution_id = ?
      `).run(detail ? `执行 ${attempt.execution_id}：${detail}` : reason, attempt.execution_id);
      releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
      if (attempt.task_workflow_engine === 'native') {
        // A damaged snapshot cannot nominate another execution's claims for
        // cleanup. Include the task-scoped code slot owned by this source.
        db.prepare('DELETE FROM resource_claims WHERE owner_execution_id = ?').run(attempt.execution_id);
      } else if (reservation) releaseAcquiredReservationClaims(db, reservation);
      reconcileNativeWorkItemExecutionsInDb(db, attempt.task_id);
      if (attempt.task_workflow_engine === 'native' && !attempt.task_is_paused
        && !workflowEndedInDb(db, attempt.task_id) && !nativeTaskHoldInDb(db, attempt.task_id)) {
        // If the source binding itself was damaged, reconciliation cannot find
        // the old node. Only its immutable reservation event may identify the
        // orphan; never guess from the task cursor or a replacement revision.
        const orphan = db.prepare(`SELECT item.item_id FROM workflow_item_events event
          JOIN workflow_items item ON item.item_id = event.item_id
          WHERE event.execution_id = ? AND event.event_key = ? AND item.task_id = ?
            AND item.origin = 'native' AND item.status = 'running'
            AND NOT EXISTS (SELECT 1 FROM execution_attempts execution
              WHERE execution.work_item_id = item.item_id AND execution.pipeline != 'intervention'
                AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying'))`)
          .all(attempt.execution_id, `reserve:${attempt.execution_id}`, attempt.task_id) as { item_id: string }[];
        for (const item of orphan) openInterventionInDb(db, { taskId: attempt.task_id, itemId: item.item_id,
          sourceExecutionId: attempt.execution_id, requestedBy: 'system', authority: 'arbitration',
          dedupeKey: `native:invalid-reservation:${attempt.execution_id}:${item.item_id}`,
          summary: `执行 ${attempt.execution_id} 的来源绑定损坏，需要核对原保留事件后恢复工作项`,
          context: { executionId: attempt.execution_id, reservationEventKey: `reserve:${attempt.execution_id}`, diagnostic: detail || reason } });
      }
      if (attempt.lane && attempt.lane !== 'control') {
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(attempt.task_id) as Task;
        settleTaskLaneInDb(db, task, attempt.lane as TaskLaneKind);
      }
      return { kind: 'invalidated', reason } as const;
    };

    if (!reservation) return invalidate('superseded', '派发保留快照无法读取或来源身份不一致');
    if (!attempt.run_status || !['starting', 'running'].includes(attempt.run_status)) return invalidate('run-stopped');
    if (attempt.task_is_paused) return invalidate('requirement-paused');
    if (workflowEndedInDb(db, attempt.task_id)) return invalidate('requirement-terminal');
    if (nativeTaskHoldInDb(db, attempt.task_id)) return invalidate('superseded');
    if (!requirementDependencyGateOpenInDb(db, attempt.task_id)) return invalidate('superseded', '前置需求尚未完成，不能激活保留执行');
    if (attempt.task_workflow_engine === 'native') {
      if (attempt.work_item_id !== reservation.work.workItemId || attempt.agent !== reservation.work.agent
        || attempt.pipeline !== reservation.work.pipeline || attempt.story_index !== reservation.work.storyIndex
        || attempt.dispatch_generation_key !== dispatchGenerationKey(reservation.work)
        || attempt.input_hash !== hash(attempt.dispatch_reservation_json)
        || attempt.input_json !== attempt.dispatch_reservation_json) {
        return invalidate('superseded', '来源执行与冻结工作项派发快照不一致');
      }
      try { nativeWorkBinding(db, reservation.work); }
      catch (error) { return invalidate('superseded', error instanceof Error ? error.message : String(error)); }
    }
    if (reservation.work.workItemId && !db.prepare(`
      SELECT 1 FROM workflow_items item WHERE item.item_id = ? AND item.status = 'running'
        AND item.dispatch_epoch = ? AND NOT EXISTS (
          SELECT 1 FROM interventions intervention WHERE intervention.item_id = item.item_id
            AND intervention.status IN ('pending', 'running', 'awaiting_human')
        )
        AND NOT EXISTS (
          SELECT 1 FROM workflow_dependencies dependency JOIN workflow_items upstream
            ON upstream.item_id = dependency.depends_on_item_id
          WHERE dependency.item_id = item.item_id AND upstream.status != 'completed'
        )
    `).get(reservation.work.workItemId, reservation.work.workItemEpoch || 1)) return invalidate('superseded');
    if (input.prepared.evolutionCandidateId) {
      if (!isActiveProjectOverlayCandidateInDb(db, attempt.task_project_id, attempt.agent, input.prepared.evolutionCandidateId)) {
        return invalidate('canary-deferred');
      }
      const activeCanary = db.prepare(`
        SELECT 1 FROM execution_attempts
        WHERE evolution_candidate_id = ? AND execution_id != ?
          AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
        LIMIT 1
      `).get(input.prepared.evolutionCandidateId, attempt.execution_id);
      if (activeCanary) return invalidate('canary-deferred');
    }

    const inputJson = JSON.stringify({
      delegation: reservation.work,
      prompt: input.prepared.prompt,
      contextSnapshot: input.prepared.contextSnapshot,
      recovery: input.prepared.recovery,
      runtime: input.prepared.runtime,
    });
    const inputHash = hash(inputJson);
    db.prepare(`
      UPDATE execution_attempts
      SET status = 'running', input_hash = ?, input_json = ?, base_commit = ?,
          dispatch_retry_consumed = 1,
          prompt_version = ?, prompt_template_version = ?, prompt_hash = ?,
          memory_revision = ?, memory_hash = ?, evolution_candidate_id = ?,
          executor_id = ?, configured_model = ?, reasoning_effort = ?, web_search_enabled = ?,
          heartbeat_at = CURRENT_TIMESTAMP, started_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'planned'
    `).run(
      inputHash,
      inputJson,
      input.prepared.baseCommit || null,
      input.prepared.promptMetadata.version,
      input.prepared.promptMetadata.templateVersion,
      input.prepared.promptMetadata.hash,
      input.prepared.memory.revision,
      input.prepared.memory.hash,
      input.prepared.evolutionCandidateId || null,
      input.prepared.runtime.executorId,
      input.prepared.runtime.model || null,
      input.prepared.runtime.reasoningEffort || null,
      input.prepared.runtime.webSearchEnabled ? 1 : 0,
      attempt.execution_id,
    );
    return {
      kind: 'running',
      attempt: db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(attempt.execution_id) as ExecutionAttempt,
    } as const;
  }).immediate();
}

async function executionExited(input: { reservationId: string }) {
  const db = await databaseConnection();
  return db.transaction(() => {
    const attempt = db.prepare(`
      SELECT execution_id, task_id, dispatch_execution_exited_at
      FROM execution_attempts WHERE execution_id = ? AND dispatch_reservation_json IS NOT NULL
    `).get(input.reservationId) as { execution_id: string; task_id: string; dispatch_execution_exited_at: string | null } | undefined;
    if (!attempt || attempt.dispatch_execution_exited_at) return { kind: 'already-released', resources: [] as ResourceKey[] } as const;
    const resources = (db.prepare(`
      SELECT resource_key FROM resource_claims WHERE owner_execution_id = ? ORDER BY resource_key
    `).all(attempt.execution_id) as { resource_key: ResourceKey }[]).map((row) => row.resource_key);
    releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
    reconcileNativeWorkItemExecutionsInDb(db, attempt.task_id);
    db.prepare(`
      UPDATE execution_attempts SET dispatch_execution_exited_at = CURRENT_TIMESTAMP WHERE execution_id = ?
    `).run(attempt.execution_id);
    return { kind: 'released', resources } as const;
  }).immediate();
}

async function preparationFailed(input: { reservationId: string; error: string }) {
  const db = await databaseConnection();
  return db.transaction(() => {
    const attempt = db.prepare(`
      SELECT * FROM execution_attempts
      WHERE execution_id = ? AND dispatch_reservation_json IS NOT NULL
    `).get(input.reservationId) as (ExecutionAttempt & { dispatch_reservation_json: string }) | undefined;
    if (!attempt || attempt.status !== 'planned') return { kind: 'ignored' } as const;
    const blocked = attempt.attempt > EXECUTION_FAILURE_MAX_RETRIES;
    const retryNotBefore = blocked ? null : retryNotBeforeForFailure(attempt.attempt);
    const native = Boolean(db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(attempt.task_id));
    const reservation = native ? undefined : JSON.parse(attempt.dispatch_reservation_json) as StoredReservation;
    db.prepare(`
      UPDATE execution_attempts
      SET status = ?, last_error = ?, failure_kind = 'agent-preparation', retry_not_before = ?, finished_at = CURRENT_TIMESTAMP,
          dispatch_retry_consumed = 1,
          heartbeat_at = CURRENT_TIMESTAMP, dispatch_execution_exited_at = CURRENT_TIMESTAMP,
          dispatch_settled_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'planned'
    `).run(blocked ? 'system_blocked' : 'retryable_failed', input.error, retryNotBefore, attempt.execution_id);
    recordExecutionFailureActivityInDb(db, {
      executionId: attempt.execution_id,
      taskId: attempt.task_id,
      lane: attempt.lane,
      agent: attempt.agent,
      storyIndex: attempt.story_index,
      failureKind: 'agent-preparation',
      failureAttempt: attempt.attempt,
      maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
      willRetry: !blocked,
      retryNotBefore,
      error: input.error,
    });
    releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
    if (native) {
      db.prepare('DELETE FROM resource_claims WHERE owner_execution_id = ?').run(attempt.execution_id);
      settleNativeExecutionFailureInDb(db, attempt.execution_id);
      return { kind: blocked ? 'blocked' : 'retry', attempt: attempt.attempt } as const;
    }
    if (reservation) releaseAcquiredReservationClaims(db, reservation);
    if (attempt.lane && attempt.lane !== 'control') {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(attempt.task_id) as Task;
      if (blocked) {
        setTaskLaneStateInDb(db, {
          taskId: attempt.task_id,
          lane: attempt.lane as TaskLaneKind,
          status: 'system_blocked',
          currentAgent: attempt.agent,
          currentStoryIndex: attempt.story_index,
          blockedReason: input.error,
        });
      } else {
        settleTaskLaneInDb(db, task, attempt.lane as TaskLaneKind);
      }
    } else if (blocked) {
      db.prepare(`
        UPDATE tasks SET agile_status = 'blocked', run_state = 'system_blocked',
          resume_status = CASE WHEN agile_status != 'blocked' THEN agile_status ELSE resume_status END,
          current_subagent = ?, blocked_reason = ?, next_step = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(attempt.agent, input.error, `系统阻塞：${input.error}`, attempt.task_id);
    }
    return { kind: blocked ? 'blocked' : 'retry', attempt: attempt.attempt } as const;
  }).immediate();
}

async function settle(input: { reservationId: string }) {
  const db = await databaseConnection();
  return db.transaction(() => {
    const attempt = db.prepare(`
      SELECT * FROM execution_attempts WHERE execution_id = ? AND dispatch_reservation_json IS NOT NULL
    `).get(input.reservationId) as (ExecutionAttempt & {
      dispatch_reservation_json: string;
      dispatch_settled_at: string | null;
    }) | undefined;
    if (!attempt || attempt.dispatch_settled_at) return { kind: 'already-settled' } as const;
    const reservation = JSON.parse(attempt.dispatch_reservation_json) as StoredReservation;
    if (attempt.status === 'planned') {
      db.prepare(`
        UPDATE execution_attempts SET status = 'cancelled', last_error = '派发保留未激活即结束',
          finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
        WHERE execution_id = ?
      `).run(attempt.execution_id);
    }
    if (['planned', 'cancelled'].includes(attempt.status)) releaseAcquiredReservationClaims(db, reservation);
    releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
    reconcileNativeWorkItemExecutionsInDb(db, attempt.task_id);
    if (attempt.lane && attempt.lane !== 'control') {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(attempt.task_id) as Task;
      if (task) settleTaskLaneInDb(db, task, attempt.lane as TaskLaneKind);
    }
    db.prepare('UPDATE execution_attempts SET dispatch_settled_at = CURRENT_TIMESTAMP WHERE execution_id = ?').run(attempt.execution_id);
    return { kind: 'settled' } as const;
  }).immediate();
}

function recoverExecutionWork(db: Awaited<ReturnType<typeof databaseConnection>>, attempt: ExecutionAttempt) {
  const delegation = restoreExecutionDelegationInDb(db, attempt);
  return {
    ...delegation,
    lane: delegation.lane || laneForAgent(delegation.agent),
    resources: resourcesRequiringClaims(Array.isArray(delegation.resources)
      ? delegation.resources : resourcesForAgent(delegation.agent)),
  } as DelegationEnvelope;
}

async function nextRecovery(): Promise<RecoverableExecution | undefined> {
  const db = await databaseConnection();
  const attempts = db.prepare(`
    SELECT execution_attempts.* FROM execution_attempts
    JOIN tasks ON tasks.task_id = execution_attempts.task_id
    WHERE execution_attempts.status IN ('output_received', 'verifying', 'applying')
      AND execution_attempts.result_json IS NOT NULL
      AND execution_attempts.pipeline != 'intervention'
      AND tasks.is_paused = 0
    ORDER BY execution_attempts.created_at, execution_attempts.execution_id
  `).all() as ExecutionAttempt[];
  // A held queue head must not starve independent requirements. Already
  // applied results need only settlement and may finish behind a new hold.
  const attempt = attempts.find(source => !workflowResultHeldInDb(db, source.task_id, source.execution_id)
    || Boolean(db.prepare("SELECT 1 FROM agent_results WHERE execution_id = ? AND application_status = 'applied'").get(source.execution_id)));
  return attempt ? { attempt, work: recoverExecutionWork(db, attempt) } : undefined;
}

async function settleRecoveredExecution(input: { executionId: string }) {
  const db = await databaseConnection();
  const attempt = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(input.executionId) as (ExecutionAttempt & {
    dispatch_reservation_json?: string | null;
  }) | undefined;
  if (!attempt) return { kind: 'already-settled' } as const;
  if (attempt.dispatch_reservation_json) return settle({ reservationId: input.executionId });
  return db.transaction(() => {
    releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
    if (attempt.lane && attempt.lane !== 'control') {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(attempt.task_id) as Task | undefined;
      if (task) settleTaskLaneInDb(db, task, attempt.lane as TaskLaneKind);
    }
    return { kind: 'settled' } as const;
  }).immediate();
}

async function reconcileStaleLanes() {
  const db = await databaseConnection();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT lane.task_id, lane.lane
      FROM task_lanes lane
      WHERE lane.status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM execution_attempts execution
          WHERE execution.task_id = lane.task_id
            AND COALESCE(execution.lane, CASE
              WHEN execution.agent = 'analyst-agent' THEN 'analysis'
              WHEN execution.agent IN ('dev-agent', 'test-agent') THEN 'delivery'
              ELSE 'control'
            END) = lane.lane
            AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
        )
    `).all() as { task_id: string; lane: TaskLaneKind }[];
    for (const row of rows) {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(row.task_id) as Task | undefined;
      if (task) settleTaskLaneInDb(db, task, row.lane);
    }
    return rows.length;
  }).immediate();
}

export function createProgressDispatcher(planner: DispatchPlanner = planDispatchInDb, bindWork: WorkBinding = nativeWorkBinding) {
  return {
    reserveNext: (input: { runId: string }) => reserveNext(input, planner, bindWork),
    activate,
    preparationFailed,
    executionExited,
    settle,
    nextRecovery,
    settleRecoveredExecution,
    reconcileStaleLanes,
  };
}

export const progressDispatcher = createProgressDispatcher();

export function createProgressDispatchInspector(planner: DispatchPlanner = inspectDispatchInDb, unadoptedInspection?: UnadoptedInspection) {
  return { inspect: (input: { requirementId: string }) => inspect(input, planner, unadoptedInspection), inspectAll: () => inspectAll(planner) };
}

export const progressDispatchInspector = createProgressDispatchInspector();
