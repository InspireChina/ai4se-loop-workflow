import Link from 'next/link';
import { AlertTriangle, ArrowRight, CircleDot } from 'lucide-react';
import { listPipeline, listTasks } from '../src/application/tasks';
import { agentLabel, statusLabel, terminologyText } from '../src/domain/terminology';

export const dynamic = 'force-dynamic';

const phase = (task: { analysis_index: number; dev_index: number; test_index: number; total_stories: number }) => `${task.analysis_index}/${task.total_stories} 分析 · ${task.dev_index}/${task.total_stories} 实现 · ${task.test_index}/${task.total_stories} 验证`;

export default async function Home() {
  const [tasks, pipeline] = await Promise.all([listTasks(), listPipeline()]);
  const laneWaitingForAnswers = tasks.flatMap((task) => task.lanes.filter((lane) => lane.status === 'waiting_for_answers').map((lane) => ({ task, lane })));
  const requirementWaitingForAnswers = tasks
    .filter((task) => task.run_state === 'waiting_for_answers' && task.current_subagent === 'backlog-agent')
    .map((task) => ({ task, lane: null }));
  const waitingForAnswers = [...requirementWaitingForAnswers, ...laneWaitingForAnswers];
  const waitingForRuntimeInput = tasks.flatMap((task) => task.lanes.filter((lane) => lane.status === 'waiting_for_runtime_input').map((lane) => ({ task, lane })));
  const readyToClose = tasks.filter((task) => task.agile_status === 'ready_to_close');
  const needsHuman = [
    ...waitingForAnswers.map((item) => ({ ...item, kind: 'answers' as const })),
    ...waitingForRuntimeInput.map((item) => ({ ...item, kind: 'runtime' as const })),
    ...readyToClose.map((task) => ({ task, lane: null, kind: 'closure' as const })),
  ];
  return <><header><div><p className="eyebrow">LOOP WORKBENCH</p><h1>工作台</h1><p className="muted">AI 自主推进；需要时补充设计决策或运行信息，并阅读最终结卡报告。</p></div></header>
    <section className="metrics"><div><b>{waitingForAnswers.length + waitingForRuntimeInput.length}</b><span>待补充信息</span></div><div><b>{readyToClose.length}</b><span>待阅读结卡</span></div><div><b>{pipeline.length}</b><span>可执行步骤</span></div></section>
    <section><h2>需要我处理</h2>{needsHuman.length === 0 ? <div className="empty">当前没有需要你处理的信息或结卡报告。</div> : needsHuman.map(({ task, lane, kind }) => <article className="attention" key={`${task.task_id}-${lane?.lane || kind}`}><AlertTriangle size={20}/><div><p className="eyebrow">{kind === 'closure' ? '待阅读结卡报告' : kind === 'runtime' ? `待补充运行信息 · ${lane!.lane === 'analysis' ? 'Analysis' : 'Delivery'} · ${agentLabel(lane!.current_agent)}` : lane ? `待回答设计澄清 · Analysis · ${agentLabel(lane.current_agent)}` : `待回答需求澄清 · 需求级 · ${agentLabel(task.current_subagent)}`}</p><h3>{task.title}</h3><p>{terminologyText(lane?.blocked_reason || task.blocked_reason)}</p><small>{terminologyText(task.next_step)}</small></div><Link href={`/tasks/${task.task_id}`} className="button secondary">去处理 <ArrowRight size={14}/></Link></article>)}</section>
    <section><h2>正在推进</h2><div className="card table"><div className="row heading"><span>需求</span><span>状态</span><span>交付进度</span><span>下一步</span></div>{tasks.map((task) => {
      const runtimeLane = task.lanes.find((lane) => lane.status === 'waiting_for_runtime_input');
      const answerLane = task.lanes.find((lane) => lane.status === 'waiting_for_answers');
      const blockedLane = task.lanes.find((lane) => lane.status === 'system_blocked');
      const requirementAnswers = task.run_state === 'waiting_for_answers' && task.current_subagent === 'backlog-agent';
      const needsAttention = requirementAnswers || runtimeLane || answerLane || blockedLane;
      const label = requirementAnswers ? '等待需求澄清' : runtimeLane ? '等待运行信息' : answerLane ? '等待单元澄清' : blockedLane ? `${blockedLane.lane === 'analysis' ? 'Analysis' : 'Delivery'} 阻塞` : statusLabel(task.agile_status);
      return <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}><span><strong>{task.title}</strong><small>{task.task_id} · {task.priority || '未定级'}</small></span><span className={`badge ${task.agile_status === 'blocked' || needsAttention ? 'amber' : 'blue'}`}><CircleDot size={13}/>{label}</span><span>{phase(task)}</span><span>{terminologyText(task.next_step)}</span></Link>;
    })}</div></section></>;
}
