import Link from 'next/link';
import { AlertTriangle, ArrowRight, CircleDot, Route, LockKeyhole } from 'lucide-react';
import { getRunStatus, listPipeline, listTasks } from '../src/application/tasks';

export const dynamic = 'force-dynamic';

const phase = (task: { analysis_index: number; dev_index: number; test_index: number; total_stories: number }) => `${task.analysis_index}/${task.total_stories} 分析 · ${task.dev_index}/${task.total_stories} 开发 · ${task.test_index}/${task.total_stories} 测试`;

export default async function Home() {
  const [tasks, pipeline, run] = await Promise.all([listTasks(), listPipeline(), getRunStatus()]);
  const blocked = tasks.filter((task) => task.agile_status === 'blocked');
  return <><header><div><p className="eyebrow">LOOP WORKBENCH</p><h1>工作台</h1><p className="muted">优先处理人工确认，再让 loop 按既有规则继续推进。</p></div></header>
    <section className="metrics"><div><b>{blocked.length}</b><span>待处理阻塞</span></div><div><b>{tasks.filter((t) => t.agile_status === 'in dev').length}</b><span>开发中的 Task</span></div><div><b>{pipeline.length}</b><span>可派发步骤</span></div></section>
    {run && <section className="run-banner"><LockKeyhole size={16}/><span>当前运行租约：{run.owner} · {run.leaseId}</span><small>{run.startedAt}</small></section>}
    <section><h2>需要我处理</h2>{blocked.length === 0 ? <div className="empty">当前没有需要人工处理的阻塞。</div> : blocked.map((task) => <article className="attention" key={task.task_id}><AlertTriangle size={20}/><div><p className="eyebrow">BLOCKED · {task.current_subagent}</p><h3>{task.title}</h3><p>{task.blocked_reason}</p><small>{task.next_step}</small></div><Link href={`/tasks/${task.task_id}`} className="button secondary">去处理 <ArrowRight size={14}/></Link></article>)}</section>
    <section><h2>Pipeline</h2><div className="card table"><div className="pipeline-row heading"><span>Task</span><span>Pipeline</span><span>Agent</span><span>Story</span><span>Resource</span></div>{pipeline.length === 0 ? <div className="empty">当前没有可派发步骤。</div> : pipeline.map((item) => <Link href={`/tasks/${item.taskId}`} className="pipeline-row" key={`${item.taskId}-${item.pipeline}-${item.storyIndex || 0}`}><span><Route size={14}/>{item.taskId}<small>{item.description}</small></span><span className="badge blue">{item.pipeline}</span><span>{item.agent}</span><span>{item.storyIndex ?? '—'}</span><span>{item.resource}</span></Link>)}</div></section>
    <section><h2>正在推进</h2><div className="card table"><div className="row heading"><span>Task</span><span>状态</span><span>Story 进度</span><span>下一步</span></div>{tasks.map((task) => <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}><span><strong>{task.title}</strong><small>{task.task_id} · {task.item_type} · {task.priority}</small></span><span className={`badge ${task.agile_status === 'blocked' ? 'amber' : 'blue'}`}><CircleDot size={13}/>{task.agile_status}</span><span>{phase(task)}</span><span>{task.next_step}</span></Link>)}</div></section></>;
}
