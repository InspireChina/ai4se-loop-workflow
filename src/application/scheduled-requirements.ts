import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  latestDueScheduledOccurrence,
  nextScheduledOccurrence,
  parseOnceLocalDateTime,
  SCHEDULE_RECURRENCE_KINDS,
  systemTimeZone,
  type RequirementSchedule,
  type ScheduleRecurrenceKind,
} from '../domain/scheduled-requirement';
import { parseRequirementMetadata } from '../domain/requirement-metadata';
import { DEFAULT_REQUIREMENT_PRIORITY, requirementPriority } from '../domain/requirement-priority';
import { databaseConnection } from '../infrastructure/database';
import {
  advanceRuntimeEventRevisionInDb,
  publishRuntimeInvalidation,
} from './runtime-events';
import { createTaskInDb, createTaskSchema } from './tasks';

export type ScheduledRequirementPlan = {
  plan_id: string;
  recurrence_kind: ScheduleRecurrenceKind;
  timezone: string;
  local_time: string | null;
  weekday: number | null;
  day_of_month: number | null;
  once_at: string | null;
  template_title: string;
  template_description: string | null;
  template_pipeline: string;
  template_priority: string;
  template_metadata_json: string;
  enabled: number;
  schedule_revision: number;
  next_trigger_at: string | null;
  last_trigger_at: string | null;
  last_task_id: string | null;
  last_error: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledRequirementOccurrence = {
  plan_id: string;
  scheduled_for: string;
  plan_revision: number;
  status: 'failed' | 'created';
  attempt_count: number;
  retry_at: string | null;
  task_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const scheduleInputSchema = z.object({
  planId: z.string().uuid().optional(),
  recurrenceKind: z.enum(SCHEDULE_RECURRENCE_KINDS),
  timezone: z.string().trim().min(1).default(systemTimeZone()),
  localTime: z.string().trim().optional().nullable(),
  weekday: z.coerce.number().int().min(0).max(6).optional().nullable(),
  dayOfMonth: z.coerce.number().int().min(1).max(31).optional().nullable(),
  onceAtLocal: z.string().trim().optional().nullable(),
  title: z.string().trim().min(1).max(300),
  description: z.string().optional().nullable(),
  pipeline: z.enum(['direct', 'business-analysis', 'end-to-end', 'feature', 'bug']).default('feature'),
  priority: z.string().trim().optional().nullable(),
  metadata: z.array(z.object({ key: z.string(), value: z.string() })).optional().default([]),
});

export type ScheduledRequirementInput = z.input<typeof scheduleInputSchema>;

function refreshSchedulePages() {
  try {
    revalidatePath('/schedules');
    revalidatePath('/tasks');
    revalidatePath('/');
  } catch {
    // Runner and CLI execute outside a Next request context.
  }
}

function scheduleFromRow(row: ScheduledRequirementPlan): RequirementSchedule {
  return {
    recurrenceKind: row.recurrence_kind,
    timezone: row.timezone,
    localTime: row.local_time,
    weekday: row.weekday,
    dayOfMonth: row.day_of_month,
    onceAt: row.once_at,
  };
}

function normalizeInput(input: unknown, now = new Date()) {
  const value = scheduleInputSchema.parse(input);
  const metadata = parseRequirementMetadata(value.metadata);
  const priority = requirementPriority(value.priority || DEFAULT_REQUIREMENT_PRIORITY);
  const onceAt = value.recurrenceKind === 'once'
    ? parseOnceLocalDateTime(value.onceAtLocal || '', value.timezone)
    : null;
  const schedule: RequirementSchedule = {
    recurrenceKind: value.recurrenceKind,
    timezone: value.timezone,
    localTime: value.recurrenceKind === 'once' ? null : value.localTime || null,
    weekday: value.recurrenceKind === 'weekly' ? value.weekday ?? null : null,
    dayOfMonth: value.recurrenceKind === 'monthly' ? value.dayOfMonth ?? null : null,
    onceAt: onceAt?.toISOString() || null,
  };
  if (value.recurrenceKind === 'weekly' && schedule.weekday === null) throw new Error('每周计划必须选择星期');
  if (value.recurrenceKind === 'monthly' && schedule.dayOfMonth === null) throw new Error('每月计划必须选择日期');
  const next = nextScheduledOccurrence(schedule, now);
  if (!next) throw new Error('计划没有未来可执行时间');
  createTaskSchema.parse({
    title: value.title,
    description: value.description,
    itemType: value.pipeline,
    priority,
    metadata,
    actor: 'system',
  });
  return { value, metadata, priority, schedule, next };
}

export async function listScheduledRequirements(options: { includeDeleted?: boolean } = {}) {
  const db = await databaseConnection();
  const where = options.includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  return db.prepare(`
    SELECT * FROM scheduled_requirement_plans
    ${where}
    ORDER BY enabled DESC, COALESCE(next_trigger_at, '9999-12-31'), created_at DESC
  `).all() as ScheduledRequirementPlan[];
}

export async function listScheduledRequirementOccurrences(planId: string, limit = 20) {
  const db = await databaseConnection();
  return db.prepare(`
    SELECT * FROM scheduled_requirement_occurrences
    WHERE plan_id = ?
    ORDER BY scheduled_for DESC
    LIMIT ?
  `).all(planId, Math.max(1, Math.min(100, limit))) as ScheduledRequirementOccurrence[];
}

export async function createScheduledRequirement(input: unknown) {
  const normalized = normalizeInput(input);
  const planId = randomUUID();
  const db = await databaseConnection();
  const scheduleRevision = db.transaction(() => {
    db.prepare(`
      INSERT INTO scheduled_requirement_plans(
        plan_id, recurrence_kind, timezone, local_time, weekday, day_of_month, once_at,
        template_title, template_description, template_pipeline, template_priority,
        template_metadata_json, next_trigger_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      normalized.schedule.recurrenceKind,
      normalized.schedule.timezone,
      normalized.schedule.localTime,
      normalized.schedule.weekday,
      normalized.schedule.dayOfMonth,
      normalized.schedule.onceAt,
      normalized.value.title,
      normalized.value.description?.trim() || null,
      normalized.value.pipeline,
      normalized.priority,
      JSON.stringify(normalized.metadata),
      normalized.next.toISOString(),
    );
    return advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
  })();
  await publishRuntimeInvalidation('schedule.invalidated', scheduleRevision, planId);
  refreshSchedulePages();
  return planId;
}

export async function updateScheduledRequirement(input: unknown) {
  const value = scheduleInputSchema.extend({ planId: z.string().uuid() }).parse(input);
  const normalized = normalizeInput(value);
  const db = await databaseConnection();
  const scheduleRevision = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE scheduled_requirement_plans
      SET recurrence_kind = ?, timezone = ?, local_time = ?, weekday = ?, day_of_month = ?, once_at = ?,
          template_title = ?, template_description = ?, template_pipeline = ?, template_priority = ?,
          template_metadata_json = ?, enabled = 1, schedule_revision = schedule_revision + 1,
          next_trigger_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = ? AND deleted_at IS NULL
    `).run(
      normalized.schedule.recurrenceKind,
      normalized.schedule.timezone,
      normalized.schedule.localTime,
      normalized.schedule.weekday,
      normalized.schedule.dayOfMonth,
      normalized.schedule.onceAt,
      normalized.value.title,
      normalized.value.description?.trim() || null,
      normalized.value.pipeline,
      normalized.priority,
      JSON.stringify(normalized.metadata),
      normalized.next.toISOString(),
      value.planId,
    );
    if (updated.changes !== 1) throw new Error('定时计划不存在');
    return advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
  })();
  await publishRuntimeInvalidation('schedule.invalidated', scheduleRevision, value.planId);
  refreshSchedulePages();
}

export async function pauseScheduledRequirement(planId: string) {
  const db = await databaseConnection();
  const revision = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE scheduled_requirement_plans
      SET enabled = 0, next_trigger_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = ? AND deleted_at IS NULL
    `).run(planId);
    if (updated.changes !== 1) throw new Error('定时计划不存在');
    return advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
  })();
  await publishRuntimeInvalidation('schedule.invalidated', revision, planId);
  refreshSchedulePages();
}

export async function resumeScheduledRequirement(planId: string, now = new Date()) {
  const db = await databaseConnection();
  const row = db.prepare('SELECT * FROM scheduled_requirement_plans WHERE plan_id = ? AND deleted_at IS NULL').get(planId) as ScheduledRequirementPlan | undefined;
  if (!row) throw new Error('定时计划不存在');
  const next = nextScheduledOccurrence(scheduleFromRow(row), now);
  if (!next) throw new Error('单次计划执行时间已经过去，请编辑执行时间后再恢复');
  const revision = db.transaction(() => {
    db.prepare(`
      UPDATE scheduled_requirement_plans
      SET enabled = 1, next_trigger_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = ? AND deleted_at IS NULL
    `).run(next.toISOString(), planId);
    return advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
  })();
  await publishRuntimeInvalidation('schedule.invalidated', revision, planId);
  refreshSchedulePages();
}

export async function deleteScheduledRequirement(planId: string) {
  const db = await databaseConnection();
  const revision = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE scheduled_requirement_plans
      SET enabled = 0, next_trigger_at = NULL, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE plan_id = ? AND deleted_at IS NULL
    `).run(planId);
    if (updated.changes !== 1) throw new Error('定时计划不存在');
    return advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
  })();
  await publishRuntimeInvalidation('schedule.invalidated', revision, planId);
  refreshSchedulePages();
}

type MaterializedSchedule = { planId: string; taskId: string; scheduledFor: string };

export async function materializeDueScheduledRequirements(now = new Date()) {
  const db = await databaseConnection();
  const due = db.prepare(`
    SELECT * FROM scheduled_requirement_plans
    WHERE enabled = 1 AND deleted_at IS NULL AND next_trigger_at IS NOT NULL AND next_trigger_at <= ?
    ORDER BY next_trigger_at, plan_id
  `).all(now.toISOString()) as ScheduledRequirementPlan[];
  const created: MaterializedSchedule[] = [];
  const failed: Array<{ planId: string; error: string; retryAt: string }> = [];

  for (const candidate of due) {
    let scheduledFor = candidate.next_trigger_at || now.toISOString();
    try {
      let dispatchRevision = 0;
      let scheduleEventRevision = 0;
      let materialized: MaterializedSchedule | null = null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const plan = db.prepare('SELECT * FROM scheduled_requirement_plans WHERE plan_id = ?').get(candidate.plan_id) as ScheduledRequirementPlan | undefined;
        if (!plan?.enabled || plan.deleted_at || !plan.next_trigger_at || new Date(plan.next_trigger_at).getTime() > now.getTime()) {
          db.exec('ROLLBACK');
          continue;
        }
        const schedule = scheduleFromRow(plan);
        const firstOccurrence = db.prepare(`
          SELECT * FROM scheduled_requirement_occurrences
          WHERE plan_id = ? AND scheduled_for = ?
        `).get(plan.plan_id, plan.next_trigger_at) as ScheduledRequirementOccurrence | undefined;
        const dueAt = firstOccurrence?.status === 'failed'
          ? new Date(plan.next_trigger_at)
          : latestDueScheduledOccurrence(schedule, new Date(plan.next_trigger_at), now);
        if (!dueAt) {
          db.exec('ROLLBACK');
          continue;
        }
        scheduledFor = dueAt.toISOString();
        const occurrence = db.prepare(`
          SELECT * FROM scheduled_requirement_occurrences
          WHERE plan_id = ? AND scheduled_for = ?
        `).get(plan.plan_id, scheduledFor) as ScheduledRequirementOccurrence | undefined;
        if (occurrence?.status === 'created') {
          const next = nextScheduledOccurrence(schedule, now);
          db.prepare(`
            UPDATE scheduled_requirement_plans
            SET enabled = ?, next_trigger_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE plan_id = ?
          `).run(next ? 1 : 0, next?.toISOString() || null, plan.plan_id);
          scheduleEventRevision = advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
          db.exec('COMMIT');
          await publishRuntimeInvalidation('schedule.invalidated', scheduleEventRevision, plan.plan_id);
          continue;
        }
        if (occurrence?.retry_at && new Date(occurrence.retry_at).getTime() > now.getTime()) {
          db.exec('ROLLBACK');
          continue;
        }
        const parsedTask = createTaskSchema.parse({
          title: plan.template_title,
          description: plan.template_description,
          itemType: plan.template_pipeline,
          priority: plan.template_priority,
          metadata: JSON.parse(plan.template_metadata_json),
          actor: 'system',
        });
        const task = createTaskInDb(db, parsedTask);
        db.prepare(`
          INSERT INTO scheduled_requirement_occurrences(
            plan_id, scheduled_for, plan_revision, status, attempt_count, task_id
          ) VALUES(?, ?, ?, 'created', 1, ?)
          ON CONFLICT(plan_id, scheduled_for) DO UPDATE SET
            plan_revision = excluded.plan_revision,
            status = 'created',
            attempt_count = scheduled_requirement_occurrences.attempt_count + 1,
            retry_at = NULL,
            task_id = excluded.task_id,
            error = NULL,
            updated_at = CURRENT_TIMESTAMP
        `).run(plan.plan_id, scheduledFor, plan.schedule_revision, task.task_id);
        const next = nextScheduledOccurrence(schedule, now);
        db.prepare(`
          UPDATE scheduled_requirement_plans
          SET enabled = ?, next_trigger_at = ?, last_trigger_at = ?, last_task_id = ?,
              last_error = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE plan_id = ?
        `).run(next ? 1 : 0, next?.toISOString() || null, scheduledFor, task.task_id, plan.plan_id);
        dispatchRevision = advanceRuntimeEventRevisionInDb(db, 'dispatch.invalidated');
        scheduleEventRevision = advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
        db.exec('COMMIT');
        materialized = { planId: plan.plan_id, taskId: task.task_id, scheduledFor };
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
      }
      if (materialized) {
        created.push(materialized);
        await publishRuntimeInvalidation('dispatch.invalidated', dispatchRevision, materialized.taskId);
        await publishRuntimeInvalidation('schedule.invalidated', scheduleEventRevision, materialized.planId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      const revision = db.transaction(() => {
        const plan = db.prepare('SELECT schedule_revision FROM scheduled_requirement_plans WHERE plan_id = ?').get(candidate.plan_id) as { schedule_revision: number } | undefined;
        if (!plan) return advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
        db.prepare(`
          INSERT INTO scheduled_requirement_occurrences(
            plan_id, scheduled_for, plan_revision, status, attempt_count, retry_at, error
          ) VALUES(?, ?, ?, 'failed', 1, ?, ?)
          ON CONFLICT(plan_id, scheduled_for) DO UPDATE SET
            plan_revision = excluded.plan_revision,
            status = 'failed',
            attempt_count = scheduled_requirement_occurrences.attempt_count + 1,
            retry_at = excluded.retry_at,
            error = excluded.error,
            updated_at = CURRENT_TIMESTAMP
        `).run(candidate.plan_id, scheduledFor, plan.schedule_revision, retryAt, message);
        db.prepare(`
          UPDATE scheduled_requirement_plans
          SET next_trigger_at = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE plan_id = ?
        `).run(scheduledFor, message, candidate.plan_id);
        return advanceRuntimeEventRevisionInDb(db, 'schedule.invalidated');
      })();
      failed.push({ planId: candidate.plan_id, error: message, retryAt });
      await publishRuntimeInvalidation('schedule.invalidated', revision, candidate.plan_id);
    }
  }
  if (created.length) refreshSchedulePages();
  return { created, failed };
}

export async function nextScheduledRequirementWakeAt() {
  const db = await databaseConnection();
  const rows = db.prepare(`
    SELECT p.next_trigger_at, o.status AS occurrence_status, o.retry_at
    FROM scheduled_requirement_plans p
    LEFT JOIN scheduled_requirement_occurrences o
      ON o.plan_id = p.plan_id AND o.scheduled_for = p.next_trigger_at
    WHERE p.enabled = 1 AND p.deleted_at IS NULL AND p.next_trigger_at IS NOT NULL
  `).all() as Array<{ next_trigger_at: string; occurrence_status: string | null; retry_at: string | null }>;
  let earliest: number | null = null;
  for (const row of rows) {
    const candidate = row.occurrence_status === 'failed' && row.retry_at ? row.retry_at : row.next_trigger_at;
    const timestamp = new Date(candidate).getTime();
    if (!Number.isFinite(timestamp)) continue;
    earliest = earliest === null ? timestamp : Math.min(earliest, timestamp);
  }
  return earliest;
}
