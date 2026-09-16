import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentExecutionOptions } from '../infrastructure/agent-executor';
import { databaseConnection, hash, paths } from '../infrastructure/database';
import { loopAgentCommandPrefix } from '../domain/agent-command-profile';
import { CODE_WORKSPACE_RESOURCE } from '../domain/resource';
import { agentConcurrencyInDb } from './project-settings';
import { releaseResourceClaimInDb } from './resource-claims';
import { laneForAgent, setTaskLaneStateInDb } from './task-lanes';
import { syncLegacyDeliveryWorkItemsInDb } from './work-items';
import { promoteReadyWorkItemsInDb, rewindWorkItemsInDb, transitionWorkItemInDb } from './work-item-transitions';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import { workflowEndedInDb, nativeTaskHoldInDb } from './work-item-controls';
import { enqueueInterventionFaultInDb } from './repair-observation-outbox';
import { version as harnessVersion } from '../../package.json';

type Db = Awaited<ReturnType<typeof databaseConnection>>;

export type InterventionStatus =
  | 'pending'
  | 'running'
  | 'resolved'
  | 'awaiting_human'
  | 'superseded'
  | 'cancelled';

export type InterventionRow = {
  intervention_id: string;
  source_kind: 'legacy-unknown' | 'human-input' | 'assistance-request' | 'agent-fault';
  repair_case_id: string | null;
  task_id: string;
  item_id: string | null;
  dedupe_key: string;
  status: InterventionStatus;
  resolver_strategy: 'system_then_human' | 'human_only';
  authority: 'standard' | 'arbitration';
  requested_by: string;
  source_execution_id: string | null;
  summary: string;
  context_json: string;
  context_hash: string;
  attempt_count: number;
  max_system_attempts: number;
  current_execution_id: string | null;
  active_session_id: string | null;
  command_token_hash: string | null;
  status_viewed_session_id: string | null;
  resolution: string | null;
  resolved_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  escalated_at: string | null;
};

export type ClaimedIntervention = {
  interventionId: string;
  taskId: string;
  itemId: string | null;
  executionId: string;
  sessionId: string;
  token: string;
  attempt: number;
  attemptSequence: number;
  maxAttempts: number;
  storyIndex: number | null;
  authority: 'standard' | 'arbitration';
  requestedBy: string;
  summary: string;
  context: Record<string, unknown>;
  taskTitle: string;
  previousErrors: string[];
};

const openInterventionSchema = z.object({
  taskId: z.string().trim().min(1),
  itemId: z.string().trim().min(1).optional().nullable(),
  dedupeKey: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(8000),
  context: z.record(z.string(), z.unknown()).default({}),
  requestedBy: z.string().trim().min(1).max(100),
  sourceExecutionId: z.string().trim().min(1).optional().nullable(),
  resolverStrategy: z.enum(['system_then_human', 'human_only']).default('system_then_human'),
  authority: z.enum(['standard', 'arbitration']).default('standard'),
  maxSystemAttempts: z.number().int().min(3).max(20).default(3),
  emitEvent: z.boolean().default(true),
  sourceKind: z.enum(['human-input', 'assistance-request', 'agent-fault']).optional(),
});

function addEvent(db: Db, taskId: string, actor: string, eventType: string, summary: string) {
  db.prepare(`
    INSERT INTO task_events(event_id, task_id, actor, event_type, summary)
    VALUES(?, ?, ?, ?, ?)
  `).run(randomUUID(), taskId, actor, eventType, summary);
}

function activeAgentCount(db: Db) {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM execution_attempts
    WHERE status IN ('planned', 'running')
  `).get() as { count: number }).count;
}

function unsuccessfulSystemAttemptsInDb(db: Db, interventionId: string) {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM intervention_attempts
    WHERE intervention_id = ? AND status IN ('deferred', 'failed')
  `).get(interventionId) as { count: number }).count;
}

function legacyVerificationJobInDb(db: Db, interventionId: string) {
  return db.prepare(`
    SELECT job_id, request_id FROM verification_assistance_jobs WHERE intervention_id = ?
  `).get(interventionId) as { job_id: string; request_id: string } | undefined;
}

export function openInterventionInDb(db: Db, input: unknown) {
  const value = openInterventionSchema.parse(input);
  const sourceKind = value.sourceKind || (value.resolverStrategy === 'human_only' ? 'human-input'
    : value.authority === 'arbitration' ? 'agent-fault' : 'assistance-request');
  if (sourceKind === 'agent-fault' && value.resolverStrategy === 'human_only') throw new Error('人工输入不能声明为自动修复故障');
  const task = db.prepare(`
    SELECT task_id, agile_status FROM tasks WHERE task_id = ?
  `).get(value.taskId) as { task_id: string; agile_status: string } | undefined;
  if (!task) throw new Error(`需求不存在：${value.taskId}`);
  if (workflowEndedInDb(db, value.taskId)) throw new Error('已结束需求不能创建介入事项');
  if (value.itemId) {
    const item = db.prepare(`
      SELECT item_id FROM workflow_items WHERE item_id = ? AND task_id = ?
    `).get(value.itemId, value.taskId);
    if (!item) throw new Error('介入事项引用了不存在或属于其他需求的工作项');
  }
  if (value.sourceExecutionId) {
    const execution = db.prepare(`
      SELECT execution_id FROM execution_attempts WHERE execution_id = ? AND task_id = ?
    `).get(value.sourceExecutionId, value.taskId);
    if (!execution) throw new Error('介入事项引用了不存在或属于其他需求的 execution');
  }
  const contextJson = JSON.stringify(value.context);
  const contextHash = hash(contextJson);
  const existing = db.prepare(`
    SELECT * FROM interventions WHERE task_id = ? AND dedupe_key = ?
  `).get(value.taskId, value.dedupeKey) as InterventionRow | undefined;
  if (existing) {
    if (existing.context_hash !== contextHash || existing.summary !== value.summary
      || existing.source_kind !== 'legacy-unknown' && existing.source_kind !== sourceKind) {
      throw new Error(`介入事项幂等键冲突：${value.dedupeKey}`);
    }
    return existing;
  }

  const interventionId = `INT-${randomUUID()}`;
  db.prepare(`
    INSERT INTO interventions(
      intervention_id, task_id, item_id, dedupe_key, status, resolver_strategy,
      authority, requested_by, source_execution_id, summary,
      context_json, context_hash, max_system_attempts, source_kind
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    interventionId,
    value.taskId,
    value.itemId || null,
    value.dedupeKey,
    value.resolverStrategy === 'human_only' ? 'awaiting_human' : 'pending',
    value.resolverStrategy,
    value.authority,
    value.requestedBy,
    value.sourceExecutionId || null,
    value.summary,
    contextJson,
    contextHash,
    value.maxSystemAttempts,
    sourceKind,
  );
  if (value.itemId) {
    const item = db.prepare('SELECT origin, status FROM workflow_items WHERE item_id = ?').get(value.itemId) as { origin: string; status: string };
    if (item.origin === 'native' && ['pending', 'ready', 'running'].includes(item.status)) {
      transitionWorkItemInDb(db, { itemId: value.itemId, action: 'wait', eventKey: `intervention:${interventionId}:open`,
        actor: value.requestedBy, authority: 'system', reason: value.summary });
    } else db.prepare(`
      UPDATE workflow_items
      SET status = 'waiting', updated_at = CURRENT_TIMESTAMP
      WHERE item_id = ? AND status IN ('ready', 'running')
    `).run(value.itemId);
  }
  if (value.emitEvent) {
    addEvent(
      db,
      value.taskId,
      value.requestedBy,
      value.authority === 'arbitration' ? 'ArbitrationRequested' : 'InterventionRequested',
      value.summary,
    );
  }
  const created = db.prepare('SELECT * FROM interventions WHERE intervention_id = ?')
    .get(interventionId) as InterventionRow;
  enqueueInterventionFaultInDb(db, created, `v${harnessVersion}`);
  return created;
}

export async function openIntervention(input: unknown) {
  const db = await databaseConnection();
  return db.transaction(() => openInterventionInDb(db, input)).immediate();
}

export async function listInterventions(taskId: string) {
  const db = await databaseConnection();
  return db.prepare(`
    SELECT * FROM interventions WHERE task_id = ? ORDER BY created_at, intervention_id
  `).all(taskId) as InterventionRow[];
}

export async function claimNextIntervention(input: {
  runId: string;
  executorId: string;
  executionOptions: AgentExecutionOptions;
  legacyVerificationOnly?: boolean;
}): Promise<ClaimedIntervention | null> {
  const db = await databaseConnection();
  return db.transaction(() => {
    if (activeAgentCount(db) >= agentConcurrencyInDb(db)) return null;
    const candidates = db.prepare(`
      SELECT intervention.*, task.title AS task_title
      FROM interventions intervention
      JOIN tasks task ON task.task_id = intervention.task_id
      JOIN projects project ON project.project_id = task.project_id
      WHERE intervention.status = 'pending'
        AND intervention.repair_case_id IS NULL
        AND intervention.source_kind <> 'agent-fault'
        AND intervention.resolver_strategy = 'system_then_human'
        AND (? = 0 OR EXISTS (
          SELECT 1 FROM verification_assistance_jobs legacy_job
          WHERE legacy_job.intervention_id = intervention.intervention_id
        ))
        AND (SELECT COUNT(*) FROM intervention_attempts previous
             WHERE previous.intervention_id = intervention.intervention_id
               AND previous.status IN ('deferred', 'failed')) < intervention.max_system_attempts
        AND task.is_paused = 0
        AND (task.workflow_engine = 'native' OR task.agile_status NOT IN ('done', 'cancelled'))
        AND project.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM execution_attempts active
          WHERE active.task_id = intervention.task_id
            AND active.agent = 'system-assistance-agent'
            AND active.status IN ('planned', 'running')
        )
      ORDER BY intervention.created_at, intervention.intervention_id
    `).all(input.legacyVerificationOnly ? 1 : 0) as (InterventionRow & { task_title: string })[];
    const row = candidates.find((candidate) => !workflowEndedInDb(db, candidate.task_id)
      && !nativeTaskHoldInDb(db, candidate.task_id, candidate.intervention_id));
    if (!row) return null;

    const attemptSequence = row.attempt_count + 1;
    const attempt = unsuccessfulSystemAttemptsInDb(db, row.intervention_id) + 1;
    const context = JSON.parse(row.context_json) as Record<string, unknown>;
    const contextStoryIndex = context.storyIndex ?? context.deliveryUnit;
    const storyIndex = typeof contextStoryIndex === 'number' && Number.isInteger(contextStoryIndex)
      ? contextStoryIndex
      : null;
    const executionId = randomUUID();
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const workItemAttempt = row.item_id
      ? ((db.prepare(`
        SELECT COALESCE(MAX(work_item_attempt), 0) AS attempt
        FROM execution_attempts WHERE work_item_id = ?
      `).get(row.item_id) as { attempt: number }).attempt + 1)
      : null;
    const snapshot = {
      interventionId: row.intervention_id,
      taskId: row.task_id,
      itemId: row.item_id,
      attempt,
      attemptSequence,
      maxAttempts: row.max_system_attempts,
      authority: row.authority,
      requestedBy: row.requested_by,
      summary: row.summary,
      contextHash: row.context_hash,
    };
    db.prepare(`
      INSERT INTO execution_attempts(
        execution_id, work_item_id, work_item_attempt, run_id, task_id, story_index, agent, pipeline, lane,
        delegation_key, attempt, status, input_hash, input_json, heartbeat_at,
        started_at, executor_id, configured_model, reasoning_effort
      ) VALUES(?, ?, ?, ?, ?, ?, 'system-assistance-agent', 'intervention', 'control',
        ?, ?, 'running', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?)
    `).run(
      executionId,
      row.item_id,
      workItemAttempt,
      input.runId,
      row.task_id,
      storyIndex,
      `intervention:${row.intervention_id}`,
      attemptSequence,
      hash(JSON.stringify(snapshot)),
      JSON.stringify(snapshot),
      input.executorId,
      input.executionOptions.model || null,
      input.executionOptions.reasoningEffort || null,
    );
    db.prepare(`
      UPDATE interventions
      SET status = 'running', attempt_count = ?, current_execution_id = ?,
          active_session_id = ?, command_token_hash = ?, status_viewed_session_id = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE intervention_id = ? AND status = 'pending'
    `).run(attemptSequence, executionId, sessionId, hash(token), row.intervention_id);
    db.prepare(`
      INSERT INTO intervention_attempts(attempt_id, intervention_id, execution_id, attempt)
      VALUES(?, ?, ?, ?)
    `).run(randomUUID(), row.intervention_id, executionId, attemptSequence);
    if (!row.item_id) promoteReadyWorkItemsInDb(db, row.task_id, `intervention:${row.intervention_id}:resolved`);
    const legacyJob = legacyVerificationJobInDb(db, row.intervention_id);
    if (legacyJob) {
      db.prepare(`
        UPDATE verification_assistance_jobs
        SET status = 'running', attempt_count = ?, active_session_id = ?,
            command_token_hash = ?, status_viewed_session_id = NULL,
            current_execution_id = ?, max_attempts = ?, updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?
      `).run(attempt, sessionId, hash(token), executionId, row.max_system_attempts, legacyJob.job_id);
    }
    addEvent(
      db,
      row.task_id,
      'system-assistance-agent',
      'InterventionAttemptStarted',
      `系统辅助 Agent 开始第 ${attempt}/${row.max_system_attempts} 次介入：${row.summary}`,
    );
    const previousErrors = (db.prepare(`
      SELECT reason FROM intervention_attempts
      WHERE intervention_id = ? AND attempt < ? AND reason IS NOT NULL
      ORDER BY attempt
    `).all(row.intervention_id, attemptSequence) as { reason: string }[]).map((item) => item.reason);
    return {
      interventionId: row.intervention_id,
      taskId: row.task_id,
      itemId: row.item_id,
      executionId,
      sessionId,
      token,
      attempt,
      attemptSequence,
      maxAttempts: row.max_system_attempts,
      storyIndex,
      authority: row.authority,
      requestedBy: row.requested_by,
      summary: row.summary,
      context,
      taskTitle: row.task_title,
      previousErrors,
    };
  }).immediate();
}

export async function finishInterventionAttempt(input: {
  interventionId: string;
  reason: string;
  outcome: 'deferred' | 'failed';
}) {
  const reason = z.string().trim().min(1).max(8000).parse(input.reason);
  const db = await databaseConnection();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM interventions WHERE intervention_id = ?
    `).get(input.interventionId) as InterventionRow | undefined;
    if (!row || row.status !== 'running') {
      return { ignored: true as const, willRetry: false, escalated: row?.status === 'awaiting_human' };
    }
    const source = db.prepare('SELECT status, last_error FROM execution_attempts WHERE execution_id = ?')
      .get(row.current_execution_id) as { status: string; last_error: string | null } | undefined;
    if (source?.status === 'cancelled') {
      cancelInterventionAttemptInDb(db, row.intervention_id, source.last_error || '执行来源已取消');
      return { ignored: true as const, willRetry: false, escalated: false };
    }
    const unsuccessfulAttempts = unsuccessfulSystemAttemptsInDb(db, row.intervention_id) + 1;
    const managedFault = row.source_kind === 'agent-fault';
    const escalated = !managedFault && unsuccessfulAttempts >= row.max_system_attempts;
    db.prepare(`
      UPDATE interventions
      SET status = ?, last_error = ?, current_execution_id = NULL,
          active_session_id = NULL, command_token_hash = NULL,
          status_viewed_session_id = NULL, updated_at = CURRENT_TIMESTAMP,
          escalated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE escalated_at END
      WHERE intervention_id = ?
    `).run(escalated ? 'awaiting_human' : 'pending', reason, escalated ? 1 : 0, row.intervention_id);
    db.prepare(`
      UPDATE intervention_attempts
      SET status = ?, reason = ?, finished_at = CURRENT_TIMESTAMP
      WHERE intervention_id = ? AND attempt = ?
    `).run(input.outcome, reason, row.intervention_id, row.attempt_count);
    const legacyJob = legacyVerificationJobInDb(db, row.intervention_id);
    if (legacyJob) {
      db.prepare(`
        UPDATE verification_assistance_jobs
        SET status = ?, last_reason = ?, active_session_id = NULL,
            command_token_hash = NULL, status_viewed_session_id = NULL,
            current_execution_id = NULL, updated_at = CURRENT_TIMESTAMP,
            escalated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE escalated_at END
        WHERE job_id = ?
      `).run(escalated ? 'escalated' : 'pending', reason, escalated ? 1 : 0, legacyJob.job_id);
    }
    db.prepare(`
      UPDATE execution_attempts
      SET status = ?, result_json = ?, last_error = ?, failure_kind = 'intervention',
          heartbeat_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
      WHERE execution_id = ? AND status = 'running'
    `).run(
      input.outcome === 'deferred' ? 'applied' : escalated ? 'system_blocked' : 'retryable_failed',
      JSON.stringify({ outcome: 'needs_input', verdict: input.outcome, summary: reason }),
      input.outcome === 'failed' ? reason : null,
      row.current_execution_id,
    );
    db.prepare(`
      UPDATE tasks SET next_step = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?
    `).run(
      managedFault ? `Agent 故障已交独立 Admin 继续调查与修复：${row.summary}` : escalated
        ? `系统辅助 Agent 已尝试 ${unsuccessfulAttempts} 次仍无法解决，等待人工${row.authority === 'arbitration' ? '仲裁' : legacyJob ? '验证协助' : '介入'}：${row.summary}`
        : `系统辅助 Agent 第 ${unsuccessfulAttempts}/${row.max_system_attempts} 次未解决，将继续自动尝试：${row.summary}`,
      row.task_id,
    );
    addEvent(
      db,
      row.task_id,
      'system-assistance-agent',
      managedFault ? 'InterventionRepairHandoff' : escalated ? 'InterventionEscalated' : 'InterventionAttemptDeferred',
      managedFault ? `旧介入执行未解决，独立 Admin 保留历史继续修复：${reason}` : escalated
        ? `系统辅助 Agent 已尝试 ${unsuccessfulAttempts} 次，介入事项转交人工：${reason}`
        : `系统辅助 Agent 第 ${unsuccessfulAttempts}/${row.max_system_attempts} 次未解决，将继续尝试：${reason}`,
    );
    return {
      ignored: false as const,
      willRetry: !escalated,
      escalated,
      attempt: unsuccessfulAttempts,
      maxAttempts: row.max_system_attempts,
    };
  }).immediate();
}

export function cancelInterventionAttemptInDb(db: Db, interventionId: string, reason: string) {
  const row = db.prepare(`
    SELECT intervention.*, task.agile_status
    FROM interventions intervention
    JOIN tasks task ON task.task_id = intervention.task_id
    WHERE intervention.intervention_id = ?
  `).get(interventionId) as (InterventionRow & { agile_status: string }) | undefined;
  if (!row || row.status !== 'running') return false;
  const terminal = workflowEndedInDb(db, row.task_id);
  db.prepare(`
    UPDATE interventions
    SET status = ?, current_execution_id = NULL, active_session_id = NULL,
        command_token_hash = NULL, status_viewed_session_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE intervention_id = ? AND status = 'running'
  `).run(terminal ? 'cancelled' : 'pending', row.intervention_id);
  db.prepare(`
    UPDATE intervention_attempts
    SET status = 'cancelled', reason = ?, finished_at = CURRENT_TIMESTAMP
    WHERE intervention_id = ? AND attempt = ? AND status = 'running'
  `).run(reason, row.intervention_id, row.attempt_count);
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'cancelled', last_error = ?, finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ? AND status IN ('planned', 'running')
  `).run(reason, row.current_execution_id);
  const legacyJob = legacyVerificationJobInDb(db, row.intervention_id);
  if (legacyJob) {
    db.prepare(`
      UPDATE verification_assistance_jobs
      SET status = ?, current_execution_id = NULL, active_session_id = NULL,
          command_token_hash = NULL, status_viewed_session_id = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(terminal ? 'cancelled' : 'pending', legacyJob.job_id);
  }
  addEvent(db, row.task_id, 'system', 'InterventionAttemptInterrupted', `${reason}；本次中断不消耗系统辅助重试额度。`);
  return true;
}

export async function cancelInterventionAttempt(interventionId: string, reason: string) {
  const db = await databaseConnection();
  return db.transaction(() => cancelInterventionAttemptInDb(db, interventionId, reason)).immediate();
}

export function interruptTaskInterventionsInDb(db: Db, taskId: string, reason: string) {
  const rows = db.prepare(`
    SELECT intervention_id FROM interventions WHERE task_id = ? AND status = 'running'
  `).all(taskId) as { intervention_id: string }[];
  for (const row of rows) cancelInterventionAttemptInDb(db, row.intervention_id, reason);
  const task = db.prepare('SELECT agile_status FROM tasks WHERE task_id = ?').get(taskId) as { agile_status: string } | undefined;
  if (task && workflowEndedInDb(db, taskId)) {
    db.prepare(`
      UPDATE interventions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status IN ('pending', 'awaiting_human')
    `).run(taskId);
    db.prepare(`
      UPDATE verification_assistance_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status IN ('pending', 'running', 'escalated')
    `).run(taskId);
  }
}

function resolveLinkedRuntimeInputInDb(db: Db, row: InterventionRow, resolution: string, resolvedBy: string) {
  const request = db.prepare(`
    SELECT request_id, source_agent, story_index FROM runtime_input_requests
    WHERE intervention_id = ? AND status = 'pending'
  `).get(row.intervention_id) as {
    request_id: string;
    source_agent: string;
    story_index: number | null;
  } | undefined;
  if (!request) return;
  db.prepare(`
    UPDATE runtime_input_requests
    SET answer = ?, status = 'answered', updated_at = CURRENT_TIMESTAMP
    WHERE request_id = ? AND status = 'pending'
  `).run(resolution, request.request_id);
  if (row.resolver_strategy !== 'system_then_human' || resolvedBy !== 'system-assistance-agent') return;
  if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(row.task_id)) {
    // resolveIntervention has already resumed the exact linked native item
    // through dependency/Intervention gates in this transaction. Old Lane
    // ownership cannot decide whether its answer was submitted.
    addEvent(db, row.task_id, 'system', 'RuntimeInputsSubmitted', `系统辅助 Agent 已提交运行信息，交回 ${request.source_agent}。`);
    return;
  }
  const lane = laneForAgent(request.source_agent);
  const agents = lane === 'delivery' ? ['dev-agent', 'test-agent']
    : lane === 'analysis' ? ['analyst-agent'] : [request.source_agent];
  const pending = (db.prepare(`
    SELECT COUNT(*) AS count FROM runtime_input_requests
    WHERE task_id = ? AND source_agent IN (${agents.map(() => '?').join(', ')}) AND status = 'pending'
  `).get(row.task_id, ...agents) as { count: number }).count;
  if (pending) return;
  if (lane !== 'control') {
    const current = db.prepare(`
      SELECT current_agent, current_story_index FROM task_lanes
      WHERE task_id = ? AND lane = ? AND status = 'waiting_for_runtime_input'
    `).get(row.task_id, lane) as { current_agent: string | null; current_story_index: number | null } | undefined;
    if (!current?.current_agent) return;
    db.prepare(`
      UPDATE tasks
      SET run_state = 'runnable', resume_pending = 0, blocked_reason = NULL,
          next_step = ?, last_actor = 'system', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(`系统辅助 Agent 已补齐运行信息，交回 ${current.current_agent} 从原计划继续`, row.task_id);
    setTaskLaneStateInDb(db, {
      taskId: row.task_id,
      lane,
      status: 'runnable',
      currentAgent: current.current_agent,
      currentStoryIndex: current.current_story_index,
      resumePending: 1,
    });
  } else {
    const result = db.prepare(`
      UPDATE tasks
      SET run_state = 'runnable', resume_pending = 1, blocked_reason = NULL,
          next_step = ?, last_actor = 'system', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND run_state = 'waiting_for_runtime_input' AND current_subagent = ?
    `).run(`系统辅助 Agent 已补齐运行信息，交回 ${request.source_agent} 从原计划继续`, row.task_id, request.source_agent);
    if (!result.changes) return;
    syncLegacyDeliveryWorkItemsInDb(db, row.task_id);
  }
  addEvent(db, row.task_id, 'system', 'RuntimeInputsSubmitted', `系统辅助 Agent 已提交运行信息，交回 ${request.source_agent}。`);
}

type ResolveInterventionInput = {
  interventionId: string;
  resolution: string;
  resolvedBy: string;
  commandAudit?: { command: string; hash: string; actor: string; target?: string };
};

export async function resolveIntervention(input: ResolveInterventionInput) {
  return resolveInterventionInDb(await databaseConnection(), input);
}

function resolveInterventionInDb(db: Db, input: ResolveInterventionInput) {
  const value = z.object({
    interventionId: z.string().trim().min(1),
    resolution: z.string().trim().min(1).max(20_000),
    resolvedBy: z.string().trim().min(1).max(100),
    commandAudit: z.object({ command: z.string(), hash: z.string(), actor: z.string(), target: z.string().optional() }).optional(),
  }).parse(input);
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM interventions WHERE intervention_id = ?
    `).get(value.interventionId) as InterventionRow | undefined;
    if (!row) throw new Error(`介入事项不存在：${value.interventionId}`);
    if (!['pending', 'running', 'awaiting_human'].includes(row.status)) return row;
    db.prepare(`
      UPDATE interventions
      SET status = 'resolved', resolution = ?, resolved_by = ?,
          current_execution_id = NULL, active_session_id = NULL,
          command_token_hash = NULL, status_viewed_session_id = NULL,
          resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE intervention_id = ?
    `).run(value.resolution, value.resolvedBy, row.intervention_id);
    if (value.commandAudit) {
      db.prepare('UPDATE interventions SET context_json = ? WHERE intervention_id = ?')
        .run(JSON.stringify({ ...JSON.parse(row.context_json || '{}'), appliedCommand: value.commandAudit }), row.intervention_id);
    }
    if (row.item_id) {
      const nativeItem = db.prepare(`
        SELECT item_id FROM workflow_items item WHERE item.item_id = ? AND origin = 'native' AND status = 'waiting'
          AND NOT EXISTS (SELECT 1 FROM interventions remaining WHERE remaining.item_id = item.item_id
            AND remaining.status IN ('pending', 'running', 'awaiting_human'))
          AND NOT EXISTS (SELECT 1 FROM workflow_dependencies dependency JOIN workflow_items upstream
            ON upstream.item_id = dependency.depends_on_item_id WHERE dependency.item_id = item.item_id AND upstream.status != 'completed')
      `).get(row.item_id) as { item_id: string } | undefined;
      if (nativeItem && row.resolver_strategy === 'system_then_human') {
        transitionWorkItemInDb(db, { itemId: row.item_id, action: 'resume', eventKey: `intervention:${row.intervention_id}:resolved`,
          actor: value.resolvedBy, authority: row.authority === 'arbitration' ? 'arbitration' : 'system', reason: value.resolution });
      }
      db.prepare(`
        UPDATE workflow_items
        SET status = 'ready', ready_at = COALESCE(ready_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE item_id = ? AND status = 'waiting' AND origin = 'legacy_projection'
          AND NOT EXISTS (
            SELECT 1 FROM interventions remaining
            WHERE remaining.item_id = workflow_items.item_id
              AND remaining.status IN ('pending', 'running', 'awaiting_human')
          )
      `).run(row.item_id);
    }
    const legacyJob = legacyVerificationJobInDb(db, row.intervention_id);
    if (legacyJob) {
      db.prepare(`
        UPDATE verification_assistance_jobs
        SET status = 'resolved', answer = ?, current_execution_id = NULL,
            active_session_id = NULL, command_token_hash = NULL,
            status_viewed_session_id = NULL, resolved_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?
      `).run(value.resolution, legacyJob.job_id);
      addEvent(db, row.task_id, 'system', 'VerificationAssistanceResolved', `系统辅助 Agent 已解决验证协助「${row.summary}」。`);
    }
    resolveLinkedRuntimeInputInDb(db, row, value.resolution, value.resolvedBy);
    promoteReadyWorkItemsInDb(db, row.task_id, `intervention:${row.intervention_id}:resolved`);
    projectNativeWorkflowDisplayInDb(db, row.task_id);
    if (row.current_execution_id) {
      db.prepare(`
        UPDATE intervention_attempts
        SET status = 'resolved', resolution = ?, finished_at = CURRENT_TIMESTAMP
        WHERE intervention_id = ? AND attempt = ? AND status = 'running'
      `).run(value.resolution, row.intervention_id, row.attempt_count);
      db.prepare(`
        UPDATE execution_attempts
        SET status = 'applied', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP,
            finished_at = CURRENT_TIMESTAMP
        WHERE execution_id = ? AND status = 'running'
      `).run(
        JSON.stringify({ outcome: 'completed', verdict: 'resolved', summary: value.resolution }),
        row.current_execution_id,
      );
    }
    addEvent(
      db,
      row.task_id,
      value.resolvedBy,
      row.authority === 'arbitration' ? 'ArbitrationResolved' : 'InterventionResolved',
      value.resolution,
    );
    return db.prepare('SELECT * FROM interventions WHERE intervention_id = ?')
      .get(row.intervention_id) as InterventionRow;
  }).immediate();
}

function interventionCommandScopeInDb(db: Db, interventionId: string) {
  const row = db.prepare(`
    SELECT intervention.*, task.title AS task_title,
           (SELECT GROUP_CONCAT(work_key, ', ') FROM workflow_items available
            WHERE available.task_id = intervention.task_id AND available.origin = 'native'
              AND available.status NOT IN ('superseded', 'cancelled')) AS available_work_keys,
           (SELECT COUNT(*) FROM intervention_attempts previous
            WHERE previous.intervention_id = intervention.intervention_id
              AND previous.status IN ('deferred', 'failed')) AS unsuccessful_attempts,
           item.work_key, item.title AS item_title, item.kind AS item_kind,
           item.agent AS item_agent, item.pipeline AS item_pipeline,
           item.story_index AS item_story_index, item.revision AS item_revision
    FROM interventions intervention
    JOIN tasks task ON task.task_id = intervention.task_id
    LEFT JOIN workflow_items item ON item.item_id = intervention.item_id
    WHERE intervention.intervention_id = ?
  `).get(interventionId) as (InterventionRow & {
    task_title: string;
    available_work_keys: string | null;
    unsuccessful_attempts: number;
    work_key: string | null;
    item_title: string | null;
    item_kind: string | null;
    item_agent: string | null;
    item_pipeline: string | null;
    item_story_index: number | null;
    item_revision: number | null;
  }) | undefined;
  return row;
}

function authorizedIntervention(db: Db, input: {
  interventionId: string;
  sessionId: string;
  token: string;
}) {
  const row = interventionCommandScopeInDb(db, input.interventionId);
  if (!row || row.status !== 'running') throw new Error('当前介入事项不存在、已经结束或不再需要处理');
  if (row.repair_case_id || row.source_kind === 'agent-fault') throw new Error('该故障已由独立 Admin 接管，旧介入命令不能修改业务状态');
  if (row.active_session_id !== input.sessionId) throw new Error('当前介入会话已经失效');
  if (!row.command_token_hash || hash(input.token) !== row.command_token_hash) {
    throw new Error('当前介入命令凭证无效');
  }
  return row;
}

function renderInterventionStatus(row: ReturnType<typeof authorizedIntervention>, actor: 'human' | 'system-assistance-agent' = 'system-assistance-agent') {
  return [
    '# INTERVENTION',
    '',
    `- Intervention: ${row.intervention_id}`,
    `- Authority: ${row.authority}`,
    `- Attempt: ${row.unsuccessful_attempts + 1}/${row.max_system_attempts} (launch ${row.attempt_count})`,
    `- Requirement: ${row.task_title} (${row.task_id})`,
    `- Work Item: ${row.item_title || '需求级'}${row.work_key ? ` (${row.work_key} r${row.item_revision})` : ''}`,
    `- Assigned Agent: ${row.item_agent || 'none'}`,
    `- Pipeline: ${row.item_pipeline || 'none'}`,
    `- Delivery Unit: ${row.item_story_index ?? 'task'}`,
    `- Requested By: ${row.requested_by}`,
    `- Summary: ${row.summary}`,
    `- Context: ${row.context_json}`,
    `- Previous Failure: ${row.last_error || '无'}`,
    ...(row.authority === 'arbitration' ? [`- Rewind Work Keys: ${row.available_work_keys || '使用兼容阶段名称及交付单元'}`] : []),
    '',
    '# TERMINAL COMMANDS',
    ...(row.authority === 'standard' ? ['- `intervention resolve --resolution-file <结论文件>`'] : []),
    ...(actor === 'human' ? [] : ['- `intervention defer --reason-file <原因文件>`']),
    ...(row.authority === 'arbitration' ? [
      '- `intervention task-rewind --to <当前需求的工作键|context|repro|plan|analysis|dev|test> --reason-file <原因文件>`',
      ...(actor === 'human' ? ['- `intervention work-item-complete --reason-file <人工裁决依据文件>`'] : []),
    ] : []),
  ].join('\n');
}

export function buildInterventionPrompt(intervention: ClaimedIntervention) {
  const command = loopAgentCommandPrefix(paths.appRoot);
  const prior = intervention.previousErrors.length
    ? intervention.previousErrors.map((reason, index) => `${index + 1}. ${reason}`).join('\n')
    : '无；这是首次尝试。';
  return [
    '# 角色目标',
    `你是 LoopWork 系统辅助 Agent，正在处理一个${intervention.authority === 'arbitration' ? '历史仲裁调查' : '流程介入'}事项。`,
    '你需要基于持久化事实检查问题、尽力解除阻塞，并让流程继续；不要把原 Agent 的自述当作已经验证的事实。',
    '',
    '# 当前事项',
    `需求：${intervention.taskTitle}（${intervention.taskId}）`,
    `Work Item：${intervention.itemId || '需求级'}`,
    `尝试：${intervention.attempt}/${intervention.maxAttempts}`,
    `请求方：${intervention.requestedBy}`,
    `摘要：${intervention.summary}`,
    `上下文：${JSON.stringify(intervention.context, null, 2)}`,
    '',
    '# 先前尝试',
    prior,
    '',
    '# 工作规则',
    '1. 必须先执行 intervention status，重新读取数据库中的最新事项和 Work Item 状态。',
    '2. 使用任务上下文、代码、Git、测试、execution receipts 与现有领域命令核对事实；优先完成安全、可恢复的本地调查。',
    '3. 不得篡改原测试结果、伪造证据或直接编辑 Loop 数据库。原失败记录必须保留。',
    intervention.authority === 'arbitration'
      ? '4. 自动介入不能直接完成 Dev/Test。Agent 故障由独立 Admin 调查、实际修复并请求独立验证；旧记录只能按已有范围 task-rewind 或 defer，不能用总结代替验证。'
      : '4. 优先发现真实入口、启动或检查本地服务、构造非敏感测试数据、运行测试或最小复现、检查日志与配置。可以执行仅影响当前验证的安全、可恢复操作；不得修改产品代码、权限、密钥或外部生产环境。只有取得可供后续 Agent 使用的真实信息与证据时才能 resolve，并写清动作、观察、证据位置及限制。',
    '5. 如果本次无法可靠解决，执行 defer，写清尝试、证据和仍缺少的最小条件。普通最终文本不会结束本次尝试。',
    '',
    '# 可用命令',
    `查看事项：${command} intervention status`,
    ...(intervention.authority === 'standard' ? [`提交解决结论：${command} intervention resolve --resolution-file <UTF-8 结论文件>`] : []),
    `本次无法解决：${command} intervention defer --reason-file <UTF-8 原因文件>`,
    ...(intervention.authority === 'arbitration' ? [
      `按工作项依赖图或兼容回退语义重新编排：${command} intervention task-rewind --to <当前需求的工作键|context|repro|plan|analysis|dev|test> --reason-file <UTF-8 裁决依据文件>`,
      '工作键从 intervention status 读取，例如 ba:design、delivery:analysis:1、direct:execute；不能跨需求引用。',
    ] : []),
    `完整任务上下文：npm --prefix ${JSON.stringify(paths.appRoot)} run loopctl -- task-context --task-id ${intervention.taskId}`,
    `任务摘要：npm --prefix ${JSON.stringify(paths.appRoot)} run loopctl -- task-get ${intervention.taskId}`,
    '',
    intervention.authority === 'arbitration'
      ? '先执行 status，再开始调查；结束前必须成功调用 task-rewind 或 defer，不能直接完成 Dev/Test。'
      : '先执行 status，再开始调查；结束前必须成功调用 resolve 或 defer。',
  ].join('\n');
}

async function completeWorkItemByArbitration(
  row: ReturnType<typeof authorizedIntervention>,
  reason: string,
  actor: 'system-assistance-agent' | 'human',
  commandAudit: { command: string; hash: string; actor: string; target?: string },
) {
  if (actor !== 'human') throw new Error('自动修复不能直接完成 Dev/Test；必须修复后请求独立验证');
  if (row.authority !== 'arbitration') throw new Error('当前介入事项没有仲裁权限');
  if (!row.item_id || !row.item_story_index || !['dev-agent', 'test-agent'].includes(row.item_agent || '')) {
    throw new Error('只有关联到当前 Dev/Test Work Item 的仲裁才能直接完成该工作项');
  }
  const { getTask, updateTask } = await import('./tasks');
  const detail = await getTask(row.task_id);
  if (!detail) throw new Error(`需求不存在：${row.task_id}`);
  const storyIndex = row.item_story_index;
  const db = await databaseConnection();
  const nativeItem = db.prepare("SELECT 1 FROM workflow_items WHERE item_id = ? AND task_id = ? AND origin = 'native'")
    .get(row.item_id, row.task_id);
  if (nativeItem) {
    db.transaction(() => {
      // Highest-authority completion replaces any in-flight primary work.
      // Freeze it as cancelled so its CLI is stopped and late results cannot
      // publish; preserve applied/failed evidence and the arbitration resolver.
      db.prepare(`UPDATE execution_attempts SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP WHERE work_item_id = ? AND task_id = ? AND pipeline != 'intervention'
          AND status IN ('planned','running','output_received','verifying','applying')`).run(row.item_id, row.task_id);
      transitionWorkItemInDb(db, { itemId: row.item_id!, action: 'complete',
        eventKey: `intervention:${row.intervention_id}:complete`, actor, authority: 'arbitration', reason });
      projectNativeWorkflowDisplayInDb(db, row.task_id);
      db.prepare(`UPDATE tasks SET next_step = ?, last_actor = ? WHERE task_id = ?`)
        .run(`仲裁完成交付单元 ${storyIndex} 的${row.item_agent === 'dev-agent' ? '开发' : '验证'}步骤：${reason}`, actor, row.task_id);
      db.prepare(`DELETE FROM resource_claims WHERE owner_execution_id IN (
        SELECT execution_id FROM execution_attempts WHERE work_item_id = ? AND task_id = ?
      )`).run(row.item_id, row.task_id);
      resolveInterventionInDb(db, { interventionId: row.intervention_id, resolution: reason, resolvedBy: actor, commandAudit });
    }).immediate();
    return;
  }
  if (row.item_agent === 'dev-agent') {
    if (detail.task.analysis_index < storyIndex || detail.task.dev_index !== storyIndex - 1) {
      throw new Error('当前 Dev Work Item 已过期或其上游尚未完成，不能仲裁推进');
    }
    await updateTask(row.task_id, 'system', {
      agile_status: detail.task.agile_status === 'in feedback' ? 'in feedback' : 'in dev',
      current_subagent: 'dev-agent',
      dev_index: storyIndex,
      next_step: `仲裁完成交付单元 ${storyIndex} 的开发步骤：${reason}`,
    });
    const db = await databaseConnection();
    setTaskLaneStateInDb(db, { taskId: row.task_id, lane: 'delivery', status: 'runnable' });
  } else {
    if (detail.task.dev_index < storyIndex || detail.task.test_index !== storyIndex - 1) {
      throw new Error('当前 Test Work Item 已过期或其上游尚未完成，不能仲裁推进');
    }
    const complete = storyIndex === detail.task.total_stories
      && detail.task.dev_index === detail.task.total_stories
      && detail.task.analysis_index === detail.task.total_stories;
    await updateTask(row.task_id, 'system', {
      agile_status: detail.task.agile_status === 'in feedback' ? 'in feedback' : complete ? 'in review' : 'in dev',
      current_subagent: detail.task.agile_status === 'in feedback' ? 'test-agent' : complete ? 'review-agent' : 'test-agent',
      test_index: storyIndex,
      next_step: `仲裁完成交付单元 ${storyIndex} 的验证步骤：${reason}`,
    });
    const db = await databaseConnection();
    setTaskLaneStateInDb(db, {
      taskId: row.task_id,
      lane: 'delivery',
      status: complete ? 'completed' : 'runnable',
    });
    releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, row.task_id);
  }
  db.prepare(`
    UPDATE workflow_items
    SET completion_authority = 'arbitration', completion_reason = ?,
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE item_id = ? AND status = 'completed'
  `).run(reason, row.item_id);
  await resolveIntervention({
    interventionId: row.intervention_id,
    resolution: reason,
    resolvedBy: actor,
    commandAudit,
  });
}

export async function runInterventionCommand(input: {
  interventionId: string;
  sessionId: string;
  token: string;
  args: string[];
}) {
  const db = await databaseConnection();
  return executeInterventionCommand(authorizedIntervention(db, input), input, 'system-assistance-agent');
}

/** Same command dispatcher, separate trusted human entrypoint. No system
 * session is forged and no human action is charged as a system attempt. */
export async function runHumanArbitrationCommand(input: {
  taskId: string; interventionId: string; args: string[];
}) {
  const db = await databaseConnection();
  const row = interventionCommandScopeInDb(db, input.interventionId);
  if (!row || row.task_id !== input.taskId || row.authority !== 'arbitration') throw new Error('当前需求没有该仲裁事项');
  const audit = parseInterventionCommand(input.args, 'human').audit;
  if (audit.command === 'intervention status') return renderInterventionStatus(row, 'human');
  if (!['intervention task-rewind', 'intervention work-item-complete'].includes(audit.command)) {
    throw new Error('人工仲裁必须使用现有的 task-rewind 或 work-item-complete 命令');
  }
  if (row.status === 'resolved') {
    const prior = JSON.parse(row.context_json || '{}').appliedCommand as typeof audit | undefined;
    if (prior?.hash !== audit.hash || prior.actor !== 'human') throw new Error('该仲裁已有裁决，不能改写');
    return '该人工仲裁已处理，未重复推进流程。';
  }
  if (row.status !== 'awaiting_human') throw new Error('系统尚未交接人工或该仲裁已经结束');
  const task = db.prepare('SELECT is_paused, agile_status, workflow_engine FROM tasks WHERE task_id = ?').get(input.taskId) as
    { is_paused: number; agile_status: string; workflow_engine: string };
  if (task.is_paused || workflowEndedInDb(db, row.task_id)) throw new Error('已暂停或结束的需求不能仲裁推进');
  if (task.workflow_engine !== 'native') throw new Error('人工仲裁入口仅适用于原生工作图');
  return executeInterventionCommand(row, input, 'human');
}

function parseInterventionCommand(args: string[], actor: 'system-assistance-agent' | 'human') {
  const commandParts: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (!item.startsWith('--')) {
      commandParts.push(item);
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${item} 必须提供值`);
    flags.set(item.slice(2), next);
    index += 1;
  }
  const command = commandParts.join(' ');
  const audit = { command, actor, hash: hash(JSON.stringify({ command, actor, flags: [...flags].sort(([a], [b]) => a.localeCompare(b)) })),
    ...(flags.get('to') ? { target: flags.get('to') } : {}) };
  return { command, flags, audit };
}

async function executeInterventionCommand(row: ReturnType<typeof authorizedIntervention>,
  input: { args: string[]; sessionId?: string }, actor: 'system-assistance-agent' | 'human') {
  const { command, flags, audit } = parseInterventionCommand(input.args, actor);
  const db = await databaseConnection();
  if (command === 'intervention status') {
    if (actor === 'human') return renderInterventionStatus(row);
    db.prepare(`
      UPDATE interventions
      SET status_viewed_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE intervention_id = ?
    `).run(input.sessionId, row.intervention_id);
    return renderInterventionStatus({ ...row, status_viewed_session_id: input.sessionId || null });
  }
  if (actor !== 'human' && row.status_viewed_session_id !== input.sessionId) {
    throw new Error('本次启动尚未查看介入事项状态，请先执行 intervention status');
  }
  if (command === 'intervention resolve') {
    if (row.authority === 'arbitration') {
      throw new Error('仲裁事项不能只提交文本结论；请使用 intervention task-rewind 或 defer；自动完成不能替代独立验证');
    }
    const resolution = flags.get('resolution')?.trim();
    if (!resolution) throw new Error('缺少 --resolution 或 --resolution-file');
    await resolveIntervention({
      interventionId: row.intervention_id,
      resolution,
      resolvedBy: actor,
      commandAudit: audit,
    });
    return '介入事项已解决；Harness 将根据持久化的 Work Item 状态继续调度。';
  }
  if (command === 'intervention defer') {
    if (actor === 'human') throw new Error('人工处置不能记为系统尝试');
    const reason = flags.get('reason')?.trim();
    if (!reason) throw new Error('缺少 --reason 或 --reason-file');
    const result = await finishInterventionAttempt({
      interventionId: row.intervention_id,
      reason,
      outcome: 'deferred',
    });
    return result.escalated
      ? `第 ${row.attempt_count}/${row.max_system_attempts} 次尝试未解决，已转交人工。`
      : `第 ${row.attempt_count}/${row.max_system_attempts} 次尝试未解决，系统将启动下一次尝试。`;
  }
  if (command === 'intervention task-rewind') {
    if (row.authority !== 'arbitration') throw new Error('当前介入事项没有仲裁权限');
    let to = flags.get('to');
    if (!to) throw new Error('缺少 --to；原生任务可以使用当前需求的 Work Item 工作键');
    const reason = flags.get('reason')?.trim();
    if (!reason) throw new Error('缺少 --reason 或 --reason-file');
    const native = db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(row.task_id);
    if (native && ['context', 'repro', 'plan'].includes(to)) to = `delivery:${to}`;
    else if (native && ['analysis', 'dev', 'test'].includes(to)) {
      const unit = flags.get('story') ? Number(flags.get('story')) : row.item_story_index;
      if (!unit || !Number.isInteger(unit) || unit < 1) throw new Error('仲裁回退缺少有效交付单元');
      to = `delivery:${to}:${unit}`;
    }
    if (to.includes(':')) {
      const eventKey = `intervention:${row.intervention_id}:rewind`;
      const historical = db.prepare(`SELECT item.item_id FROM workflow_item_events event JOIN workflow_items item
        ON item.item_id = event.item_id WHERE item.task_id = ? AND item.work_key = ?
          AND event.event_type = 'rewind' AND event.event_key = ?`).get(row.task_id, to, eventKey) as { item_id: string } | undefined;
      const target = historical || db.prepare(`SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = ?
        AND origin = 'native' AND status NOT IN ('superseded', 'cancelled')`).get(row.task_id, to) as { item_id: string } | undefined;
      if (!target) throw new Error('--to 必须引用当前需求的原生工作项，不能引用其他需求或已移除的节点');
      if (!historical && db.prepare(`SELECT 1 FROM workflow_item_events event JOIN workflow_items item
        ON item.item_id = event.item_id WHERE item.task_id = ? AND event.event_type = 'rewind' AND event.event_key = ?`)
        .get(row.task_id, eventKey)) throw new Error('当前仲裁已有回退裁决，不能改写目标');
      // The graph rewind invalidates any affected frozen plan itself. Keep
      // that invalidation and the final arbitration receipt in one transaction.
      db.transaction(() => {
        rewindWorkItemsInDb(db, { taskId: row.task_id, targetItemId: target.item_id, eventKey,
          actor, authority: 'arbitration', reason, preserveInterventionId: row.intervention_id });
        projectNativeWorkflowDisplayInDb(db, row.task_id);
        db.prepare('UPDATE tasks SET next_step = ?, last_actor = ? WHERE task_id = ?')
          .run(`仲裁回退到 ${to}：${reason}`, actor, row.task_id);
        resolveInterventionInDb(db, { interventionId: row.intervention_id, resolution: reason, resolvedBy: actor, commandAudit: audit });
      }).immediate();
      return `仲裁已将工作项 ${to} 及其下游切换到新版本，历史证据保留。`;
    }
    if (!['context', 'repro', 'plan', 'analysis', 'dev', 'test'].includes(to)) {
      throw new Error('--to 必须是当前需求的原生工作键，或 context/repro/plan/analysis/dev/test');
    }
    const story = flags.get('story') ? Number(flags.get('story')) : row.item_story_index;
    if (['analysis', 'dev', 'test'].includes(to) && (!story || !Number.isInteger(story) || story < 1)) throw new Error('仲裁回退缺少有效交付单元');
    const { rewindTask } = await import('./tasks');
    await rewindTask({ taskId: row.task_id, actor: 'system', to, story, reason,
      eventKey: `intervention:${row.intervention_id}:rewind`, preserveInterventionId: row.intervention_id });
    await resolveIntervention({
      interventionId: row.intervention_id,
      resolution: reason,
      resolvedBy: actor,
      commandAudit: audit,
    });
    return `仲裁已按现有 task-rewind 语义回退到 ${to}${story ? `（交付单元 ${story}）` : ''}。`;
  }
  if (command === 'intervention work-item-complete') {
    const reason = flags.get('reason')?.trim();
    if (!reason) throw new Error('缺少 --reason 或 --reason-file');
    await completeWorkItemByArbitration(row, reason, actor, audit);
    return '当前 Work Item 已由仲裁完成；原始失败证据保持不变，流程将继续。';
  }
  throw new Error(`未知命令：${command || '(empty)'}。请使用 intervention status`);
}

export async function interventionStatus(interventionId: string) {
  const db = await databaseConnection();
  return db.prepare('SELECT * FROM interventions WHERE intervention_id = ?')
    .get(interventionId) as InterventionRow | undefined;
}

export async function reconcileInterventions() {
  const db = await databaseConnection();
  const stale = db.prepare(`
    SELECT intervention.intervention_id, intervention.task_id, execution.status AS execution_status,
           task.is_paused, task.agile_status
    FROM interventions intervention
    JOIN tasks task ON task.task_id = intervention.task_id
    LEFT JOIN execution_attempts execution
      ON execution.execution_id = intervention.current_execution_id
    WHERE intervention.status = 'running'
      AND (execution.execution_id IS NULL OR execution.status NOT IN ('planned', 'running'))
  `).all() as { intervention_id: string; task_id: string; execution_status: string | null; is_paused: number; agile_status: string }[];
  for (const item of stale) {
    if (item.execution_status === 'cancelled' || item.is_paused || workflowEndedInDb(db, item.task_id)) {
      await cancelInterventionAttempt(item.intervention_id, '系统辅助 Agent 上次运行因停止、暂停或取消而中断');
      continue;
    }
    await finishInterventionAttempt({
      interventionId: item.intervention_id,
      reason: '系统辅助 Agent 上次运行未正常收尾，已由 Runner 恢复并重新尝试',
      outcome: 'failed',
    });
  }
  return stale.length;
}
