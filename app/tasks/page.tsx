import Link from 'next/link';
import { listTasks } from '../../src/application/tasks';
import { createTaskAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const tasks = await listTasks();
  return <>
    <header><p className="eyebrow">TASK CENTER</p><h1>Task</h1><p className="muted">当前 SQLite 工作区中的全部活动 Task。</p></header>
    <section className="split">
      <form action={createTaskAction} className="card form-panel">
        <h2>新增 Task</h2>
        <label>标题<input name="title" required placeholder="例如：项目列表支持按 PIC 筛选"/></label>
        <div className="fields">
          <label>类型<select name="itemType" defaultValue="feature"><option value="feature">feature</option><option value="bug">bug</option><option value="tech">tech</option><option value="intake">intake</option><option value="other">other</option></select></label>
          <label>优先级<input name="priority" placeholder="P1"/></label>
        </div>
        <label>原始 URL<input name="link" placeholder="https://..."/></label>
        <div className="fields">
          <label>External ID<input name="externalId"/></label>
          <label>External Status<input name="externalStatus"/></label>
        </div>
        <button className="button" type="submit">创建 Task</button>
      </form>
      <div className="card table task-table">
        <div className="row heading"><span>标题</span><span>类型</span><span>状态</span><span>当前 Agent</span></div>
        {tasks.map((task) => <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}><span><strong>{task.title}</strong><small>{task.task_id} · {task.priority || '未定级'}</small></span><span>{task.item_type}</span><span className="badge blue">{task.agile_status}</span><span>{task.current_subagent ?? '—'}</span></Link>)}
      </div>
    </section>
  </>;
}
