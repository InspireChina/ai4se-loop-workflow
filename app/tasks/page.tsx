import Link from 'next/link';
import { formatEventTime } from '../../src/application/event-time';
import { listCompletedTasks, listTasks } from '../../src/application/tasks';
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
    <header className="page-header"><div><p className="eyebrow">TASK CENTER</p><h1>Task</h1><p className="muted">{completedView ? '已完成的 Task 记录。' : '当前 SQLite 工作区中的全部活动 Task。'}</p></div><CreateTaskDialog/></header>
    <section>
      <nav className="task-views" aria-label="Task 视图">
        <Link href="/tasks" aria-current={!completedView ? 'page' : undefined}>活动 Task</Link>
        <Link href="/tasks?view=completed" aria-current={completedView ? 'page' : undefined}>已完成</Link>
      </nav>
      <div className="card table task-table">
        <div className="row heading"><span>标题</span><span>类型</span><span>状态</span><span>{completedView ? '时间' : '当前 Agent'}</span></div>
        {tasks.map((task) => {
          const hasCompletedAt = Boolean(task.completed_at);
          const timeLabel = hasCompletedAt ? '完成时间' : '更新时间';
          const timeValue = task.completed_at ?? task.updated_at;

          return <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}>
            <span><strong>{task.title}</strong><small>{task.task_id} · {task.priority || '未定级'}</small></span>
            <span>{task.item_type}</span>
            <span className={`badge ${task.agile_status === 'done' ? 'green' : 'blue'}`}>{task.agile_status}</span>
            <span>{completedView ? <><small>{timeLabel}</small><br />{formatEventTime(timeValue)}</> : task.current_subagent ?? '—'}</span>
          </Link>;
        })}
        {tasks.length === 0 && <div className="empty">{completedView ? '暂无已完成 Task。' : '当前没有活动 Task。'}</div>}
      </div>
    </section>
  </>;
}
