import Link from 'next/link';
import { formatEventTime } from '../../src/application/event-time';
import { listCompletedTasks, listTasks, type TaskWithLanes } from '../../src/application/tasks';
import { agentLabel, itemTypeLabel, statusLabel } from '../../src/domain/terminology';
import CreateTaskDialog from './create-task-dialog';

export const dynamic = 'force-dynamic';

type TasksPageProps = {
  searchParams: Promise<{ view?: string | string[] }>;
};

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const { view } = await searchParams;
  const completedView = view === 'completed';
  const tasks = completedView ? await listCompletedTasks() : await listTasks();

  return <>
    <header className="page-header"><div><p className="eyebrow">REQUIREMENTS</p><h1>需求</h1><p className="muted">{completedView ? '已经完成交付的需求。' : '当前项目中正在推进的全部需求。'}</p></div><CreateTaskDialog/></header>
    <section>
      <nav className="task-views" aria-label="需求视图">
        <Link href="/tasks" aria-current={!completedView ? 'page' : undefined}>进行中</Link>
        <Link href="/tasks?view=completed" aria-current={completedView ? 'page' : undefined}>已完成</Link>
      </nav>
      <div className="card table task-table">
        <div className="row heading"><span>标题</span><span>类型</span><span>状态</span><span>{completedView ? '时间' : '当前 Agent'}</span></div>
        {tasks.map((task) => {
          const hasCompletedAt = Boolean(task.completed_at);
          const timeLabel = hasCompletedAt ? '完成时间' : '更新时间';
          const timeValue = task.completed_at ?? task.updated_at;
          const laneSummary = completedView ? '' : (task as TaskWithLanes).lanes.map((lane) => `${lane.lane === 'analysis' ? 'Analysis' : 'Delivery'}: ${agentLabel(lane.current_agent)}（${lane.status}）`).join(' · ');

          return <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}>
            <span><strong>{task.title}</strong><small>{task.task_id} · {task.priority || '未定级'}</small></span>
            <span>{itemTypeLabel(task.item_type)}</span>
            <span className={`badge ${task.agile_status === 'done' ? 'green' : 'blue'}`}>{statusLabel(task.agile_status)}</span>
            <span>{completedView ? <><small>{timeLabel}</small><br />{formatEventTime(timeValue)}</> : laneSummary}</span>
          </Link>;
        })}
        {tasks.length === 0 && <div className="empty">{completedView ? '暂无已完成需求。' : '当前没有进行中的需求。'}</div>}
      </div>
    </section>
  </>;
}
