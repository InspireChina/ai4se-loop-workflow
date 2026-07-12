import Link from 'next/link';
import { listTasks } from '../../src/application/tasks';
import CreateTaskDialog from './create-task-dialog';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const tasks = await listTasks();
  return <>
    <header className="page-header"><div><p className="eyebrow">TASK CENTER</p><h1>Task</h1><p className="muted">当前 SQLite 工作区中的全部活动 Task。</p></div><CreateTaskDialog/></header>
    <section>
      <div className="card table task-table">
        <div className="row heading"><span>标题</span><span>类型</span><span>状态</span><span>当前 Agent</span></div>
        {tasks.map((task) => <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}><span><strong>{task.title}</strong><small>{task.task_id} · {task.priority || '未定级'}</small></span><span>{task.item_type}</span><span className="badge blue">{task.agile_status}</span><span>{task.current_subagent ?? '—'}</span></Link>)}
        {tasks.length === 0 && <div className="empty">当前没有活动 Task。</div>}
      </div>
    </section>
  </>;
}
