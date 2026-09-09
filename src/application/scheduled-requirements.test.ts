import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import {
  createScheduledRequirement,
  listScheduledRequirements,
  listScheduledRequirementOccurrences,
  materializeDueScheduledRequirements,
  nextScheduledRequirementWakeAt,
  pauseScheduledRequirement,
  resumeScheduledRequirement,
  updateScheduledRequirement,
} from './scheduled-requirements';
import { getTask } from './tasks';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';

test('materializes only the latest missed recurring requirement and remains idempotent', async () => {
  const planId = await createScheduledRequirement({
    recurrenceKind: 'daily',
    timezone: 'Asia/Shanghai',
    localTime: '09:30',
    title: '每日生成的需求',
    description: '由定时计划创建。',
    pipeline: 'direct',
    priority: '7',
    metadata: [],
  });
  const db = await databaseConnection();
  db.prepare(`UPDATE scheduled_requirement_plans SET next_trigger_at = '2026-08-10T01:30:00.000Z' WHERE plan_id = ?`).run(planId);

  const first = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].scheduledFor, '2026-08-13T01:30:00.000Z');
  const task = await getTask(first.created[0].taskId);
  assert.equal(task?.task.title, '每日生成的需求');
  assert.equal(task?.task.last_actor, 'system');
  assert.equal(task?.task.priority, '7');
  assert.equal(task?.task.item_type, 'direct');
  assert.equal(task?.task.current_subagent, 'direct-agent');
  assert.equal((await inspectTaskDispatch(first.created[0].taskId))[0]?.pipeline, 'direct');
  assert.equal((await listScheduledRequirementOccurrences(planId)).length, 1);

  const repeated = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  assert.equal(repeated.created.length, 0);
  assert.equal((await listScheduledRequirementOccurrences(planId)).length, 1);
  const plan = db.prepare('SELECT next_trigger_at, last_task_id FROM scheduled_requirement_plans WHERE plan_id = ?').get(planId) as {
    next_trigger_at: string;
    last_task_id: string;
  };
  assert.equal(plan.next_trigger_at, '2026-08-14T01:30:00.000Z');
  assert.equal(plan.last_task_id, first.created[0].taskId);
});

test('pausing drops missed occurrences and resuming starts at the next future time', async () => {
  const planId = await createScheduledRequirement({
    recurrenceKind: 'weekdays',
    timezone: 'Asia/Shanghai',
    localTime: '09:30',
    title: '工作日需求',
    pipeline: 'feature',
    priority: '5',
  });
  await pauseScheduledRequirement(planId);
  const db = await databaseConnection();
  assert.equal((db.prepare('SELECT next_trigger_at FROM scheduled_requirement_plans WHERE plan_id = ?').get(planId) as { next_trigger_at: string | null }).next_trigger_at, null);

  await resumeScheduledRequirement(planId, new Date('2026-08-14T02:00:00.000Z'));
  const resumed = db.prepare('SELECT next_trigger_at FROM scheduled_requirement_plans WHERE plan_id = ?').get(planId) as { next_trigger_at: string };
  assert.equal(resumed.next_trigger_at, '2026-08-17T01:30:00.000Z');
  assert.equal(await nextScheduledRequirementWakeAt(), new Date('2026-08-14T01:30:00.000Z').getTime());
});

test('retries the same failed occurrence instead of advancing to a later generation', async () => {
  const planId = await createScheduledRequirement({
    recurrenceKind: 'daily',
    timezone: 'Asia/Shanghai',
    localTime: '08:00',
    title: '失败重试需求',
    pipeline: 'feature',
    priority: '5',
  });
  const db = await databaseConnection();
  db.prepare(`
    UPDATE scheduled_requirement_plans
    SET next_trigger_at = '2026-08-10T00:00:00.000Z', template_metadata_json = 'not-json'
    WHERE plan_id = ?
  `).run(planId);
  const failed = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  assert.equal(failed.failed.length, 1);
  const failedOccurrence = (await listScheduledRequirementOccurrences(planId))[0];
  assert.equal(failedOccurrence.status, 'failed');
  assert.equal(failedOccurrence.scheduled_for, '2026-08-13T00:00:00.000Z');

  db.prepare(`UPDATE scheduled_requirement_plans SET template_metadata_json = '[]' WHERE plan_id = ?`).run(planId);
  const retried = await materializeDueScheduledRequirements(new Date('2026-08-15T10:00:00.000Z'));
  const retriedPlan = retried.created.filter((item) => item.planId === planId);
  assert.equal(retriedPlan.length, 1);
  assert.equal(retriedPlan[0].scheduledFor, '2026-08-13T00:00:00.000Z');
  const occurrences = await listScheduledRequirementOccurrences(planId);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].status, 'created');
  assert.equal(occurrences[0].attempt_count, 2);
});

test('keeps a scheduled requirement bound to its selected project when materializing', async () => {
  const db = await databaseConnection();
  const projectId = 'PRJ-scheduled-isolation';
  db.prepare(`
    INSERT OR IGNORE INTO projects(project_id, name, workspace_root, is_default)
    VALUES(?, '定时需求隔离项目', ?, 0)
  `).run(projectId, `${process.env.LOOP_WORKSPACE_ROOT_OVERRIDE}-scheduled`);
  const planId = await createScheduledRequirement({
    projectId,
    recurrenceKind: 'daily',
    timezone: 'Asia/Shanghai',
    localTime: '09:30',
    title: '归属不随默认项目变化',
    pipeline: 'direct',
    priority: '5',
  });
  db.prepare(`UPDATE scheduled_requirement_plans SET next_trigger_at = '2026-08-13T01:30:00.000Z' WHERE plan_id = ?`).run(planId);
  const result = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  const created = result.created.find((item) => item.planId === planId);
  assert.ok(created);
  assert.equal((await getTask(created.taskId))?.task.project_id, projectId);
  assert.equal(
    (db.prepare('SELECT project_id FROM scheduled_requirement_plans WHERE plan_id = ?').get(planId) as { project_id: string }).project_id,
    projectId,
  );
});

test('keeps soft-deleted project schedules dormant until the workspace is restored', async () => {
  const db = await databaseConnection();
  const projectId = 'PRJ-scheduled-soft-deleted';
  db.prepare(`
    INSERT OR IGNORE INTO projects(project_id, name, workspace_root, is_default)
    VALUES(?, '软删定时项目', ?, 0)
  `).run(projectId, `${process.env.LOOP_WORKSPACE_ROOT_OVERRIDE}-scheduled-soft-deleted`);
  const planId = await createScheduledRequirement({
    projectId,
    recurrenceKind: 'daily',
    timezone: 'Asia/Shanghai',
    localTime: '09:30',
    title: '软删期间不得生成',
    pipeline: 'direct',
    priority: '5',
  });
  db.prepare(`UPDATE scheduled_requirement_plans SET next_trigger_at = '2026-08-13T01:30:00.000Z' WHERE plan_id = ?`).run(planId);
  db.prepare('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE project_id = ?').run(projectId);

  assert.equal((await listScheduledRequirements()).some((plan) => plan.plan_id === planId), false);
  const dormant = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  assert.equal(dormant.created.some((item) => item.planId === planId), false);

  db.prepare('UPDATE projects SET deleted_at = NULL WHERE project_id = ?').run(projectId);
  assert.equal((await listScheduledRequirements()).some((plan) => plan.plan_id === planId), true);
  const restored = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  assert.equal(restored.created.some((item) => item.planId === planId), true);
});

test('does not move a materialized schedule and its history to another project', async () => {
  const db = await databaseConnection();
  const originalProject = db.prepare('SELECT project_id FROM projects WHERE is_default = 1').get() as { project_id: string };
  const otherProjectId = 'PRJ-scheduled-history-target';
  db.prepare(`
    INSERT OR IGNORE INTO projects(project_id, name, workspace_root, is_default)
    VALUES(?, '定时历史目标项目', ?, 0)
  `).run(otherProjectId, `${process.env.LOOP_WORKSPACE_ROOT_OVERRIDE}-scheduled-history-target`);
  const planId = await createScheduledRequirement({
    projectId: originalProject.project_id,
    recurrenceKind: 'daily',
    timezone: 'Asia/Shanghai',
    localTime: '10:30',
    title: '不能跨项目移动的定时需求',
    pipeline: 'direct',
    priority: '5',
  });
  db.prepare(`UPDATE scheduled_requirement_plans SET next_trigger_at = '2026-08-13T02:30:00.000Z' WHERE plan_id = ?`).run(planId);
  const materialized = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  assert.ok(materialized.created.some((item) => item.planId === planId));

  await assert.rejects(() => updateScheduledRequirement({
    planId,
    projectId: otherProjectId,
    recurrenceKind: 'daily',
    timezone: 'Asia/Shanghai',
    localTime: '10:30',
    title: '不能跨项目移动的定时需求',
    pipeline: 'direct',
    priority: '5',
  }), /已经生成过需求，不能切换项目/);
  assert.equal(
    (db.prepare('SELECT project_id FROM scheduled_requirement_plans WHERE plan_id = ?').get(planId) as { project_id: string }).project_id,
    originalProject.project_id,
  );
  assert.throws(
    () => db.prepare('UPDATE scheduled_requirement_plans SET project_id = ? WHERE plan_id = ?').run(otherProjectId, planId),
    /定时计划.*项目/,
  );
});
