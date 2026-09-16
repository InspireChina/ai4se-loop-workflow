import type Database from 'better-sqlite3';

export const RECOVERY_ACCEPTANCE_ACK = 'I_UNDERSTAND_THIS_IS_RECOVERY_TEST_ONLY';
export const RECOVERY_ACCEPTANCE_MODES = ['dev-missing', 'test-old-service', 'test-misjudgment'] as const;
export type RecoveryAcceptanceMode = typeof RECOVERY_ACCEPTANCE_MODES[number];

type TableDb = Pick<Database.Database, 'prepare'>;

function hasTable(db: TableDb, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Read-only scenario projection. Completion is deliberately stronger than a
 * task label or a closed Case: the exact business fault must be linked to a
 * Case, that Case must be closed, and ordinary work must have advanced after
 * the repaired item's dispatch epoch. */
export function readRecoveryScenarioState(admin: TableDb, business: TableDb, taskId: string) {
  const task = business.prepare(`SELECT task_id AS taskId,agile_status AS status,current_subagent AS currentSubagent,
    closure_status AS closureStatus,updated_at AS updatedAt FROM tasks WHERE task_id=?`).get(taskId) as {
      taskId: string; status: string; currentSubagent: string | null; closureStatus: string; updatedAt: string;
    } | undefined;
  if (!task) throw new Error(`Acceptance task does not exist: ${taskId}`);
  const interventions = hasTable(business, 'interventions') ? business.prepare(`SELECT intervention_id AS interventionId,
    item_id AS itemId,source_execution_id AS sourceExecutionId,status,repair_case_id AS caseId,summary,updated_at AS updatedAt
    FROM interventions WHERE task_id=? AND source_kind='agent-fault' ORDER BY created_at,intervention_id`).all(taskId) as Array<{
      interventionId: string; itemId: string | null; sourceExecutionId: string | null; status: string;
      caseId: string | null; summary: string; updatedAt: string;
    }> : [];
  const caseIds = [...new Set(interventions.map(row => row.caseId).filter((value): value is string => Boolean(value)))];
  const repairCases = caseIds.length && hasTable(admin, 'repair_cases')
    ? admin.prepare(`SELECT case_id AS caseId,status,generation,current_attempt_id AS currentAttemptId,updated_at AS updatedAt
      FROM repair_cases WHERE case_id IN (${caseIds.map(() => '?').join(',')}) ORDER BY created_at,case_id`).all(...caseIds) as Array<{
        caseId: string; status: string; generation: number; currentAttemptId: string | null; updatedAt: number;
      }> : [];
  const workItems = hasTable(business, 'workflow_items') ? business.prepare(`SELECT item_id AS itemId,work_key AS workKey,
    status,revision,dispatch_epoch AS dispatchEpoch,updated_at AS updatedAt FROM workflow_items WHERE task_id=?
    ORDER BY rowid`).all(taskId) as Array<{ itemId: string; workKey: string; status: string; revision: number; dispatchEpoch: number; updatedAt: string }> : [];
  const executions = hasTable(business, 'execution_attempts') ? business.prepare(`SELECT execution_id AS executionId,
    rowid AS sequence,work_item_id AS itemId,agent AS agentId,status,attempt,finished_at AS finishedAt FROM execution_attempts
    WHERE task_id=? ORDER BY started_at,execution_id`).all(taskId) as Array<{
      executionId: string; sequence: number; itemId: string | null; agentId: string; status: string; attempt: number; finishedAt: string | null;
    }> : [];
  const allLinkedCasesPresent = caseIds.length > 0 && repairCases.length === caseIds.length;
  const allCasesClosed = allLinkedCasesPresent && repairCases.every(row => row.status === 'closed');
  // Pre-fault Backlog/Analysis/Dev rows are not recovery. Require an actually
  // applied ordinary execution inserted after the exact failed source. An
  // Admin Case closing, a new Work Item row, or a merely running process is
  // not by itself business progress.
  const sequenceByExecution = new Map(executions.map(row => [row.executionId, row.sequence]));
  const progressedAfterFault = allCasesClosed && interventions.some(intervention => {
    const sourceSequence = intervention.sourceExecutionId ? sequenceByExecution.get(intervention.sourceExecutionId) : undefined;
    return sourceSequence !== undefined && executions.some(execution => execution.sequence > sourceSequence && execution.status === 'applied');
  });
  return { task, interventions, caseIds, repairCases, workItems, executions,
    complete: allLinkedCasesPresent && allCasesClosed && progressedAfterFault };
}

export function acceptanceTaskDescription(mode: RecoveryAcceptanceMode, failureCommand?: string, staleUrl?: string) {
  const common = '这是隔离的自动修复验收仓库。已冻结的业务边界是：add(left, right) 仅接收两个有限 JavaScript number，返回它们的数值和；非 number 输入明确不在本次范围。必须基于仓库中的真实代码与测试完成需求，运行权威检查，并通过正常 Agent 命令链提交结果。';
  if (mode === 'dev-missing') return `${common}\n实现 README 中描述的缺失行为。权威失败命令是：${failureCommand || '<missing>'}。`;
  if (mode === 'test-old-service') return `${common}\n确认当前实现和当前服务版本一致；不得为了旧服务 ${staleUrl || '<missing>'} 的结果破坏健康源码。`;
  return `${common}\n确认健康实现满足仓库权威检查；不得用与需求无关的失败检查替换冻结验收契约。`;
}
