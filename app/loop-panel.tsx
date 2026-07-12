import Link from 'next/link';
import { Activity, LockKeyhole, Route, ScrollText } from 'lucide-react';
import { getRunStatus, listPipeline, listRecentEvents } from '../src/application/tasks';
import { endLoopRunAction, startLoopRunAction } from './actions';

export default async function LoopPanel() {
  const [run, pipeline, events] = await Promise.all([getRunStatus(), listPipeline(), listRecentEvents(12)]);
  return <aside className="loop-panel">
    <div className="loop-panel-head">
      <p className="eyebrow">LOOP</p>
      <h2>运行面板</h2>
    </div>
    {run?.active ? <form action={endLoopRunAction} className="loop-run active">
      <LockKeyhole size={17}/>
      <div><strong>本轮运行中</strong><small>{run.owner} · {run.leaseUntil}</small></div>
      <input type="hidden" name="leaseId" value={run.leaseId}/>
      <button className="button secondary" type="submit">结束本轮</button>
    </form> : <form action={startLoopRunAction} className="loop-run">
      <Route size={17}/>
      <div><strong>开始 Loop</strong><small>生成 run lease 和 dispatch</small></div>
      <button className="button" type="submit">开始</button>
    </form>}

    <section className="side-section">
      <h3><Route size={14}/>Pipeline</h3>
      <div className="side-list">
        {pipeline.length === 0 ? <p className="side-empty">当前没有可派发步骤。</p> : pipeline.map((item) => <Link href={item.taskId ? `/tasks/${item.taskId}` : '/'} className="side-item" key={`${item.taskId}-${item.pipeline}-${item.storyIndex || 0}`}>
          <span className="badge blue">{item.pipeline}</span>
          <strong>{item.agent}</strong>
          <small>{item.taskId || 'System'}{item.storyIndex ? ` · Story-${item.storyIndex}` : ''}</small>
          <em>{item.description}</em>
        </Link>)}
      </div>
    </section>

    <section className="side-section logs">
      <h3><ScrollText size={14}/>日志</h3>
      <div className="side-list">
        {events.length === 0 ? <p className="side-empty">暂无日志。</p> : events.map((event) => <Link href={`/tasks/${event.task_id}`} className="log-item" key={event.event_id}>
          <Activity size={13}/>
          <span><strong>{event.actor}</strong><small>{event.title}</small><em>{event.summary}</em></span>
        </Link>)}
      </div>
    </section>
  </aside>;
}
