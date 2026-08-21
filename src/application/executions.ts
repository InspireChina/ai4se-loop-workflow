import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import {
  releaseResourceClaimInDb,
  resourceClaimInDb,
  releaseExecutionResourceClaimsInDb,
  releaseRunExecutionResourceClaimsInDb,
} from './resource-claims';
import { setTaskLaneStateInDb, settleTaskLaneInDb, type TaskLaneKind } from './task-lanes';
import type { Task } from './tasks';
import type { ResourceKey } from '../domain/resource';

export type ExecutionStatus =
  | 'planned'
  | 'running'
  | 'output_received'
  | 'verifying'
  | 'applying'
  | 'applied'
  | 'retryable_failed'
  | 'system_blocked'
  | 'cancelled';

export const EXECUTION_FAILURE_MAX_RETRIES = 3;

export type ExecutionAttempt = {
  execution_id: string;
  run_id: string;
  task_id: string;
  story_index: number | null;
  agent: string;
  pipeline: string;
  lane: string | null;
  delegation_key: string;
  attempt: number;
  status: ExecutionStatus;
  input_hash: string;
  input_json: string;
  result_json: string | null;
  base_commit: string | null;
  code_commit: string | null;
  verification_id: string | null;
  application_result_id: string | null;
  heartbeat_at: string | null;
  last_error: string | null;
  failure_kind: string | null;
  prompt_version: number | null;
  prompt_template_version: number | null;
  prompt_hash: string | null;
  memory_revision: number | null;
  memory_hash: string | null;
  evolution_candidate_id: string | null;
  executor_id: string | null;
  configured_model: string | null;
  reasoning_effort: string | null;
  web_search_enabled: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type ExecutionFailureActivityInput = {
  executionId: string;
  taskId: string;
  lane: string | null;
  agent: string;
  storyIndex: number | null;
  failureKind: string;
  failureAttempt: number;
  maxRetries: number;
  willRetry: boolean;
  error: string;
};

export function recordExecutionFailureActivityInDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  input: ExecutionFailureActivityInput,
) {
  const scope = input.lane ? `${input.lane} Lane` : 'control';
  const unit = input.storyIndex === null ? '' : ` · 交付单元 ${input.storyIndex}`;
  const outcome = input.willRetry
    ? `第 ${input.failureAttempt} 次失败，自动重试 ${input.failureAttempt}/${input.maxRetries}`
    : `第 ${input.failureAttempt} 次失败，${input.maxRetries} 次自动重试已耗尽`;
  const summary = `${scope} · ${input.agent}${unit} · ${outcome} · ${input.failureKind} · execution=${input.executionId}：${input.error}`;
  db.prepare(`
    INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
    VALUES(?, ?, 'system', ?, ?)
  `).run(
    randomUUID(),
    input.taskId,
    input.willRetry ? 'AgentExecutionRetryScheduled' : 'AgentExecutionRetriesExhausted',
    summary,
  );
}

export function shouldRecordDevCodeCommit(
  agent: string,
  result: { outcome?: string; changedFiles?: readonly string[] },
) {
  return agent === 'dev-agent'
    && result.outcome === 'completed'
    && Array.isArray(result.changedFiles)
    && result.changedFiles.length > 0;
}

export async function reconcileInterruptedExecutions(runId: string | null, reason: string) {
  const db = await databaseConnection();
  const scope = runId ? 'AND execution_attempts.run_id = ?' : '';
  return db.transaction(() => {
  const orphanReservations = db.prepare(`
    SELECT execution_attempts.execution_id, execution_attempts.task_id,
           execution_attempts.lane, execution_attempts.dispatch_reservation_json
    FROM execution_attempts
    WHERE status = 'planned' AND result_json IS NULL
      AND dispatch_reservation_json IS NOT NULL
      ${scope}
      AND NOT EXISTS (
        SELECT 1 FROM agent_results
        WHERE agent_results.execution_id = execution_attempts.execution_id
          AND agent_results.application_status = 'pending'
      )
  `).all(...(runId ? [runId] : [])) as {
    execution_id: string;
    task_id: string;
    lane: string | null;
    dispatch_reservation_json: string;
  }[];
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'cancelled',
        last_error = '需求已取消',
        finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP
    WHERE status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
      ${scope}
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.task_id = execution_attempts.task_id
          AND tasks.agile_status = 'cancelled'
      )
  `).run(...(runId ? [runId] : []));
  const pendingResultCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_attempts
    WHERE status IN ('planned', 'running')
      AND result_json IS NULL
      ${scope}
      AND EXISTS (
        SELECT 1 FROM agent_results
        WHERE agent_results.execution_id = execution_attempts.execution_id
          AND agent_results.application_status = 'pending'
      )
  `).get(...(runId ? [runId] : [])) as { count: number }).count;
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'cancelled',
        last_error = '所属 Runner 已退出，取消未激活的派发保留并重新调度',
        finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP,
        dispatch_execution_exited_at = CURRENT_TIMESTAMP,
        dispatch_settled_at = CURRENT_TIMESTAMP
    WHERE status = 'planned'
      AND result_json IS NULL
      ${scope}
      AND NOT EXISTS (
        SELECT 1 FROM agent_results
        WHERE agent_results.execution_id = execution_attempts.execution_id
          AND agent_results.application_status = 'pending'
      )
  `).run(...(runId ? [runId] : [])).changes;
  for (const orphan of orphanReservations) {
    const reservation = JSON.parse(orphan.dispatch_reservation_json) as {
      resourceAcquisitions?: Record<ResourceKey, 'acquired' | 'inherited'>;
    };
    for (const [resourceKey, acquisition] of Object.entries(reservation.resourceAcquisitions || {}) as [ResourceKey, 'acquired' | 'inherited'][]) {
      const current = resourceClaimInDb(db, resourceKey);
      if (acquisition === 'acquired' && current?.owner_execution_id === orphan.execution_id) {
        releaseResourceClaimInDb(db, resourceKey, orphan.task_id);
      }
    }
    if (orphan.lane && orphan.lane !== 'control') {
      const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(orphan.task_id) as Task | undefined;
      if (task) settleTaskLaneInDb(db, task, orphan.lane as TaskLaneKind);
    }
  }
  const interruptedExecutions = db.prepare(`
    SELECT execution_id, task_id, lane, agent, story_index, attempt
    FROM execution_attempts
    WHERE status = 'running'
      AND result_json IS NULL
      ${scope}
      AND NOT EXISTS (
        SELECT 1 FROM agent_results
        WHERE agent_results.execution_id = execution_attempts.execution_id
          AND agent_results.application_status = 'pending'
      )
  `).all(...(runId ? [runId] : [])) as Array<{
    execution_id: string;
    task_id: string;
    lane: string | null;
    agent: string;
    story_index: number | null;
    attempt: number;
  }>;
  for (const interrupted of interruptedExecutions) {
    const willRetry = interrupted.attempt <= EXECUTION_FAILURE_MAX_RETRIES;
    db.prepare(`
      UPDATE execution_attempts
      SET status = ?, last_error = ?, failure_kind = 'runner-interrupted',
          finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'running'
    `).run(willRetry ? 'retryable_failed' : 'system_blocked', reason, interrupted.execution_id);
    recordExecutionFailureActivityInDb(db, {
      executionId: interrupted.execution_id,
      taskId: interrupted.task_id,
      lane: interrupted.lane,
      agent: interrupted.agent,
      storyIndex: interrupted.story_index,
      failureKind: 'runner-interrupted',
      failureAttempt: interrupted.attempt,
      maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
      willRetry,
      error: reason,
    });
    if (!willRetry && interrupted.lane && interrupted.lane !== 'control') {
      setTaskLaneStateInDb(db, {
        taskId: interrupted.task_id,
        lane: interrupted.lane as TaskLaneKind,
        status: 'system_blocked',
        currentAgent: interrupted.agent,
        currentStoryIndex: interrupted.story_index,
        blockedReason: reason,
      });
    } else if (!willRetry) {
      db.prepare(`
        UPDATE tasks SET agile_status = 'blocked', run_state = 'system_blocked',
          resume_status = CASE WHEN agile_status != 'blocked' THEN agile_status ELSE resume_status END,
          current_subagent = ?, blocked_reason = ?, next_step = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(interrupted.agent, reason, `系统阻塞：${reason}`, interrupted.task_id);
    }
  }
  const retryableCount = interruptedExecutions.filter((execution) => execution.attempt <= EXECUTION_FAILURE_MAX_RETRIES).length;
  const blockedCount = interruptedExecutions.length - retryableCount;
  const failedCount = interruptedExecutions.length;
  const cancelledReservationCount = orphanReservations.length;
  const recoverableCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_attempts
    WHERE status IN ('output_received', 'verifying', 'applying')
      AND result_json IS NOT NULL
      ${scope}
  `).get(...(runId ? [runId] : [])) as { count: number }).count;
  releaseRunExecutionResourceClaimsInDb(db, runId);
    return {
      failedCount,
      retryableCount,
      blockedCount,
      cancelledReservationCount,
      recoverableCount,
      pendingResultCount,
    };
  }).immediate();
}

export async function markExecutionOutput(executionId: string, result: unknown) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status != 'cancelled'
  `).run(JSON.stringify(result), executionId);
}

export async function markExecutionStage(executionId: string, status: 'verifying' | 'applying') {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status != 'cancelled'
  `).run(status, executionId);
}

export async function recordExecutionReceipt(executionId: string, kind: string, receiptKey: string, payload: unknown) {
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO execution_receipts(receipt_id, execution_id, kind, receipt_key, payload_json)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(execution_id, kind, receipt_key) DO NOTHING
  `).run(randomUUID(), executionId, kind, receiptKey, JSON.stringify(payload));
  if (kind === 'code_commit') {
    db.prepare('UPDATE execution_attempts SET code_commit = ?, heartbeat_at = CURRENT_TIMESTAMP WHERE execution_id = ?').run(receiptKey, executionId);
  } else if (kind === 'verification') {
    db.prepare('UPDATE execution_attempts SET verification_id = ?, heartbeat_at = CURRENT_TIMESTAMP WHERE execution_id = ?').run(receiptKey, executionId);
  } else if (kind === 'agent_result') {
    db.prepare('UPDATE execution_attempts SET application_result_id = ?, heartbeat_at = CURRENT_TIMESTAMP WHERE execution_id = ?').run(receiptKey, executionId);
  }
}

export async function completeExecution(executionId: string) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'applied', finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status != 'cancelled'
  `).run(executionId);
  releaseExecutionResourceClaimsInDb(db, executionId);
}

export async function executionCancellationRequested(executionId: string) {
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT execution_attempts.status AS execution_status, tasks.agile_status AS task_status,
           tasks.is_paused AS task_is_paused
    FROM execution_attempts
    JOIN tasks ON tasks.task_id = execution_attempts.task_id
    WHERE execution_attempts.execution_id = ?
  `).get(executionId) as { execution_status: ExecutionStatus; task_status: string; task_is_paused: number } | undefined;
  return !row || row.execution_status === 'cancelled' || row.task_status === 'cancelled' || Boolean(row.task_is_paused);
}

export async function cancelExecution(executionId: string, reason = '需求已取消') {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'cancelled', last_error = ?, finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status != 'applied'
  `).run(reason, executionId);
  releaseExecutionResourceClaimsInDb(db, executionId);
}

export async function deferExecutionResult(executionId: string, reason: string) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'output_received', last_error = ?, finished_at = NULL,
        heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status NOT IN ('cancelled', 'applied')
  `).run(reason, executionId);
  releaseExecutionResourceClaimsInDb(db, executionId);
}

export type ExecutionFailureRetryPolicy = {
  kind: string;
  maxRetries: number;
};

export async function failExecutionWithRetryPolicy(
  executionId: string,
  error: string,
  policy: ExecutionFailureRetryPolicy,
) {
  const db = await databaseConnection();
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT execution_id, task_id, lane, agent, story_index, attempt, status
      FROM execution_attempts WHERE execution_id = ?
    `).get(executionId) as {
      execution_id: string;
      task_id: string;
      lane: string | null;
      agent: string;
      story_index: number | null;
      attempt: number;
      status: ExecutionStatus;
    } | undefined;
    if (!current || ['cancelled', 'applied'].includes(current.status)) {
      return { ignored: true as const, willRetry: false, failureAttempt: 0, maxRetries: policy.maxRetries };
    }
    const failureAttempt = current.attempt;
    const willRetry = failureAttempt <= policy.maxRetries;
    db.prepare(`
      UPDATE execution_attempts
      SET status = ?, last_error = ?, failure_kind = ?, finished_at = CURRENT_TIMESTAMP,
          heartbeat_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status NOT IN ('cancelled', 'applied')
    `).run(willRetry ? 'retryable_failed' : 'system_blocked', error, policy.kind, executionId);
    recordExecutionFailureActivityInDb(db, {
      executionId: current.execution_id,
      taskId: current.task_id,
      lane: current.lane,
      agent: current.agent,
      storyIndex: current.story_index,
      failureKind: policy.kind,
      failureAttempt,
      maxRetries: policy.maxRetries,
      willRetry,
      error,
    });
    if (!willRetry && current.lane && current.lane !== 'control') {
      setTaskLaneStateInDb(db, {
        taskId: current.task_id,
        lane: current.lane as TaskLaneKind,
        status: 'system_blocked',
        currentAgent: current.agent,
        currentStoryIndex: current.story_index,
        blockedReason: error,
      });
    } else if (!willRetry) {
      db.prepare(`
        UPDATE tasks SET agile_status = 'blocked', run_state = 'system_blocked',
          resume_status = CASE WHEN agile_status != 'blocked' THEN agile_status ELSE resume_status END,
          current_subagent = ?, blocked_reason = ?, next_step = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(current.agent, error, `系统阻塞：${error}`, current.task_id);
    }
    releaseExecutionResourceClaimsInDb(db, executionId);
    return { ignored: false as const, willRetry, failureAttempt, maxRetries: policy.maxRetries };
  }).immediate();
}
