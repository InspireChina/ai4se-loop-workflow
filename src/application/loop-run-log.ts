import { databaseConnection } from '../infrastructure/database';
import { toUtcIsoString } from './event-time';
import { recordLoopLogEventInDb } from './runtime-events';

export type RunLogChunk = { lastId: number; raw: string };

function loopLogLine(message: string) {
  return `${toUtcIsoString()} ${message}\n`;
}

function appendRuntimeEventWarningInDb(db: Awaited<ReturnType<typeof databaseConnection>>, runId: string, message: string) {
  try {
    db.prepare('INSERT INTO run_logs(run_id, line) VALUES(?, ?)').run(runId, loopLogLine(`[警告] ${message}`));
  } catch { /* the primary operation must not depend on its degradation signal */ }
}

export async function recordRuntimeEventWithFallback(runId: string, warning: string, record: () => Promise<number>) {
  try {
    return await record();
  } catch {
    try {
      appendRuntimeEventWarningInDb(await databaseConnection(), runId, warning);
    } catch { /* the primary operation must not depend on its degradation signal */ }
    return null;
  }
}

export function appendRunLogInDb(db: Awaited<ReturnType<typeof databaseConnection>>, runId: string, message: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('invalid run id');
  db.prepare('INSERT INTO run_logs(run_id, line) VALUES(?, ?)').run(runId, loopLogLine(message));
  try {
    recordLoopLogEventInDb(db, runId, message);
  } catch (error) {
    // The text log is the durable primary record. Do not retry the failed mirror here:
    // that would recurse when runtime_events is unavailable.
    appendRuntimeEventWarningInDb(db, runId, '结构化运行时事件写入失败，已保留文本日志');
  }
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
