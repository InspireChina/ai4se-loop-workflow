import { randomUUID } from 'node:crypto';
import { databaseConnection } from './database';
import { waitForProcessIdentity } from './process-tree';

export type ManagedProcessKind = 'ui-server' | 'agent-runner' | 'agent-cli';

export function registerManagedProcessInDb(
  db: Awaited<ReturnType<typeof databaseConnection>>,
  input: {
    processId: string;
    supervisionToken: number;
    processKind: ManagedProcessKind;
    pid: number;
    processStartMarker: string;
    runId?: string | null;
  },
) {
  const registered = db.prepare(`
    INSERT INTO loop_managed_processes(
      process_id, supervision_token, process_kind, pid, process_start_marker, run_id
    ) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(supervision_token, process_kind, pid, process_start_marker)
    DO UPDATE SET status = 'running', exited_at = NULL, run_id = excluded.run_id
    WHERE COALESCE(loop_managed_processes.run_id, '') = COALESCE(excluded.run_id, '')
    RETURNING process_id
  `).get(
    input.processId,
    input.supervisionToken,
    input.processKind,
    input.pid,
    input.processStartMarker,
    input.runId ?? null,
  ) as { process_id: string } | undefined;
  if (!registered) {
    throw new Error(`受管进程身份已属于其他运行：kind=${input.processKind} pid=${input.pid}`);
  }
  return registered.process_id;
}

export async function registerManagedAgentProcess(runId: string, pid: number) {
  const supervisionToken = Number(process.env.LOOP_SUPERVISION_TOKEN || 0);
  if (process.env.LOOP_TEST === '1' && supervisionToken <= 0) return `test-${pid}`;
  if (!Number.isInteger(supervisionToken) || supervisionToken <= 0) {
    throw new Error('Agent CLI 缺少有效的 supervision token');
  }
  const identity = await waitForProcessIdentity(pid);
  if (!identity) throw new Error(`Agent CLI 已退出或等待进程身份信息就绪超时 pid=${pid}`);
  const db = await databaseConnection();
  db.transaction(() => {
    const lease = db.prepare(`SELECT fencing_token, expires_at FROM loop_supervisor_lease WHERE singleton = 1`).get() as {
      fencing_token: number; expires_at: string;
    } | undefined;
    const state = db.prepare(`SELECT desired_intent, mode FROM loop_lifecycle_state WHERE singleton = 1`).get() as {
      desired_intent: string; mode: string;
    } | undefined;
    const leaseExpiresAt = lease ? new Date(lease.expires_at).getTime() : 0;
    if (!lease || lease.fencing_token !== supervisionToken || leaseExpiresAt <= Date.now()
      || state?.desired_intent !== 'running' || state.mode !== 'normal') {
      throw new Error('Agent CLI 登记被拒绝：监督代次已经失效');
    }
    registerManagedProcessInDb(db, {
      processId: randomUUID(),
      supervisionToken,
      processKind: 'agent-cli',
      pid,
      processStartMarker: identity.startMarker,
      runId,
    });
  }).immediate();
  return identity.startMarker;
}

export async function markManagedAgentProcessExited(runId: string, pid: number, processStartMarker: string) {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE loop_managed_processes
    SET status = 'exited', exited_at = CURRENT_TIMESTAMP
    WHERE run_id = ? AND pid = ? AND process_start_marker = ?
  `).run(runId, pid, processStartMarker);
}
