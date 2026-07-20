#!/usr/bin/env tsx
import '../load-env.js';
import { unlinkSync } from 'node:fs';
import {
  buildSoftwareMaintenancePrompt,
  claimNextSoftwareMaintenanceJob,
  getSoftwareMaintenanceSettings,
  loadMaintenanceEvidence,
  updateSoftwareMaintenanceJob,
  type SoftwareMaintenanceJob,
} from '../../src/application/software-maintenance';
import { recordRuntimeEvent, recordRuntimeException } from '../../src/application/runtime-events';
import { getAgentExecutorSettings, getLangfuseRuntimeEnv } from '../../src/application/project-settings';
import { parseSoftwareMaintenanceResult } from '../../src/domain/software-maintenance';
import { databaseConnection, paths } from '../../src/infrastructure/database';
import { getAgentExecutor } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { createLangfuseTelemetry } from '../../src/infrastructure/langfuse';
import {
  applyRepairCandidate,
  commitRepairCandidate,
  createRepairWorktree,
  inspectRepairChanges,
  mainRepositorySnapshot,
  mainRepositorySnapshotMatches,
  mainRepositoryCanApply,
  prepareRepairDependencies,
  removeRepairWorktree,
  runSoftwareRepairHarness,
} from '../../src/infrastructure/software-repair';
import { maintenancePidPath } from '../../src/infrastructure/maintenance-runner';
import { startMaintenanceRunner } from '../../src/infrastructure/maintenance-runner';

async function maintenanceLog(job: SoftwareMaintenanceJob, message: string, severity: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
  await recordRuntimeEvent({
    eventName: 'loop.software_maintenance',
    component: 'software-maintenance',
    body: message,
    severity,
    context: { runId: job.trigger_run_id, executionId: job.trigger_execution_id, stage: job.status },
    attributes: { jobId: job.job_id, status: job.status },
  });
}

async function hasActiveAppWriter() {
  if (paths.root !== paths.appRoot) return false;
  const db = await databaseConnection();
  const row = db.prepare(`
    SELECT 1 FROM execution_attempts
    WHERE agent = 'dev-agent' AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
    LIMIT 1
  `).get();
  return Boolean(row);
}

async function tryAutoApply(job: SoftwareMaintenanceJob, patchCommit: string) {
  const settings = await getSoftwareMaintenanceSettings();
  if (!settings.autoApply) return { applied: false, status: 'verified' as const, reason: '自动落地已关闭' };
  if (await hasActiveAppWriter()) return { applied: false, status: 'verified' as const, reason: '应用仓库当前有开发写入步骤' };
  const readiness = mainRepositoryCanApply(job.base_commit || '');
  if (!readiness.ok) return { applied: false, status: 'verified' as const, reason: readiness.reason };
  const applied = applyRepairCandidate(patchCommit);
  if (!applied.ok) return { applied: false, status: 'verified' as const, reason: applied.reason };
  return { applied: true, status: 'applied' as const, reason: `已自动落地 ${applied.commit}` };
}

async function retryVerifiedCandidates() {
  const settings = await getSoftwareMaintenanceSettings();
  if (!settings.autoApply || await hasActiveAppWriter()) return;
  const db = await databaseConnection();
  const jobs = db.prepare(`
    SELECT * FROM software_maintenance_jobs
    WHERE status = 'verified' AND patch_commit IS NOT NULL
    ORDER BY created_at LIMIT 20
  `).all() as SoftwareMaintenanceJob[];
  for (const job of jobs) {
    const readiness = mainRepositoryCanApply(job.base_commit || '');
    if (!readiness.ok) {
      if (readiness.reason.includes('HEAD 已离开')) {
        await updateSoftwareMaintenanceJob(job.job_id, { status: 'stale', error: readiness.reason, finished: true });
      }
      continue;
    }
    const applied = applyRepairCandidate(job.patch_commit!);
    if (!applied.ok) continue;
    await updateSoftwareMaintenanceJob(job.job_id, { status: 'applied', summary: `${job.summary || ''}；安全窗口自动落地 ${applied.commit}`, finished: true });
    removeRepairWorktree(job.job_id, true);
    await maintenanceLog(job, `候选在安全窗口自动落地：${applied.commit}`);
  }
}

async function processJob(job: SoftwareMaintenanceJob) {
  await maintenanceLog(job, `开始维护检查 job=${job.job_id} trigger=${job.trigger_kind} severity=${job.severity_text}`);
  const evidence = await loadMaintenanceEvidence(job);
  if (!evidence.length) {
    await updateSoftwareMaintenanceJob(job.job_id, { status: 'no_issue', summary: '没有可分析的结构化运行事件', finished: true });
    return;
  }
  const { worktree, branch } = createRepairWorktree(job.job_id, job.base_commit || '');
  await updateSoftwareMaintenanceJob(job.job_id, { workspacePath: worktree, branchName: branch });
  const settings = await getAgentExecutorSettings();
  const executor = getAgentExecutor(settings.executorId);
  const executionOptions = settings.executorId === 'codex' ? {
    model: settings.codexModel || undefined,
    reasoningEffort: settings.codexReasoningEffort === 'default' ? undefined : settings.codexReasoningEffort,
  } : {};
  const prompt = buildSoftwareMaintenancePrompt(job, evidence);
  const mainSnapshot = mainRepositorySnapshot();
  const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
  const execution = await executeDelegation({
    runId: `maintenance-${job.job_id}`,
    prompt,
    workspaceRoot: worktree,
    executor,
    executionOptions,
    context: { agent: 'software-maintenance-agent', taskId: job.trigger_execution_id || job.job_id, storyIndex: null, pipeline: 'software-maintenance' },
    description: '分析 Loop Engineering 结构化日志并修复一个最小软件缺陷',
    telemetry,
    appendLog: (message) => recordRuntimeEvent({
      eventName: 'loop.software_maintenance.agent',
      component: 'software-maintenance',
      body: message,
      severity: /错误|失败|error|failed/i.test(message) ? 'ERROR' : 'INFO',
      context: { runId: job.trigger_run_id, executionId: job.trigger_execution_id, stage: 'agent' },
      attributes: { jobId: job.job_id, executor: executor.id },
    }),
    maxRuntimeMs: Number(process.env.SOFTWARE_MAINTENANCE_TIMEOUT_MS || 20 * 60_000),
    idleTimeoutMs: Number(process.env.SOFTWARE_MAINTENANCE_IDLE_TIMEOUT_MS || 5 * 60_000),
    resultKind: 'maintenance',
  });
  if (execution.exitCode !== 0) throw new Error(`Maintenance Agent CLI 退出码 ${execution.exitCode}`);
  if (!mainRepositorySnapshotMatches(mainSnapshot)) {
    await updateSoftwareMaintenanceJob(job.job_id, {
      status: 'rejected', error: 'Maintenance Agent 执行期间应用主仓库发生变化；已触发隔离 circuit breaker', finished: true,
    });
    await maintenanceLog(job, '应用主仓库快照在 Maintenance Agent 执行期间发生变化，候选已拒绝', 'ERROR');
    return;
  }
  const result = parseSoftwareMaintenanceResult(execution.submittedResult || execution.finalText);
  if (!execution.submittedResult) await maintenanceLog(job, 'Maintenance Agent 未调用 submit-agent-result，已兼容读取最终文本', 'WARN');
  await updateSoftwareMaintenanceJob(job.job_id, {
    incidentFingerprint: result.fingerprint,
    summary: result.summary,
    diagnosisJson: JSON.stringify(result),
  });
  const changes = inspectRepairChanges(worktree);

  if (result.outcome !== 'fixed') {
    if (changes.files.length) {
      await updateSoftwareMaintenanceJob(job.job_id, {
        status: 'rejected',
        changedFilesJson: JSON.stringify(changes.files),
        error: 'Agent 声明未修复但修改了文件',
        finished: true,
      });
      return;
    }
    await updateSoftwareMaintenanceJob(job.job_id, { status: 'no_issue', changedFilesJson: '[]', finished: true });
    await maintenanceLog(job, `检查完成，无自动修复：${result.summary}`);
    return;
  }

  if (result.classification !== 'loop_bug' || result.confidence < 0.8) {
    await updateSoftwareMaintenanceJob(job.job_id, {
      status: 'rejected', changedFilesJson: JSON.stringify(changes.files),
      error: `自动修复证据不足：classification=${result.classification} confidence=${result.confidence}`, finished: true,
    });
    return;
  }
  if (!changes.ok) {
    await updateSoftwareMaintenanceJob(job.job_id, {
      status: 'rejected', changedFilesJson: JSON.stringify(changes.files), error: changes.errors.join('；'), finished: true,
    });
    return;
  }
  const reported = [...result.changedFiles].sort();
  const actual = [...changes.files].sort();
  if (JSON.stringify(reported) !== JSON.stringify(actual)) {
    await updateSoftwareMaintenanceJob(job.job_id, {
      status: 'rejected', changedFilesJson: JSON.stringify(actual),
      error: `Agent 声明文件与实际变更不一致：reported=${reported.join(', ')} actual=${actual.join(', ')}`, finished: true,
    });
    return;
  }
  const existing = (await databaseConnection()).prepare(`
    SELECT job_id FROM software_maintenance_jobs
    WHERE incident_fingerprint = ? AND status = 'applied' AND job_id != ? LIMIT 1
  `).get(result.fingerprint, job.job_id) as { job_id: string } | undefined;
  if (existing) {
    await updateSoftwareMaintenanceJob(job.job_id, { status: 'rejected', changedFilesJson: JSON.stringify(actual), error: `相同 incident 已由 ${existing.job_id} 修复`, finished: true });
    return;
  }

  prepareRepairDependencies(worktree);
  const harness = runSoftwareRepairHarness(worktree);
  await updateSoftwareMaintenanceJob(job.job_id, { harnessJson: JSON.stringify(harness), changedFilesJson: JSON.stringify(actual) });
  if (!harness.passed) {
    await updateSoftwareMaintenanceJob(job.job_id, { status: 'rejected', error: '软件维护 Harness 未通过', finished: true });
    await maintenanceLog(job, '修复候选未通过 test/build，已拒绝', 'WARN');
    return;
  }
  const commit = commitRepairCandidate(worktree, result.fingerprint);
  await updateSoftwareMaintenanceJob(job.job_id, { patchCommit: commit });
  const application = await tryAutoApply(job, commit);
  await updateSoftwareMaintenanceJob(job.job_id, {
    status: application.status,
    summary: `${result.summary}；${application.reason}`,
    error: application.applied ? null : application.reason,
    finished: application.applied,
  });
  await maintenanceLog(job, application.applied ? `修复已自动落地：${commit}` : `修复已验证并等待安全窗口：${application.reason}`, application.applied ? 'INFO' : 'WARN');
}

async function finalizeJobWorkspace(job: SoftwareMaintenanceJob) {
  const db = await databaseConnection();
  const current = db.prepare('SELECT status FROM software_maintenance_jobs WHERE job_id = ?').get(job.job_id) as { status: SoftwareMaintenanceJob['status'] } | undefined;
  const cleanup = removeRepairWorktree(job.job_id, current?.status !== 'verified');
  if (!cleanup.ok) await maintenanceLog(job, `维护 worktree 收尾未完成：${cleanup.errors.join('；')}`, 'WARN');
}

async function main() {
  await retryVerifiedCandidates();
  while (true) {
    const job = await claimNextSoftwareMaintenanceJob();
    if (!job) return;
    try {
      await processJob(job);
    } catch (error) {
      await recordRuntimeException({ component: 'software-maintenance', stage: 'job', error });
      await updateSoftwareMaintenanceJob(job.job_id, {
        status: 'failed', error: error instanceof Error ? error.message : String(error), finished: true,
      });
    } finally {
      try { await finalizeJobWorkspace(job); }
      catch (error) { await maintenanceLog(job, `维护 worktree 收尾检查失败：${error instanceof Error ? error.message : String(error)}`, 'WARN'); }
    }
  }
}

void main().finally(async () => {
  try { unlinkSync(maintenancePidPath()); } catch { /* runner PID already removed */ }
  try {
    const db = await databaseConnection();
    const pending = db.prepare("SELECT 1 FROM software_maintenance_jobs WHERE status = 'queued' LIMIT 1").get();
    if (pending) await startMaintenanceRunner();
  } catch { /* the next enqueue will retry waking the runner */ }
});
