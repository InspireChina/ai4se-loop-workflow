/** Explicit historical-data factory for migration/compatibility regression.
 * Runtime imports application/tasks directly and always creates native work. */
export * from '../application/tasks';
import { createTaskSchema } from '../application/tasks';
import { randomUUID } from 'node:crypto';
import { assertActorCanCreate, assertState, type TaskState, type Actor } from '../domain/task';
import { parseRequirementMetadata } from '../domain/requirement-metadata';
import { DEFAULT_REQUIREMENT_PRIORITY, requirementPriority } from '../domain/requirement-priority';
import { defaultProjectInDb, projectInDb } from '../application/projects';
import { ensureTaskLanesInDb } from '../application/task-lanes';
import { syncLegacyDeliveryWorkItemsInDb } from '../application/work-items';
import { configureRequirementDependenciesInDb, requirementDependencySatisfied } from '../application/task-dependencies';
import type { ParsedCreateTaskInput, Task } from '../application/tasks';
import { databaseConnection } from '../infrastructure/database';
import { advanceRuntimeEventRevisionInDb, publishRuntimeInvalidation } from '../application/runtime-events';

export async function createTask(input: unknown) {
  const value = createTaskSchema.parse(input);
  const db = await databaseConnection();
  const { task, revision } = db.transaction(() => {
    const task = createLegacyTaskInDb(db, value);
    return { task, revision: advanceRuntimeEventRevisionInDb(db, 'dispatch.invalidated') };
  })();
  await publishRuntimeInvalidation('dispatch.invalidated', revision, task.task_id);
  return task.task_id;
}

function fetchTask(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string) {
  return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Task | undefined;
}
function addEvent(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string, actor: Actor | 'system', eventType: string, summary: string) {
  db.prepare('INSERT INTO task_events(event_id, task_id, actor, event_type, summary) VALUES(?, ?, ?, ?, ?)').run(randomUUID(), taskId, actor, eventType, summary);
}

export function createLegacyTaskInDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  value: ParsedCreateTaskInput,
  taskId = `REQ-${randomUUID()}`,
) {
  const metadata = parseRequirementMetadata(value.metadata);
  const priority = requirementPriority(value.priority || DEFAULT_REQUIREMENT_PRIORITY);
  const description = value.description?.trim() || null;
  const link = value.link || null;
  const requestedSubagent = value.currentSubagent || null;
  const project = value.projectId ? projectInDb(db, value.projectId) : defaultProjectInDb(db);
  if (!project) throw new Error('指定项目不存在');
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
      task_id, project_id, title, description, link, external_id, external_status, item_type, priority,
      agile_status, current_subagent, analysis_index, dev_index, test_index,
      total_stories, spec_resolved_index, next_step,
      work_dir, blocked_reason, last_actor, workflow_engine
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?)
  `).run(taskId, project.project_id, value.title, description, link, value.externalId || null, value.externalStatus || null, value.itemType, priority, value.status, currentSubagent, value.itemType === 'direct' ? '新建需求，等待直接执行' : '新建需求，等待 Loop 梳理', project.workspace_root, state.blocked_reason, value.actor, 'legacy');
  const insertMetadata = db.prepare(`
    INSERT INTO requirement_metadata(task_id, metadata_key, metadata_value)
    VALUES (?, ?, ?)
  `);
  for (const item of metadata) insertMetadata.run(taskId, item.key, item.value);
  const dependencies = configureRequirementDependenciesInDb(db, taskId, value.dependsOnTaskIds);
  const task = fetchTask(db, taskId);
  if (!task) throw new Error('需求创建失败');
  ensureTaskLanesInDb(db, task);
  syncLegacyDeliveryWorkItemsInDb(db, task.task_id);
  addEvent(db, task.task_id, value.actor, 'TaskCreated', `创建需求：${task.title}`);
  if (dependencies.length) {
    const waiting = dependencies.filter((dependency) => !requirementDependencySatisfied(dependency));
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
