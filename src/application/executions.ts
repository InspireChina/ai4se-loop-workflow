import { randomUUID } from 'node:crypto';
import { hash } from '../infrastructure/database';
import { databaseConnection } from '../infrastructure/database';
import type { DelegationEnvelope } from './tasks';

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
  lease_owner: string | null;
  lease_expires_at: string | null;
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

export async function reconcileStaleExecutions() {
  const db = await databaseConnection();
  return db.prepare(`
    UPDATE execution_attempts
    SET status = 'retryable_failed',
        last_error = COALESCE(last_error, '执行进程在返回结构化输出前失去租约'),
        finished_at = CURRENT_TIMESTAMP
    WHERE status IN ('planned', 'running')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < CURRENT_TIMESTAMP
  `).run().changes;
}

export async function beginExecutionAttempt(input: {
  runId: string;
  delegation: DelegationEnvelope;
  prompt: string;
  baseCommit?: string;
  leaseMinutes?: number;
  promptVersion?: number;
  promptHash?: string;
  memoryRevision?: number;
  memoryHash?: string;
  evolutionCandidateId?: string | null;
}) {
  const db = await databaseConnection();
  const inputJson = JSON.stringify({ delegation: input.delegation, prompt: input.prompt });
  const inputHash = hash(inputJson);
  const key = delegationKey(input.delegation, inputHash);
  const previous = db.prepare(`
    SELECT * FROM execution_attempts
    WHERE delegation_key = ?
    ORDER BY attempt DESC LIMIT 1
  `).get(key) as ExecutionAttempt | undefined;
  if (previous && RECOVERABLE.includes(previous.status as typeof RECOVERABLE[number])) {
    return { attempt: previous, recovered: true };
  }
  if (previous?.status === 'applied') return { attempt: previous, recovered: true };

  const attemptNumber = (previous?.attempt || 0) + 1;
  const executionId = randomUUID();
  const leaseMinutes = Math.max(1, Math.min(input.leaseMinutes || 40, 24 * 60));
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline,
      delegation_key, attempt, status, input_hash, input_json, base_commit,
      prompt_version, prompt_hash, memory_revision, memory_hash, evolution_candidate_id,
      lease_owner, lease_expires_at, heartbeat_at, started_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    executionId,
    input.runId,
    input.delegation.taskId,
    input.delegation.storyIndex,
    input.delegation.agent,
    input.delegation.pipeline,
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
    input.runId,
    `+${leaseMinutes} minutes`,
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
    SET status = 'output_received', result_json = ?, heartbeat_at = CURRENT_TIMESTAMP,
        lease_expires_at = datetime('now', '+40 minutes')
    WHERE execution_id = ?
  `).run(JSON.stringify(result), executionId);
}

export async function markExecutionStage(executionId: string, status: 'verifying' | 'applying') {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = ?, heartbeat_at = CURRENT_TIMESTAMP, lease_expires_at = datetime('now', '+40 minutes')
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
    SET status = 'applied', finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP,
        lease_expires_at = NULL
    WHERE execution_id = ?
  `).run(executionId);
}

export async function failExecution(executionId: string, error: string, blocked = false) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE execution_attempts
    SET status = ?, last_error = ?, finished_at = CURRENT_TIMESTAMP,
        heartbeat_at = CURRENT_TIMESTAMP, lease_expires_at = NULL
    WHERE execution_id = ?
  `).run(blocked ? 'system_blocked' : 'retryable_failed', error, executionId);
}
