import Link from 'next/link';
import { Activity, ScrollText } from 'lucide-react';
import { formatEventTime } from '../../src/application/event-time';
import { getRunStatus, listRecentEvents } from '../../src/application/tasks';
import { agentLabel, terminologyText } from '../../src/domain/terminology';
import LoopLogStream from '../loop-log-stream';
import { RunLifecycleControls } from './run-lifecycle-controls';

export const dynamic = 'force-dynamic';

function runDetail(run: NonNullable<Awaited<ReturnType<typeof getRunStatus>>>) {
  const supervisor = run.owner === 'cli-supervisor'
    ? 'CLI Supervisor'
    : run.owner === 'electron-supervisor'
      ? 'Electron Supervisor'
      : null;
  const processKind = run.processKind || 'agent-runner';
  return `${processKind} · pid ${run.pid ?? '启动中'}${supervisor ? ` · 由 ${supervisor} 管理` : ''}`;
}

export default async function RunsPage() {
  const [run, events] = await Promise.all([getRunStatus(), listRecentEvents(30)]);

  return <>
    <header>
      <p className="eyebrow">LOOP RUNS</p>
      <h1>运行面板</h1>
      <p className="muted">这里展示每轮 Loop 的实时运行日志，包括 Agent 执行、推进计划和状态变化。</p>
    </header>

    <section className="run-toolbar">
      <RunLifecycleControls
        active={Boolean(run?.active)}
        detail={run?.active ? runDetail(run) : '当前没有运行中的 loop。'}
      />
    </section>

    <section className="run-console-layout">
      <div className="card run-console-main">
        <div className="run-console-head">
          <div>
            <h2><ScrollText size={16}/>{run?.active ? '实时运行日志' : '运行日志'}</h2>
            <p className="muted">{run?.active ? '日志会在本轮运行期间持续追加。' : '点击上方开始运行后，这里会实时追加日志。'}</p>
          </div>
        </div>
        {run?.active ? <div className="run-page-log"><LoopLogStream runId={run.runId}/></div> : <div className="empty run-idle-note">暂无实时日志。最近事件在下方可查看。</div>}
      </div>
    </section>

    <section className="task-section">
      <div className="section-head"><h2>最近事件</h2><small>{events.length} 条</small></div>
      <div className="card run-event-list">
        {events.length === 0 ? <div className="empty">暂无事件。</div> : events.map((event) => <Link href={`/tasks/${event.task_id}`} className="run-event-row" key={event.event_id}>
          <Activity size={14}/>
          <span><strong>{agentLabel(event.actor)}</strong><small>{event.title}</small></span>
          <em>{terminologyText(event.summary)}</em>
          <small>{formatEventTime(event.created_at)}</small>
        </Link>)}
      </div>
    </section>
  </>;
}
