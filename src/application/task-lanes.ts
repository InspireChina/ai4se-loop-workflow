import type Database from 'better-sqlite3';
import type { TaskState } from '../domain/task';

export const TASK_LANES = ['analysis', 'delivery'] as const;
export type TaskLaneKind = typeof TASK_LANES[number];
export type DelegationLane = TaskLaneKind | 'control';
export type TaskLaneStatus =
  | 'pending'
  | 'runnable'
  | 'running'
  | 'waiting_for_answers'
  | 'waiting_for_runtime_input'
  | 'system_blocked'
  | 'completed';

export type TaskLane = {
  task_id: string;
  lane: TaskLaneKind;
  status: TaskLaneStatus;
  current_agent: string | null;
  current_story_index: number | null;
  blocked_reason: string | null;
  resume_pending: number;
  ready_at: string | null;
  updated_at: string;
};

type Db = Database.Database;

export function laneForAgent(agent: string): DelegationLane {
  if (agent === 'analyst-agent') return 'analysis';
  if (agent === 'dev-agent' || agent === 'test-agent') return 'delivery';
  return 'control';
}

function inferredLaneStatus(task: TaskState, lane: TaskLaneKind): TaskLaneStatus {
  if (['done', 'cancelled', 'in review', 'ready_to_close'].includes(task.agile_status)) return 'completed';
  if (!task.total_stories) return 'pending';
  if (lane === 'analysis') return task.analysis_index < task.total_stories ? 'runnable' : 'completed';
  if (task.test_index < task.dev_index || task.dev_index < task.analysis_index) return 'runnable';
  return task.analysis_index === task.total_stories && task.test_index === task.total_stories ? 'completed' : 'pending';
}

export function ensureTaskLanesInDb(db: Db, task: TaskState) {
  for (const lane of TASK_LANES) {
    const status = inferredLaneStatus(task, lane);
    db.prepare(`
      INSERT OR IGNORE INTO task_lanes(task_id, lane, status, ready_at)
      VALUES(?, ?, ?, CASE WHEN ? = 'runnable' THEN CURRENT_TIMESTAMP END)
    `).run(task.task_id, lane, status, status);
  }
}

export function taskLanesInDb(db: Db, task: TaskState) {
  ensureTaskLanesInDb(db, task);
  return db.prepare(`
    SELECT * FROM task_lanes WHERE task_id = ? ORDER BY CASE lane WHEN 'analysis' THEN 0 ELSE 1 END
  `).all(task.task_id) as TaskLane[];
}

export function taskLaneInDb(db: Db, task: TaskState, lane: TaskLaneKind) {
  ensureTaskLanesInDb(db, task);
  return db.prepare('SELECT * FROM task_lanes WHERE task_id = ? AND lane = ?').get(task.task_id, lane) as TaskLane;
}

export function setTaskLaneStateInDb(db: Db, input: {
  taskId: string;
  lane: TaskLaneKind;
  status: TaskLaneStatus;
  currentAgent?: string | null;
  currentStoryIndex?: number | null;
  blockedReason?: string | null;
  resumePending?: number;
}) {
  const previous = db.prepare('SELECT status, ready_at FROM task_lanes WHERE task_id = ? AND lane = ?').get(input.taskId, input.lane) as { status: TaskLaneStatus; ready_at: string | null } | undefined;
  const readyAt = input.status === 'runnable'
    ? previous?.status === 'runnable' && previous.ready_at ? previous.ready_at : new Date().toISOString()
    : null;
  db.prepare(`
    INSERT INTO task_lanes(
      task_id, lane, status, current_agent, current_story_index,
      blocked_reason, resume_pending, ready_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(task_id, lane) DO UPDATE SET
      status = excluded.status,
      current_agent = excluded.current_agent,
      current_story_index = excluded.current_story_index,
      blocked_reason = excluded.blocked_reason,
      resume_pending = excluded.resume_pending,
      ready_at = excluded.ready_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    input.taskId,
    input.lane,
    input.status,
    input.currentAgent ?? null,
    input.currentStoryIndex ?? null,
    input.blockedReason ?? null,
    input.resumePending ?? 0,
    readyAt,
  );
}

export function refreshTaskLaneStatesInDb(db: Db, task: TaskState) {
  ensureTaskLanesInDb(db, task);
  for (const lane of TASK_LANES) {
    const current = taskLaneInDb(db, task, lane);
    if (current.resume_pending || ['running', 'waiting_for_answers', 'waiting_for_runtime_input', 'system_blocked'].includes(current.status)) continue;
    const status = inferredLaneStatus(task, lane);
    if (current.status === status) continue;
    setTaskLaneStateInDb(db, { taskId: task.task_id, lane, status });
  }
}

export function markTaskLaneRunningInDb(db: Db, input: { taskId: string; lane: TaskLaneKind; agent: string; storyIndex: number | null }) {
  setTaskLaneStateInDb(db, {
    taskId: input.taskId,
    lane: input.lane,
    status: 'running',
    currentAgent: input.agent,
    currentStoryIndex: input.storyIndex,
  });
}

export function settleTaskLaneInDb(db: Db, task: TaskState, lane: TaskLaneKind) {
  const current = taskLaneInDb(db, task, lane);
  if (current.status !== 'running') return current;
  const status = inferredLaneStatus(task, lane);
  setTaskLaneStateInDb(db, { taskId: task.task_id, lane, status });
  return taskLaneInDb(db, task, lane);
}

export function laneCanDispatch(lane: TaskLane) {
  return lane.status === 'runnable' || (lane.status === 'pending' && lane.resume_pending === 1);
}
