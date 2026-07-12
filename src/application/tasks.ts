import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { databaseConnection, hash, paths } from '../infrastructure/database';
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
  approval_file: string | null;
  last_actor: string | null;
  owner: string | null;
  evidence: string | null;
  risk: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type Story = { task_id: string; story_index: number; title: string; directory: string };
export type Question = {
  question_id: string;
  task_id: string;
  story_index: number | null;
  title: string;
  question: string;
  recommendation: string | null;
  answer: string | null;
  status: string;
  relative_path: string;
  kind: string;
  created_at: string;
  updated_at: string;
};
export type Artifact = { artifact_id: string; task_id: string; story_index: number | null; kind: string; relative_path: string; content_hash: string | null; updated_at: string };
export type Approval = { approval_id: string; task_id: string; story_index: number | null; kind: string; decision: string; relative_path: string; updated_at: string };
export type Event = { event_id: string; actor: string; event_type: string; summary: string; created_at: string };
export type RunStatus = { leaseId: string; owner: string; startedAt: string; leaseUntil: string; active: boolean } | null;
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
  approvalFile: string;
  lastActor: string;
  workDir: string;
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
         resume_pending, next_step, work_dir, blocked_reason, approval_file,
         last_actor, owner, evidence, risk, created_at, updated_at, completed_at
  FROM tasks
`;

function fetchTask(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string) {
  return db.prepare(`${taskSelect} WHERE task_id = ?`).get(taskId) as Task | undefined;
}

function addEvent(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string, actor: Actor | 'system', eventType: string, summary: string) {
  db.prepare('INSERT INTO task_events(event_id, task_id, actor, event_type, summary) VALUES(?, ?, ?, ?, ?)').run(randomUUID(), taskId, actor, eventType, summary);
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

function assertInsideWorkspace(fullPath: string) {
  const root = resolve(paths.root);
  const full = resolve(fullPath);
  if (full !== root && !full.startsWith(`${root}${sep}`)) throw new Error('Invalid artifact path');
  return full;
}

function fullPath(relativePath: string) {
  return assertInsideWorkspace(join(paths.root, relativePath));
}

function toRelativePath(pathValue: string) {
  const full = assertInsideWorkspace(resolve(paths.root, pathValue));
  return full.slice(resolve(paths.root).length + 1);
}

async function writeFileIfMissing(relativePath: string, content: string) {
  const path = fullPath(relativePath);
  await mkdir(dirname(path), { recursive: true });
  if (!existsSync(path)) await writeFile(path, content, 'utf8');
}

async function persistArtifact(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string, storyIndex: number | null, kind: string, relativePath: string) {
  let contentHash: string | null = null;
  try {
    contentHash = hash(await readFile(fullPath(relativePath), 'utf8'));
  } catch {
    contentHash = null;
  }
  db.prepare(`
    INSERT INTO artifacts(artifact_id, task_id, story_index, kind, relative_path, content_hash)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, relative_path) DO UPDATE SET
      story_index = excluded.story_index,
      kind = excluded.kind,
      content_hash = excluded.content_hash,
      updated_at = CURRENT_TIMESTAMP
  `).run(randomUUID(), taskId, storyIndex, kind, relativePath, contentHash);
}

function slugify(value: string) {
  const parts: string[] = [];
  let dash = false;
  for (const char of value.trim().toLowerCase()) {
    if (/[\p{Letter}\p{Number}]/u.test(char)) {
      parts.push(char);
      dash = false;
    } else if (!dash) {
      parts.push('-');
      dash = true;
    }
  }
  return parts.join('').replace(/^-+|-+$/g, '').slice(0, 60);
}

function buildWorkSlug(title: string, explicitSlug?: string | null) {
  const slug = slugify(explicitSlug || title);
  if (!slug) throw new Error('无法生成工作目录名，请填写 slug');
  const normalized = slug.replace(/[-_]/g, '');
  if (slug.startsWith('task-') || normalized === 'task' || normalized === '需求' || normalized === '问题') {
    throw new Error('工作目录名过于技术化或泛化，请换一个业务 slug');
  }
  return slug;
}

function taskIdFromTitleLink(title: string, link?: string | null) {
  const seed = link || title;
  return `TASK-${createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
}

function todayCompact() {
  const date = new Date();
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
}

function blockFileForTask(task: Task) {
  return task.work_dir ? `${task.work_dir}/block.md` : `.project/_loop/blocks/${task.task_id}.md`;
}

async function writeBlockFile(task: Task) {
  const relativePath = blockFileForTask(task);
  await writeFileIfMissing(relativePath, '');
  await writeFile(fullPath(relativePath), [
    '# Blocked',
    '',
    `- Task ID: ${task.task_id}`,
    `- Title: ${task.title || ''}`,
    `- Current Subagent: ${task.current_subagent || ''}`,
    `- Resume Status: ${task.resume_status || ''}`,
    `- Resume Pending: ${task.resume_pending}`,
    `- Blocked Reason: ${task.blocked_reason || ''}`,
    `- Approval File: ${task.approval_file || ''}`,
    `- Next Step: ${task.next_step || ''}`,
    `- Updated At: ${task.updated_at || ''}`,
    '',
  ].join('\n'), 'utf8');
}

async function clearBlockFile(task: Task, create = false) {
  const relativePath = blockFileForTask(task);
  const path = fullPath(relativePath);
  if (create || existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '', 'utf8');
  }
}

async function writeLoopStateFile(task: Task) {
  if (!task.work_dir) return;
  const dir = fullPath(task.work_dir);
  if (!existsSync(dir)) return;
  await writeFile(fullPath(`${task.work_dir}/00_loop_state.md`), [
    '# Loop State',
    '',
    '本文件由 Loop Engineering 自动维护。agent 不应手写或手动同步本文件。',
    '',
    `- Task ID: ${task.task_id}`,
    `- Title: ${task.title || ''}`,
    `- 类型: ${task.item_type || ''}`,
    `- Agile 状态: ${task.agile_status}`,
    `- Resume Status: ${task.resume_status || ''}`,
    `- 当前 Subagent: ${task.current_subagent || ''}`,
    `- Analysis Approved Index: ${task.analysis_approved_index}`,
    `- Review Approved: ${task.review_approved}`,
    `- Approval File: ${task.approval_file || ''}`,
    `- Last Actor: ${task.last_actor || ''}`,
    `- Analysis Index: ${task.analysis_index}`,
    `- Dev Index: ${task.dev_index}`,
    `- Test Index: ${task.test_index}`,
    `- Total Stories: ${task.total_stories}`,
    `- Next Step: ${task.next_step || ''}`,
    `- Blocked Reason: ${task.blocked_reason || ''}`,
    `- 原始 URL: ${task.link || ''}`,
    `- 本地目录: ${task.work_dir}`,
    `- 最近更新: ${new Date().toISOString().slice(0, 10)}`,
    '',
  ].join('\n'), 'utf8');
}

async function syncTaskFiles(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string, options: { createClearedBlock?: boolean } = {}) {
  const task = fetchTask(db, taskId);
  if (!task) return;
  if (task.agile_status === 'blocked') await writeBlockFile(task);
  else await clearBlockFile(task, options.createClearedBlock);
  await writeLoopStateFile(task);
}

function readApprovalDecision(text: string, actor: string) {
  const key = actor === 'review-agent' ? 'Review Decision' : 'Analysis Decision';
  const aliases: Record<string, string> = actor === 'review-agent'
    ? { pending: 'pending', '待确认': 'pending', approved: 'approved', approve: 'approved', '已批准': 'approved', changes_requested: 'changes_requested', '要求修改': 'changes_requested', '驳回': 'changes_requested' }
    : { pending: 'pending', '待确认': 'pending', continue: 'continue', '继续': 'continue', '继续澄清': 'continue', confirmed: 'confirmed', confirm: 'confirmed', '已确认': 'confirmed', '确认完成': 'confirmed' };
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?${key}\\s*[:：]\\s*(.*?)\\s*$`, 'gim');
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return 'pending';
  const raw = String(matches[matches.length - 1][1] || '').trim().replace(/`/g, '').toLowerCase().replace(/ /g, '_');
  return aliases[raw] || 'pending';
}

async function inferOrReadDecision(task: Task, pendingQuestions: number) {
  if (!task.approval_file) {
    if (task.current_subagent === 'analyst-agent') return pendingQuestions === 0 ? 'confirmed' : 'pending';
    if (task.current_subagent === 'review-agent') return pendingQuestions === 0 ? 'approved' : 'pending';
    return 'none';
  }
  let text = '';
  try {
    text = await readFile(fullPath(task.approval_file), 'utf8');
  } catch {
    text = '';
  }
  const decision = readApprovalDecision(text, task.current_subagent || '');
  if (decision !== 'pending' || pendingQuestions > 0) return decision;
  const inferred = task.current_subagent === 'review-agent' ? 'approved' : 'confirmed';
  await appendFile(fullPath(task.approval_file), `\n- 用户确认：${inferred === 'approved' ? '已批准' : '已确认'}\n`, 'utf8');
  return inferred;
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
  const artifacts = db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY relative_path').all(taskId) as Artifact[];
  const approvals = db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY kind, story_index').all(taskId) as Approval[];
  const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC').all(taskId) as Event[];
  return { task, stories, questions, artifacts, approvals, events };
}

const createTaskSchema = z.object({
  title: z.string().min(1).max(300),
  link: z.string().trim().optional().nullable(),
  externalId: z.string().trim().optional().nullable(),
  externalStatus: z.string().trim().optional().nullable(),
  itemType: z.enum(['feature', 'bug', 'tech', 'intake', 'other']).default('feature'),
  priority: z.string().trim().optional().nullable(),
  actor: z.enum(['human', 'source-agent']).default('human'),
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
    work_dir: '',
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
  const kindDir = { feature: 'features', bug: 'bugs', tech: 'tech', intake: 'intake' }[value.kind];
  const workDir = before.work_dir || `.project/${kindDir}/${todayCompact()}-${buildWorkSlug(before.title, value.slug)}`;
  await mkdir(fullPath(`${workDir}/attachments`), { recursive: true });
  await writeFileIfMissing(`${workDir}/01_init_input.md`, [
    '# Initial Input',
    '',
    '## Source',
    '',
    `- Task ID: ${before.task_id}`,
    `- Original URL: ${before.link || ''}`,
    `- External ID: ${before.external_id || ''}`,
    `- External Status: ${before.external_status || ''}`,
    `- Priority: ${before.priority || ''}`,
    '',
    '## Raw Title',
    '',
    before.title,
    '',
    '## Raw Body / Comments / Attachments',
    '',
    '待 backlog-agent 从原始 URL 收集正文、评论、显式附件和页面内嵌图片。',
    '',
    '## Attachment Index',
    '',
    '| 本地文件 | 类型 | 来源位置 | 原始 URL | 尺寸/大小 | 说明 |',
    '|---|---|---|---|---|---|',
    '| 待收集 | 待收集 | 待收集 | 待收集 | 待收集 | 待收集 |',
    '',
  ].join('\n'));
  await writeFileIfMissing(`${workDir}/90_questions.md`, [
    '# 90 Questions',
    '',
    '这个文件用于当前工作目录级的通用 human-in-the-loop 问题。',
    '',
    '## 待确认',
    '',
    'story 级业务分析问题写入 stories/<story>/90_analysis_questions.md；测试上下文问题写入 stories/<story>/91_test_questions.md。',
    '',
    '## 已确认',
    '',
  ].join('\n'));

  const changes: Partial<TaskState> & { item_type?: string; work_dir?: string; next_step?: string } = {
    work_dir: workDir,
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
      SET item_type = ?, work_dir = ?, agile_status = ?, current_subagent = ?,
          next_step = ?, blocked_reason = ?, last_actor = ?, resume_pending = 0,
          resume_status = CASE WHEN ? = 'blocked' AND agile_status != 'blocked' THEN agile_status WHEN ? != 'blocked' THEN NULL ELSE resume_status END,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ?
    `).run(value.kind, workDir, changes.agile_status, changes.current_subagent, changes.next_step, changes.blocked_reason, value.actor, changes.agile_status, changes.agile_status, value.taskId);
    addEvent(db, value.taskId, value.actor, 'ContextInitialized', `初始化本地目录：${workDir}`);
    db.exec('COMMIT');
    await syncTaskFiles(db, value.taskId);
    await persistArtifact(db, value.taskId, null, 'loop-state', `${workDir}/00_loop_state.md`);
    await persistArtifact(db, value.taskId, null, 'input', `${workDir}/01_init_input.md`);
    await persistArtifact(db, value.taskId, null, 'questions', `${workDir}/90_questions.md`);
    refreshPages('/', `/tasks/${value.taskId}`);
    return workDir;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const storySchema = z.object({ taskId: z.string().min(1), title: z.string().min(1).max(200) });

export async function addStory(input: unknown) {
  const value = storySchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('Task not found');
  const nextIndex = ((db.prepare('SELECT COALESCE(MAX(story_index), 0) AS index_value FROM stories WHERE task_id = ?').get(value.taskId) as { index_value: number }).index_value || 0) + 1;
  const directory = `stories/story-${String(nextIndex).padStart(3, '0')}`;
  const prospective = { ...task, total_stories: Math.max(task.total_stories, nextIndex) };
  assertState(prospective);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(value.taskId, nextIndex, value.title, directory);
    db.prepare('UPDATE tasks SET total_stories = ?, next_step = ?, last_actor = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?').run(prospective.total_stories, `已新增 Story-${nextIndex}，等待分析`, 'human', value.taskId);
    addEvent(db, value.taskId, 'human', 'StoryAdded', `新增 Story-${nextIndex}：${value.title}`);
    db.exec('COMMIT');
    if (task.work_dir) await mkdir(fullPath(`${task.work_dir}/${directory}`), { recursive: true });
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
  const file = fullPath(question.relative_path);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `\n- 用户确认：${answer}\n`, 'utf8');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE questions SET answer = ?, status = \'answered\', updated_at = CURRENT_TIMESTAMP WHERE question_id = ?').run(answer, questionId);
    addEvent(db, taskId, 'human', 'QuestionAnswered', `回答了「${question.title}」。`);
    db.exec('COMMIT');
    await persistArtifact(db, taskId, question.story_index, question.kind, question.relative_path);
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
});

export async function addQuestion(input: unknown) {
  const value = questionSchema.parse(input);
  const db = await databaseConnection();
  const task = fetchTask(db, value.taskId);
  if (!task) throw new Error('Task not found');
  if (!task.work_dir) throw new Error('请先初始化本地工作目录');
  const questionId = `Q-${randomUUID().slice(0, 8)}`;
  const defaultStoryIndex = value.kind === 'analysis' ? Math.min(task.total_stories, task.analysis_index + 1) : value.kind === 'test' ? Math.min(task.total_stories, task.test_index + 1) : null;
  const storyIndex = value.storyIndex || defaultStoryIndex;
  let story: Story | undefined;
  if (value.kind === 'analysis' || value.kind === 'test') {
    if (!storyIndex) throw new Error(`${value.kind} 问题必须关联 Story；请先拆分 Story`);
    story = db.prepare('SELECT * FROM stories WHERE task_id = ? AND story_index = ?').get(value.taskId, storyIndex) as Story | undefined;
    if (!story) throw new Error(`Story-${storyIndex} 不存在`);
  } else if (storyIndex) {
    story = db.prepare('SELECT * FROM stories WHERE task_id = ? AND story_index = ?').get(value.taskId, storyIndex) as Story | undefined;
  }
  const fileName = value.kind === 'analysis' ? '90_analysis_questions.md' : value.kind === 'test' ? '91_test_questions.md' : value.kind === 'review' ? '06_review.md' : '90_questions.md';
  const relativePath = value.kind === 'local' || value.kind === 'review'
    ? `${task.work_dir}/${fileName}`
    : `${task.work_dir}/${story!.directory}/${fileName}`;
  await writeFileIfMissing(relativePath, `${value.kind === 'analysis' ? '# 90 Analysis Questions' : value.kind === 'test' ? '# 91 Test Questions' : value.kind === 'review' ? '# 06 Review' : '# 90 Questions'}\n\n${value.kind === 'analysis' ? 'Analysis Decision: pending\n\n' : value.kind === 'review' ? 'Review Decision: pending\n\n' : ''}## 待确认\n\n## 已确认\n\n`);
  const block = [
    '',
    `### ${questionId}：${value.title}`,
    '',
    `- Task ID：${value.taskId}`,
    `- 本地目录：${task.work_dir}`,
    '- Agile 状态：blocked',
    `- 阻塞原因：${value.blockedReason || ''}`,
    `- 问题：${value.question}`,
    `- 为什么问：${value.why || ''}`,
    `- 推荐答案：${value.recommendation || ''}`,
    '- 你的答复：',
    '',
  ].join('\n');
  const path = fullPath(relativePath);
  const current = await readFile(path, 'utf8');
  await writeFile(path, current.includes('\n## 已确认') ? current.replace('\n## 已确认', `${block}\n## 已确认`) : `${current.trimEnd()}${block}\n`, 'utf8');

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO questions(question_id, task_id, story_index, kind, title, question, recommendation, relative_path) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(questionId, value.taskId, storyIndex || null, value.kind, value.title, value.question, value.recommendation || null, relativePath);
    if (value.kind === 'analysis' || value.kind === 'review') {
      db.prepare(`
        INSERT INTO approvals(approval_id, task_id, story_index, kind, decision, relative_path)
        VALUES(?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(task_id, story_index, kind) DO UPDATE SET decision = 'pending', relative_path = excluded.relative_path, updated_at = CURRENT_TIMESTAMP
      `).run(randomUUID(), value.taskId, storyIndex || null, value.kind, relativePath);
    }
    if (value.blockTask) {
      const agent = value.kind === 'analysis' ? 'analyst-agent' : value.kind === 'test' ? 'test-agent' : value.kind === 'review' ? 'review-agent' : task.current_subagent || 'backlog-agent';
      db.prepare(`
        UPDATE tasks
        SET agile_status = 'blocked', current_subagent = ?, resume_status = CASE WHEN agile_status != 'blocked' THEN agile_status ELSE resume_status END,
            resume_pending = 0, blocked_reason = ?, approval_file = ?, next_step = ?, last_actor = 'human', updated_at = CURRENT_TIMESTAMP
        WHERE task_id = ?
      `).run(agent, value.blockedReason || value.title, value.kind === 'analysis' || value.kind === 'review' ? relativePath : task.approval_file, `等待人工回答：${value.title}`, value.taskId);
    }
    addEvent(db, value.taskId, 'human', 'QuestionAdded', `新增问题：${value.title}`);
    db.exec('COMMIT');
    await persistArtifact(db, value.taskId, storyIndex || null, value.kind, relativePath);
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
  const decision = await inferOrReadDecision(task, pendingQuestions);
  if (task.current_subagent === 'analyst-agent') {
    if (decision === 'pending') throw new Error(`human decision is still pending in ${task.approval_file || 'questions'}`);
    if (decision === 'confirmed') {
      analysisApprovedIndex = Math.max(analysisApprovedIndex, task.analysis_index + 1);
      if (analysisApprovedIndex > task.total_stories) throw new Error('analysis approval exceeds total_stories');
      detail = '人工已确认当前 story 分析决策';
    } else {
      detail = '人工要求继续澄清，不得推进 analysis_index';
    }
  } else if (task.current_subagent === 'review-agent') {
    if (decision === 'pending') throw new Error(`human decision is still pending in ${task.approval_file || 'questions'}`);
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

export async function updateTask(taskId: string, actor: Actor, changes: Partial<TaskState> & {
  next_step?: string | null;
  item_type?: string | null;
  priority?: string | null;
  title?: string | null;
  work_dir?: string | null;
  approval_file?: string | null;
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
  if (changes.analysis_index !== undefined && changes.analysis_index > before.analysis_index && before.analysis_approved_index < changes.analysis_index) {
    throw new Error(`story-${changes.analysis_index} analysis 尚未人工确认`);
  }
  if (changes.agile_status === 'done' && !before.review_approved) throw new Error('review 尚未人工批准');
  if (['in dev', 'in review'].includes(prospective.agile_status)) {
    const active = db.prepare(`
      ${taskSelect}
      WHERE task_id != ? AND (agile_status IN ('in dev','in review') OR (agile_status='blocked' AND resume_status IN ('in dev','in review')) OR (agile_status='blocked' AND current_subagent='review-agent'))
      LIMIT 1
    `).get(taskId) as Task | undefined;
    if (active) throw new Error(`代码槽已被 ${active.task_id} 占用`);
  }
  const allowed = ['agile_status', 'current_subagent', 'analysis_index', 'dev_index', 'test_index', 'total_stories', 'analysis_approved_index', 'blocked_reason', 'next_step', 'item_type', 'priority', 'title', 'work_dir', 'approval_file', 'resume_status'];
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
    fields.push('review_approved = 0', 'approval_file = NULL');
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
          review_approved = 0, approval_file = NULL, next_step = ?,
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
          review_approved = 0, approval_file = NULL, last_actor = 'human',
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
    const taskCodeAvailable = codeAvailable && (!readyDev || task.task_id === readyDev);
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
    approvalFile: task.approval_file || '',
    lastActor: task.last_actor || '',
    workDir: task.work_dir || '',
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

function sourceEnvelope(): DelegationEnvelope {
  return {
    taskId: '',
    pipeline: 'source',
    agent: 'source-agent',
    storyIndex: null,
    resource: 'none',
    description: 'process changed inbox.md',
    title: 'Inbox changed',
    itemType: 'source',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: '',
    currentSubagent: '',
    resumePending: 0,
    analysisApprovedIndex: 0,
    reviewApproved: 0,
    approvalFile: '',
    lastActor: 'loopctl',
    workDir: '.project/_loop',
    analysisIndex: 0,
    devIndex: 0,
    testIndex: 0,
    totalStories: 0,
    nextStep: 'process changed inbox.md',
    blockedReason: '',
    owner: '',
    evidence: 'inbox.md md5 changed',
    risk: 'new tasks will be routed on the next loop run after source-agent commits inbox md5',
  };
}

export async function pipelineAllEnvelopes(options: { includeInbox?: boolean } = {}): Promise<DelegationEnvelope[]> {
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
  if (options.includeInbox && await inboxHasChanges()) lines.push(sourceEnvelope());
  for (const task of tasks) {
    const taskCodeAvailable = codeAvailable && (!readyDev || task.task_id === readyDev);
    const line = nextDelegation(task, taskCodeAvailable);
    if (!line) continue;
    if (line.resource === 'browser' && browserUsed) continue;
    if (line.resource === 'browser') browserUsed = true;
    if (line.pipeline === 'dev') codeAvailable = false;
    lines.push(toEnvelope(task, line));
  }
  return lines;
}

export async function beginRun(owner = 'ui', leaseMinutes = 120) {
  if (!Number.isInteger(leaseMinutes) || leaseMinutes < 1 || leaseMinutes > 1440) throw new Error('leaseMinutes must be between 1 and 1440');
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.active) {
    const minutes = Math.max(1, Math.ceil((new Date(current.leaseUntil).getTime() - Date.now()) / 60000));
    throw new Error(`busy: another loop run is active for about ${minutes} more minute(s)`);
  }
  const leaseId = randomUUID();
  const startedAt = new Date();
  const leaseUntil = new Date(startedAt.getTime() + leaseMinutes * 60000);
  db.prepare(`
    INSERT INTO loop_meta(key, value) VALUES('run_lease', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify({ leaseId, owner, startedAt: startedAt.toISOString(), leaseUntil: leaseUntil.toISOString() }));
  return leaseId;
}

export async function endRun(leaseId: string, force = false) {
  const db = await databaseConnection();
  const current = getRunStatusFromDb(db);
  if (current?.leaseId && current.leaseId !== leaseId && !force) throw new Error('运行租约不匹配');
  db.prepare("DELETE FROM loop_meta WHERE key = 'run_lease'").run();
}

function getRunStatusFromDb(db: Awaited<ReturnType<typeof databaseConnection>>) {
  const row = db.prepare("SELECT value FROM loop_meta WHERE key = 'run_lease'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { leaseId: string; owner: string; startedAt: string; leaseUntil?: string };
    const leaseUntil = parsed.leaseUntil || parsed.startedAt;
    return { ...parsed, leaseUntil, active: new Date(leaseUntil).getTime() > Date.now() } satisfies NonNullable<RunStatus>;
  } catch {
    return null;
  }
}

export async function getRunStatus(): Promise<RunStatus> {
  const db = await databaseConnection();
  return getRunStatusFromDb(db);
}

export async function requireRunLease(leaseId: string) {
  const run = await getRunStatus();
  if (!run || run.leaseId !== leaseId) throw new Error('invalid or inactive run token; call run-begin first');
  if (!run.active) throw new Error('run lease expired; start a new loop run');
}

function md5(value: Buffer | string) {
  return createHash('md5').update(value).digest('hex');
}

async function fileHash(relativePath: string) {
  try {
    return md5(await readFile(fullPath(relativePath)));
  } catch {
    return '';
  }
}

export async function ensureLoopRuntimeFiles() {
  await mkdir(fullPath('.project/_loop'), { recursive: true });
  await writeFileIfMissing('.project/_loop/inbox.md', [
    '# Loop Inbox',
    '',
    '## 新输入',
    '',
    '把新卡片、Bug、临时需求或 URL 粘贴在这里。source-agent 处理后执行 inbox-commit。',
    '',
  ].join('\n'));
  await writeFileIfMissing('.project/_loop/control.md', [
    '# Loop Control',
    '',
    '本文件由 `/loop` 命令读取。实际状态以 SQLite 和 loopctl 输出为准。',
    '',
  ].join('\n'));
}

export async function inboxHasChanges(inboxPath = '.project/_loop/inbox.md') {
  await ensureLoopRuntimeFiles();
  const current = await fileHash(inboxPath);
  if (!current) return false;
  const db = await databaseConnection();
  const row = db.prepare("SELECT value FROM loop_meta WHERE key = 'inbox_md5'").get() as { value: string } | undefined;
  return !row?.value || row.value !== current;
}

export async function inboxCheck(inboxPath = '.project/_loop/inbox.md') {
  return inboxHasChanges(inboxPath);
}

export async function inboxCommit(inboxPath = '.project/_loop/inbox.md') {
  await ensureLoopRuntimeFiles();
  const current = await fileHash(inboxPath);
  if (!current) throw new Error(`inbox not found: ${inboxPath}`);
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO loop_meta(key, value) VALUES('inbox_md5', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(current);
  return current;
}

export async function createLoopDispatch(leaseId: string) {
  await requireRunLease(leaseId);
  const lines = await pipelineAllEnvelopes({ includeInbox: true });
  const runDir = `.project/_loop/runs/${leaseId}`;
  await mkdir(fullPath(runDir), { recursive: true });
  await writeFile(fullPath(`${runDir}/delegations.jsonl`), lines.map(toJsonlEnvelope).join('\n') + (lines.length ? '\n' : ''), 'utf8');
  await writeFile(fullPath(`${runDir}/summary.md`), [
    '# Loop Run',
    '',
    `- Run Token: ${leaseId}`,
    `- Delegations: ${lines.length}`,
    '',
    ...lines.map((line, index) => `## ${index + 1}. ${line.agent} / ${line.pipeline}\n\n- Task: ${line.title || line.taskId || 'Inbox'}\n- Work Dir: ${line.workDir}\n- Story: ${line.storyIndex ?? ''}\n- Resource: ${line.resource}\n- Description: ${line.description}\n`),
  ].join('\n'), 'utf8');
  return { runDir, delegations: lines };
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
    approval_file: item.approvalFile,
    last_actor: item.lastActor,
    work_dir: item.workDir,
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
  return [item.taskId, item.title, item.workDir, item.pipeline, item.agent, item.storyIndex ?? '', item.description].map(clean).join('|');
}

export async function readQuestionArtifact(relativePath: string) {
  try {
    return await readFile(fullPath(relativePath), 'utf8');
  } catch {
    return '';
  }
}

export async function readArtifact(relativePath: string) {
  return readQuestionArtifact(toRelativePath(relativePath));
}
