import { randomUUID } from 'node:crypto';
import { resourcesForAgent, type ResourceKey } from '../domain/resource';
import { databaseConnection, hash } from '../infrastructure/database';
import { acquireResourceClaimsInDb, releaseResourceClaimInDb, resourceClaimInDb } from './resource-claims';
import { releaseExecutionResourceClaimsInDb } from './resource-claims';
import { laneForAgent, markTaskLaneRunningInDb, settleTaskLaneInDb, setTaskLaneStateInDb, type TaskLaneKind } from './task-lanes';
import { pipelineAllEnvelopesInDb, type DelegationEnvelope, type Task } from './tasks';
import type { ExecutionAttempt } from './executions';

export type DispatchWaitReason =
  | 'active-execution'
  | 'pending-result'
  | 'resources-busy'
  | 'paused-only'
  | 'waiting-for-input'
  | 'system-blocked'
  | 'lower-priority'
  | 'no-runnable-work';

export type DispatchWakeInstruction =
  | { kind: 'execution-completion' }
  | { kind: 'retry-after'; notBefore: string }
  | { kind: 'external-change' };

export type ReservedExecution = {
  reservationId: string;
  executionId: string;
  runId: string;
  work: DelegationEnvelope;
  claimedResources: readonly ResourceKey[];
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
};

export type DispatchExplanation = {
  requirementId: string;
  decisions: DispatchDecision[];
};

export type PreparedExecution = {
  prompt: string;
  contextSnapshot: unknown;
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
    if (acquisition === 'acquired') releaseResourceClaimInDb(db, resourceKey, reservation.work.taskId);
  }
}

function dispatchGenerationKey(work: DelegationEnvelope) {
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

async function reserveNext(input: { runId: string }): Promise<ReserveNextResult> {
  const db = await databaseConnection();
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db.prepare('SELECT status FROM loop_runs WHERE run_id = ?').get(input.runId) as { status: string } | undefined;
    if (!run || !['starting', 'running'].includes(run.status)) {
      db.exec('ROLLBACK');
      return { kind: 'run-stopped' };
    }

    const workItems = pipelineAllEnvelopesInDb(db);
    if (!workItems.length) {
      const result = waitResult(db);
      db.exec('COMMIT');
      return result;
    }

    const reservations: ReservedExecution[] = [];
    for (const work of workItems) {
      const executionId = randomUUID();
      const reservationId = executionId;
      const generationKey = dispatchGenerationKey(work);
      const previous = db.prepare(`
        SELECT MAX(attempt) AS attempt
        FROM execution_attempts
        WHERE dispatch_generation_key = ? AND dispatch_retry_consumed = 1
      `).get(generationKey) as { attempt: number | null };
      const attempt = (previous.attempt || 0) + 1;
      const resourceAcquisitions = Object.fromEntries(work.resources.map((resourceKey) => {
        const claim = resourceClaimInDb(db, resourceKey);
        return [resourceKey, claim?.owner_task_id === work.taskId ? 'inherited' : 'acquired'];
      })) as Record<ResourceKey, 'acquired' | 'inherited'>;
      const reservation: StoredReservation = {
        reservationId,
        executionId,
        runId: input.runId,
        work,
        claimedResources: work.resources,
        generationKey,
        resourceAcquisitions,
      };
      const reservationJson = JSON.stringify(reservation);
      const reservationHash = hash(reservationJson);
      db.prepare(`
        INSERT INTO execution_attempts(
          execution_id, run_id, task_id, story_index, agent, pipeline, lane,
          delegation_key, dispatch_generation_key, attempt, status,
          input_hash, input_json, dispatch_reservation_json, dispatch_retry_consumed, heartbeat_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, 0, CURRENT_TIMESTAMP)
      `).run(
        executionId,
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
        resourceKeys: work.resources,
        taskId: work.taskId,
        lane: work.lane,
        storyIndex: work.storyIndex,
        executionId,
      });
      if (work.lane !== 'control') {
        markTaskLaneRunningInDb(db, {
          taskId: work.taskId,
          lane: work.lane,
          agent: work.agent,
          storyIndex: work.storyIndex,
        });
      }
      reservations.push({ reservationId, executionId, runId: input.runId, work, claimedResources: work.resources });
    }
    db.exec('COMMIT');
    return { kind: 'reserved', reservations };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

async function inspect(input: { requirementId: string }): Promise<DispatchExplanation> {
  const db = await databaseConnection();
  const active = db.prepare(`
    SELECT execution_id, dispatch_reservation_json
    FROM execution_attempts
    WHERE task_id = ?
      AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
    ORDER BY created_at, execution_id
  `).all(input.requirementId) as { execution_id: string; dispatch_reservation_json: string | null }[];
  if (active.length) {
    return {
      requirementId: input.requirementId,
      decisions: active.map((row) => {
        const reservation = row.dispatch_reservation_json
          ? JSON.parse(row.dispatch_reservation_json) as StoredReservation
          : undefined;
        return {
          lane: reservation?.work.lane || 'control',
          state: 'active',
          reason: 'active-execution',
          executionId: row.execution_id,
          reservationId: reservation?.reservationId || row.execution_id,
        };
      }),
    };
  }
  const task = db.prepare('SELECT agile_status, run_state, is_paused FROM tasks WHERE task_id = ?')
    .get(input.requirementId) as { agile_status: string; run_state: string; is_paused: number } | undefined;
  if (!task) return { requirementId: input.requirementId, decisions: [] };
  if (['done', 'cancelled'].includes(task.agile_status)) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'completed' }] };
  }
  if (task.is_paused) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'waiting', reason: 'paused-only' }] };
  }
  if (task.agile_status === 'blocked' || task.run_state === 'system_blocked') {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'waiting', reason: 'system-blocked' }] };
  }
  if (['waiting_for_answers', 'waiting_for_runtime_input'].includes(task.run_state)) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'waiting', reason: 'waiting-for-input' }] };
  }
  const pending = db.prepare(`
    SELECT 1 FROM agent_results WHERE task_id = ? AND application_status = 'pending' LIMIT 1
  `).get(input.requirementId);
  if (pending) {
    return { requirementId: input.requirementId, decisions: [{ lane: 'control', state: 'waiting', reason: 'pending-result' }] };
  }
  let selected: DelegationEnvelope[] = [];
  db.exec('SAVEPOINT dispatch_inspect');
  try {
    selected = pipelineAllEnvelopesInDb(db).filter((work) => work.taskId === input.requirementId);
  } finally {
    db.exec('ROLLBACK TO dispatch_inspect');
    db.exec('RELEASE dispatch_inspect');
  }
  if (selected.length) {
    return {
      requirementId: input.requirementId,
      decisions: selected.map((work) => ({ lane: work.lane, state: 'selected' })),
    };
  }
  return {
    requirementId: input.requirementId,
    decisions: [{ lane: 'control', state: 'waiting', reason: 'lower-priority' }],
  };
}

async function activate(input: { reservationId: string; prepared: PreparedExecution }): Promise<ActivateResult> {
  const db = await databaseConnection();
  return db.transaction(() => {
    const attempt = db.prepare(`
      SELECT execution_attempts.*, tasks.agile_status AS task_status, tasks.is_paused AS task_is_paused,
             loop_runs.status AS run_status
      FROM execution_attempts
      JOIN tasks ON tasks.task_id = execution_attempts.task_id
      LEFT JOIN loop_runs ON loop_runs.run_id = execution_attempts.run_id
      WHERE execution_attempts.execution_id = ?
        AND execution_attempts.dispatch_reservation_json IS NOT NULL
    `).get(input.reservationId) as (ExecutionAttempt & {
      dispatch_reservation_json: string;
      task_status: string;
      task_is_paused: number;
      run_status: string | null;
    }) | undefined;
    if (!attempt) return { kind: 'invalidated', reason: 'superseded' } as const;
    const reservation = JSON.parse(attempt.dispatch_reservation_json) as StoredReservation;
    if (attempt.status !== 'planned') {
      if (attempt.status === 'running') return { kind: 'running', attempt } as const;
      if (!['output_received', 'verifying', 'applying'].includes(attempt.status)) {
        releaseAcquiredReservationClaims(db, reservation);
      }
      return { kind: 'invalidated', reason: 'superseded' } as const;
    }

    const invalidate = (reason: InvalidationReason) => {
      db.prepare(`
        UPDATE execution_attempts
        SET status = 'cancelled', last_error = ?, finished_at = CURRENT_TIMESTAMP,
            heartbeat_at = CURRENT_TIMESTAMP, dispatch_settled_at = CURRENT_TIMESTAMP
        WHERE execution_id = ?
      `).run(reason, attempt.execution_id);
      releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
      releaseAcquiredReservationClaims(db, reservation);
      if (attempt.lane && attempt.lane !== 'control') {
        const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(attempt.task_id) as Task;
        settleTaskLaneInDb(db, task, attempt.lane as TaskLaneKind);
      }
      return { kind: 'invalidated', reason } as const;
    };

    if (!attempt.run_status || !['starting', 'running'].includes(attempt.run_status)) return invalidate('run-stopped');
    if (attempt.task_is_paused) return invalidate('requirement-paused');
    if (['done', 'cancelled'].includes(attempt.task_status)) return invalidate('requirement-terminal');
    if (input.prepared.evolutionCandidateId) {
      const candidate = db.prepare(`
        SELECT 1 FROM agent_prompt_candidates
        WHERE candidate_id = ? AND agent_id = ?
      `).get(input.prepared.evolutionCandidateId, attempt.agent);
      if (!candidate) return invalidate('canary-deferred');
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
      SELECT execution_id, dispatch_execution_exited_at
      FROM execution_attempts WHERE execution_id = ? AND dispatch_reservation_json IS NOT NULL
    `).get(input.reservationId) as { execution_id: string; dispatch_execution_exited_at: string | null } | undefined;
    if (!attempt || attempt.dispatch_execution_exited_at) return { kind: 'already-released', resources: [] as ResourceKey[] } as const;
    const resources = (db.prepare(`
      SELECT resource_key FROM resource_claims WHERE owner_execution_id = ? ORDER BY resource_key
    `).all(attempt.execution_id) as { resource_key: ResourceKey }[]).map((row) => row.resource_key);
    releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
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
    const blocked = attempt.attempt >= 3;
    const reservation = JSON.parse(attempt.dispatch_reservation_json) as StoredReservation;
    db.prepare(`
      UPDATE execution_attempts
      SET status = ?, last_error = ?, finished_at = CURRENT_TIMESTAMP,
          dispatch_retry_consumed = 1,
          heartbeat_at = CURRENT_TIMESTAMP, dispatch_execution_exited_at = CURRENT_TIMESTAMP,
          dispatch_settled_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'planned'
    `).run(blocked ? 'system_blocked' : 'retryable_failed', input.error, attempt.execution_id);
    releaseExecutionResourceClaimsInDb(db, attempt.execution_id);
    releaseAcquiredReservationClaims(db, reservation);
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
    if (attempt.lane && attempt.lane !== 'control') {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(attempt.task_id) as Task;
      if (task) settleTaskLaneInDb(db, task, attempt.lane as TaskLaneKind);
    }
    db.prepare('UPDATE execution_attempts SET dispatch_settled_at = CURRENT_TIMESTAMP WHERE execution_id = ?').run(attempt.execution_id);
    return { kind: 'settled' } as const;
  }).immediate();
}

function recoverExecutionWork(attempt: ExecutionAttempt) {
  const snapshot = JSON.parse(attempt.input_json) as { delegation: DelegationEnvelope };
  return {
    ...snapshot.delegation,
    lane: snapshot.delegation.lane || laneForAgent(snapshot.delegation.agent),
    resources: Array.isArray(snapshot.delegation.resources)
      ? snapshot.delegation.resources
      : resourcesForAgent(snapshot.delegation.agent),
  } as DelegationEnvelope;
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

export const progressDispatcher = {
  reserveNext,
  activate,
  preparationFailed,
  executionExited,
  settle,
  recoverExecutionWork,
  settleRecoveredExecution,
};

export const progressDispatchInspector = { inspect };
