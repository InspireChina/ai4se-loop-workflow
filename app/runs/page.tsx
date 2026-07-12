import Link from 'next/link';
import { Activity, LockKeyhole, Route, ScrollText } from 'lucide-react';
import { getRunStatus, listRecentEvents } from '../../src/application/tasks';
import { endLoopRunAction, startLoopRunAction } from '../actions';
import LoopLogStream from '../loop-log-stream';

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const [run, events] = await Promise.all([getRunStatus(), listRecentEvents(30)]);

  return <>
    <header>
      <p className="eyebrow">LOOP RUNS</p>
      <h1>运行面板</h1>
      <p className="muted">这里展示每轮 loop 的实时运行日志。需要执行的 agent、dispatch 和状态变化都会写到日志里。</p>
    </header>

    <section className="run-toolbar">
      <div>
        <span className={`badge ${run?.active ? 'amber' : 'green'}`}>{run?.active ? 'running' : 'idle'}</span>
        <small>{run?.active ? `${run.owner} · ${run.leaseUntil}` : '当前没有运行中的 loop。'}</small>
      </div>
      {run?.active ? <form action={endLoopRunAction}>
        <input type="hidden" name="leaseId" value={run.leaseId}/>
        <input type="hidden" name="redirectTo" value="/runs"/>
        <button className="button secondary" type="submit"><LockKeyhole size={15}/>结束本轮</button>
      </form> : <form action={startLoopRunAction}>
        <input type="hidden" name="redirectTo" value="/runs"/>
        <button className="button" type="submit"><Route size={15}/>开始运行</button>
      </form>}
    </section>

    <section className="run-console-layout">
      <div className="card run-console-main">
        <div className="run-console-head">
          <div>
            <h2><ScrollText size={16}/>{run?.active ? '实时运行日志' : '运行日志'}</h2>
            <p className="muted">{run?.active ? '日志会在本轮运行期间持续追加。' : '点击上方开始运行后，这里会实时追加日志。'}</p>
          </div>
        </div>
        {run?.active ? <div className="run-page-log"><LoopLogStream leaseId={run.leaseId}/></div> : <div className="empty run-idle-note">暂无实时日志。最近事件在下方可查看。</div>}
      </div>
    </section>

    <section className="task-section">
      <div className="section-head"><h2>最近事件</h2><small>{events.length} 条</small></div>
      <div className="card run-event-list">
        {events.length === 0 ? <div className="empty">暂无事件。</div> : events.map((event) => <Link href={`/tasks/${event.task_id}`} className="run-event-row" key={event.event_id}>
          <Activity size={14}/>
          <span><strong>{event.actor}</strong><small>{event.title}</small></span>
          <em>{event.summary}</em>
          <small>{event.created_at}</small>
        </Link>)}
      </div>
    </section>
  </>;
}
