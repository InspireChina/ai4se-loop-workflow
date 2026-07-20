import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { sliceSpecSchema } from '../domain/agent-result';
import { databaseConnection, paths } from '../infrastructure/database';
import { verifyDevCommit } from '../infrastructure/git';
import { isRunProcessAlive, readRunPid } from '../infrastructure/run-process';
import { toUtcIsoString } from './event-time';
import { recordLoopLogEventInDb } from './runtime-events';
import {
  assertActorCanCreate,
  assertState,
  assertUpdate,
  nextDelegation,
  occupiesCodeSlot,
  type Actor,
  type Delegation,
  type TaskState,
  type TaskStatus,
} from '../domain/task';

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
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type Story = { task_id: string; story_index: number; title: string; directory: string };
export type StorySpec = { spec_id: string; task_id: string; story_index: number; revision: number; status: 'draft' | 'waiting_for_answers' | 'resolved' | 'superseded'; spec_json: string; source_result_id: string | null; created_at: string; resolved_at: string | null };
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
  evolution_status: 'pending' | 'analyzed';
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
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
  spec_revision: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ClosureAcknowledgement = { acknowledgement_id: string; task_id: string; review_document_id: string; review_revision: number; acknowledged_by: string; acknowledged_at: string };
export type VerificationRun = { verification_id: string; task_id: string; story_index: number; spec_revision: number; code_commit: string | null; status: string; started_at: string; finished_at: string | null };
export type VerificationEvidence = { evidence_id: string; verification_id: string; criterion_id: string; kind: string; instruction: string; command: string | null; exit_code: number | null; output_summary: string | null; passed: number; created_at: string };
export type ExecutionAttemptView = { execution_id: string; run_id: string; task_id: string; story_index: number | null; agent: string; pipeline: string; attempt: number; status: string; input_hash: string; base_commit: string | null; code_commit: string | null; verification_id: string | null; prompt_version: number | null; prompt_hash: string | null; memory_revision: number | null; memory_hash: string | null; evolution_candidate_id: string | null; last_error: string | null; created_at: string; started_at: string | null; finished_at: string | null };
export type Event = { event_id: string; actor: string; event_type: string; summary: string; created_at: string };
export type RunStatus = { runId: string; owner: string; startedAt: string; pid: number | null; active: boolean } | null;
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
};

const taskSelect = `
  SELECT task_id, title, description, link, external_id, external_status, item_type, priority,
         agile_status, current_subagent, analysis_index, dev_index, test_index,
         total_stories, spec_resolved_index, resume_status,
         resume_pending, next_step, blocked_reason, run_state, closure_status,
         review_revision, review_document_id, closure_acknowledged_at,
         last_actor, owner, evidence, risk, created_at, updated_at, completed_at
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

function appendRunLogInDb(db: Awaited<ReturnType<typeof databaseConnection>>, runId: string, message: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('invalid run id');
  db.prepare('INSERT INTO run_logs(run_id, line) VALUES(?, ?)').run(runId, loopLogLine(message));
  recordLoopLogEventInDb(db, runId, message);
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
  for (const pagePath of pagePaths) {
    try {
      revalidatePath(pagePath);
    } catch {
      // CLI usage runs outside Next's request context; database/file writes are still complete.
    }
  }
}

function taskIdFromTitleLink(title: string, link?: string | null) {
  const seed = link || title;
  return `REQ-${createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
}

async function syncTaskFiles(_db: Awaited<ReturnType<typeof databaseConnection>>, _taskId: string, _options: { createClearedBlock?: boolean } = {}) {
  // DB-first product mode: target repo files are no longer generated or synchronized.
}

export async function listTasks(options: { includeTerminal?: boolean } = {}): Promise<Task[]> {
  const db = await databaseConnection();
  const where = options.includeTerminal ? '' : "WHERE agile_status NOT IN ('done', 'cancelled')";
  return db.prepare(`
    ${taskSelect}
    ${where}
    ORDER BY CASE agile_status WHEN 'blocked' THEN 0 ELSE 1 END, priority, updated_at DESC
  `).all() as Task[];
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

export async function listPipeline() {
  return pipelineAll();
}

export async function listRecentEvents(limit = 20): Promise<(Event & { task_id: string; title: string })[]> {
  const db = await databaseConnection();
  return db.prepare(`
    SELECT e.event_id, e.task_id, t.title, e.actor, e.event_type, e.summary, e.created_at
    FROM task_events e
    JOIN tasks t ON t.task_id = e.task_id
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(limit) as (Event & { task_id: string; title: string })[];
}

export async function getTask(taskId: string) {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task) return null;
  const stories = db.prepare('SELECT * FROM stories WHERE task_id = ? ORDER BY story_index').all(taskId) as Story[];
  const storySpecs = db.prepare('SELECT * FROM story_specs WHERE task_id = ? ORDER BY story_index, revision').all(taskId) as StorySpec[];
  const questions = db.prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY created_at').all(taskId) as Question[];
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY story_index, kind, updated_at').all(taskId) as Document[];
  const documentComments = db.prepare('SELECT * FROM document_comments WHERE task_id = ? ORDER BY created_at').all(taskId) as DocumentComment[];
  const closureAcknowledgements = db.prepare('SELECT * FROM closure_acknowledgements WHERE task_id = ? ORDER BY review_revision').all(taskId) as ClosureAcknowledgement[];
  const verificationRuns = db.prepare('SELECT * FROM verification_runs WHERE task_id = ? ORDER BY started_at, verification_id').all(taskId) as VerificationRun[];
  const verificationEvidence = db.prepare(`
    SELECT evidence.* FROM verification_evidence evidence
    JOIN verification_runs run ON run.verification_id = evidence.verification_id
    WHERE run.task_id = ? ORDER BY evidence.created_at, evidence.evidence_id
  `).all(taskId) as VerificationEvidence[];
  const executionAttempts = db.prepare(`
    SELECT execution_id, run_id, task_id, story_index, agent, pipeline, attempt, status,
           input_hash, base_commit, code_commit, verification_id,
           prompt_version, prompt_hash, memory_revision, memory_hash, evolution_candidate_id, last_error,
           created_at, started_at, finished_at
    FROM execution_attempts
    WHERE task_id = ?
    ORDER BY created_at, execution_id
  `).all(taskId) as ExecutionAttemptView[];
  const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as Event[];
  return { task, stories, storySpecs, questions, documents, documentComments, closureAcknowledgements, verificationRuns, verificationEvidence, executionAttempts, events };
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
  actor: z.enum(['human', 'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent']).default('human'),
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
});

export async function addDocumentComment(input: unknown) {
  const value = documentCommentSchema.parse(input);
  const db = await databaseConnection();
  const document = db.prepare('SELECT * FROM documents WHERE document_id = ? AND task_id = ?').get(value.documentId, value.taskId) as Document | undefined;
  if (!document) throw new Error('文档不存在');
  const hasSelection = value.anchorType === 'selection' && Boolean(value.quotedText);
  if (value.anchorType === 'selection' && !hasSelection) throw new Error('选区评论必须包含引用内容');
  if (value.startOffset != null && value.endOffset != null && value.endOffset < value.startOffset) throw new Error('评论选区无效');
  const commentId = randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO document_comments(
        comment_id, document_id, task_id, document_revision, agent_id,
        anchor_type, quoted_text, start_offset, end_offset, content
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
    addEvent(db, value.taskId, 'human', 'DocumentCommented', `评论文档：${document.title}`);
  })();
  refreshPages(`/tasks/${value.taskId}`);
  return commentId;
}

const resolveDocumentCommentSchema = z.object({
  taskId: z.string().min(1),
  commentId: z.string().min(1),
});

export async function resolveDocumentComment(input: unknown) {
  const value = resolveDocumentCommentSchema.parse(input);
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
      SET status = 'resolved', evolution_status = 'pending', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE comment_id = ?
    `).run(value.commentId);
    addEvent(db, value.taskId, 'human', 'DocumentCommentResolved', `解决文档评论：${comment.title}`);
  })();
  refreshPages(`/tasks/${value.taskId}`);
}

const createTaskSchema = z.object({
  title: z.string().min(1).max(300),
  // Story 2 persists and exposes this value to agents. Accept it here so the
  // creation boundary remains stable while title-only Tasks stay valid.
  description: z.string().optional().nullable(),
  link: z.string().trim().optional().nullable(),
  externalId: z.string().trim().optional().nullable(),
  externalStatus: z.string().trim().optional().nullable(),
  itemType: z.enum(['feature', 'bug', 'tech', 'intake', 'other']).default('feature'),
  priority: z.string().trim().optional().nullable(),
  actor: z.enum(['human']).default('human'),
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'ready_to_close', 'done', 'cancelled', 'blocked']).default('backlog'),
  currentSubagent: z.string().trim().optional().nullable(),
  taskId: z.string().trim().optional().nullable(),
});

export async function createTask(input: unknown) {
  const value = createTaskSchema.parse(input);
  const description = value.description?.trim() || null;
  const link = value.link || null;
  const taskId = value.taskId || taskIdFromTitleLink(value.title, link);
  const currentSubagent = value.currentSubagent || null;
  assertActorCanCreate(value.actor, value.status, currentSubagent);
  const state: TaskState = {
    task_id: taskId,
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
  const db = await databaseConnection();
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT OR IGNORE INTO tasks(
        task_id, title, description, link, external_id, external_status, item_type, priority,
        agile_status, current_subagent, analysis_index, dev_index, test_index,
        total_stories, spec_resolved_index, next_step,
        work_dir, blocked_reason, last_actor
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, '', ?, ?)
    `).run(taskId, value.title, description, link, value.externalId || null, value.externalStatus || null, value.itemType, value.priority || null, value.status, currentSubagent, '新建需求，等待 Loop 梳理', state.blocked_reason, value.actor);
    const task = link ? (db.prepare(`${taskSelect} WHERE link = ?`).get(link) as Task | undefined) : fetchTask(db, taskId);
    if (!task) throw new Error('需求创建失败');
    addEvent(db, task.task_id, value.actor, 'TaskCreated', `创建需求：${task.title}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, task.task_id);
    refreshPages('/', '/tasks');
    return task.task_id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const contextSchema = z.object({
  taskId: z.string().min(1),
  kind: z.enum(['feature', 'bug', 'tech', 'intake']).default('feature'),
  slug: z.string().trim().optional().nullable(),
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'ready_to_close', 'done', 'cancelled', 'blocked']).optional().nullable(),
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
    db.prepare('UPDATE tasks SET total_stories = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(prospective.total_stories, `已新增交付单元 ${nextIndex}，等待方案分析`, value.actor, value.taskId);
    addEvent(db, value.taskId, value.actor, 'StoryAdded', `新增交付单元 ${nextIndex}：${value.title}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    refreshPages(`/tasks/${value.taskId}`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function saveStorySpec(input: unknown) {
  const value = z.object({
    taskId: z.string().min(1),
    storyIndex: z.coerce.number().int().positive(),
    status: z.enum(['draft', 'waiting_for_answers', 'resolved']),
    spec: sliceSpecSchema,
    sourceResultId: z.string().optional().nullable(),
  }).parse(input);
  if (value.status === 'resolved' && value.spec.ambiguities.length) throw new Error('resolved Slice Spec 不能包含未解决歧义');
  if (value.status === 'waiting_for_answers' && !value.spec.ambiguities.length) throw new Error('等待回答的 Slice Spec 必须列出歧义');
  const criterionIds = new Set(value.spec.acceptanceCriteria.map((criterion) => criterion.id));
  const missingCriteria = value.spec.verificationPlan.filter((step) => !criterionIds.has(step.criterionId));
  if (missingCriteria.length) throw new Error(`验证计划引用了不存在的验收标准：${missingCriteria.map((step) => step.criterionId).join(', ')}`);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task || value.storyIndex > task.total_stories) throw new Error('交付单元不存在');
  if (value.status === 'resolved') {
    const pending = (db.prepare(`
      SELECT COUNT(*) AS count FROM questions
      WHERE task_id = ? AND story_index = ? AND status = 'pending'
    `).get(value.taskId, value.storyIndex) as { count: number }).count;
    if (pending) throw new Error('仍有未回答的产品歧义，不能保存 resolved Slice Spec');
    const answeredKeys = (db.prepare(`
      SELECT decision_key FROM questions
      WHERE task_id = ? AND story_index = ? AND status = 'answered' AND decision_key IS NOT NULL
    `).all(value.taskId, value.storyIndex) as { decision_key: string }[]).map((row) => row.decision_key);
    const decisionKeys = new Set(value.spec.decisions.map((decision) => decision.key));
    const missingDecisions = answeredKeys.filter((key) => !decisionKeys.has(key));
    if (missingDecisions.length) throw new Error(`用户回答尚未写入规格决策：${missingDecisions.join(', ')}`);
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
    addEvent(db, value.taskId, 'analyst-agent', 'SliceSpecSaved', `保存交付单元 ${value.storyIndex} 规格 v${revision}（${value.status}）。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages(`/tasks/${value.taskId}`);
  return { specId, revision, status: value.status };
}

const answerSchema = z.object({ taskId: z.string().min(1), questionId: z.string().min(1), answer: z.string().min(1).max(4000) });

export async function answerQuestion(input: unknown) {
  const { taskId, questionId, answer } = answerSchema.parse(input);
  const db = await databaseConnection();
  const question = db.prepare('SELECT * FROM questions WHERE question_id = ? AND task_id = ?').get(questionId, taskId) as Question | undefined;
  if (!question) throw new Error('确认事项不存在');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE questions SET answer = ?, status = \'answered\', updated_at = CURRENT_TIMESTAMP WHERE question_id = ?').run(answer, questionId);
    addEvent(db, taskId, 'human', 'QuestionAnswered', `回答了「${question.title}」。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages(`/tasks/${taskId}`, '/');
}

const questionSchema = z.object({
  taskId: z.string().min(1),
  storyIndex: z.coerce.number().int().positive().optional().nullable(),
  kind: z.enum(['local', 'analysis', 'test', 'review']).default('local'),
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
  specRevision: z.coerce.number().int().positive().default(1),
  blockedReason: z.string().max(1000).optional().nullable(),
  blockTask: z.coerce.boolean().default(true),
  actor: z.enum(['human', 'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent']).default('human'),
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
        recommendation_reason, depends_on_json, spec_revision
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      questionId, value.taskId, storyIndex || null, value.kind, value.title, value.question,
      value.why || null, value.recommendation || null, relativePath, value.actor,
      value.decisionKey || null, value.alternatives.length ? JSON.stringify(value.alternatives) : null,
      value.recommendationReason || null, value.dependsOn.length ? JSON.stringify(value.dependsOn) : null,
      value.specRevision,
    );
    if (value.blockTask) {
      const agent = value.kind === 'analysis' ? 'analyst-agent' : value.actor !== 'human' ? value.actor : task.current_subagent || 'backlog-agent';
      db.prepare(`
        UPDATE tasks
        SET run_state = 'waiting_for_answers', current_subagent = ?,
            resume_pending = 0, blocked_reason = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(agent, value.blockedReason || value.title, `等待人工回答：${value.title}`, value.actor, value.taskId);
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
  if (!task || task.run_state !== 'waiting_for_answers') throw new Error('需求当前不在等待澄清回答状态');
  if (task.current_subagent !== 'analyst-agent') throw new Error('只有方案分析阶段可以提交产品澄清回答');
  const pending = (db.prepare("SELECT COUNT(*) AS count FROM questions WHERE task_id = ? AND status = 'pending'").get(taskId) as { count: number }).count;
  if (pending) throw new Error('仍有未回答的澄清问题，不能继续分析');
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET run_state = 'runnable', resume_pending = 1, blocked_reason = NULL,
          next_step = '用户回答已提交，交回方案分析 Agent 重建完整规格',
          last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(taskId);
    addEvent(db, taskId, 'human', 'ClarificationAnswersSubmitted', '提交全部澄清回答，等待 AI 重建规格。');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${taskId}`);
}

export async function releaseBlock(taskId: string) {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task || task.agile_status !== 'blocked') throw new Error('需求当前不在系统阻塞状态');
  const pendingQuestions = (db.prepare('SELECT COUNT(*) AS count FROM questions WHERE task_id = ? AND status = \'pending\'').get(taskId) as { count: number }).count;
  if (pendingQuestions) throw new Error('产品澄清必须通过提交回答恢复，不能用系统恢复命令绕过');
  const resumeStatus = task.resume_status;
  if (!resumeStatus || resumeStatus === 'blocked') throw new Error('系统阻塞缺少可恢复状态');
  if (!task.current_subagent) throw new Error('系统阻塞缺少负责 Agent');

  const prospective = { ...task, agile_status: resumeStatus, run_state: 'runnable' as const };
  assertState(prospective);
  const active = db.prepare(`
    ${taskSelect}
    WHERE task_id != ? AND (
      agile_status = 'in dev'
      OR (agile_status = 'blocked' AND resume_status = 'in dev')
      OR run_state = 'waiting_for_git_input'
    )
    LIMIT 1
  `).get(taskId) as Task | undefined;
  if (active && resumeStatus === 'in dev') throw new Error(`代码槽已被 ${active.task_id} 占用`);

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET agile_status = ?, run_state = 'runnable', resume_status = NULL, resume_pending = 1, blocked_reason = NULL,
          next_step = ?,
          last_actor = 'system', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(resumeStatus, `系统阻塞已解除，交回 ${task.current_subagent} 继续处理`, taskId);
    addEvent(db, taskId, 'system', 'SystemBlockRecovered', `恢复系统阻塞，交回 ${task.current_subagent}。`);
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
  if (changes.analysis_index !== undefined && changes.analysis_index > before.analysis_index && prospective.spec_resolved_index < changes.analysis_index) {
    throw new Error(`交付单元 ${changes.analysis_index} 尚无已解决的 Slice Spec`);
  }
  if (changes.analysis_index !== undefined && changes.analysis_index > before.analysis_index) {
    const resolvedSpec = db.prepare(`
      SELECT 1 FROM story_specs
      WHERE task_id = ? AND story_index = ? AND status = 'resolved'
      LIMIT 1
    `).get(taskId, changes.analysis_index);
    if (!resolvedSpec) throw new Error(`交付单元 ${changes.analysis_index} 缺少 resolved Slice Spec`);
  }
  if (changes.dev_index !== undefined && changes.dev_index > before.dev_index) {
    const recorded = db.prepare(`
      SELECT code_commit FROM execution_attempts
      WHERE task_id = ? AND story_index = ? AND agent = 'dev-agent' AND code_commit IS NOT NULL
      ORDER BY created_at DESC, execution_id DESC LIMIT 1
    `).get(taskId, changes.dev_index) as { code_commit: string } | undefined;
    const verification = verifyDevCommit(paths.root, taskId, changes.dev_index, recorded?.code_commit);
    if (!verification.ok) throw new Error(`交付单元 ${changes.dev_index} 的代码尚未按要求提交：${verification.reason}`);
  }
  if (changes.agile_status === 'done' && before.closure_status !== 'acknowledged') throw new Error('当前版本的结卡报告尚未阅读');
  if (prospective.agile_status === 'in dev') {
    const active = db.prepare(`
      ${taskSelect}
      WHERE task_id != ? AND (
        agile_status = 'in dev'
        OR (agile_status='blocked' AND resume_status = 'in dev')
        OR run_state = 'waiting_for_git_input'
      )
      LIMIT 1
    `).get(taskId) as Task | undefined;
    if (active) throw new CodeSlotBusyError(active.task_id);
  }
  const allowed = ['agile_status', 'current_subagent', 'analysis_index', 'dev_index', 'test_index', 'total_stories', 'spec_resolved_index', 'blocked_reason', 'next_step', 'item_type', 'priority', 'title', 'resume_status', 'run_state', 'closure_status', 'review_revision', 'review_document_id', 'closure_acknowledged_at'];
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
    addEvent(db, taskId, actor, 'TaskUpdated', changes.next_step || `更新状态：${changes.agile_status || before.agile_status}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, taskId, { createClearedBlock: Boolean(changes.agile_status && changes.agile_status !== 'blocked') });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${taskId}`);
}

const transitionSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'ready_to_close', 'done', 'cancelled', 'blocked']),
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
  to: z.enum(['plan', 'analysis', 'dev', 'test']),
  story: z.coerce.number().int().positive().optional().nullable(),
  reason: z.string().trim().optional().nullable(),
  actor: z.enum(['human', 'system', 'analyst-agent', 'dev-agent', 'test-agent', 'review-agent']).default('human'),
});

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
    'review-agent': ['plan', 'analysis', 'dev', 'test'],
  };
  if (value.actor !== 'human' && value.actor !== 'system' && !permissions[value.actor]?.includes(value.to)) throw new Error(`${value.actor} 无权 rewind 到 ${value.to}`);
  const occupied = occupiesCodeSlot(task) || task.dev_index > 0;
  const targetAgent = { plan: 'story-splitter-agent', analysis: 'analyst-agent', dev: 'dev-agent', test: 'test-agent' }[value.to];
  let analysisIndex = task.analysis_index;
  let devIndex = task.dev_index;
  let testIndex = task.test_index;
  let totalStories = task.total_stories;
  let resolvedSpecIndex = task.spec_resolved_index;
  let nextStatus: TaskStatus;
  let storyLabel: string;
  if (value.to === 'plan') {
    analysisIndex = 0;
    devIndex = 0;
    testIndex = 0;
    totalStories = 0;
    resolvedSpecIndex = 0;
    nextStatus = occupied ? 'in dev' : 'in plan';
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
    nextStatus = occupied || devIndex > 0 ? 'in dev' : 'ready for dev';
    storyLabel = `交付单元 ${value.story}`;
  }
  const prospective = { ...task, agile_status: nextStatus, analysis_index: analysisIndex, dev_index: devIndex, test_index: testIndex, total_stories: totalStories, spec_resolved_index: resolvedSpecIndex };
  assertState(prospective);
  db.exec('BEGIN');
  try {
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
    addEvent(db, value.taskId, value.actor, 'TaskRewound', `回退 ${storyLabel} 到 ${value.to}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId, { createClearedBlock: true });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${value.taskId}`);
}

const cancelSchema = z.object({ taskId: z.string().min(1), reason: z.string().min(1).max(500), confirmCodeClean: z.coerce.boolean().default(false) });

export async function cancelTask(input: unknown) {
  const value = cancelSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('需求不存在');
  if (task.agile_status === 'done') throw new Error('已完成需求不能取消');
  if (task.agile_status === 'cancelled') return;
  if (occupiesCodeSlot(task) && !value.confirmCodeClean) throw new Error('需求占用代码槽，请确认代码已清理后再取消');
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET agile_status = 'cancelled', current_subagent = NULL, next_step = ?,
          blocked_reason = NULL, resume_status = NULL, resume_pending = 0,
          last_actor = 'human',
          completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(`已取消：${value.reason}`, value.taskId);
    addEvent(db, value.taskId, 'human', 'TaskCancelled', value.reason);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId, { createClearedBlock: true });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  refreshPages('/', `/tasks/${value.taskId}`);
}

export async function pipelineForTask(taskId: string): Promise<Delegation[]> {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task) throw new Error('需求不存在');
  const otherActive = db.prepare(`${taskSelect} WHERE task_id != ?`).all(taskId) as Task[];
  const codeSlotAvailable = !otherActive.some(occupiesCodeSlot);
  const line = nextDelegation(task, codeSlotAvailable);
  return line ? [line] : [];
}

export async function pipelineAll(): Promise<Delegation[]> {
  const db = await databaseConnection();
  const tasks = db.prepare(`${taskSelect} WHERE agile_status NOT IN ('done', 'cancelled') ORDER BY updated_at`).all() as Task[];
  let codeAvailable = !tasks.some(occupiesCodeSlot);
  const readyDev = !codeAvailable ? null : tasks.find((task) => task.agile_status === 'ready for dev' && task.dev_index < task.analysis_index)?.task_id || null;
  let browserUsed = false;
  const lines: Delegation[] = [];
  for (const task of tasks) {
    const taskCodeAvailable = occupiesCodeSlot(task) || (codeAvailable && (!readyDev || task.task_id === readyDev));
    const line = nextDelegation(task, taskCodeAvailable);
    if (!line) continue;
    if (line.resource === 'browser' && browserUsed) continue;
    if (line.resource === 'browser') browserUsed = true;
    if (line.pipeline === 'dev') codeAvailable = false;
    lines.push(line);
  }
  return lines;
}

function toEnvelope(task: Task, delegation: Delegation): DelegationEnvelope {
  return {
    ...delegation,
    title: task.title || '',
    taskDescription: task.description,
    itemType: task.item_type || 'other',
    priority: task.priority || '',
    link: task.link || '',
    externalId: task.external_id || '',
    externalStatus: task.external_status || '',
    agileStatus: task.agile_status,
    currentSubagent: task.current_subagent || '',
    resumePending: task.resume_pending,
    specResolvedIndex: task.spec_resolved_index,
    runState: task.run_state,
    closureStatus: task.closure_status,
    reviewRevision: task.review_revision,
    reviewDocumentId: task.review_document_id || '',
    lastActor: task.last_actor || '',
    analysisIndex: task.analysis_index,
    devIndex: task.dev_index,
    testIndex: task.test_index,
    totalStories: task.total_stories,
    nextStep: task.next_step || '',
    blockedReason: task.blocked_reason || '',
    owner: task.owner || '',
    evidence: task.evidence || '',
    risk: task.risk || '',
  };
}

export async function pipelineAllEnvelopes(): Promise<DelegationEnvelope[]> {
  const db = await databaseConnection();
  const tasks = db.prepare(`${taskSelect} WHERE agile_status NOT IN ('done', 'cancelled') ORDER BY
    CASE agile_status
      WHEN 'blocked' THEN 0 WHEN 'in dev' THEN 1 WHEN 'in review' THEN 2
      WHEN 'in plan' THEN 4 WHEN 'in repro' THEN 5 WHEN 'backlog' THEN 6 ELSE 7
    END,
    CASE upper(COALESCE(priority, ''))
      WHEN 'P0' THEN 0 WHEN 'S0' THEN 0 WHEN 'P1' THEN 1 WHEN 'S1' THEN 1
      WHEN 'P2' THEN 2 WHEN 'S2' THEN 2 WHEN 'P3' THEN 3 WHEN 'S3' THEN 3 ELSE 9
    END,
    updated_at DESC`).all() as Task[];
  let codeAvailable = !tasks.some(occupiesCodeSlot);
  const readyDev = !codeAvailable ? null : tasks.find((task) => task.agile_status === 'ready for dev' && task.dev_index < task.analysis_index)?.task_id || null;
  let browserUsed = false;
  const lines: DelegationEnvelope[] = [];
  for (const task of tasks) {
    const taskCodeAvailable = occupiesCodeSlot(task) || (codeAvailable && (!readyDev || task.task_id === readyDev));
    const line = nextDelegation(task, taskCodeAvailable);
    if (!line) continue;
    if (line.resource === 'browser' && browserUsed) continue;
    if (line.resource === 'browser') browserUsed = true;
    if (line.pipeline === 'dev') codeAvailable = false;
    lines.push(toEnvelope(task, line));
  }
  return lines;
}

export async function beginRun(owner = 'ui') {
  const { ensureAgentRuntimeWorkspace } = await import('./agent-profiles');
  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.active) {
    throw new Error(`已有本地 loop 正在运行 pid=${current.pid ?? 'starting'}`);
  }
  const runId = randomUUID();
  const startedAt = new Date();
  db.prepare(`
    INSERT INTO loop_meta(key, value) VALUES('active_run', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify({ runId, owner, startedAt: toUtcIsoString(startedAt) }));
  return runId;
}

export async function endRun(runId: string, force = false, options: { stopRunner?: boolean; reason?: string } = {}) {
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.runId && current.runId !== runId) {
    if (force) return;
    throw new Error('运行 ID 不匹配');
  }
  if (current?.runId && options.stopRunner !== false) {
    const { stopAgentRun } = await import('../infrastructure/agent-runner');
    await stopAgentRun(current.runId);
  }
  if (current?.runId) {
    const reason = options.reason || (force ? '异常终止' : '用户停止');
    await appendLoopRunLog(current.runId, `[运行] Loop 已停止：${reason}`);
  }
  db.prepare("DELETE FROM loop_meta WHERE key = 'active_run'").run();
}

function getRunStatusFromDb(db: Awaited<ReturnType<typeof databaseConnection>>) {
  const row = db.prepare("SELECT value FROM loop_meta WHERE key = 'active_run'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { runId: string; owner: string; startedAt: string };
    const pid = readRunPid(parsed.runId);
    const starting = !pid && Date.now() - new Date(parsed.startedAt).getTime() < 15_000;
    return { ...parsed, pid, active: starting || isRunProcessAlive(parsed.runId) } satisfies NonNullable<RunStatus>;
  } catch {
    return null;
  }
}

export async function getRunStatus(): Promise<RunStatus> {
  const db = await databaseConnection();
  return getRunStatusFromDb(db);
}

export async function requireActiveRun(runId: string) {
  const run = await getRunStatus();
  if (!run || run.runId !== runId || !run.active) throw new Error('运行已停止，请从运行面板重新开始');
}

export async function ensureLoopRuntimeFiles() {
  await databaseConnection();
}

export async function createLoopDispatch(runId: string, options: { includeRunHeader?: boolean; logDelegations?: boolean } = {}) {
  await requireActiveRun(runId);
  if (options.includeRunHeader !== false) {
    await appendLoopRunLog(runId, `[运行] 开始运行 run=${runId}`);
    await appendLoopRunLog(runId, `[运行] 工作区=${paths.root}`);
    await appendLoopRunLog(runId, `[运行] 数据目录=${paths.dataDir}`);
  }
  const lines = (await pipelineAllEnvelopes()).slice(0, 1);
  if (options.logDelegations !== false) {
    await appendLoopRunLog(runId, `[派发] 本轮生成 ${lines.length} 个 agent`);
    for (const [index, line] of lines.entries()) {
      await appendLoopRunLog(runId, `[派发] #${index + 1} agent=${line.agent} flow=${line.pipeline} requirement=${line.taskId} unit=${line.storyIndex ?? '-'} resource=${line.resource}`);
      await appendLoopRunLog(runId, `[派发]      ${line.description}`);
    }
    if (!lines.length) await appendLoopRunLog(runId, '[派发] 当前没有可执行步骤，等待新需求或状态变化');
  }
  return { runDir: 'database', delegations: lines };
}

export function toJsonlEnvelope(item: DelegationEnvelope) {
  return JSON.stringify({
    task_id: item.taskId,
    title: item.title,
    task_description: item.taskDescription,
    item_type: item.itemType,
    priority: item.priority,
    link: item.link,
    external_id: item.externalId,
    external_status: item.externalStatus,
    agile_status: item.agileStatus,
    pipeline: item.pipeline,
    agent: item.agent,
    resource: item.resource,
    current_subagent: item.currentSubagent,
    resume_pending: item.resumePending,
    spec_resolved_index: item.specResolvedIndex,
    run_state: item.runState,
    closure_status: item.closureStatus,
    review_revision: item.reviewRevision,
    review_document_id: item.reviewDocumentId,
    last_actor: item.lastActor,
    story_index: item.storyIndex,
    analysis_index: item.analysisIndex,
    dev_index: item.devIndex,
    test_index: item.testIndex,
    total_stories: item.totalStories,
    next_step: item.nextStep,
    blocked_reason: item.blockedReason,
    owner: item.owner,
    evidence: item.evidence,
    risk: item.risk,
    description: item.description,
  });
}

export function toPipeEnvelope(item: DelegationEnvelope) {
  const clean = (value: unknown) => String(value ?? '').replaceAll('|', '／').replaceAll('\n', ' ').trim();
  return [item.taskId, item.title, item.pipeline, item.agent, item.storyIndex ?? '', item.description].map(clean).join('|');
}
