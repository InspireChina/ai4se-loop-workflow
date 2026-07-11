import Link from 'next/link';
import { listTasks } from '../../src/application/tasks';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const tasks = await listTasks();
  return <><header><p className="eyebrow">TASK CENTER</p><h1>Task</h1><p className="muted">当前 SQLite 工作区中的全部活动 Task。</p></header><div className="card table"><div className="row heading"><span>标题</span><span>类型</span><span>状态</span><span>当前 Agent</span></div>{tasks.map((task) => <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}><span><strong>{task.title}</strong><small>{task.task_id} · {task.priority}</small></span><span>{task.item_type}</span><span className="badge blue">{task.agile_status}</span><span>{task.current_subagent ?? '—'}</span></Link>)}</div></>;
}
