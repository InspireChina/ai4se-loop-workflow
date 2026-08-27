import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { deliveryUnitContractSchema } from '../domain/delivery-unit';
import { CODE_WORKSPACE_RESOURCE } from '../domain/resource';
import { parseRequirementMetadata, type RequirementMetadataKey } from '../domain/requirement-metadata';
import { DEFAULT_REQUIREMENT_PRIORITY, requirementPriority, requirementPriorityRank } from '../domain/requirement-priority';
import { AgentResultContractError, assertDeliverySpecDecisionCoverage, deliverySpecSchema } from '../domain/agent-result';
import { agentCommandProfile } from '../domain/agent-command-profile';
import { databaseConnection, paths } from '../infrastructure/database';
import { registerManagedProcessInDb } from '../infrastructure/managed-process-registry';
import { isProcessAlive, readRunPid } from '../infrastructure/run-process';
import { toUtcIsoString } from './event-time';
import { recordLoopLogEventInDb } from './runtime-events';
import {
  ensureTaskLanesInDb,
  laneForAgent,
  refreshTaskLaneStatesInDb,
  setTaskLaneStateInDb,
  taskLaneInDb,
  taskLanesInDb,
  type TaskLane,
  type TaskLaneKind,
} from './task-lanes';
import { insertDeliveryUnitContractsInDb } from './delivery-units';
import {
  releaseResourceClaimInDb,
  releaseExecutionResourceClaimsInDb,
  releaseLaneExecutionResourceClaimsInDb,
  releaseTaskResourceClaimsInDb,
} from './resource-claims';
import {
  assertActorCanCreate,
  assertState,
  assertUpdate,
  type Actor,
  type Delegation,
  type TaskState,
  type TaskStatus,
} from '../domain/task';
import type { RecoveryItem } from './recovery-items';
import { cancelFeedbackForTask } from './feedback';
import { advanceAndPublishRuntimeInvalidation, advanceRuntimeEventRevisionInDb, publishRuntimeInvalidation } from './runtime-events';
import {
  configureRequirementDependenciesInDb,
  requirementDependenciesInDb,
  requirementDependencyCandidatesInDb,
  requirementDependencyGateOpenInDb,
  requirementDependencySatisfied,
  type RequirementDependency,
} from './task-dependencies';
import { queueVerificationAssistanceInDb } from './verification-assistance';

export type Task = TaskState & {
  title: string;
  description: string | null;
  item_type: string;
  priority: string | null;
  link: string | null;
  external_id: string | null;
  external_status: string | null;
  next_step: string | null;
  last_actor: string | null;
  owner: string | null;
  evidence: string | null;
  risk: string | null;
  is_paused: number;
  paused_reason: string | null;
  paused_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  retry_cycle: number;
};
export type TaskWithLanes = Task & {
  lanes: TaskLane[];
  dependencies: RequirementDependency[];
  dependency_gate_open: boolean;
  verification_assistance_pending_count: number;
  verification_assistance_running_count: number;
  verification_assistance_escalated_count: number;
  verification_assistance_attempt: number;
  verification_assistance_max_attempts: number;
};

export type RequirementMetadata = {
  task_id: string;
  metadata_key: RequirementMetadataKey;
  metadata_value: string;
  created_at: string;
  updated_at: string;
};

export type Story = {
  task_id: string;
  story_index: number;
  title: string;
  directory: string;
  origin_type: 'original' | 'feedback_behavior' | 'feedback_bug' | 'feedback_scope' | 'feedback_technical';
  origin_feedback_batch_id: string | null;
  corrects_story_indexes_json: string | null;
  unit_key: string | null;
  actor: string | null;
  trigger_condition: string | null;
  observable_outcome: string | null;
  acceptance: string | null;
  source_delivery_plan_draft_id: string | null;
  context_links: {
    source_key: string;
    source_kind: 'change' | 'preserve' | 'technical' | 'acceptance';
    content: string;
    source_ref: string;
  }[];
  depends_on_story_indexes: number[];
};
export type DeliverySpecRecord = { spec_id: string; task_id: string; story_index: number; revision: number; status: 'draft' | 'waiting_for_answers' | 'resolved' | 'superseded'; spec_json: string; source_result_id: string | null; created_at: string; resolved_at: string | null };
export type Document = {
  document_id: string;
  task_id: string;
  story_index: number | null;
  kind: string;
  title: string;
  content: string;
  format: string;
  revision: number;
  source_agent: string | null;
  created_at: string;
  updated_at: string;
};
export type DocumentComment = {
  comment_id: string;
  document_id: string;
  task_id: string;
  document_revision: number;
  agent_id: string | null;
  anchor_type: 'file' | 'selection';
  quoted_text: string | null;
  start_offset: number | null;
  end_offset: number | null;
  content: string;
  status: 'open' | 'resolved';
  intent: 'note' | 'question' | 'change_request';
  feedback_status: 'submitted' | 'triaged' | 'in_progress' | 'verifying' | 'resolved' | 'reopened';
  disposition: 'no_change' | 'reply' | 'revise' | 'rewind' | 'learning_only' | null;
  target_stage: 'context' | 'repro' | 'plan' | 'analysis' | 'dev' | 'test' | 'review' | null;
  target_agent: string | null;
  target_story_index: number | null;
  acceptance_json: string | null;
  triage_reason: string | null;
  resolution_claim_json: string | null;
  verification_json: string | null;
  triaged_at: string | null;
  submitted_at: string;
  feedback_batch_id: string | null;
  feedback_is_rewind_frontier: number;
  feedback_needs_rebase: number;
  evolution_status: 'pending' | 'analyzed';
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};
export type FeedbackBatch = {
  batch_id: string;
  task_id: string;
  batch_number: number;
  status: 'triaging' | 'waiting_for_answers' | 'executing' | 'verifying' | 'reporting' | 'completed' | 'cancelled' | 'system_blocked';
  source_execution_id: string | null;
  summary: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};
export type FeedbackGroup = {
  group_id: string;
  batch_id: string;
  group_order: number;
  group_key: string;
  work_type: 'reply' | 'historical_correction' | 'report_correction' | 'bug' | 'behavior_change' | 'scope_addition' | 'technical_change' | 'learning_only';
  status: 'planned' | 'waiting_for_repro' | 'waiting_for_plan' | 'executing' | 'ready_for_verification' | 'completed' | 'reopened' | 'cancelled' | 'system_blocked';
  title: string | null;
  reason: string;
  acceptance_json: string;
  affected_story_indexes_json: string;
  response_text: string | null;
  source_execution_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  comment_ids?: string[];
  delivery_unit_indexes?: number[];
};
export type Question = {
  question_id: string;
  task_id: string;
  story_index: number | null;
  title: string;
  question: string;
  why: string | null;
  recommendation: string | null;
  answer: string | null;
  status: string;
  relative_path: string | null;
  source_agent: string | null;
  kind: string;
  decision_key: string | null;
  alternatives_json: string | null;
  recommendation_reason: string | null;
  depends_on_json: string | null;
  activation_json: string | null;
  selected_option_id: string | null;
  status_reason: string | null;
  decision_authority: 'human' | 'agent';
  spec_revision: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};
export type RuntimeInputRequest = {
  request_id: string;
  task_id: string;
  story_index: number | null;
  source_agent: string;
  request_key: string | null;
  title: string;
  question: string;
  why: string | null;
  recommendation: string | null;
  answer: string | null;
  status: 'pending' | 'answered' | 'resolved' | 'superseded';
  source_execution_id: string | null;
  resolved_execution_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  assistance_job_id: string | null;
  assistance_status: 'pending' | 'running' | 'resolved' | 'escalated' | 'cancelled' | null;
  assistance_attempt_count: number | null;
  assistance_max_attempts: number | null;
  assistance_last_reason: string | null;
};
export type ClosureAcknowledgement = { acknowledgement_id: string; task_id: string; review_document_id: string; review_revision: number; acknowledged_by: string; acknowledged_at: string };
export type ExecutionAttemptView = { execution_id: string; run_id: string; task_id: string; story_index: number | null; agent: string; pipeline: string; lane: string | null; attempt: number; status: string; input_hash: string; base_commit: string | null; code_commit: string | null; verification_id: string | null; prompt_version: number | null; prompt_template_version: number | null; prompt_hash: string | null; memory_revision: number | null; memory_hash: string | null; evolution_candidate_id: string | null; executor_id: string | null; configured_model: string | null; reasoning_effort: string | null; result_outcome: string | null; result_verdict: string | null; result_summary: string | null; last_error: string | null; retry_not_before: string | null; dispatch_generation_key: string | null; dispatch_execution_exited_at: string | null; dispatch_settled_at: string | null; claimed_resources: string | null; created_at: string; started_at: string | null; finished_at: string | null };
export type Event = { event_id: string; actor: string; event_type: string; summary: string; created_at: string };
export type RunStatus = {
  runId: string;
  owner: string;
  startedAt: string;
  heartbeatAt: string | null;
  processKind: string | null;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  pid: number | null;
  active: boolean;
  health: {
    starting: boolean;
    pidAlive: boolean;
    heartbeatFresh: boolean;
    heartbeatAgeMs: number | null;
    generationActive: boolean;
  };
} | null;
export type RunLogChunk = { lastId: number; raw: string };
export type DelegationEnvelope = Delegation & {
  title: string;
  taskDescription: string | null;
  itemType: string;
  priority: string;
  link: string;
  externalId: string;
  externalStatus: string;
  agileStatus: string;
  currentSubagent: string;
  resumePending: number;
  specResolvedIndex: number;
  runState: string;
  closureStatus: string;
  reviewRevision: number;
  reviewDocumentId: string;
  lastActor: string;
  analysisIndex: number;
  devIndex: number;
  testIndex: number;
  totalStories: number;
  nextStep: string;
  blockedReason: string;
  owner: string;
  evidence: string;
  risk: string;
  retryCycle?: number;
};

const taskSelect = `
  SELECT task_id, title, description, link, external_id, external_status, item_type, priority,
         agile_status, current_subagent, analysis_index, dev_index, test_index,
         total_stories, spec_resolved_index, resume_status,
         resume_pending, next_step, blocked_reason, run_state, closure_status,
         review_revision, review_document_id, closure_acknowledged_at,
         last_actor, owner, evidence, risk, is_paused, paused_reason, paused_at,
         created_at, updated_at, completed_at, retry_cycle
  FROM tasks
`;

function fetchTask(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string) {
  return db.prepare(`${taskSelect} WHERE task_id = ?`).get(taskId) as Task | undefined;
}

function addEvent(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string, actor: Actor | 'system', eventType: string, summary: string) {
  db.prepare('INSERT INTO task_events(event_id, task_id, actor, event_type, summary) VALUES(?, ?, ?, ?, ?)').run(randomUUID(), taskId, actor, eventType, summary);
  appendActiveRunLog(db, `[事件] ${actor} ${eventType} ${taskId} - ${summary}`);
}

function loopLogLine(message: string) {
  return `${toUtcIsoString()} ${message}\n`;
}

function appendRuntimeEventWarningInDb(db: Awaited<ReturnType<typeof databaseConnection>>, runId: string, message: string) {
  try {
    db.prepare('INSERT INTO run_logs(run_id, line) VALUES(?, ?)').run(runId, loopLogLine(`[警告] ${message}`));
  } catch { /* the primary operation must not depend on its degradation signal */ }
}

export async function recordRuntimeEventWithFallback(runId: string, warning: string, record: () => Promise<number>) {
  try {
    return await record();
  } catch {
    try {
      appendRuntimeEventWarningInDb(await databaseConnection(), runId, warning);
    } catch { /* the primary operation must not depend on its degradation signal */ }
    return null;
  }
}

function appendRunLogInDb(db: Awaited<ReturnType<typeof databaseConnection>>, runId: string, message: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('invalid run id');
  db.prepare('INSERT INTO run_logs(run_id, line) VALUES(?, ?)').run(runId, loopLogLine(message));
  try {
    recordLoopLogEventInDb(db, runId, message);
  } catch (error) {
    // The text log is the durable primary record. Do not retry the failed mirror here:
    // that would recurse when runtime_events is unavailable.
    appendRuntimeEventWarningInDb(db, runId, '结构化运行时事件写入失败，已保留文本日志');
  }
}

export async function appendLoopRunLog(runId: string, message: string) {
  const db = await databaseConnection();
  appendRunLogInDb(db, runId, message);
}

export async function readLoopRunLogChunk(runId: string, afterId = 0): Promise<RunLogChunk> {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('invalid run id');
  const db = await databaseConnection();
  const rows = db.prepare('SELECT log_id, line FROM run_logs WHERE run_id = ? AND log_id > ? ORDER BY log_id').all(runId, afterId) as { log_id: number; line: string }[];
  return {
    lastId: rows.length ? rows[rows.length - 1].log_id : afterId,
    raw: rows.map((row) => row.line).join(''),
  };
}

function appendActiveRunLog(db: Awaited<ReturnType<typeof databaseConnection>>, message: string) {
  const run = getRunStatusFromDb(db);
  if (!run?.active) return;
  appendRunLogInDb(db, run.runId, message);
}

function refreshPages(...pagePaths: string[]) {
  void advanceAndPublishRuntimeInvalidation('dispatch.invalidated').catch(() => undefined);
  for (const pagePath of pagePaths) {
    try {
      revalidatePath(pagePath);
    } catch {
      // CLI usage runs outside Next's request context; database/file writes are still complete.
    }
  }
}

async function syncTaskFiles(_db: Awaited<ReturnType<typeof databaseConnection>>, _taskId: string, _options: { createClearedBlock?: boolean } = {}) {
  // DB-first product mode: target repo files are no longer generated or synchronized.
}

export async function listTasks(options: { includeTerminal?: boolean } = {}): Promise<TaskWithLanes[]> {
  const db = await databaseConnection();
  const where = options.includeTerminal ? '' : "WHERE agile_status NOT IN ('done', 'cancelled')";
  const tasks = db.prepare(`
    ${taskSelect}
    ${where}
  `).all() as Task[];
  tasks.sort((left, right) => Number(right.agile_status === 'blocked') - Number(left.agile_status === 'blocked')
    || requirementPriorityRank(right.priority) - requirementPriorityRank(left.priority)
    || right.updated_at.localeCompare(left.updated_at));
  return tasks.map((task) => {
    refreshTaskLaneStatesInDb(db, task);
    const assistance = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) AS escalated_count,
        COALESCE(MAX(attempt_count), 0) AS attempt,
        COALESCE(MAX(max_attempts), 0) AS max_attempts
      FROM verification_assistance_jobs
      WHERE task_id = ? AND status IN ('pending', 'running', 'escalated')
    `).get(task.task_id) as {
      pending_count: number | null;
      running_count: number | null;
      escalated_count: number | null;
      attempt: number;
      max_attempts: number;
    };
    return {
      ...task,
      lanes: taskLanesInDb(db, task),
      dependencies: requirementDependenciesInDb(db, task.task_id),
      dependency_gate_open: requirementDependencyGateOpenInDb(db, task.task_id),
      verification_assistance_pending_count: assistance.pending_count || 0,
      verification_assistance_running_count: assistance.running_count || 0,
      verification_assistance_escalated_count: assistance.escalated_count || 0,
      verification_assistance_attempt: assistance.attempt,
      verification_assistance_max_attempts: assistance.max_attempts,
    };
  });
}

export async function listRequirementDependencyCandidates() {
  const db = await databaseConnection();
  return requirementDependencyCandidatesInDb(db);
}

/**
 * Returns completed Tasks only. Cancelled Tasks are a separate terminal state
 * and deliberately do not appear in this result.
 */
export async function listCompletedTasks(): Promise<Task[]> {
  const db = await databaseConnection();
  return db.prepare(`
    ${taskSelect}
    WHERE agile_status = 'done'
    ORDER BY COALESCE(completed_at, updated_at) DESC
  `).all() as Task[];
}

export async function listRecentEvents(limit = 20): Promise<(Event & { task_id: string; title: string })[]> {
  const db = await databaseConnection();
  return db.prepare(`
    SELECT e.event_id, e.task_id, t.title, e.actor, e.event_type, e.summary, e.created_at
    FROM task_events e
    JOIN tasks t ON t.task_id = e.task_id
    ORDER BY e.created_at DESC, e.rowid DESC
    LIMIT ?
  `).all(limit) as (Event & { task_id: string; title: string })[];
}

export async function getTask(taskId: string) {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task) return null;
  const metadata = db.prepare(`
    SELECT task_id, metadata_key, metadata_value, created_at, updated_at
    FROM requirement_metadata
    WHERE task_id = ?
    ORDER BY created_at, metadata_key
  `).all(taskId) as RequirementMetadata[];
  const taskDependencies = requirementDependenciesInDb(db, taskId);
  const storyRows = db.prepare('SELECT * FROM stories WHERE task_id = ? ORDER BY story_index')
    .all(taskId) as Omit<Story, 'context_links' | 'depends_on_story_indexes'>[];
  const contextLinks = db.prepare(`
    SELECT story_index, source_key, source_kind, content, source_ref
    FROM delivery_unit_context_links
    WHERE task_id = ?
    ORDER BY story_index, source_key
  `).all(taskId) as (Story['context_links'][number] & { story_index: number })[];
  const dependencies = db.prepare(`
    SELECT story_index, depends_on_story_index
    FROM delivery_unit_dependencies
    WHERE task_id = ?
    ORDER BY story_index, depends_on_story_index
  `).all(taskId) as { story_index: number; depends_on_story_index: number }[];
  const stories: Story[] = storyRows.map((story) => ({
    ...story,
    context_links: contextLinks
      .filter((link) => link.story_index === story.story_index)
      .map(({ story_index: _storyIndex, ...link }) => link),
    depends_on_story_indexes: dependencies
      .filter((dependency) => dependency.story_index === story.story_index)
      .map((dependency) => dependency.depends_on_story_index),
  }));
  const deliverySpecs = db.prepare('SELECT * FROM story_specs WHERE task_id = ? ORDER BY story_index, revision').all(taskId) as DeliverySpecRecord[];
  const questions = db.prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY created_at').all(taskId) as Question[];
  const runtimeInputs = db.prepare(`
    SELECT request.*,
           job.job_id AS assistance_job_id,
           job.status AS assistance_status,
           job.attempt_count AS assistance_attempt_count,
           job.max_attempts AS assistance_max_attempts,
           job.last_reason AS assistance_last_reason
    FROM runtime_input_requests request
    LEFT JOIN verification_assistance_jobs job ON job.request_id = request.request_id
    WHERE request.task_id = ?
    ORDER BY request.created_at
  `).all(taskId) as RuntimeInputRequest[];
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY story_index, kind, updated_at').all(taskId) as Document[];
  const documentComments = db.prepare('SELECT * FROM document_comments WHERE task_id = ? ORDER BY created_at').all(taskId) as DocumentComment[];
  const feedbackBatches = db.prepare(`
    SELECT * FROM feedback_batches WHERE task_id = ? ORDER BY batch_number
  `).all(taskId) as FeedbackBatch[];
  const feedbackGroups = db.prepare(`
    SELECT feedback_group.*
    FROM feedback_groups feedback_group
    JOIN feedback_batches feedback_batch ON feedback_batch.batch_id = feedback_group.batch_id
    WHERE feedback_batch.task_id = ?
    ORDER BY feedback_batch.batch_number, feedback_group.group_order
  `).all(taskId) as FeedbackGroup[];
  for (const group of feedbackGroups) {
    group.comment_ids = (db.prepare(`
      SELECT comment_id FROM feedback_group_comments WHERE group_id = ? ORDER BY comment_id
    `).all(group.group_id) as { comment_id: string }[]).map((row) => row.comment_id);
    group.delivery_unit_indexes = (db.prepare(`
      SELECT story_index FROM feedback_group_delivery_units
      WHERE group_id = ? AND task_id = ? ORDER BY story_index
    `).all(group.group_id, taskId) as { story_index: number }[]).map((row) => row.story_index);
  }
  const closureAcknowledgements = db.prepare('SELECT * FROM closure_acknowledgements WHERE task_id = ? ORDER BY review_revision').all(taskId) as ClosureAcknowledgement[];
  refreshTaskLaneStatesInDb(db, task);
  const lanes = taskLanesInDb(db, task);
  const executionAttempts = db.prepare(`
    SELECT execution_id, run_id, task_id, story_index, agent, pipeline, lane, attempt, status,
           input_hash, base_commit, code_commit, verification_id,
           prompt_version, prompt_template_version, prompt_hash, memory_revision, memory_hash, evolution_candidate_id,
           executor_id, configured_model, reasoning_effort, last_error, retry_not_before,
           dispatch_generation_key, dispatch_execution_exited_at, dispatch_settled_at,
           (SELECT GROUP_CONCAT(value, ', ')
            FROM json_each(execution_attempts.dispatch_reservation_json, '$.claimedResources')) AS claimed_resources,
           json_extract(result_json, '$.outcome') AS result_outcome,
           json_extract(result_json, '$.verdict') AS result_verdict,
           json_extract(result_json, '$.summary') AS result_summary,
           created_at, started_at, finished_at
    FROM execution_attempts
    WHERE task_id = ?
    ORDER BY created_at, execution_id
  `).all(taskId) as ExecutionAttemptView[];
  const recoveryItems = db.prepare(`
    SELECT * FROM recovery_items
    WHERE task_id = ?
    ORDER BY created_at, recovery_id
  `).all(taskId) as RecoveryItem[];
  const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC, rowid DESC').all(taskId) as Event[];
  return {
    task,
    metadata,
    dependencies: taskDependencies,
    dependencyGateOpen: requirementDependencyGateOpenInDb(db, taskId),
    lanes,
    stories,
    deliverySpecs,
    questions,
    runtimeInputs,
    documents,
    documentComments,
    feedbackBatches,
    feedbackGroups,
    closureAcknowledgements,
    executionAttempts,
    recoveryItems,
    events,
  };
}

export async function getTaskContext(taskId: string) {
  const detail = await getTask(taskId);
  if (!detail) throw new Error(`需求不存在：${taskId}`);
  const questions = detail.questions.map(({ relative_path: _relativePath, ...question }) => question);
  return { ...detail, questions };
}

const documentSchema = z.object({
  taskId: z.string().min(1),
  storyIndex: z.coerce.number().int().positive().optional().nullable(),
  kind: z.string().min(1).max(80),
  title: z.string().min(1).max(240).optional().nullable(),
  content: z.string().max(100000),
  format: z.enum(['markdown', 'json', 'text']).default('markdown'),
  actor: z.enum(['human', 'direct-agent', 'idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent', 'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent']).default('human'),
});

export async function upsertDocument(input: unknown) {
  const value = documentSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  if (value.storyIndex && value.storyIndex > task.total_stories) throw new Error(`交付单元 ${value.storyIndex} 不存在`);
  const title = value.title || `${value.kind}${value.storyIndex ? ` · 交付单元 ${value.storyIndex}` : ''}`;
  db.exec('BEGIN');
  try {
    const existing = db.prepare('SELECT document_id FROM documents WHERE task_id = ? AND story_index IS ? AND kind = ?').get(value.taskId, value.storyIndex || null, value.kind) as { document_id: string } | undefined;
    const storyIndex = value.storyIndex || null;
    const documentId = existing?.document_id || randomUUID();
    if (existing) {
      db.prepare(`
        UPDATE documents
        SET title = ?,
            content = ?,
            format = ?,
            source_agent = ?,
            revision = revision + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE document_id = ?
      `).run(title, value.content, value.format, value.actor, documentId);
    } else {
      db.prepare(`
        INSERT INTO documents(document_id, task_id, story_index, kind, title, content, format, source_agent)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(documentId, value.taskId, storyIndex, value.kind, title, value.content, value.format, value.actor);
    }
    addEvent(db, value.taskId, value.actor, 'DocumentUpserted', `保存文档：${title}`);
    db.exec('COMMIT');
    refreshPages(`/tasks/${value.taskId}`);
    return documentId;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function listDocuments(taskId: string) {
  const db = await databaseConnection();
  return db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY story_index, kind, updated_at').all(taskId) as Document[];
}

export async function getDocument(taskId: string, kind: string, storyIndex?: number | null) {
  const db = await databaseConnection();
  return db.prepare('SELECT * FROM documents WHERE task_id = ? AND kind = ? AND story_index IS ?').get(taskId, kind, storyIndex || null) as Document | undefined;
}

const documentCommentSchema = z.object({
  taskId: z.string().min(1),
  documentId: z.string().min(1),
  anchorType: z.enum(['file', 'selection']).default('file'),
  quotedText: z.string().trim().max(4000).optional().nullable(),
  startOffset: z.coerce.number().int().nonnegative().optional().nullable(),
  endOffset: z.coerce.number().int().nonnegative().optional().nullable(),
  content: z.string().trim().min(1).max(4000),
  intent: z.enum(['note', 'question', 'change_request']).default('change_request'),
});

export async function addDocumentComment(input: unknown) {
  const value = documentCommentSchema.parse(input);
  const db = await databaseConnection();
  const document = db.prepare('SELECT * FROM documents WHERE document_id = ? AND task_id = ?').get(value.documentId, value.taskId) as Document | undefined;
  if (!document) throw new Error('文档不存在');
  const task = fetchTask(db, value.taskId);
  const revisesBusinessAnalysisSpecification = task?.item_type === 'business-analysis'
    && task.agile_status === 'ready_to_close'
    && task.review_document_id === document.document_id;
  const hasSelection = value.anchorType === 'selection' && Boolean(value.quotedText);
  if (value.anchorType === 'selection' && !hasSelection) throw new Error('选区评论必须包含引用内容');
  if (value.startOffset != null && value.endOffset != null && value.endOffset < value.startOffset) throw new Error('评论选区无效');
  const commentId = randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO document_comments(
        comment_id, document_id, task_id, document_revision, agent_id,
        anchor_type, quoted_text, start_offset, end_offset, content,
        intent, status, feedback_status, submitted_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'submitted', CURRENT_TIMESTAMP)
    `).run(
      commentId,
      document.document_id,
      document.task_id,
      document.revision,
      document.source_agent,
      value.anchorType,
      hasSelection ? value.quotedText : null,
      hasSelection ? value.startOffset ?? null : null,
      hasSelection ? value.endOffset ?? null : null,
      value.content,
      value.intent,
    );
    if (revisesBusinessAnalysisSpecification) {
      db.prepare(`
        UPDATE document_comments
        SET feedback_status = 'in_progress', disposition = 'revise',
            target_agent = 'requirement-spec-agent',
            triage_reason = '用户要求修订已审查的需求规格',
            triaged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE comment_id = ?
      `).run(commentId);
      db.prepare(`
        UPDATE tasks
        SET agile_status = 'backlog', current_subagent = 'requirement-spec-agent',
            run_state = 'runnable', closure_status = 'none', review_document_id = NULL,
            next_step = ?, last_actor = 'human', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(`用户对已审查需求规格提出反馈，请修订规格并重新独立审查：${value.content}`, value.taskId);
      addEvent(db, value.taskId, 'human', 'BusinessAnalysisSpecificationRevisionRequested', `提交需求规格修订意见：${document.title}`);
    } else {
      addEvent(db, value.taskId, 'human', 'DocumentCommented', `提交${value.intent === 'change_request' ? '修改请求' : value.intent === 'question' ? '问题' : '建议'}：${document.title}`);
    }
  })();
  refreshPages(`/tasks/${value.taskId}`);
  return commentId;
}

export async function resolveBusinessAnalysisSpecificationComments(input: { taskId: string; revision: number }) {
  const db = await databaseConnection();
  const evidence = JSON.stringify({
    verdict: 'resolved',
    reason: '需求规格已经修订并重新通过独立审查',
    evidence: [`需求规格说明书 revision ${input.revision}`],
  });
  const result = db.prepare(`
    UPDATE document_comments
    SET status = 'resolved', feedback_status = 'resolved',
        verification_json = ?, evolution_status = 'pending',
        resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ? AND status = 'open'
      AND feedback_status = 'in_progress'
      AND target_agent = 'requirement-spec-agent'
  `).run(evidence, input.taskId);
  if (result.changes) {
    addEvent(db, input.taskId, 'spec-review-agent', 'BusinessAnalysisSpecificationCommentsResolved', `修订后的需求规格已通过独立审查，闭环 ${result.changes} 条评论`);
  }
  refreshPages(`/tasks/${input.taskId}`);
}

const documentCommentIdSchema = z.object({
  taskId: z.string().min(1),
  commentId: z.string().min(1),
});

export async function reopenDocumentComment(input: unknown) {
  const value = documentCommentIdSchema.parse(input);
  const db = await databaseConnection();
  const comment = db.prepare(`
    SELECT comment.comment_id, document.title
    FROM document_comments comment
    JOIN documents document ON document.document_id = comment.document_id
    WHERE comment.comment_id = ? AND comment.task_id = ?
  `).get(value.commentId, value.taskId) as { comment_id: string; title: string } | undefined;
  if (!comment) throw new Error('评论不存在');
  db.transaction(() => {
    db.prepare(`
      UPDATE document_comments
      SET status = 'open', feedback_status = 'reopened', verification_json = NULL,
          disposition = NULL, target_stage = NULL, target_agent = NULL,
          target_story_index = NULL, acceptance_json = NULL, triage_reason = NULL,
          resolution_claim_json = NULL, triaged_at = NULL, feedback_batch_id = NULL,
          feedback_is_rewind_frontier = 0, feedback_needs_rebase = 0,
          resolved_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE comment_id = ?
    `).run(value.commentId);
    addEvent(db, value.taskId, 'human', 'DocumentCommentReopened', `重新打开文档反馈：${comment.title}`);
  })();
  refreshPages(`/tasks/${value.taskId}`);
}

export type FeedbackVerificationDecision = {
  commentId: string;
  verdict: 'resolved' | 'reopened';
  reason: string;
  evidence: string[];
};

export const createTaskSchema = z.object({
  title: z.string().min(1).max(300),
  // Story 2 persists and exposes this value to agents. Accept it here so the
  // creation boundary remains stable while title-only Tasks stay valid.
  description: z.string().optional().nullable(),
  link: z.string().trim().optional().nullable(),
  externalId: z.string().trim().optional().nullable(),
  externalStatus: z.string().trim().optional().nullable(),
  metadata: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })).optional().default([]),
  dependsOnTaskIds: z.array(z.string().trim().min(1)).max(50).optional().default([]),
  itemType: z.enum(['direct', 'business-analysis', 'end-to-end', 'feature', 'bug', 'tech', 'intake', 'other']).default('feature'),
  priority: z.string().trim().optional().nullable(),
  actor: z.enum(['human', 'system']).default('human'),
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'in feedback', 'ready_to_close', 'done', 'cancelled', 'blocked']).default('backlog'),
  currentSubagent: z.string().trim().optional().nullable(),
});

export type ParsedCreateTaskInput = z.infer<typeof createTaskSchema>;

export function createTaskInDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  value: ParsedCreateTaskInput,
  taskId = `REQ-${randomUUID()}`,
) {
  const metadata = parseRequirementMetadata(value.metadata);
  const priority = requirementPriority(value.priority || DEFAULT_REQUIREMENT_PRIORITY);
  const description = value.description?.trim() || null;
  const link = value.link || null;
  const requestedSubagent = value.currentSubagent || null;
  assertActorCanCreate(value.actor, value.status, requestedSubagent);
  const currentSubagent = requestedSubagent
    || (value.itemType === 'direct'
      ? 'direct-agent'
      : ['business-analysis', 'end-to-end'].includes(value.itemType) ? 'idea-context-agent' : null);
  const state: TaskState = {
    task_id: taskId,
    item_type: value.itemType,
    agile_status: value.status,
    current_subagent: currentSubagent,
    analysis_index: 0,
    dev_index: 0,
    test_index: 0,
    total_stories: 0,
    spec_resolved_index: 0,
    run_state: 'runnable',
    closure_status: 'none',
    review_revision: 0,
    review_document_id: null,
    closure_acknowledged_at: null,
    resume_status: null,
    resume_pending: 0,
    blocked_reason: value.status === 'blocked' ? '系统异常暂停' : null,
  };
  assertState(state);
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, description, link, external_id, external_status, item_type, priority,
      agile_status, current_subagent, analysis_index, dev_index, test_index,
      total_stories, spec_resolved_index, next_step,
      work_dir, blocked_reason, last_actor
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, '', ?, ?)
  `).run(taskId, value.title, description, link, value.externalId || null, value.externalStatus || null, value.itemType, priority, value.status, currentSubagent, value.itemType === 'direct' ? '新建需求，等待直接执行' : '新建需求，等待 Loop 梳理', state.blocked_reason, value.actor);
  const insertMetadata = db.prepare(`
    INSERT INTO requirement_metadata(task_id, metadata_key, metadata_value)
    VALUES (?, ?, ?)
  `);
  for (const item of metadata) insertMetadata.run(taskId, item.key, item.value);
  const dependencies = configureRequirementDependenciesInDb(db, taskId, value.dependsOnTaskIds);
  const task = fetchTask(db, taskId);
  if (!task) throw new Error('需求创建失败');
  ensureTaskLanesInDb(db, task);
  addEvent(db, task.task_id, value.actor, 'TaskCreated', `创建需求：${task.title}`);
  if (dependencies.length) {
    const waiting = dependencies.filter((dependency) => !requirementDependencySatisfied(dependency.agile_status));
    addEvent(
      db,
      task.task_id,
      value.actor,
      'TaskDependenciesConfigured',
      `配置 ${dependencies.length} 个前置需求${waiting.length ? `，等待进入结卡：${waiting.map((dependency) => dependency.title).join('、')}` : '，创建时依赖条件均已满足'}`,
    );
  }
  return task;
}

export async function createTask(input: unknown) {
  const value = createTaskSchema.parse(input);
  const db = await databaseConnection();
  db.exec('BEGIN');
  try {
    const task = createTaskInDb(db, value);
    const dispatchRevision = advanceRuntimeEventRevisionInDb(db, 'dispatch.invalidated');
    db.exec('COMMIT');
    await syncTaskFiles(db, task.task_id);
    await publishRuntimeInvalidation('dispatch.invalidated', dispatchRevision, task.task_id);
    refreshPages('/', '/tasks', `/tasks/${task.task_id}`);
    return task.task_id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const updateUnstartedTaskInputSchema = z.object({
  taskId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  description: z.string().optional().nullable(),
  itemType: z.enum(['direct', 'business-analysis', 'end-to-end', 'feature', 'bug']),
  priority: z.string().trim().optional().nullable(),
  metadata: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })).optional().default([]),
  dependsOnTaskIds: z.array(z.string().trim().min(1)).max(50).optional().default([]),
});

export async function updateUnstartedTaskInput(input: unknown) {
  const value = updateUnstartedTaskInputSchema.parse(input);
  const metadata = parseRequirementMetadata(value.metadata);
  const priority = requirementPriority(value.priority || DEFAULT_REQUIREMENT_PRIORITY);
  const description = value.description?.trim() || null;
  const currentSubagent = value.itemType === 'direct'
    ? 'direct-agent'
    : ['business-analysis', 'end-to-end'].includes(value.itemType) ? 'idea-context-agent' : null;
  const nextStep = value.itemType === 'direct' ? '新建需求，等待直接执行' : '新建需求，等待 Loop 梳理';
  const db = await databaseConnection();
  let dispatchRevision: number;

  db.exec('BEGIN IMMEDIATE');
  try {
    const before = fetchTask(db, value.taskId);
    if (!before) throw new Error('需求不存在');
    if (['done', 'cancelled'].includes(before.agile_status)) throw new Error('已结束的需求不能编辑输入');
    const execution = db.prepare('SELECT 1 FROM execution_attempts WHERE task_id = ? LIMIT 1').get(value.taskId);
    const contextChat = db.prepare('SELECT 1 FROM task_context_chat_sessions WHERE task_id = ? LIMIT 1').get(value.taskId);
    if (execution || contextChat) throw new Error('该需求已经由 Agent 开始处理，原始输入不能再修改');

    const previousMetadata = db.prepare(`
      SELECT metadata_key AS key, metadata_value AS value
      FROM requirement_metadata WHERE task_id = ? ORDER BY metadata_key
    `).all(value.taskId) as { key: string; value: string }[];
    const previousDependencies = requirementDependenciesInDb(db, value.taskId).map((item) => item.depends_on_task_id);
    const changedFields = [
      before.title !== value.title ? '标题' : '',
      before.description !== description ? '描述' : '',
      before.item_type !== value.itemType ? 'Pipeline' : '',
      before.priority !== priority ? '优先级' : '',
      JSON.stringify(previousMetadata) !== JSON.stringify([...metadata].sort((left, right) => left.key.localeCompare(right.key))) ? 'Metadata' : '',
      JSON.stringify(previousDependencies) !== JSON.stringify([...new Set(value.dependsOnTaskIds)]) ? '前置需求' : '',
    ].filter(Boolean);

    db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, item_type = ?, priority = ?, current_subagent = ?,
          next_step = ?, last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(value.title, description, value.itemType, priority, currentSubagent, nextStep, value.taskId);
    db.prepare('DELETE FROM requirement_metadata WHERE task_id = ?').run(value.taskId);
    const insertMetadata = db.prepare(`
      INSERT INTO requirement_metadata(task_id, metadata_key, metadata_value) VALUES(?, ?, ?)
    `);
    for (const item of metadata) insertMetadata.run(value.taskId, item.key, item.value);
    db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(value.taskId);
    configureRequirementDependenciesInDb(db, value.taskId, value.dependsOnTaskIds);
    db.prepare('DELETE FROM task_lanes WHERE task_id = ?').run(value.taskId);
    const after = fetchTask(db, value.taskId);
    if (!after) throw new Error('需求输入更新失败');
    ensureTaskLanesInDb(db, after);
    addEvent(
      db,
      value.taskId,
      'human',
      'TaskInputUpdated',
      changedFields.length ? `Agent 开始前更新需求输入：${changedFields.join('、')}` : 'Agent 开始前确认需求输入，无字段变化',
    );
    dispatchRevision = advanceRuntimeEventRevisionInDb(db, 'dispatch.invalidated');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  await syncTaskFiles(db, value.taskId);
  await publishRuntimeInvalidation('dispatch.invalidated', dispatchRevision, value.taskId);
  refreshPages('/', '/tasks', `/tasks/${value.taskId}`);
}

const contextSchema = z.object({
  taskId: z.string().min(1),
  kind: z.enum(['feature', 'bug', 'tech', 'intake']).default('feature'),
  slug: z.string().trim().optional().nullable(),
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'in feedback', 'ready_to_close', 'done', 'cancelled', 'blocked']).optional().nullable(),
  currentSubagent: z.string().trim().optional().nullable(),
  nextStep: z.string().trim().optional().nullable(),
  blockedReason: z.string().trim().optional().nullable(),
  actor: z.enum(['human', 'backlog-agent']).default('human'),
});

export async function initializeTaskContext(input: unknown) {
  const value = contextSchema.parse(input);
  const db = await databaseConnection();
  const before = fetchTask(db, value.taskId);
  if (!before) throw new Error('需求不存在');
  if (value.actor !== 'human' && value.actor !== 'backlog-agent') throw new Error(`${value.actor} cannot initialize context`);
  const changes: Partial<TaskState> & { item_type?: string; next_step?: string } = {
    agile_status: value.status || before.agile_status,
    current_subagent: value.currentSubagent || before.current_subagent || 'backlog-agent',
    blocked_reason: value.blockedReason || before.blocked_reason,
    next_step: value.nextStep || before.next_step || '上下文已初始化',
    item_type: value.kind,
  };
  const prospective = { ...before, ...changes } as TaskState;
  assertUpdate(before, value.actor, changes, Object.keys(changes));
  assertState(prospective);
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET item_type = ?, agile_status = ?, current_subagent = ?,
          next_step = ?, blocked_reason = ?, last_actor = ?, resume_pending = 0,
          resume_status = CASE WHEN ? = 'blocked' AND agile_status != 'blocked' THEN agile_status WHEN ? != 'blocked' THEN NULL ELSE resume_status END,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(value.kind, changes.agile_status, changes.current_subagent, changes.next_step, changes.blocked_reason, value.actor, changes.agile_status, changes.agile_status, value.taskId);
    const after = fetchTask(db, value.taskId);
    if (after) refreshTaskLaneStatesInDb(db, after);
    addEvent(db, value.taskId, value.actor, 'ContextInitialized', '初始化数据库上下文');
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    refreshPages('/', `/tasks/${value.taskId}`);
    return 'database';
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const storySchema = z.object({
  taskId: z.string().min(1),
  title: z.string().min(1).max(200),
  actor: z.enum(['human', 'story-splitter-agent']).default('human'),
});

export async function addStory(input: unknown) {
  const value = storySchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  const nextIndex = ((db.prepare('SELECT COALESCE(MAX(story_index), 0) AS index_value FROM stories WHERE task_id = ?').get(value.taskId) as { index_value: number }).index_value || 0) + 1;
  const directory = `story-${String(nextIndex).padStart(3, '0')}`;
  const prospective = { ...task, total_stories: Math.max(task.total_stories, nextIndex) };
  assertState(prospective);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(value.taskId, nextIndex, value.title, directory);
    db.prepare('UPDATE tasks SET total_stories = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(prospective.total_stories, `已新增交付单元 ${nextIndex}，等待交付分析`, value.actor, value.taskId);
    const after = fetchTask(db, value.taskId);
    if (after) refreshTaskLaneStatesInDb(db, after);
    addEvent(db, value.taskId, value.actor, 'StoryAdded', `新增交付单元 ${nextIndex}：${value.title}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    refreshPages(`/tasks/${value.taskId}`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function addPlannedDeliveryUnits(input: unknown) {
  const value = z.object({
    taskId: z.string().min(1),
    actor: z.literal('story-splitter-agent'),
    units: z.array(deliveryUnitContractSchema).min(1).max(50),
    sourceDeliveryPlanDraftId: z.string().min(1),
  }).parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  const existingCount = (db.prepare(`
    SELECT COUNT(*) AS value FROM stories WHERE task_id = ?
  `).get(value.taskId) as { value: number }).value;
  if (existingCount) throw new Error('当前需求已存在交付单元，拒绝重复拆分');
  const prospective = { ...task, total_stories: value.units.length };
  assertState(prospective);
  db.exec('BEGIN');
  try {
    const inserted = insertDeliveryUnitContractsInDb(db, {
      taskId: value.taskId,
      units: value.units,
      originType: 'original',
      sourceDeliveryPlanDraftId: value.sourceDeliveryPlanDraftId,
    });
    db.prepare(`
      UPDATE tasks
      SET total_stories = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(
      prospective.total_stories,
      `已规划 ${inserted.length} 个交付单元，等待交付分析`,
      value.actor,
      value.taskId,
    );
    const after = fetchTask(db, value.taskId);
    if (after) refreshTaskLaneStatesInDb(db, after);
    for (const unit of inserted) {
      addEvent(
        db,
        value.taskId,
        value.actor,
        'DeliveryUnitAdded',
        `新增交付单元 ${unit.storyIndex}：${unit.title}（${unit.key}）`,
      );
    }
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    refreshPages(`/tasks/${value.taskId}`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function saveDeliverySpec(input: unknown) {
  const value = z.object({
    taskId: z.string().min(1),
    storyIndex: z.coerce.number().int().positive(),
    status: z.enum(['draft', 'waiting_for_answers', 'resolved']),
    spec: deliverySpecSchema,
    sourceResultId: z.string().optional().nullable(),
  }).parse(input);
  assertDeliverySpecDecisionCoverage(value.spec);
  const unresolvedDecisions = value.spec.decisions.filter((decision) => decision.status === 'needs_user_input');
  if (value.status === 'resolved' && unresolvedDecisions.length) throw new Error('已收敛交付规格不能包含未解决决策');
  if (value.status === 'waiting_for_answers' && !unresolvedDecisions.length) throw new Error('等待回答的交付规格必须列出待确认决策');
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task || value.storyIndex > task.total_stories) throw new Error('交付单元不存在');
  if (value.status === 'resolved') {
    const pending = (db.prepare(`
      SELECT COUNT(*) AS count FROM questions
      WHERE task_id = ? AND story_index = ? AND status = 'pending'
    `).get(value.taskId, value.storyIndex) as { count: number }).count;
    if (pending) throw new Error('仍有未回答的交付决策，不能保存已收敛交付规格');
    const answeredKeys = (db.prepare(`
      SELECT decision_key FROM questions
      WHERE task_id = ? AND story_index = ? AND status = 'answered' AND decision_key IS NOT NULL
    `).all(value.taskId, value.storyIndex) as { decision_key: string }[]).map((row) => row.decision_key);
    const decisionKeys = new Set(value.spec.decisions
      .filter((decision) => decision.status === 'resolved')
      .map((decision) => decision.key));
    const missingDecisions = answeredKeys.filter((key) => !decisionKeys.has(key));
    if (missingDecisions.length) {
      throw new AgentResultContractError(
        `已回答问题的 decisionKey 是跨轮次稳定 ID，已收敛交付规格必须在 decisions 中原样复用并关闭，禁止改名或创建别名；缺少：${missingDecisions.join(', ')}`,
      );
    }
  }
  const revision = ((db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM story_specs WHERE task_id = ? AND story_index = ?').get(value.taskId, value.storyIndex) as { revision: number }).revision || 0) + 1;
  const specId = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE story_specs SET status = 'superseded'
      WHERE task_id = ? AND story_index = ? AND status != 'superseded'
    `).run(value.taskId, value.storyIndex);
    db.prepare(`
      INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, source_result_id, resolved_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE NULL END)
    `).run(specId, value.taskId, value.storyIndex, revision, value.status, JSON.stringify(value.spec), value.sourceResultId || null, value.status);
    if (value.status === 'resolved') {
      db.prepare(`
        UPDATE questions
        SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND story_index = ? AND status = 'answered'
      `).run(value.taskId, value.storyIndex);
    }
    addEvent(db, value.taskId, 'analyst-agent', 'DeliverySpecSaved', `保存交付单元 ${value.storyIndex} 的交付规格 v${revision}（${value.status}）。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages(`/tasks/${value.taskId}`);
  return { specId, revision, status: value.status };
}

const answerSchema = z.object({
  taskId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string().max(4000).optional().default(''),
  selectedOptionId: z.string().min(1).max(100).optional().nullable(),
}).refine((value) => Boolean(value.answer.trim() || value.selectedOptionId), {
  message: '必须选择一个选项或填写答复',
});

type QuestionActivation = { decisionKey: string; optionId: string };

function parseQuestionActivations(value: string | null): QuestionActivation[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is QuestionActivation =>
      Boolean(item)
      && typeof item === 'object'
      && typeof (item as QuestionActivation).decisionKey === 'string'
      && typeof (item as QuestionActivation).optionId === 'string');
  } catch {
    return [];
  }
}

export function recomputeTaskQuestionApplicabilityInDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  taskId: string,
  sourceAgent: string,
  storyIndex: number | null,
) {
  const rows = db.prepare(`
    SELECT question_id, decision_key, title, answer, selected_option_id,
           alternatives_json, activation_json, status
    FROM questions
    WHERE task_id = ? AND story_index IS ? AND source_agent = ?
      AND decision_key IS NOT NULL
    ORDER BY created_at, question_id
  `).all(taskId, storyIndex, sourceAgent) as {
    question_id: string;
    decision_key: string;
    title: string;
    answer: string | null;
    selected_option_id: string | null;
    alternatives_json: string | null;
    activation_json: string | null;
    status: string;
  }[];
  const byKey = new Map(rows.map((row) => [row.decision_key, row]));
  const optionLabel = (row: typeof rows[number] | undefined, optionId: string) => {
    if (!row?.alternatives_json) return '指定选项';
    try {
      const options = JSON.parse(row.alternatives_json) as { id?: unknown; label?: unknown }[];
      const option = Array.isArray(options)
        ? options.find((item) => item?.id === optionId)
        : null;
      return typeof option?.label === 'string' ? option.label : '指定选项';
    } catch {
      return '指定选项';
    }
  };
  for (let pass = 0; pass < rows.length + 1; pass += 1) {
    let changed = false;
    for (const row of rows) {
      if (row.status === 'superseded' || row.status === 'resolved') continue;
      const gates = parseQuestionActivations(row.activation_json);
      let nextStatus: string;
      let reason: string | null = null;
      if (!gates.length) {
        nextStatus = row.answer ? 'answered' : 'pending';
      } else {
        const parents = gates.map((gate) => ({ gate, parent: byKey.get(gate.decisionKey) }));
        const inactive = parents.find(({ parent }) =>
          !parent || ['not_applicable', 'superseded'].includes(parent.status));
        const mismatch = parents.find(({ gate, parent }) =>
          parent
          && ['answered', 'resolved'].includes(parent.status)
          && parent.selected_option_id
          && parent.selected_option_id !== gate.optionId);
        const unresolved = parents.find(({ parent }) =>
          !parent || !['answered', 'resolved'].includes(parent.status) || !parent.selected_option_id);
        if (inactive || mismatch) {
          nextStatus = 'not_applicable';
          const cause = inactive || mismatch;
          reason = cause
            ? `「${cause.parent?.title || '上游决策'}」未选择「${optionLabel(cause.parent, cause.gate.optionId)}」`
            : '上游决策路径未命中';
        } else if (unresolved) {
          nextStatus = 'conditional';
          reason = `等待「${unresolved.parent?.title || '上游决策'}」完成`;
        } else {
          nextStatus = row.status === 'not_applicable' && row.answer ? 'pending' : row.answer ? 'answered' : 'pending';
        }
      }
      if (nextStatus !== row.status) {
        row.status = nextStatus;
        changed = true;
      }
      db.prepare(`
        UPDATE questions SET status = ?, status_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE question_id = ?
      `).run(nextStatus, reason, row.question_id);
    }
    if (!changed) break;
  }
}

export function recomputeBacklogQuestionApplicabilityInDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  taskId: string,
) {
  recomputeTaskQuestionApplicabilityInDb(db, taskId, 'backlog-agent', null);
}

export async function answerQuestion(input: unknown) {
  const { taskId, questionId, answer, selectedOptionId } = answerSchema.parse(input);
  const db = await databaseConnection();
  const question = db.prepare('SELECT * FROM questions WHERE question_id = ? AND task_id = ?').get(questionId, taskId) as Question | undefined;
  if (!question) throw new Error('确认事项不存在');
  if (question.status !== 'pending') throw new Error('当前决策不在可回答状态');
  const alternatives = question.alternatives_json
    ? JSON.parse(question.alternatives_json) as { id: string; label: string }[]
    : [];
  const selected = selectedOptionId
    ? alternatives.find((option) => option.id === selectedOptionId)
    : null;
  if (selectedOptionId && !selected) throw new Error('选择的决策选项不存在');
  const normalizedAnswer = answer.trim() || selected?.label || '';
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE questions
      SET answer = ?, selected_option_id = ?, status = 'answered', status_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE question_id = ?
    `).run(normalizedAnswer, selectedOptionId || null, questionId);
    if (question.source_agent === 'backlog-agent') {
      recomputeBacklogQuestionApplicabilityInDb(db, taskId);
    } else if (question.source_agent === 'analyst-agent') {
      recomputeTaskQuestionApplicabilityInDb(db, taskId, 'analyst-agent', question.story_index);
    } else if (question.source_agent === 'idea-context-agent' || question.source_agent === 'business-design-agent') {
      recomputeTaskQuestionApplicabilityInDb(db, taskId, question.source_agent, null);
    }
    addEvent(db, taskId, 'human', 'QuestionAnswered', `回答了「${question.title}」。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages(`/tasks/${taskId}`, '/decisions', '/');
}

const runtimeInputSchema = z.object({
  taskId: z.string().min(1),
  storyIndex: z.coerce.number().int().positive().optional().nullable(),
  sourceAgent: z.enum(['backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent']),
  sourceKey: z.string().min(1).max(120).optional().nullable(),
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().nullable(),
  recommendation: z.string().max(2000).optional().nullable(),
  sourceExecutionId: z.string().min(1).optional().nullable(),
});

export async function addRuntimeInputRequest(input: unknown) {
  const value = runtimeInputSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  if (value.storyIndex) {
    const story = db.prepare('SELECT 1 FROM stories WHERE task_id = ? AND story_index = ?').get(value.taskId, value.storyIndex);
    if (!story) throw new Error(`交付单元 ${value.storyIndex} 不存在`);
  }
  const requestId = `RI-${randomUUID().slice(0, 8)}`;
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO runtime_input_requests(
        request_id, task_id, story_index, source_agent, title, question, why,
        recommendation, source_execution_id, request_key
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId, value.taskId, value.storyIndex || null, value.sourceAgent,
      value.title, value.question, value.why || null, value.recommendation || null,
      value.sourceExecutionId || null, value.sourceKey || null,
    );
    db.prepare(`
      UPDATE tasks
      SET run_state = 'waiting_for_runtime_input', current_subagent = ?,
          resume_pending = 0, blocked_reason = ?, next_step = ?, last_actor = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(
      value.sourceAgent,
      value.title,
      `等待补充运行信息：${value.title}`,
      value.sourceAgent,
      value.taskId,
    );
    if (['dev-agent', 'test-agent'].includes(value.sourceAgent)) {
      releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, value.taskId);
    }
    if (value.sourceExecutionId) {
      releaseExecutionResourceClaimsInDb(db, value.sourceExecutionId);
    }
    const lane = laneForAgent(value.sourceAgent);
    if (lane !== 'control') {
      setTaskLaneStateInDb(db, {
        taskId: value.taskId,
        lane,
        status: 'waiting_for_runtime_input',
        currentAgent: value.sourceAgent,
        currentStoryIndex: value.storyIndex || null,
        blockedReason: value.title,
      });
    }
    if (value.sourceAgent === 'test-agent') {
      queueVerificationAssistanceInDb(db, {
        requestId,
        taskId: value.taskId,
        storyIndex: value.storyIndex || null,
        title: value.title,
      });
    }
    addEvent(db, value.taskId, value.sourceAgent, 'RuntimeInputRequested', `请求运行信息：${value.title}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${value.taskId}`);
  return requestId;
}

const runtimeInputAnswerSchema = z.object({
  taskId: z.string().min(1),
  requestId: z.string().min(1),
  answer: z.string().min(1).max(4000),
});

export async function answerRuntimeInput(input: unknown) {
  const value = runtimeInputAnswerSchema.parse(input);
  const db = await databaseConnection();
  const request = db.prepare(`
    SELECT * FROM runtime_input_requests WHERE request_id = ? AND task_id = ?
  `).get(value.requestId, value.taskId) as RuntimeInputRequest | undefined;
  if (!request) throw new Error('运行信息请求不存在');
  if (request.status !== 'pending') throw new Error('运行信息请求已经处理');
  const assistance = db.prepare(`
    SELECT status FROM verification_assistance_jobs WHERE request_id = ?
  `).get(value.requestId) as { status: string } | undefined;
  if (assistance && ['pending', 'running'].includes(assistance.status)) {
    throw new Error('系统辅助 Agent 正在处理该验证协助；连续尝试后仍无法解决时才会转交人工');
  }
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE runtime_input_requests
      SET answer = ?, status = 'answered', updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(value.answer, value.requestId);
    db.prepare(`
      UPDATE verification_assistance_jobs
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ? AND status = 'escalated'
    `).run(value.requestId);
    addEvent(db, value.taskId, 'human', 'RuntimeInputAnswered', `回答了运行信息「${request.title}」。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${value.taskId}`);
}

export async function submitRuntimeInputs(taskId: string, requestedLane?: TaskLaneKind) {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task) throw new Error('需求不存在');
  const lanes = taskLanesInDb(db, task);
  const lane = requestedLane
    ? lanes.find((item) => item.lane === requestedLane)
    : lanes.find((item) => item.status === 'waiting_for_runtime_input');
  const controlAgent = !requestedLane
    && task.run_state === 'waiting_for_runtime_input'
    && task.current_subagent
    && laneForAgent(task.current_subagent) === 'control'
    ? task.current_subagent
    : null;
  if ((!lane || lane.status !== 'waiting_for_runtime_input' || !lane.current_agent) && !controlAgent) {
    throw new Error('当前流程不在等待运行信息状态');
  }
  if (controlAgent) {
    const pending = (db.prepare(`
      SELECT COUNT(*) AS count FROM runtime_input_requests
      WHERE task_id = ? AND source_agent = ? AND status = 'pending'
    `).get(taskId, controlAgent) as { count: number }).count;
    if (pending) throw new Error('仍有未回答的运行信息，不能继续执行');
    const answered = (db.prepare(`
      SELECT COUNT(*) AS count FROM runtime_input_requests
      WHERE task_id = ? AND source_agent = ? AND status = 'answered'
    `).get(taskId, controlAgent) as { count: number }).count;
    if (!answered) throw new Error('没有可提交的运行信息回答');
    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE tasks
        SET run_state = 'runnable', resume_pending = 1, blocked_reason = NULL,
            next_step = ?, last_actor = 'human', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(`运行信息已补充，交回 ${controlAgent} 从当前阶段继续`, taskId);
      addEvent(db, taskId, 'human', 'RuntimeInputsSubmitted', `提交需求级运行信息回答，交回 ${controlAgent}。`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    refreshPages('/', `/tasks/${taskId}`, '/decisions');
    return;
  }
  if (!lane || !lane.current_agent) throw new Error('指定 Lane 当前不在等待运行信息状态');
  const agents = lane.lane === 'analysis' ? ['analyst-agent'] : ['dev-agent', 'test-agent'];
  const placeholders = agents.map(() => '?').join(', ');
  const pending = (db.prepare(`
    SELECT COUNT(*) AS count FROM runtime_input_requests
    WHERE task_id = ? AND source_agent IN (${placeholders}) AND status = 'pending'
  `).get(taskId, ...agents) as { count: number }).count;
  if (pending) throw new Error('仍有未回答的运行信息，不能继续执行');
  const answered = (db.prepare(`
    SELECT COUNT(*) AS count FROM runtime_input_requests
    WHERE task_id = ? AND source_agent IN (${placeholders}) AND status = 'answered'
  `).get(taskId, ...agents) as { count: number }).count;
  if (!answered) throw new Error('没有可提交的运行信息回答');
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET run_state = 'runnable', resume_pending = 0, blocked_reason = NULL,
          next_step = ?, last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(`运行信息已补充，交回 ${lane.current_agent} 从当前阶段继续`, taskId);
    setTaskLaneStateInDb(db, {
      taskId,
      lane: lane.lane,
      status: 'runnable',
      currentAgent: lane.current_agent,
      currentStoryIndex: lane.current_story_index,
      resumePending: 1,
    });
    addEvent(db, taskId, 'human', 'RuntimeInputsSubmitted', `提交 ${lane.lane} Lane 运行信息回答，交回 ${lane.current_agent}。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${taskId}`);
}

export async function resolveRuntimeInputs(input: {
  taskId: string;
  storyIndex: number | null;
  sourceAgent: string;
  resolvedExecutionId?: string;
}) {
  const db = await databaseConnection();
  const result = db.prepare(`
    UPDATE runtime_input_requests
    SET status = 'resolved', resolved_execution_id = ?, resolved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE task_id = ? AND story_index IS ? AND source_agent = ? AND status = 'answered'
  `).run(input.resolvedExecutionId || null, input.taskId, input.storyIndex, input.sourceAgent);
  if (result.changes) {
    addEvent(db, input.taskId, input.sourceAgent as Actor, 'RuntimeInputsResolved', `已使用 ${result.changes} 条运行信息继续执行。`);
    refreshPages('/', `/tasks/${input.taskId}`);
  }
  return result.changes;
}

const questionSchema = z.object({
  taskId: z.string().min(1),
  storyIndex: z.coerce.number().int().positive().optional().nullable(),
  kind: z.enum(['local', 'analysis', 'test', 'review', 'feedback']).default('local'),
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  why: z.string().max(1000).optional().nullable(),
  recommendation: z.string().max(2000).optional().nullable(),
  decisionKey: z.string().min(1).max(240).optional().nullable(),
  alternatives: z.array(z.object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(240),
    consequences: z.array(z.string().max(1000)).max(20).optional().default([]),
  })).max(20).optional().default([]),
  recommendationReason: z.string().max(2000).optional().nullable(),
  dependsOn: z.array(z.string().min(1).max(240)).max(50).optional().default([]),
  activation: z.array(z.object({
    decisionKey: z.string().min(1).max(240),
    optionId: z.string().min(1).max(100),
  })).max(50).optional().default([]),
  initialStatus: z.enum(['pending', 'conditional', 'not_applicable']).optional().default('pending'),
  specRevision: z.coerce.number().int().positive().default(1),
  blockedReason: z.string().max(1000).optional().nullable(),
  blockTask: z.coerce.boolean().default(true),
  actor: z.enum(['human', 'idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent', 'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent', 'feedback-agent']).default('human'),
});

export async function addQuestion(input: unknown) {
  const value = questionSchema.parse(input);
  if (value.actor === 'review-agent' || value.kind === 'review') throw new Error('Review Agent 只生成结卡报告，不能创建人工审批或澄清问题');
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  const questionId = `Q-${randomUUID().slice(0, 8)}`;
  const defaultStoryIndex = value.kind === 'analysis' ? Math.min(task.total_stories, task.analysis_index + 1) : value.kind === 'test' ? Math.min(task.total_stories, task.test_index + 1) : null;
  const storyIndex = value.storyIndex || defaultStoryIndex;
  if (value.kind === 'analysis' || value.kind === 'test') {
    if (!storyIndex) throw new Error(`${value.kind} 确认事项必须关联交付单元；请先完成交付拆分`);
    const story = db.prepare('SELECT * FROM stories WHERE task_id = ? AND story_index = ?').get(value.taskId, storyIndex) as Story | undefined;
    if (!story && storyIndex > task.total_stories) throw new Error(`交付单元 ${storyIndex} 不存在`);
  } else if (storyIndex) {
    const story = db.prepare('SELECT * FROM stories WHERE task_id = ? AND story_index = ?').get(value.taskId, storyIndex) as Story | undefined;
    if (!story && storyIndex > task.total_stories) throw new Error(`交付单元 ${storyIndex} 不存在`);
  }
  const relativePath = null;

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO questions(
        question_id, task_id, story_index, kind, title, question, why, recommendation,
        relative_path, source_agent, decision_key, alternatives_json,
        recommendation_reason, depends_on_json, activation_json, spec_revision, status,
        status_reason
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      questionId, value.taskId, storyIndex || null, value.kind, value.title, value.question,
      value.why || null, value.recommendation || null, relativePath, value.actor,
      value.decisionKey || null, value.alternatives.length ? JSON.stringify(value.alternatives) : null,
      value.recommendationReason || null, value.dependsOn.length ? JSON.stringify(value.dependsOn) : null,
      value.activation.length ? JSON.stringify(value.activation) : null, value.specRevision,
      value.initialStatus,
      value.initialStatus === 'conditional' ? '等待上游决策' : value.initialStatus === 'not_applicable' ? '上游路径未命中' : null,
    );
    if (value.blockTask) {
      const agent = value.kind === 'analysis' ? 'analyst-agent' : value.actor !== 'human' ? value.actor : task.current_subagent || 'backlog-agent';
      db.prepare(`
        UPDATE tasks
        SET run_state = 'waiting_for_answers', current_subagent = ?,
            resume_pending = 0, blocked_reason = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(agent, value.blockedReason || value.title, `等待人工回答：${value.title}`, value.actor, value.taskId);
      const lane = laneForAgent(agent);
      if (lane !== 'control') {
        setTaskLaneStateInDb(db, {
          taskId: value.taskId,
          lane,
          status: 'waiting_for_answers',
          currentAgent: agent,
          currentStoryIndex: storyIndex || null,
          blockedReason: value.blockedReason || value.title,
        });
      }
    }
    addEvent(db, value.taskId, value.actor, 'ClarificationRequested', `请求澄清：${value.title}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    refreshPages('/', `/tasks/${value.taskId}`);
    return questionId;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function submitClarificationAnswers(taskId: string) {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task) throw new Error('需求不存在');
  const lane = taskLaneInDb(db, task, 'analysis');
  const controlAgent = task.run_state === 'waiting_for_answers'
    && (['idea-context-agent', 'business-design-agent', 'backlog-agent', 'repro-agent', 'feedback-agent'].includes(task.current_subagent || ''))
    ? task.current_subagent
    : null;
  const analysisLevel = !controlAgent && lane.status === 'waiting_for_answers';
  if (!controlAgent && !analysisLevel) throw new Error('当前需求不在等待澄清回答状态');
  const pending = controlAgent
    ? (db.prepare(`
        SELECT COUNT(*) AS count FROM questions
        WHERE task_id = ? AND story_index IS NULL AND source_agent = ? AND status = 'pending'
      `).get(taskId, controlAgent) as { count: number }).count
    : (db.prepare(`
        SELECT COUNT(*) AS count FROM questions
        WHERE task_id = ? AND story_index = ? AND source_agent = 'analyst-agent' AND status = 'pending'
      `).get(taskId, lane.current_story_index || task.analysis_index + 1) as { count: number }).count;
  if (pending) throw new Error('仍有未回答的澄清问题，不能继续推进');
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET run_state = 'runnable', resume_pending = ?, blocked_reason = NULL,
          next_step = ?,
          last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(
      controlAgent ? 1 : 0,
      controlAgent === 'backlog-agent'
        ? '用户回答已提交，交回需求梳理 Agent 更新需求边界'
        : controlAgent === 'idea-context-agent'
          ? '用户回答已提交，交回需求意图 Agent 综合有效意图路径'
          : controlAgent === 'business-design-agent'
            ? '用户回答已提交，交回业务方案 Agent 关闭有效业务决策树'
        : controlAgent === 'repro-agent'
          ? '用户回答已提交，交回问题复现 Agent 重新复现并核对证据'
          : controlAgent === 'feedback-agent'
            ? '用户回答已提交，交回 Feedback Agent 继续当前反馈批次'
          : '用户回答已提交，交回交付分析 Agent 继续收敛交付规格',
      taskId,
    );
    if (analysisLevel) {
      setTaskLaneStateInDb(db, {
        taskId,
        lane: 'analysis',
        status: 'runnable',
        currentAgent: 'analyst-agent',
        currentStoryIndex: lane.current_story_index || task.analysis_index + 1,
        resumePending: 1,
      });
    }
    addEvent(
      db,
      taskId,
      'human',
      'ClarificationAnswersSubmitted',
      controlAgent === 'backlog-agent'
        ? '提交全部需求级澄清回答，等待 AI 更新需求边界。'
        : controlAgent === 'idea-context-agent'
          ? '提交全部需求意图回答，等待 Agent 综合有效意图路径。'
          : controlAgent === 'business-design-agent'
            ? '提交全部业务方案决定，等待 Agent 关闭有效决策树。'
        : controlAgent === 'repro-agent'
          ? '提交全部复现对齐回答，等待 AI 重新复现并核对证据。'
          : controlAgent === 'feedback-agent'
            ? '提交全部反馈澄清回答，等待 Feedback Agent 继续当前批次。'
          : '提交全部单元级澄清回答，等待 AI 重建规格。',
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${taskId}`, '/decisions');
}

export async function releaseBlock(taskId: string, requestedLane?: TaskLaneKind) {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task) throw new Error('需求不存在');
  const lane = taskLanesInDb(db, task).find((item) => item.status === 'system_blocked' && (!requestedLane || item.lane === requestedLane));
  if (lane) {
    const pendingQuestions = lane.lane === 'analysis'
      ? (db.prepare("SELECT COUNT(*) AS count FROM questions WHERE task_id = ? AND status = 'pending'").get(taskId) as { count: number }).count
      : 0;
    if (pendingQuestions) throw new Error('业务或交付决策必须通过提交回答恢复，不能用系统恢复命令绕过');
    db.exec('BEGIN');
    try {
      setTaskLaneStateInDb(db, {
        taskId,
        lane: lane.lane,
        status: 'runnable',
        currentAgent: lane.current_agent,
        currentStoryIndex: lane.current_story_index,
        resumePending: 1,
      });
      db.prepare(`
        UPDATE task_lanes SET retry_cycle = retry_cycle + 1, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND lane = ?
      `).run(taskId, lane.lane);
      const otherBlocked = (db.prepare(`
        SELECT COUNT(*) AS count FROM task_lanes
        WHERE task_id = ? AND status = 'system_blocked'
      `).get(taskId) as { count: number }).count;
      if (task.agile_status === 'blocked' && task.resume_status && task.resume_status !== 'blocked') {
        db.prepare(`
          UPDATE tasks SET agile_status = ?, run_state = 'runnable', resume_status = NULL,
            resume_pending = 0, blocked_reason = NULL, last_actor = 'system', updated_at = CURRENT_TIMESTAMP
          WHERE task_id = ?
        `).run(task.resume_status, taskId);
      } else if (!otherBlocked) {
        db.prepare(`
          UPDATE tasks SET blocked_reason = NULL, next_step = ?, last_actor = 'system', updated_at = CURRENT_TIMESTAMP
          WHERE task_id = ?
        `).run(`${lane.lane} Lane 阻塞已解除，等待继续调度`, taskId);
      }
      addEvent(db, taskId, 'system', 'LaneBlockRecovered', `恢复 ${lane.lane} Lane，交回 ${lane.current_agent || '对应 Agent'}。`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    refreshPages(`/tasks/${taskId}`, '/');
    return;
  }
  if (task.agile_status !== 'blocked') throw new Error('需求当前不在系统阻塞状态');
  const pendingQuestions = (db.prepare('SELECT COUNT(*) AS count FROM questions WHERE task_id = ? AND status = \'pending\'').get(taskId) as { count: number }).count;
  if (pendingQuestions) throw new Error('业务或交付决策必须通过提交回答恢复，不能用系统恢复命令绕过');
  const resumeStatus = task.resume_status;
  if (!resumeStatus || resumeStatus === 'blocked') throw new Error('系统阻塞缺少可恢复状态');
  if (!task.current_subagent) throw new Error('系统阻塞缺少负责 Agent');
  const resumesSameDraft = Boolean(agentCommandProfile(task.current_subagent, 'resume'));

  const prospective = { ...task, agile_status: resumeStatus, run_state: 'runnable' as const };
  assertState(prospective);
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET agile_status = ?, run_state = 'runnable', resume_status = NULL, resume_pending = ?, blocked_reason = NULL,
          next_step = ?, retry_cycle = retry_cycle + 1,
          last_actor = 'system', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(
      resumeStatus,
      resumesSameDraft ? 1 : 0,
      resumesSameDraft
        ? `系统阻塞已解除，交回 ${task.current_subagent} 继续处理`
        : `系统阻塞已解除，重新派发 ${task.current_subagent} 负责的当前步骤`,
      taskId,
    );
    addEvent(
      db,
      taskId,
      'system',
      'SystemBlockRecovered',
      resumesSameDraft
        ? `恢复系统阻塞，交回 ${task.current_subagent}。`
        : `恢复系统阻塞，重新派发 ${task.current_subagent} 负责的当前步骤。`,
    );
    db.exec('COMMIT');
    await syncTaskFiles(db, taskId, { createClearedBlock: true });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages(`/tasks/${taskId}`, '/');
}

export class CodeSlotBusyError extends Error {
  constructor(public readonly ownerTaskId: string) {
    super(`代码槽已被 ${ownerTaskId} 占用`);
    this.name = 'CodeSlotBusyError';
  }
}

export async function updateTask(taskId: string, actor: Actor, changes: Partial<TaskState> & {
  next_step?: string | null;
  item_type?: string | null;
  priority?: string | null;
  title?: string | null;
}) {
  const db = await databaseConnection();
  const before = fetchTask(db, taskId);
  if (!before) throw new Error('需求不存在');
  changes = Object.fromEntries(Object.entries(changes).filter(([, item]) => item !== undefined)) as typeof changes;
  const changed = Object.keys(changes);
  assertUpdate(before, actor, changes, changed);
  if (changes.agile_status === 'blocked' && before.agile_status !== 'blocked') changes.resume_status = before.agile_status;
  const prospective = { ...before, ...changes } as TaskState;
  assertState(prospective);
  const completingRequirementClarification = actor === 'backlog-agent'
    && before.current_subagent === 'backlog-agent'
    && before.total_stories === 0
    && (changes.current_subagent === 'story-splitter-agent' || changes.current_subagent === 'repro-agent');
  const completingReproClarification = actor === 'repro-agent'
    && before.current_subagent === 'repro-agent'
    && changes.current_subagent === 'story-splitter-agent'
    && changes.agile_status === 'in plan';
  if (completingRequirementClarification) {
    const pending = (db.prepare(`
      SELECT COUNT(*) AS count FROM questions
      WHERE task_id = ? AND story_index IS NULL AND source_agent = 'backlog-agent' AND status = 'pending'
    `).get(taskId) as { count: number }).count;
    if (pending) throw new Error('仍有未回答的需求级产品歧义，不能完成需求梳理');
  }
  if (completingReproClarification) {
    const pending = (db.prepare(`
      SELECT COUNT(*) AS count FROM questions
      WHERE task_id = ? AND story_index IS NULL AND source_agent = 'repro-agent' AND status = 'pending'
    `).get(taskId) as { count: number }).count;
    if (pending) throw new Error('仍有未回答的复现对齐问题，不能进入交付拆分');
  }
  if (changes.analysis_index !== undefined && changes.analysis_index > before.analysis_index && prospective.spec_resolved_index < changes.analysis_index) {
    throw new Error(`交付单元 ${changes.analysis_index} 尚无已收敛的交付规格`);
  }
  if (changes.analysis_index !== undefined && changes.analysis_index > before.analysis_index) {
    const resolvedSpec = db.prepare(`
      SELECT 1 FROM story_specs
      WHERE task_id = ? AND story_index = ? AND status = 'resolved'
      LIMIT 1
    `).get(taskId, changes.analysis_index);
    if (!resolvedSpec) throw new Error(`交付单元 ${changes.analysis_index} 缺少已收敛的交付规格`);
  }
  if (changes.dev_index !== undefined && changes.dev_index > before.dev_index) {
    const resolvedSpec = db.prepare(`
      SELECT 1 FROM story_specs
      WHERE task_id = ? AND story_index = ? AND status = 'resolved'
      LIMIT 1
    `).get(taskId, changes.dev_index);
    if (!resolvedSpec) throw new Error(`交付单元 ${changes.dev_index} 缺少已收敛的交付规格`);
  }
  if (changes.agile_status === 'done' && before.closure_status !== 'acknowledged'
    && !(actor === 'direct-agent' && before.item_type === 'direct')) {
    throw new Error('当前版本的结卡报告尚未阅读');
  }
  const allowed = ['agile_status', 'current_subagent', 'analysis_index', 'dev_index', 'test_index', 'total_stories', 'spec_resolved_index', 'resume_status', 'blocked_reason', 'next_step', 'item_type', 'priority', 'title', 'run_state', 'closure_status', 'review_revision', 'review_document_id', 'closure_acknowledged_at'];
  const keys = allowed.filter((key) => key in changes);
  if (!keys.length) throw new Error('没有需要更新的字段');
  const fields = keys.map((key) => `${key} = ?`);
  const values = keys.map((key) => (changes as Record<string, unknown>)[key]);
  if (changes.agile_status && changes.agile_status !== 'blocked') {
    fields.push('resume_status = NULL');
    if (!('blocked_reason' in changes)) fields.push('blocked_reason = NULL');
  }
  if (changes.agile_status === 'done') fields.push('completed_at = CURRENT_TIMESTAMP');
  else if (changes.agile_status) fields.push('completed_at = NULL');
  if (changes.agile_status && !['ready_to_close', 'done'].includes(changes.agile_status)) {
    fields.push("closure_status = 'none'", 'review_document_id = NULL', 'closure_acknowledged_at = NULL');
  }
  fields.push('last_actor = ?', 'resume_pending = 0', 'updated_at = CURRENT_TIMESTAMP');
  values.push(actor);
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE task_id = ?`).run(...values, taskId);
    if (completingRequirementClarification) {
      const resolved = db.prepare(`
        UPDATE questions
        SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND story_index IS NULL AND source_agent = 'backlog-agent' AND status = 'answered'
      `).run(taskId);
      if (resolved.changes) addEvent(db, taskId, 'backlog-agent', 'RequirementClarificationsResolved', '需求级澄清回答已纳入最新需求上下文。');
    }
    if (completingReproClarification) {
      const resolved = db.prepare(`
        UPDATE questions
        SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND story_index IS NULL AND source_agent = 'repro-agent' AND status = 'answered'
      `).run(taskId);
      if (resolved.changes) addEvent(db, taskId, 'repro-agent', 'ReproClarificationsResolved', '复现对齐回答已纳入最新复现证据。');
    }
    const after = fetchTask(db, taskId);
    if (after) refreshTaskLaneStatesInDb(db, after);
    const updateSummary = changes.next_step
      || (changes.priority ? `调整优先级：${before.priority || '未设置'} → ${changes.priority}` : `更新状态：${changes.agile_status || before.agile_status}`);
    addEvent(db, taskId, actor, 'TaskUpdated', updateSummary);
    db.exec('COMMIT');
    await syncTaskFiles(db, taskId, { createClearedBlock: Boolean(changes.agile_status && changes.agile_status !== 'blocked') });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${taskId}`);
}

export async function setTaskPriority(input: unknown) {
  const value = z.object({
    taskId: z.string().min(1),
    priority: z.union([z.string(), z.number()]),
  }).parse(input);
  const priority = requirementPriority(value.priority);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET priority = ?, last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(priority, value.taskId);
    addEvent(db, value.taskId, 'human', 'TaskPriorityChanged', `调整优先级：${task.priority || '未设置'} → ${priority}`);
  })();
  refreshPages('/', '/tasks', `/tasks/${value.taskId}`);
}

const transitionSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'in feedback', 'ready_to_close', 'done', 'cancelled', 'blocked']),
  currentSubagent: z.string().trim().optional().nullable(),
  nextStep: z.string().trim().optional().nullable(),
});

export async function transitionTask(input: unknown) {
  const value = transitionSchema.parse(input);
  if (value.status === 'done' || value.status === 'ready_to_close') throw new Error('结卡状态只能由 Review 报告和阅读结卡流程推进');
  await updateTask(value.taskId, 'human', {
    agile_status: value.status,
    current_subagent: value.currentSubagent || undefined,
    next_step: value.nextStep || `人工设置状态为 ${value.status}`,
  });
}

export async function acknowledgeClosure(input: unknown) {
  const value = z.object({
    taskId: z.string().min(1),
    reviewRevision: z.coerce.number().int().positive(),
    actor: z.enum(['human']).default('human'),
  }).parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task || task.agile_status !== 'ready_to_close' || task.closure_status !== 'awaiting_read') throw new Error('需求当前没有等待阅读的结卡报告');
  if (task.review_revision !== value.reviewRevision || !task.review_document_id) throw new Error('结卡报告版本已变化，请阅读最新版本');
  const openComments = (db.prepare(`
    SELECT COUNT(*) AS count FROM document_comments
    WHERE task_id = ? AND feedback_status != 'resolved'
  `).get(value.taskId) as { count: number }).count;
  if (openComments) throw new Error(`当前还有 ${openComments} 条反馈尚未通过反馈闭环验证`);
  const activeFeedbackBatches = (db.prepare(`
    SELECT COUNT(*) AS count FROM feedback_batches
    WHERE task_id = ? AND status NOT IN ('completed', 'cancelled')
  `).get(value.taskId) as { count: number }).count;
  if (activeFeedbackBatches) throw new Error('当前反馈批次尚未完成，不能关闭需求');
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO closure_acknowledgements(
        acknowledgement_id, task_id, review_document_id, review_revision, acknowledged_by
      ) VALUES(?, ?, ?, ?, ?)
    `).run(randomUUID(), value.taskId, task.review_document_id, value.reviewRevision, value.actor);
    db.prepare(`
      UPDATE tasks
      SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle',
          closure_acknowledged_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP,
          next_step = '结卡报告已阅读，需求已关闭', last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(value.taskId);
    setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'analysis', status: 'completed' });
    setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'delivery', status: 'completed' });
    addEvent(db, value.taskId, value.actor, 'ClosureAcknowledged', `已阅读结卡报告 v${value.reviewRevision} 并关闭需求。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', '/tasks', `/tasks/${value.taskId}`);
}

const rewindSchema = z.object({
  taskId: z.string().min(1),
  to: z.enum(['context', 'repro', 'plan', 'analysis', 'dev', 'test']),
  story: z.coerce.number().int().positive().optional().nullable(),
  reason: z.string().trim().optional().nullable(),
  actor: z.enum(['human', 'system', 'analyst-agent', 'dev-agent', 'test-agent', 'review-agent']).default('human'),
});

const REWIND_STAGE_AGENTS = {
  context: 'backlog-agent',
  repro: 'repro-agent',
  plan: 'story-splitter-agent',
  analysis: 'analyst-agent',
  dev: 'dev-agent',
  test: 'test-agent',
} as const;

export async function rewindTask(input: unknown) {
  const value = rewindSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  if (task.agile_status === 'blocked') throw new Error('请先完成确认再执行回退');
  if (task.agile_status === 'done' || task.agile_status === 'cancelled') throw new Error('已结束需求不能直接回退');
  const permissions: Record<string, string[]> = {
    'analyst-agent': ['plan'],
    'dev-agent': ['analysis'],
    'test-agent': ['analysis', 'dev'],
  };
  if (value.actor !== 'human' && value.actor !== 'system' && !permissions[value.actor]?.includes(value.to)) throw new Error(`${value.actor} 无权 rewind 到 ${value.to}`);
  const targetAgent = REWIND_STAGE_AGENTS[value.to];
  let analysisIndex = task.analysis_index;
  let devIndex = task.dev_index;
  let testIndex = task.test_index;
  let totalStories = task.total_stories;
  let resolvedSpecIndex = task.spec_resolved_index;
  let nextStatus: TaskStatus;
  let storyLabel: string;
  const taskLevelRewind = ['context', 'repro', 'plan'].includes(value.to);
  if (taskLevelRewind) {
    analysisIndex = 0;
    devIndex = 0;
    testIndex = 0;
    totalStories = 0;
    resolvedSpecIndex = 0;
    const targetStatus: TaskStatus = value.to === 'context' ? 'backlog' : value.to === 'repro' ? 'in repro' : 'in plan';
    nextStatus = targetStatus;
    storyLabel = '全部交付单元';
  } else {
    if (task.total_stories <= 0) throw new Error('交付拆分完成前不能回退到单元阶段');
    if (!value.story || value.story < 1 || value.story > task.total_stories) throw new Error(`交付单元序号必须在 1-${task.total_stories} 之间`);
    const boundary = value.story - 1;
    if (value.to === 'analysis') {
      analysisIndex = Math.min(analysisIndex, boundary);
      resolvedSpecIndex = Math.min(resolvedSpecIndex, boundary);
      devIndex = Math.min(devIndex, boundary);
      testIndex = Math.min(testIndex, devIndex);
    } else if (value.to === 'dev') {
      devIndex = Math.min(devIndex, boundary);
      testIndex = Math.min(testIndex, devIndex);
    } else {
      testIndex = Math.min(testIndex, boundary);
    }
    nextStatus = task.agile_status === 'in feedback'
      ? 'in feedback'
      : devIndex > 0 ? 'in dev' : 'ready for dev';
    storyLabel = `交付单元 ${value.story}`;
  }
  const prospective = { ...task, agile_status: nextStatus, analysis_index: analysisIndex, dev_index: devIndex, test_index: testIndex, total_stories: totalStories, spec_resolved_index: resolvedSpecIndex };
  assertState(prospective);
  db.exec('BEGIN');
  try {
    if (taskLevelRewind) {
      releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, value.taskId);
      db.prepare(`
        UPDATE questions
        SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND status IN ('pending', 'answered', 'resolved')
      `).run(value.taskId);
      db.prepare(`
        UPDATE recovery_items
        SET status = 'superseded', resolved_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ? AND status IN ('pending', 'claimed', 'reopened')
      `).run(value.taskId);
      db.prepare('DELETE FROM stories WHERE task_id = ?').run(value.taskId);
    }
    db.prepare(`
      UPDATE tasks
      SET agile_status = ?, current_subagent = ?, analysis_index = ?, dev_index = ?,
          test_index = ?, total_stories = ?, spec_resolved_index = ?,
          next_step = ?,
          blocked_reason = NULL, resume_status = NULL, resume_pending = 0,
          run_state = 'runnable', closure_status = 'none', review_document_id = NULL,
          closure_acknowledged_at = NULL,
          last_actor = ?, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(nextStatus, targetAgent, analysisIndex, devIndex, testIndex, totalStories, resolvedSpecIndex, value.reason || `回退 ${storyLabel} 到 ${value.to}`, value.actor, value.taskId);
    if (taskLevelRewind) {
      setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'analysis', status: 'pending' });
      setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'delivery', status: 'pending' });
    } else if (value.to === 'analysis') {
      releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, value.taskId);
      setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'analysis', status: 'runnable' });
      const deliveryStatus = testIndex < devIndex || devIndex < analysisIndex ? 'runnable' : 'pending';
      setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'delivery', status: deliveryStatus });
    } else {
      setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'delivery', status: 'runnable' });
      const nextTask = fetchTask(db, value.taskId);
      if (nextTask) refreshTaskLaneStatesInDb(db, nextTask);
    }
    addEvent(db, value.taskId, value.actor, 'TaskRewound', `回退 ${storyLabel} 到 ${value.to}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId, { createClearedBlock: true });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${value.taskId}`);
}

const cancelSchema = z.object({ taskId: z.string().min(1), reason: z.string().min(1).max(500) });

export async function cancelTask(input: unknown) {
  const value = cancelSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  if (task.agile_status === 'done') throw new Error('已完成需求不能取消');
  if (task.agile_status === 'cancelled') return;
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET agile_status = 'cancelled', current_subagent = NULL, next_step = ?,
          blocked_reason = NULL, resume_status = NULL, resume_pending = 0,
          run_state = 'idle', last_actor = 'human',
          completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(`已取消：${value.reason}`, value.taskId);
    setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'analysis', status: 'completed' });
    setTaskLaneStateInDb(db, { taskId: value.taskId, lane: 'delivery', status: 'completed' });
    db.prepare(`
      UPDATE agent_results
      SET application_status = 'applied', application_error = NULL,
          effect_outcome = 'discarded', applied_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND application_status = 'pending'
    `).run(value.taskId);
    db.prepare(`
      UPDATE execution_attempts
      SET status = 'cancelled', last_error = '需求已取消',
          finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
        AND status IN ('planned', 'output_received', 'verifying', 'applying', 'retryable_failed', 'system_blocked')
    `).run(value.taskId);
    releaseTaskResourceClaimsInDb(db, value.taskId);
    addEvent(db, value.taskId, 'human', 'TaskCancelled', value.reason);
    db.exec('COMMIT');
    await cancelFeedbackForTask(value.taskId);
    await syncTaskFiles(db, value.taskId, { createClearedBlock: true });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  await advanceAndPublishRuntimeInvalidation('execution.cancel-requested', value.taskId);
  refreshPages('/', `/tasks/${value.taskId}`);
}

const pauseTaskSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

export async function pauseTask(input: unknown) {
  const value = pauseTaskSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  if (['done', 'cancelled'].includes(task.agile_status)) throw new Error('已结束需求不能暂停');
  const reason = value.reason || '暂缓推进';
  db.transaction(() => {
    if (!task.is_paused) {
      db.prepare(`
        UPDATE tasks
        SET is_paused = 1, paused_reason = ?, paused_at = CURRENT_TIMESTAMP,
            last_actor = 'human', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(reason, value.taskId);
    }
    db.prepare(`
      UPDATE execution_attempts
      SET status = 'cancelled', last_error = '需求已暂停',
          finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status IN ('planned', 'running')
    `).run(value.taskId);
    const resources = (db.prepare(`
      SELECT resource_key FROM resource_claims
      WHERE owner_task_id = ? ORDER BY resource_key
    `).all(value.taskId) as Array<{ resource_key: string }>).map((row) => row.resource_key);
    releaseTaskResourceClaimsInDb(db, value.taskId);
    if (!task.is_paused) {
      addEvent(
        db,
        value.taskId,
        'human',
        'TaskPaused',
        `暂停推进：${reason}${resources.length ? `；已立即释放资源：${resources.join('、')}` : ''}`,
      );
    }
  })();
  await advanceAndPublishRuntimeInvalidation('execution.cancel-requested', value.taskId);
  refreshPages('/', '/tasks', `/tasks/${value.taskId}`);
}

export async function resumeTask(input: unknown) {
  const { taskId } = z.object({ taskId: z.string().min(1) }).parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task) throw new Error('需求不存在');
  if (!task.is_paused) return;
  if (['done', 'cancelled'].includes(task.agile_status)) throw new Error('已结束需求不能恢复推进');
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET is_paused = 0, paused_reason = NULL, paused_at = NULL,
          last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(taskId);
    addEvent(db, taskId, 'human', 'TaskResumed', '恢复推进，等待重新调度');
  })();
  refreshPages('/', '/tasks', `/tasks/${taskId}`);
}

export async function setTaskLaneState(input: {
  taskId: string;
  lane: TaskLaneKind;
  status: TaskLane['status'];
  currentAgent?: string | null;
  currentStoryIndex?: number | null;
  blockedReason?: string | null;
  resumePending?: number;
}) {
  const db = await databaseConnection();
  const task = fetchTask(db, input.taskId);
  if (!task) throw new Error('需求不存在');
  db.transaction(() => {
    setTaskLaneStateInDb(db, input);
    if (input.status === 'system_blocked') {
      releaseLaneExecutionResourceClaimsInDb(db, input.taskId, input.lane);
      if (input.lane === 'delivery' && ['dev-agent', 'test-agent'].includes(input.currentAgent || '')) {
        releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, input.taskId);
      }
      db.prepare(`
        UPDATE tasks SET current_subagent = ?, blocked_reason = ?, next_step = ?,
          resume_pending = 0, last_actor = 'system', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(
        input.currentAgent || null,
        input.blockedReason || 'Lane 执行失败',
        `${input.lane} Lane 系统阻塞：${input.blockedReason || '执行失败'}`,
        input.taskId,
      );
      addEvent(db, input.taskId, 'system', 'LaneSystemBlocked', `${input.lane} Lane：${input.blockedReason || '执行失败'}`);
    }
  })();
  refreshPages('/', `/tasks/${input.taskId}`);
}

type BeginRunOptions = { preserveRunIntent?: boolean };

async function reconcileDispatchLanes() {
  const { progressDispatcher } = await import('./progress-dispatch');
  return progressDispatcher.reconcileStaleLanes();
}

function interruptedExecutionRecoveryLog(recovered: Awaited<ReturnType<typeof import('./executions')['reconcileInterruptedExecutions']>>) {
  return `${recovered.retryableCount} 个无结果执行转为可重试，`
    + `${recovered.blockedCount} 个无结果执行因重试耗尽而阻塞，`
    + `${recovered.cancelledReservationCount} 个未启动派发已取消，`
    + `${recovered.recoverableCount + recovered.pendingResultCount} 个已有结果执行等待恢复`;
}

export async function beginRun(owner = 'ui', options: BeginRunOptions = {}) {
  const { ensureAgentRuntimeWorkspace } = await import('./agent-profiles');
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.active) {
    throw new Error(`已有本地 loop 正在运行 pid=${current.pid ?? 'starting'}`);
  }
  if (current?.runId) {
    const { stopAgentRun } = await import('../infrastructure/agent-runner');
    const { reconcileInterruptedExecutions } = await import('./executions');
    await stopAgentRun(current.runId);
    const recovered = await reconcileInterruptedExecutions(current.runId, 'Runner 异常退出，执行尚未返回结构化结果');
    db.prepare(`
      UPDATE loop_runs
      SET status = 'crashed', finished_at = CURRENT_TIMESTAMP,
          failure_reason = COALESCE(failure_reason, '启动新一轮时检测到 Runner 已退出')
      WHERE run_id = ? AND status IN ('starting', 'running', 'stopping')
    `).run(current.runId);
    db.prepare("DELETE FROM loop_meta WHERE key = 'active_run'").run();
    await reconcileDispatchLanes();
    await appendLoopRunLog(current.runId, `[恢复] 检测到旧 Runner 已退出：${interruptedExecutionRecoveryLog(recovered)}`);
  } else {
    const { reconcileInterruptedExecutions } = await import('./executions');
    const recovered = await reconcileInterruptedExecutions(null, '未找到所属 Runner，执行尚未返回结构化结果');
    if (recovered.failedCount) await reconcileDispatchLanes();
  }
  const runId = randomUUID();
  const startedAt = new Date();
  db.transaction(() => {
    if (!options.preserveRunIntent) {
      db.prepare(`
        INSERT INTO loop_meta(key, value) VALUES('loop_run_intent', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(JSON.stringify({ enabledAt: toUtcIsoString(startedAt), restartCount: 0 }));
    }
    db.prepare(`
      INSERT INTO loop_runs(run_id, owner, status, started_at)
      VALUES(?, ?, 'starting', ?)
    `).run(runId, owner, toUtcIsoString(startedAt));
    db.prepare(`
      INSERT INTO loop_meta(key, value) VALUES('active_run', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify({ runId, owner, startedAt: toUtcIsoString(startedAt) }));
  })();
  await appendLoopRunLog(runId, `[运行] 开始运行 run=${runId}`);
  await appendLoopRunLog(runId, `[运行] 工作区=${paths.root}`);
  await appendLoopRunLog(runId, `[运行] 数据目录=${paths.dataDir}`);
  return runId;
}

export async function endRun(runId: string, force = false, options: { stopRunner?: boolean; reason?: string; preserveRunIntent?: boolean } = {}) {
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.runId && current.runId !== runId) {
    if (force) return;
    throw new Error('运行 ID 不匹配');
  }
  // Clear the durable intent before stopping the process so the desktop
  // supervisor cannot race a deliberate user stop and start a replacement.
  if (!options.preserveRunIntent) db.prepare("DELETE FROM loop_meta WHERE key = 'loop_run_intent'").run();
  if (current?.runId && options.stopRunner !== false) {
    db.prepare("UPDATE loop_runs SET status = 'stopping', stop_requested_at = CURRENT_TIMESTAMP WHERE run_id = ?").run(current.runId);
    const { stopAgentRun } = await import('../infrastructure/agent-runner');
    await stopAgentRun(current.runId);
  }
  if (current?.runId) {
    const reason = options.reason || (force ? '异常终止' : '用户停止');
    const { reconcileInterruptedExecutions } = await import('./executions');
    const recovered = await reconcileInterruptedExecutions(current.runId, `Loop 已停止（${reason}），执行尚未返回结构化结果`);
    await reconcileDispatchLanes();
    await appendLoopRunLog(current.runId, `[运行] Loop 已停止：${reason}`);
    await appendLoopRunLog(current.runId, `[恢复] ${interruptedExecutionRecoveryLog(recovered)}，将在下次运行继续`);
    db.prepare(`
      UPDATE loop_runs
      SET status = ?, finished_at = CURRENT_TIMESTAMP, failure_reason = ?
      WHERE run_id = ?
    `).run(force ? 'crashed' : 'stopped', force ? reason : null, current.runId);
  }
  db.prepare("DELETE FROM loop_meta WHERE key = 'active_run'").run();
}

type LoopRunRow = {
  run_id: string;
  owner: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  process_kind: string | null;
  runner_pid: number | null;
  started_at: string;
  heartbeat_at: string | null;
  supervision_token: number | null;
};

const RUN_HEARTBEAT_TIMEOUT_MS = 45_000;

function databaseTimestampMs(value: string | null | undefined) {
  if (!value) return 0;
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

function getRunStatusFromDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  expectedSupervisionToken = Number(process.env.LOOP_SUPERVISION_TOKEN || 0),
) {
  const row = db.prepare("SELECT value FROM loop_meta WHERE key = 'active_run'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { runId: string; owner: string; startedAt: string };
    const persisted = db.prepare('SELECT * FROM loop_runs WHERE run_id = ?').get(parsed.runId) as LoopRunRow | undefined;
    const pid = persisted?.runner_pid || readRunPid(parsed.runId);
    const startedAt = persisted?.started_at || parsed.startedAt;
    const heartbeatAt = persisted?.heartbeat_at || null;
    const starting = !heartbeatAt && Date.now() - databaseTimestampMs(startedAt) < 15_000;
    const heartbeatAgeMs = heartbeatAt ? Math.max(0, Date.now() - databaseTimestampMs(heartbeatAt)) : null;
    const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= RUN_HEARTBEAT_TIMEOUT_MS;
    const pidAlive = isProcessAlive(pid);
    let generationActive = true;
    const runnerToken = expectedSupervisionToken;
    if (runnerToken > 0) {
      const lifecycle = db.prepare(`SELECT desired_intent, mode FROM loop_lifecycle_state WHERE singleton = 1`).get() as { desired_intent: string; mode: string } | undefined;
      const lease = db.prepare(`SELECT fencing_token, expires_at FROM loop_supervisor_lease WHERE singleton = 1`).get() as { fencing_token: number; expires_at: string } | undefined;
      generationActive = lifecycle?.desired_intent === 'running'
        && lifecycle.mode === 'normal'
        && persisted?.supervision_token === runnerToken
        && lease?.fencing_token === runnerToken
        && databaseTimestampMs(lease.expires_at) + 15_000 > Date.now();
    }
    const active = generationActive && persisted?.status !== 'stopped' && persisted?.status !== 'crashed'
      && (starting || (pidAlive && heartbeatFresh));
    return {
      runId: parsed.runId,
      owner: persisted?.owner || parsed.owner,
      startedAt,
      heartbeatAt,
      processKind: persisted?.process_kind || null,
      status: persisted?.status || 'starting',
      pid,
      active,
      health: { starting, pidAlive, heartbeatFresh, heartbeatAgeMs, generationActive },
    } satisfies NonNullable<RunStatus>;
  } catch {
    return null;
  }
}

export async function getRunStatus(expectedSupervisionToken?: number): Promise<RunStatus> {
  const db = await databaseConnection();
  return getRunStatusFromDb(db, expectedSupervisionToken);
}

export async function registerRunProcess(runId: string, processKind: 'agent-runner', pid: number, supervisionToken: number, processStartMarker: string) {
  const db = await databaseConnection();
  db.transaction(() => {
    const lease = db.prepare(`SELECT fencing_token, expires_at FROM loop_supervisor_lease WHERE singleton = 1`).get() as { fencing_token: number; expires_at: string } | undefined;
    const lifecycle = db.prepare(`SELECT desired_intent, mode FROM loop_lifecycle_state WHERE singleton = 1`).get() as { desired_intent: string; mode: string } | undefined;
    if (!lease || lease.fencing_token !== supervisionToken || databaseTimestampMs(lease.expires_at) <= Date.now()
      || lifecycle?.desired_intent !== 'running' || lifecycle.mode !== 'normal') {
      throw new Error('Runner 登记被拒绝：监督代次已经失效');
    }
    const updated = db.prepare(`
      UPDATE loop_runs
      SET status = 'running', process_kind = ?, runner_pid = ?, supervision_token = ?, heartbeat_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status IN ('starting', 'running')
    `).run(processKind, pid, supervisionToken, runId);
    if (updated.changes !== 1) throw new Error('Runner 登记被拒绝：运行状态已经变化');
    registerManagedProcessInDb(db, {
      processId: randomUUID(),
      supervisionToken,
      processKind: 'agent-runner',
      pid,
      processStartMarker,
      runId,
    });
  }).immediate();
}

export async function heartbeatRun(runId: string, processKind: 'agent-runner') {
  const db = await databaseConnection();
  const supervisionToken = Number(process.env.LOOP_SUPERVISION_TOKEN || 0);
  db.prepare(`
    UPDATE loop_runs
    SET status = 'running', process_kind = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE run_id = ? AND supervision_token = ? AND status IN ('starting', 'running')
  `).run(processKind, runId, supervisionToken);
}

export async function startRunHeartbeat(runId: string, processKind: 'agent-runner') {
  await heartbeatRun(runId, processKind);
  const timer = setInterval(() => {
    void heartbeatRun(runId, processKind).catch(() => { /* main runner owns error reporting */ });
  }, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function ensureLoopRuntimeFiles() {
  await databaseConnection();
}

export function toPipeEnvelope(item: DelegationEnvelope) {
  const clean = (value: unknown) => String(value ?? '').replaceAll('|', '／').replaceAll('\n', ' ').trim();
  return [item.taskId, item.title, item.pipeline, item.agent, item.storyIndex ?? '', item.description, item.lane].map(clean).join('|');
}
