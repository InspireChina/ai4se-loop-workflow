import Link from 'next/link';
import { AlertTriangle, ArrowRight, CircleDot } from 'lucide-react';
import { listPipeline, listTasks } from '../src/application/tasks';
import { agentLabel, statusLabel, terminologyText } from '../src/domain/terminology';

export const dynamic = 'force-dynamic';

const phase = (task: { analysis_index: number; dev_index: number; test_index: number; total_stories: number }) => `${task.analysis_index}/${task.total_stories} 分析 · ${task.dev_index}/${task.total_stories} 实现 · ${task.test_index}/${task.total_stories} 验证`;

export default async function Home() {
  const [tasks, pipeline] = await Promise.all([listTasks(), listPipeline()]);
  const waitingForAnswers = tasks.filter((task) => task.run_state === 'waiting_for_answers');
  const readyToClose = tasks.filter((task) => task.agile_status === 'ready_to_close');
  const needsHuman = [...waitingForAnswers, ...readyToClose];
  return <><header><div><p className="eyebrow">LOOP WORKBENCH</p><h1>工作台</h1><p className="muted">AI 自主推进；你只需要回答产品歧义并阅读最终结卡报告。</p></div></header>
    <section className="metrics"><div><b>{waitingForAnswers.length}</b><span>待回答澄清</span></div><div><b>{readyToClose.length}</b><span>待阅读结卡</span></div><div><b>{pipeline.length}</b><span>可执行步骤</span></div></section>
    <section><h2>需要我处理</h2>{needsHuman.length === 0 ? <div className="empty">当前没有需要你处理的澄清或结卡报告。</div> : needsHuman.map((task) => <article className="attention" key={task.task_id}><AlertTriangle size={20}/><div><p className="eyebrow">{task.agile_status === 'ready_to_close' ? '待阅读结卡报告' : `待回答 · ${agentLabel(task.current_subagent)}`}</p><h3>{task.title}</h3><p>{terminologyText(task.blocked_reason)}</p><small>{terminologyText(task.next_step)}</small></div><Link href={`/tasks/${task.task_id}`} className="button secondary">去处理 <ArrowRight size={14}/></Link></article>)}</section>
    <section><h2>正在推进</h2><div className="card table"><div className="row heading"><span>需求</span><span>状态</span><span>交付进度</span><span>下一步</span></div>{tasks.map((task) => <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}><span><strong>{task.title}</strong><small>{task.task_id} · {task.priority || '未定级'}</small></span><span className={`badge ${task.agile_status === 'blocked' ? 'amber' : 'blue'}`}><CircleDot size={13}/>{statusLabel(task.agile_status)}</span><span>{phase(task)}</span><span>{terminologyText(task.next_step)}</span></Link>)}</div></section></>;
}
