import type Database from 'better-sqlite3';

export function taskContextChatTurnIsRunning(db: Database.Database, taskId: string) {
  return Boolean(db.prepare(`
    SELECT 1 FROM task_context_chat_sessions
    WHERE task_id = ?
      AND state = 'running'
      AND datetime(updated_at) >= datetime('now', '-30 minutes')
    LIMIT 1
  `).get(taskId));
}
