import { Activity, GitCommitHorizontal, HeartPulse, ShieldCheck, Wrench } from 'lucide-react';
import { getSoftwareMaintenanceOverview, getSoftwareMaintenanceSettings, listSoftwareMaintenanceJobs } from '../../src/application/software-maintenance';
import { formatEventTime } from '../../src/application/event-time';
import { saveSoftwareMaintenanceSettingsAction } from '../actions';

export const dynamic = 'force-dynamic';

function json<T>(value: string | null, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

const statusLabel: Record<string, string> = {
  queued: '等待分析', running: '分析中', no_issue: '无需修复', verified: '已验证候选', applied: '已自动落地',
  rejected: 'Harness 拒绝', failed: '维护失败', stale: '基线已变化',
};

export default async function MaintenancePage() {
  const [settings, overview, jobs] = await Promise.all([
    getSoftwareMaintenanceSettings(),
    getSoftwareMaintenanceOverview(),
    listSoftwareMaintenanceJobs(),
  ]);
  return <>
    <header><p className="eyebrow">AUTONOMOUS MAINTENANCE</p><h1>软件演化</h1><p className="muted">独立 Maintenance Runner 从结构化日志中识别 Loop Engineering 自身缺陷，在隔离 worktree 内生成小修复，并由确定性 Harness 决定落地或回退。</p></header>

    <section className="metrics maintenance-metrics">
      <div className="card metric"><Activity/><small>结构化事件</small><b>{overview.eventCount}</b></div>
      <div className="card metric"><HeartPulse/><small>维护任务</small><b>{overview.total}</b></div>
      <div className="card metric"><Wrench/><small>队列 / 运行中</small><b>{overview.active || 0}</b></div>
      <div className="card metric"><ShieldCheck/><small>自动落地</small><b>{overview.applied || 0}</b></div>
    </section>

    <form action={saveSoftwareMaintenanceSettingsAction} className="card settings maintenance-settings">
      <div className="settings-section-head"><span className="executor-icon"><HeartPulse size={18}/></span><div><strong>独立自维护线程</strong><p className="muted settings-description">主 Loop 的 finally 只持久化检查任务；诊断、代码修改和 test/build 全部由独立进程执行。</p></div><span className={`badge ${settings.enabled ? 'green' : 'blue'}`}>{settings.enabled ? '已启用' : '已关闭'}</span></div>
      <label className="checkbox"><input type="checkbox" name="softwareMaintenanceEnabled" defaultChecked={settings.enabled}/>每个 execution 结束后分析结构化日志</label>
      <label className="checkbox"><input type="checkbox" name="softwareMaintenanceAutoApply" defaultChecked={settings.autoApply}/>Harness 通过且应用仓库处于相同 clean baseline 时自动落地</label>
      <p className="path-line">自动落地不需要 Approval。若主仓库正在写入、有未提交改动或 HEAD 已变化，候选会保留为 verified/stale，不会抢占主流程。</p>
      <button className="button" type="submit">保存软件演化设置</button>
    </form>

    <section className="task-section">
      <div className="section-head"><h2>维护记录</h2><small>{jobs.length} 条</small></div>
      <div className="maintenance-job-list">
        {jobs.length ? jobs.map((job) => {
          const diagnosis = json<{ rootCause?: string; classification?: string; confidence?: number; followUp?: string }>(job.diagnosis_json, {});
          const files = json<string[]>(job.changed_files_json, []);
          const harness = json<{ passed?: boolean; checks?: { command: string; passed: boolean; summary: string }[] }>(job.harness_json, {});
          const statusClass = job.status === 'applied' || job.status === 'no_issue' ? 'green' : job.status === 'queued' || job.status === 'running' ? 'amber' : 'blue';
          return <article className="card maintenance-job" key={job.job_id}>
            <div className="maintenance-job-head"><div><span className={`badge ${statusClass}`}>{statusLabel[job.status] || job.status}</span><strong>{job.summary || '等待 Maintenance Agent 分析'}</strong></div><small>{formatEventTime(job.created_at)}</small></div>
            <div className="agent-stats">
              <span><Activity size={13}/>{job.severity_text}</span>
              <span>{job.trigger_kind}</span>
              <span>attempt {job.attempt}</span>
              {diagnosis.classification && <span>{diagnosis.classification} · {Number(diagnosis.confidence || 0).toFixed(2)}</span>}
              {job.patch_commit && <span><GitCommitHorizontal size={13}/>{job.patch_commit.slice(0, 10)}</span>}
            </div>
            {diagnosis.rootCause && <p><b>根因：</b>{diagnosis.rootCause}</p>}
            {files.length > 0 && <p><b>变更：</b>{files.join('、')}</p>}
            {job.error && <p className="maintenance-error"><b>未落地原因：</b>{job.error}</p>}
            {(harness.checks?.length || diagnosis.followUp) && <details><summary>查看 Harness 与后续信息</summary>
              {harness.checks?.map((check) => <div className="maintenance-check" key={check.command}><span className={`badge ${check.passed ? 'green' : 'amber'}`}>{check.passed ? 'PASS' : 'FAIL'}</span><b>{check.command}</b><pre>{check.summary}</pre></div>)}
              {diagnosis.followUp && <p>{diagnosis.followUp}</p>}
            </details>}
          </article>;
        }) : <div className="card empty">尚无维护任务。新的 execution 完成后会自动产生一次独立检查。</div>}
      </div>
    </section>
  </>;
}
