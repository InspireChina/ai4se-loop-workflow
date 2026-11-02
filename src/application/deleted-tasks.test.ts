import assert from 'node:assert/strict';
import test from 'node:test';

test('lists only deleted requirements in deletion order', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { listDeletedTasks } = await import('./tasks');
  const db = await databaseConnection();
  const defaultProject = db.prepare('SELECT project_id FROM projects WHERE is_default = 1').get() as { project_id: string };
  const insertTask = db.prepare(`
    INSERT INTO tasks(task_id, project_id, title, item_type, agile_status, work_dir, completed_at, updated_at)
    VALUES(?, ?, ?, 'task', ?, '', ?, ?)
  `);
  insertTask.run('TASK-deleted-new', defaultProject.project_id, 'Recently deleted', 'cancelled', '2026-09-08 10:00:00', '2026-09-08 10:00:00');
  insertTask.run('TASK-deleted-old', defaultProject.project_id, 'Previously deleted', 'cancelled', '2026-09-08 09:00:00', '2026-09-08 09:00:00');
  insertTask.run('TASK-not-deleted', defaultProject.project_id, 'Still active', 'backlog', null, '2026-09-08 12:00:00');

  const deleted = await listDeletedTasks();

  assert.deepEqual(deleted.map((task) => task.task_id), ['TASK-deleted-new', 'TASK-deleted-old']);
  assert.ok(deleted.every((task) => task.agile_status === 'cancelled'));
});
