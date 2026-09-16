import type { databaseConnection } from '../infrastructure/database';
import { adoptNativeWorkflowInDb } from './work-item-transitions';
import { restoreExecutionDelegationInDb } from './execution-delegation';
import type { ExecutionAttempt } from './executions';

type Db = Awaited<ReturnType<typeof databaseConnection>>;
export type WorkflowUpgradeReceipt = {
  runId: string;
  supervisionToken: number;
  tasks: Array<{ taskId: string; previousEngine: string; itemCount: number }>;
};

/** Only the fenced supervisor, after draining old processes and before spawning
 * a new Runner, may adopt the database. One ambiguous task rolls back the ENTIRE
 * cohort. This is not a background projection or an execution retry. */
export function upgradeWorkflowAtStartupInDb(db: Db, runId: string, supervisionToken: number): WorkflowUpgradeReceipt {
  return db.transaction(() => {
    const lease = db.prepare('SELECT fencing_token, expires_at FROM loop_supervisor_lease WHERE singleton = 1')
      .get() as { fencing_token: number; expires_at: string } | undefined;
    const run = db.prepare('SELECT status FROM loop_runs WHERE run_id = ?').get(runId) as { status: string } | undefined;
    if (!Number.isInteger(supervisionToken) || supervisionToken <= 0 || !lease
      || lease.fencing_token !== supervisionToken || Date.parse(lease.expires_at) <= Date.now()
      || !Number.isFinite(Date.parse(lease.expires_at)) || run?.status !== 'starting') {
      throw new Error('工作流迁移被拒绝：缺少有效监督租约或 Runner 不在启动边界');
    }
    if (db.prepare("SELECT 1 FROM loop_runs WHERE run_id != ? AND status IN ('starting', 'running', 'stopping')").get(runId)
      || db.prepare("SELECT 1 FROM loop_managed_processes WHERE status = 'running' AND process_kind IN ('agent-runner', 'agent-cli')").get()
      || db.prepare("SELECT 1 FROM execution_attempts WHERE status = 'running'").get()) {
      throw new Error('工作流迁移被拒绝：旧 Runner、CLI 或执行尚未排空');
    }
    const prior = db.prepare('SELECT supervision_token, receipt_json FROM workflow_upgrade_receipts WHERE run_id = ?')
      .get(runId) as { supervision_token: number; receipt_json: string } | undefined;
    if (prior) {
      if (prior.supervision_token !== supervisionToken) throw new Error('工作流迁移收据的监督代次不匹配');
      const unexpected = db.prepare("SELECT task_id FROM tasks WHERE workflow_engine != 'native' ORDER BY task_id LIMIT 1")
        .get() as { task_id: string } | undefined;
      if (unexpected) throw new Error(`工作流迁移收据已封存后出现未迁移需求 task=${unexpected.task_id}；必须重新启动迁移`);
      return JSON.parse(prior.receipt_json) as WorkflowUpgradeReceipt;
    }
    // Include paused and completed requirements: dependency reads must not fall
    // back to the old completion badge after the upgrade. Do not skip a task
    // merely because its compatibility metadata currently looks terminal.
    const tasks = db.prepare('SELECT task_id, workflow_engine FROM tasks ORDER BY task_id')
      .all() as Array<{ task_id: string; workflow_engine: string }>;
    const receipt: WorkflowUpgradeReceipt = { runId, supervisionToken, tasks: [] };
    for (const task of tasks) {
      try {
        const items = adoptNativeWorkflowInDb(db, task.task_id);
        const recoverable = db.prepare(`SELECT * FROM execution_attempts WHERE task_id = ?
          AND status IN ('output_received', 'verifying', 'applying') AND result_json IS NOT NULL
          AND pipeline != 'intervention'`).all(task.task_id) as ExecutionAttempt[];
        for (const source of recoverable) restoreExecutionDelegationInDb(db, source);
        receipt.tasks.push({ taskId: task.task_id, previousEngine: task.workflow_engine, itemCount: items.length });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`工作流迁移失败 task=${task.task_id}：${detail}`, { cause: error });
      }
    }
    // A large cohort can outlive its lease even though SQLite serializes edits.
    // Roll it back rather than handing an unfenced graph to a new Runner.
    if (Date.parse(lease.expires_at) <= Date.now()) throw new Error('工作流迁移被撤销：监督租约在迁移期间已过期');
    db.prepare('INSERT INTO workflow_upgrade_receipts(run_id, supervision_token, receipt_json) VALUES(?, ?, ?)')
      .run(runId, supervisionToken, JSON.stringify(receipt));
    return receipt;
  })();
}
