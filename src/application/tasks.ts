import { createHash, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { databaseConnection, paths } from '../infrastructure/database';
import { verifyDevCommit } from '../infrastructure/git';
import { isRunProcessAlive, readRunPid } from '../infrastructure/run-process';
import { toUtcIsoString } from './event-time';
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
export type Document = {
  document_id: string;
  task_id: string;
  story_index: number | null;
  kind: string;
  title: string;
  content: string;
  format: string;
  source_agent: string | null;
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
  created_at: string;
  updated_at: string;
};
export type Approval = { approval_id: string; task_id: string; story_index: number | null; kind: string; decision: string; relative_path: string | null; updated_at: string };
export type Event = { event_id: string; actor: string; event_type: string; summary: string; created_at: string };
export type RunStatus = { runId: string; owner: string; startedAt: string; pid: number | null; active: boolean } | null;
export type RunLogChunk = { lastId: number; raw: string };
export type DelegationEnvelope = Delegation & {
  title: string;
  itemType: string;
  priority: string;
  link: string;
  externalId: string;
  externalStatus: string;
  agileStatus: string;
  currentSubagent: string;
  resumePending: number;
  analysisApprovedIndex: number;
  reviewApproved: number;
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
  SELECT task_id, title, link, external_id, external_status, item_type, priority,
         agile_status, current_subagent, analysis_index, dev_index, test_index,
         total_stories, analysis_approved_index, review_approved, resume_status,
         resume_pending, next_step, blocked_reason,
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
  return `TASK-${createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
}

async function syncTaskFiles(_db: Awaited<ReturnType<typeof databaseConnection>>, _taskId: string, _options: { createClearedBlock?: boolean } = {}) {
  // DB-first product mode: target repo files are no longer generated or synchronized.
}

function inferDecisionFromAnsweredQuestions(task: Task, pendingQuestions: number) {
  if (pendingQuestions > 0) return 'pending';
  if (task.current_subagent === 'analyst-agent') return 'confirmed';
  if (task.current_subagent === 'review-agent') return 'approved';
  return 'none';
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
  const questions = db.prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY created_at').all(taskId) as Question[];
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY story_index, kind, updated_at').all(taskId) as Document[];
  const approvals = db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY kind, story_index').all(taskId) as Approval[];
  const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as Event[];
  return { task, stories, questions, documents, approvals, events };
}

export async function getTaskContext(taskId: string) {
  const detail = await getTask(taskId);
  if (!detail) throw new Error(`task not found: ${taskId}`);
  const questions = detail.questions.map(({ relative_path: _relativePath, ...question }) => question);
  const approvals = detail.approvals.map(({ relative_path: _relativePath, ...approval }) => approval);
  return { ...detail, questions, approvals };
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
  if (!task) throw new Error('Task not found');
  if (value.storyIndex && value.storyIndex > task.total_stories) throw new Error(`Story-${value.storyIndex} 不存在`);
  const title = value.title || `${value.kind}${value.storyIndex ? ` · Story-${value.storyIndex}` : ''}`;
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
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'done', 'cancelled', 'blocked']).default('backlog'),
  currentSubagent: z.string().trim().optional().nullable(),
  taskId: z.string().trim().optional().nullable(),
});

export async function createTask(input: unknown) {
  const value = createTaskSchema.parse(input);
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
    analysis_approved_index: 0,
    review_approved: 0,
    resume_status: null,
    resume_pending: 0,
    blocked_reason: value.status === 'blocked' ? '等待人工处理' : null,
  };
  assertState(state);
  const db = await databaseConnection();
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT OR IGNORE INTO tasks(
        task_id, title, link, external_id, external_status, item_type, priority,
        agile_status, current_subagent, analysis_index, dev_index, test_index,
        total_stories, analysis_approved_index, review_approved, next_step,
        work_dir, blocked_reason, last_actor
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, '', ?, ?)
    `).run(taskId, value.title, link, value.externalId || null, value.externalStatus || null, value.itemType, value.priority || null, value.status, currentSubagent, '新建 Task，等待 loop 处理', state.blocked_reason, value.actor);
    const task = link ? (db.prepare(`${taskSelect} WHERE link = ?`).get(link) as Task | undefined) : fetchTask(db, taskId);
    if (!task) throw new Error('Task 创建失败');
    addEvent(db, task.task_id, value.actor, 'TaskCreated', `创建 Task：${task.title}`);
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
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'done', 'cancelled', 'blocked']).optional().nullable(),
  currentSubagent: z.string().trim().optional().nullable(),
  nextStep: z.string().trim().optional().nullable(),
  blockedReason: z.string().trim().optional().nullable(),
  actor: z.enum(['human', 'backlog-agent']).default('human'),
});

export async function initializeTaskContext(input: unknown) {
  const value = contextSchema.parse(input);
  const db = await databaseConnection();
  const before = fetchTask(db, value.taskId);
  if (!before) throw new Error('Task not found');
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
  if (!task) throw new Error('Task not found');
  const nextIndex = ((db.prepare('SELECT COALESCE(MAX(story_index), 0) AS index_value FROM stories WHERE task_id = ?').get(value.taskId) as { index_value: number }).index_value || 0) + 1;
  const directory = `story-${String(nextIndex).padStart(3, '0')}`;
  const prospective = { ...task, total_stories: Math.max(task.total_stories, nextIndex) };
  assertState(prospective);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(value.taskId, nextIndex, value.title, directory);
    db.prepare('UPDATE tasks SET total_stories = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(prospective.total_stories, `已新增 Story-${nextIndex}，等待分析`, value.actor, value.taskId);
    addEvent(db, value.taskId, value.actor, 'StoryAdded', `新增 Story-${nextIndex}：${value.title}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    refreshPages(`/tasks/${value.taskId}`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const answerSchema = z.object({ taskId: z.string().min(1), questionId: z.string().min(1), answer: z.string().min(1).max(4000) });

export async function answerQuestion(input: unknown) {
  const { taskId, questionId, answer } = answerSchema.parse(input);
  const db = await databaseConnection();
  const question = db.prepare('SELECT * FROM questions WHERE question_id = ? AND task_id = ?').get(questionId, taskId) as Question | undefined;
  if (!question) throw new Error('Question not found');
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
  blockedReason: z.string().max(1000).optional().nullable(),
  blockTask: z.coerce.boolean().default(true),
  actor: z.enum(['human', 'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent']).default('human'),
});

export async function addQuestion(input: unknown) {
  const value = questionSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('Task not found');
  const questionId = `Q-${randomUUID().slice(0, 8)}`;
  const defaultStoryIndex = value.kind === 'analysis' ? Math.min(task.total_stories, task.analysis_index + 1) : value.kind === 'test' ? Math.min(task.total_stories, task.test_index + 1) : null;
  const storyIndex = value.storyIndex || defaultStoryIndex;
  if (value.kind === 'analysis' || value.kind === 'test') {
    if (!storyIndex) throw new Error(`${value.kind} 问题必须关联 Story；请先拆分 Story`);
    const story = db.prepare('SELECT * FROM stories WHERE task_id = ? AND story_index = ?').get(value.taskId, storyIndex) as Story | undefined;
    if (!story && storyIndex > task.total_stories) throw new Error(`Story-${storyIndex} 不存在`);
  } else if (storyIndex) {
    const story = db.prepare('SELECT * FROM stories WHERE task_id = ? AND story_index = ?').get(value.taskId, storyIndex) as Story | undefined;
    if (!story && storyIndex > task.total_stories) throw new Error(`Story-${storyIndex} 不存在`);
  }
  const relativePath = null;

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO questions(question_id, task_id, story_index, kind, title, question, why, recommendation, relative_path, source_agent) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(questionId, value.taskId, storyIndex || null, value.kind, value.title, value.question, value.why || null, value.recommendation || null, relativePath, value.actor);
    if (value.kind === 'analysis' || value.kind === 'review') {
      db.prepare(`
        INSERT INTO approvals(approval_id, task_id, story_index, kind, decision, relative_path)
        VALUES(?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(task_id, story_index, kind) DO UPDATE SET decision = 'pending', relative_path = excluded.relative_path, updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), value.taskId, storyIndex || null, value.kind, relativePath);
    }
    if (value.blockTask) {
      const agent = value.kind === 'analysis' ? 'analyst-agent' : value.kind === 'test' ? 'test-agent' : value.kind === 'review' ? 'review-agent' : value.actor !== 'human' ? value.actor : task.current_subagent || 'backlog-agent';
      db.prepare(`
        UPDATE tasks
        SET agile_status = 'blocked', current_subagent = ?, resume_status = CASE WHEN agile_status != 'blocked' THEN agile_status ELSE resume_status END,
            resume_pending = 0, blocked_reason = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(agent, value.blockedReason || value.title, `等待人工回答：${value.title}`, value.actor, value.taskId);
    }
    addEvent(db, value.taskId, value.actor, 'QuestionAdded', `新增问题：${value.title}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    refreshPages('/', `/tasks/${value.taskId}`);
    return questionId;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function releaseBlock(taskId: string) {
  const db = await databaseConnection();
  const task = fetchTask(db, taskId);
  if (!task || task.agile_status !== 'blocked') throw new Error('Task is not blocked');
  const pendingQuestions = (db.prepare('SELECT COUNT(*) AS count FROM questions WHERE task_id = ? AND status = \'pending\'').get(taskId) as { count: number }).count;
  if (pendingQuestions) throw new Error('仍有待回答问题，不能解除阻塞');
  const resumeStatus = task.resume_status;
  if (!resumeStatus || resumeStatus === 'blocked') throw new Error('blocked Task 缺少有效 resume_status');
  if (!task.current_subagent) throw new Error('blocked Task 缺少 current_subagent');

  let analysisApprovedIndex = task.analysis_approved_index;
  let reviewApproved = task.review_approved;
  let detail = '';
  const decision = inferDecisionFromAnsweredQuestions(task, pendingQuestions);
  if (task.current_subagent === 'analyst-agent') {
    if (decision === 'pending') throw new Error('human decision is still pending in questions table');
    if (decision === 'confirmed') {
      analysisApprovedIndex = Math.max(analysisApprovedIndex, task.analysis_index + 1);
      if (analysisApprovedIndex > task.total_stories) throw new Error('analysis approval exceeds total_stories');
      detail = '人工已确认当前 story 分析决策';
    } else {
      detail = '人工要求继续澄清，不得推进 analysis_index';
    }
  } else if (task.current_subagent === 'review-agent') {
    if (decision === 'pending') throw new Error('human decision is still pending in questions table');
    reviewApproved = decision === 'approved' ? 1 : 0;
    detail = reviewApproved ? '人工已批准交付' : '人工要求修改，必须执行 rewind';
  }
  const prospective = { ...task, agile_status: resumeStatus, analysis_approved_index: analysisApprovedIndex, review_approved: reviewApproved };
  assertState(prospective);
  const active = db.prepare(`
    ${taskSelect}
    WHERE task_id != ? AND (agile_status IN ('in dev', 'in review') OR (agile_status = 'blocked' AND resume_status IN ('in dev', 'in review')) OR (agile_status = 'blocked' AND current_subagent = 'review-agent'))
    LIMIT 1
  `).get(taskId) as Task | undefined;
  if (active && ['in dev', 'in review'].includes(resumeStatus)) throw new Error(`代码槽已被 ${active.task_id} 占用`);

  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET agile_status = ?, resume_status = NULL, resume_pending = 1, blocked_reason = NULL,
          analysis_approved_index = ?, review_approved = ?, next_step = ?,
          last_actor = 'human', updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(resumeStatus, analysisApprovedIndex, reviewApproved, `阻塞已解除，交回 ${task.current_subagent} 继续处理${detail ? `；${detail}` : ''}`, taskId);
    if (task.current_subagent === 'analyst-agent') {
      db.prepare('UPDATE approvals SET decision = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND kind = ? AND story_index IS ?').run(decision, taskId, 'analysis', task.analysis_index + 1);
    }
    if (task.current_subagent === 'review-agent') {
      db.prepare('UPDATE approvals SET decision = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ? AND kind = ?').run(decision, taskId, 'review');
    }
    addEvent(db, taskId, 'human', 'BlockReleased', `解除阻塞，交回 ${task.current_subagent}。`);
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
  if (!before) throw new Error('Task not found');
  changes = Object.fromEntries(Object.entries(changes).filter(([, item]) => item !== undefined)) as typeof changes;
  const changed = Object.keys(changes);
  assertUpdate(before, actor, changes, changed);
  if (changes.agile_status === 'blocked' && before.agile_status !== 'blocked') changes.resume_status = before.agile_status;
  const prospective = { ...before, ...changes } as TaskState;
  assertState(prospective);
  if (changes.analysis_index !== undefined && changes.analysis_index > before.analysis_index && prospective.analysis_approved_index < changes.analysis_index) {
    throw new Error(`story-${changes.analysis_index} analysis 尚有未解决决策`);
  }
  if (changes.dev_index !== undefined && changes.dev_index > before.dev_index) {
    const verification = verifyDevCommit(paths.root, taskId, changes.dev_index);
    if (!verification.ok) throw new Error(`Story-${changes.dev_index} 代码尚未按要求提交：${verification.reason}`);
  }
  if (changes.agile_status === 'done' && !before.review_approved) throw new Error('review 尚未人工批准');
  if (['in dev', 'in review'].includes(prospective.agile_status)) {
    const active = db.prepare(`
      ${taskSelect}
      WHERE task_id != ? AND (agile_status IN ('in dev','in review') OR (agile_status='blocked' AND resume_status IN ('in dev','in review')) OR (agile_status='blocked' AND current_subagent='review-agent'))
      LIMIT 1
    `).get(taskId) as Task | undefined;
    if (active) throw new CodeSlotBusyError(active.task_id);
  }
  const allowed = ['agile_status', 'current_subagent', 'analysis_index', 'dev_index', 'test_index', 'total_stories', 'analysis_approved_index', 'blocked_reason', 'next_step', 'item_type', 'priority', 'title', 'resume_status'];
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
  if (changes.agile_status === 'in review' && before.agile_status !== 'in review') {
    fields.push('review_approved = 0');
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
  status: z.enum(['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'done', 'cancelled', 'blocked']),
  currentSubagent: z.string().trim().optional().nullable(),
  nextStep: z.string().trim().optional().nullable(),
});

export async function transitionTask(input: unknown) {
  const value = transitionSchema.parse(input);
  await updateTask(value.taskId, 'human', {
    agile_status: value.status,
    current_subagent: value.currentSubagent || undefined,
    next_step: value.nextStep || `人工设置状态为 ${value.status}`,
  });
}

const rewindSchema = z.object({
  taskId: z.string().min(1),
  to: z.enum(['plan', 'analysis', 'dev', 'test']),
  story: z.coerce.number().int().positive().optional().nullable(),
  reason: z.string().trim().optional().nullable(),
  actor: z.enum(['human', 'analyst-agent', 'dev-agent', 'test-agent', 'review-agent']).default('human'),
});

export async function rewindTask(input: unknown) {
  const value = rewindSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('Task not found');
  if (task.agile_status === 'blocked') throw new Error('请先解除阻塞再 rewind');
  if (task.agile_status === 'done' || task.agile_status === 'cancelled') throw new Error('终态 Task 不能直接 rewind');
  const permissions: Record<string, string[]> = {
    'analyst-agent': ['plan'],
    'dev-agent': ['analysis'],
    'test-agent': ['analysis', 'dev'],
    'review-agent': ['plan', 'analysis', 'dev', 'test'],
  };
  if (value.actor !== 'human' && !permissions[value.actor]?.includes(value.to)) throw new Error(`${value.actor} 无权 rewind 到 ${value.to}`);
  const occupied = occupiesCodeSlot(task) || task.dev_index > 0;
  const targetAgent = { plan: 'story-splitter-agent', analysis: 'analyst-agent', dev: 'dev-agent', test: 'test-agent' }[value.to];
  let analysisIndex = task.analysis_index;
  let devIndex = task.dev_index;
  let testIndex = task.test_index;
  let totalStories = task.total_stories;
  let approvedIndex = task.analysis_approved_index;
  let nextStatus: TaskStatus;
  let storyLabel: string;
  if (value.to === 'plan') {
    analysisIndex = 0;
    devIndex = 0;
    testIndex = 0;
    totalStories = 0;
    approvedIndex = 0;
    nextStatus = occupied ? 'in dev' : 'in plan';
    storyLabel = 'all stories';
  } else {
    if (task.total_stories <= 0) throw new Error('Story 拆分完成前不能 rewind 到 story 阶段');
    if (!value.story || value.story < 1 || value.story > task.total_stories) throw new Error(`story 必须在 1-${task.total_stories} 之间`);
    const boundary = value.story - 1;
    if (value.to === 'analysis') {
      analysisIndex = Math.min(analysisIndex, boundary);
      approvedIndex = Math.min(approvedIndex, boundary);
      devIndex = Math.min(devIndex, boundary);
      testIndex = Math.min(testIndex, devIndex);
    } else if (value.to === 'dev') {
      devIndex = Math.min(devIndex, boundary);
      testIndex = Math.min(testIndex, devIndex);
    } else {
      testIndex = Math.min(testIndex, boundary);
    }
    nextStatus = occupied || devIndex > 0 ? 'in dev' : 'ready for dev';
    storyLabel = `story-${value.story}`;
  }
  const prospective = { ...task, agile_status: nextStatus, analysis_index: analysisIndex, dev_index: devIndex, test_index: testIndex, total_stories: totalStories, analysis_approved_index: approvedIndex };
  assertState(prospective);
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET agile_status = ?, current_subagent = ?, analysis_index = ?, dev_index = ?,
          test_index = ?, total_stories = ?, analysis_approved_index = ?,
          review_approved = 0, next_step = ?,
          blocked_reason = NULL, resume_status = NULL, resume_pending = 0,
          last_actor = ?, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(nextStatus, targetAgent, analysisIndex, devIndex, testIndex, totalStories, approvedIndex, value.reason || `rewind ${storyLabel} to ${value.to}`, value.actor, value.taskId);
    addEvent(db, value.taskId, value.actor, 'TaskRewound', `rewind ${storyLabel} to ${value.to}`);
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
  if (!task) throw new Error('Task not found');
  if (task.agile_status === 'done') throw new Error('done Task 不能取消');
  if (task.agile_status === 'cancelled') return;
  if (occupiesCodeSlot(task) && !value.confirmCodeClean) throw new Error('Task 占用代码槽，请确认代码已清理后再取消');
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE tasks
      SET agile_status = 'cancelled', current_subagent = NULL, next_step = ?,
          blocked_reason = NULL, resume_status = NULL, resume_pending = 0,
          review_approved = 0, last_actor = 'human',
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
  if (!task) throw new Error('Task not found');
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
    itemType: task.item_type || 'other',
    priority: task.priority || '',
    link: task.link || '',
    externalId: task.external_id || '',
    externalStatus: task.external_status || '',
    agileStatus: task.agile_status,
    currentSubagent: task.current_subagent || '',
    resumePending: task.resume_pending,
    analysisApprovedIndex: task.analysis_approved_index,
    reviewApproved: task.review_approved,
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
      await appendLoopRunLog(runId, `[派发] #${index + 1} agent=${line.agent} pipeline=${line.pipeline} task=${line.taskId} story=${line.storyIndex ?? '-'} resource=${line.resource}`);
      await appendLoopRunLog(runId, `[派发]      ${line.description}`);
    }
    if (!lines.length) await appendLoopRunLog(runId, '[派发] 当前没有可执行委派，等待新 Task 或状态变化');
  }
  return { runDir: 'database', delegations: lines };
}

export function toJsonlEnvelope(item: DelegationEnvelope) {
  return JSON.stringify({
    task_id: item.taskId,
    title: item.title,
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
    analysis_approved_index: item.analysisApprovedIndex,
    review_approved: item.reviewApproved,
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
