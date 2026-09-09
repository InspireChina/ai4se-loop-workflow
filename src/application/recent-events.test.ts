import assert from 'node:assert/strict';
import test from 'node:test';

test('counts recent events and returns a stable page by offset', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { countRecentEvents, listRecentEvents } = await import('./tasks');
  const db = await databaseConnection();
  const baseline = await countRecentEvents();

  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir)
    VALUES('TASK-recent-events-page', 'Recent events page', 'task', 'backlog', '')
  `).run();
  const insertEvent = db.prepare(`
    INSERT INTO task_events(event_id, task_id, actor, event_type, summary, created_at)
    VALUES(?, 'TASK-recent-events-page', 'test-agent', 'test', ?, ?)
  `);
  for (let index = 1; index <= 5; index += 1) {
    insertEvent.run(`event-page-${index}`, `Event ${index}`, `2099-01-01 00:00:0${index}`);
  }

  assert.equal(await countRecentEvents(), baseline + 5);
  const page = await listRecentEvents(2, 1);
  assert.deepEqual(page.map((event) => event.event_id), ['event-page-4', 'event-page-3']);
});
