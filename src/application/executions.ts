import { randomUUID } from 'node:crypto';
import { hash } from '../infrastructure/database';
import { databaseConnection } from '../infrastructure/database';
import type { DelegationEnvelope } from './tasks';
import { laneForAgent } from './task-lanes';

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
  prompt_version: number | null;
  prompt_hash: string | null;
  memory_revision: number | null;
  memory_hash: string | null;
  evolution_candidate_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const RECOVERABLE = ['output_received', 'verifying', 'applying'] as const;

function delegationKey(delegation: DelegationEnvelope, inputHash: string) {
  return hash(JSON.stringify({
    taskId: delegation.taskId,
    lane: delegation.lane,
    storyIndex: delegation.storyIndex,
    agent: delegation.agent,
    pipeline: delegation.pipeline,
    analysisIndex: delegation.analysisIndex,
    devIndex: delegation.devIndex,
    testIndex: delegation.testIndex,
    reviewRevision: delegation.reviewRevision,
    inputHash,
  }));
}

function retrySignature(delegation: DelegationEnvelope) {
  const base = {
    taskId: delegation.taskId,
    lane: delegation.lane || laneForAgent(delegation.agent),
    storyIndex: delegation.storyIndex,
    agent: delegation.agent,
    pipeline: delegation.pipeline,
    feedbackId: delegation.feedbackId || null,
  };
  if (delegation.lane === 'analysis') return JSON.stringify({
    ...base,
    analysisIndex: delegation.analysisIndex,
    specResolvedIndex: delegation.specResolvedIndex,
    totalStories: delegation.totalStories,
  });
  if (delegation.lane === 'delivery') return JSON.stringify({
    ...base,
    devIndex: delegation.devIndex,
    testIndex: delegation.testIndex,
  });
  return JSON.stringify({
    ...base,
    agileStatus: delegation.agileStatus,
    analysisIndex: delegation.analysisIndex,
    devIndex: delegation.devIndex,
    testIndex: delegation.testIndex,
    totalStories: delegation.totalStories,
    reviewRevision: delegation.reviewRevision,
  });
}

function storedRetrySignature(attempt: ExecutionAttempt) {
  try {
    const snapshot = JSON.parse(attempt.input_json) as { delegation?: DelegationEnvelope };
    return snapshot.delegation ? retrySignature(snapshot.delegation) : null;
  } catch {
    return null;
  }
}

export async function reconcileInterruptedExecutions(runId: string | null, reason: string) {
  const db = await databaseConnection();
  const scope = runId ? 'AND execution_attempts.run_id = ?' : '';
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
  const failedCount = db.prepare(`
    UPDATE execution_attempts
    SET status = 'retryable_failed',
        last_error = ?,
        finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP
    WHERE status IN ('planned', 'running')
      AND result_json IS NULL
      ${scope}
      AND NOT EXISTS (
        SELECT 1 FROM agent_results
        WHERE agent_results.execution_id = execution_attempts.execution_id
          AND agent_results.application_status = 'pending'
      )
  `).run(reason, ...(runId ? [runId] : [])).changes;
  const recoverableCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_attempts
    WHERE status IN ('output_received', 'verifying', 'applying')
      AND result_json IS NOT NULL
      ${scope}
  `).get(...(runId ? [runId] : [])) as { count: number }).count;
  return { failedCount, recoverableCount, pendingResultCount };
}

export async function beginExecutionAttempt(input: {
  runId: string;
  delegation: DelegationEnvelope;
  prompt: string;
  baseCommit?: string;
  promptVersion?: number;
  promptHash?: string;
  memoryRevision?: number;
  memoryHash?: string;
  evolutionCandidateId?: string | null;
}) {
  const db = await databaseConnection();
  const inputJson = JSON.stringify({ delegation: input.delegation, prompt: input.prompt });
  const inputHash = hash(inputJson);
  let key = delegationKey(input.delegation, inputHash);
  let previous = db.prepare(`
    SELECT * FROM execution_attempts
    WHERE delegation_key = ?
    ORDER BY attempt DESC LIMIT 1
  `).get(key) as ExecutionAttempt | undefined;
  const latestLogical = db.prepare(`
    SELECT * FROM execution_attempts
    WHERE task_id = ? AND story_index IS ? AND agent = ? AND pipeline = ?
      AND COALESCE(lane, CASE
        WHEN agent = 'analyst-agent' THEN 'analysis'
        WHEN agent IN ('dev-agent', 'test-agent') THEN 'delivery'
        ELSE 'control'
      END) = ?
    ORDER BY rowid DESC
    LIMIT 1
  `).get(
    input.delegation.taskId,
    input.delegation.storyIndex,
    input.delegation.agent,
    input.delegation.pipeline,
    input.delegation.lane || laneForAgent(input.delegation.agent),
  ) as ExecutionAttempt | undefined;
  if (latestLogical?.status === 'retryable_failed' && storedRetrySignature(latestLogical) === retrySignature(input.delegation)) {
    key = latestLogical.delegation_key;
    previous = latestLogical;
  }
  if (previous && RECOVERABLE.includes(previous.status as typeof RECOVERABLE[number])) {
    return { attempt: previous, recovered: true };
  }
  if (previous?.status === 'applied') return { attempt: previous, recovered: true };

  const attemptNumber = (previous?.attempt || 0) + 1;
  const executionId = randomUUID();
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline, lane,
      delegation_key, attempt, status, input_hash, input_json, base_commit,
      prompt_version, prompt_hash, memory_revision, memory_hash, evolution_candidate_id,
      heartbeat_at, started_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    executionId,
    input.runId,
    input.delegation.taskId,
    input.delegation.storyIndex,
    input.delegation.agent,
    input.delegation.pipeline,
    input.delegation.lane || laneForAgent(input.delegation.agent),
    key,
    attemptNumber,
    inputHash,
    inputJson,
    input.baseCommit || null,
    input.promptVersion || null,
    input.promptHash || null,
    input.memoryRevision || null,
    input.memoryHash || null,
    input.evolutionCandidateId || null,
  );
  const attempt = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId) as ExecutionAttempt;
  return { attempt, recovered: false };
}

export async function recoverNextExecutionAttempt() {
  const db = await databaseConnection();
  return db.prepare(`
    SELECT * FROM execution_attempts
    WHERE status IN ('output_received', 'verifying', 'applying')
      AND result_json IS NOT NULL
    ORDER BY created_at, execution_id
    LIMIT 1
  `).get() as ExecutionAttempt | undefined;
}

export async function markExecutionOutput(executionId: string, result: unknown) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(JSON.stringify(result), executionId);
}

export async function markExecutionStage(executionId: string, status: 'verifying' | 'applying') {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
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
    WHERE execution_id = ?
  `).run(executionId);
}

export async function failExecution(executionId: string, error: string, blocked = false) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = ?, last_error = ?, finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(blocked ? 'system_blocked' : 'retryable_failed', error, executionId);
}
