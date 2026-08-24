import Link from 'next/link';
import { AlertTriangle, ArrowRight, CircleDot } from 'lucide-react';
import { listTasks } from '../src/application/tasks';
import { progressDispatchInspector } from '../src/application/progress-dispatch';
import { requirementDependencySatisfied } from '../src/application/task-dependencies';
import { agentLabel, statusLabel, terminologyText } from '../src/domain/terminology';
import { requirementPriorityLabel } from '../src/domain/requirement-priority';

export const dynamic = 'force-dynamic';

const businessAnalysisAgents = ['idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent'];
const inBusinessAnalysis = (task: { item_type: string; current_subagent: string | null }) => task.item_type === 'business-analysis'
  || (task.item_type === 'end-to-end' && businessAnalysisAgents.includes(task.current_subagent || ''));

const phase = (task: { item_type: string; current_subagent: string | null; analysis_index: number; dev_index: number; test_index: number; total_stories: number }) => inBusinessAnalysis(task)
  ? task.current_subagent ? agentLabel(task.current_subagent) : '等待阅读需求规格'
  : `${task.analysis_index}/${task.total_stories} 交付分析 · ${task.dev_index}/${task.total_stories} 实现 · ${task.test_index}/${task.total_stories} 验证`;

export default async function Home() {
  const [tasks, pipeline] = await Promise.all([listTasks(), progressDispatchInspector.inspectAll()]);
  const activeTasks = tasks.filter((task) => !task.is_paused);
  const laneWaitingForAnswers = activeTasks.flatMap((task) => task.lanes.filter((lane) => lane.status === 'waiting_for_answers').map((lane) => ({ task, lane })));
  const requirementWaitingForAnswers = tasks
    .filter((task) => !task.is_paused && task.run_state === 'waiting_for_answers'
      && ['idea-context-agent', 'business-design-agent', 'backlog-agent'].includes(task.current_subagent || ''))
    .map((task) => ({ task, lane: null }));
  const waitingForAnswers = [...requirementWaitingForAnswers, ...laneWaitingForAnswers];
  const waitingForRuntimeInput = activeTasks.flatMap((task) => task.lanes.filter((lane) => lane.status === 'waiting_for_runtime_input').map((lane) => ({ task, lane })));
  const readyToClose = activeTasks.filter((task) => task.agile_status === 'ready_to_close');
  const needsHuman = [
    ...waitingForAnswers.map((item) => ({ ...item, kind: 'answers' as const })),
    ...waitingForRuntimeInput.map((item) => ({ ...item, kind: 'runtime' as const })),
    ...readyToClose.map((task) => ({ task, lane: null, kind: 'closure' as const })),
  ];
  return <><header><div><p className="eyebrow">LOOP WORKBENCH</p><h1>工作台</h1><p className="muted">AI 自主推进；需要时补充设计决策、运行信息或验证协助，并阅读最终结卡报告。</p></div></header>
    <section className="metrics"><div><b>{waitingForAnswers.length + waitingForRuntimeInput.length}</b><span>待处理信息</span></div><div><b>{readyToClose.length}</b><span>待阅读产物</span></div><div><b>{pipeline.length}</b><span>可执行步骤</span></div></section>
    <section><h2>需要我处理</h2>{needsHuman.length === 0 ? <div className="empty">当前没有需要你处理的信息或最终产物。</div> : needsHuman.map(({ task, lane, kind }) => <article className="attention" key={`${task.task_id}-${lane?.lane || kind}`}><AlertTriangle size={20}/><div><p className="eyebrow">{kind === 'closure' ? task.item_type === 'business-analysis' ? '待阅读需求规格说明书' : '待阅读结卡报告' : kind === 'runtime' ? `${lane!.current_agent === 'test-agent' ? '待验证协助' : '待补充运行信息'} · ${lane!.lane === 'analysis' ? '交付分析' : '开发验证'} · ${agentLabel(lane!.current_agent)}` : lane ? `待回答关键决策 · 交付分析 · ${agentLabel(lane.current_agent)}` : `待回答需求澄清 · 需求级 · ${agentLabel(task.current_subagent)}`}</p><h3>{task.title}</h3><p>{terminologyText(lane?.blocked_reason || task.blocked_reason)}</p><small>{terminologyText(task.next_step)}</small></div><Link href={`/tasks/${task.task_id}`} className="button secondary">去处理 <ArrowRight size={14}/></Link></article>)}</section>
    <section><h2>正在推进</h2><div className="card table"><div className="row heading"><span>需求</span><span>状态</span><span>交付进度</span><span>下一步</span></div>{tasks.map((task) => {
      const runtimeLane = task.lanes.find((lane) => lane.status === 'waiting_for_runtime_input');
      const answerLane = task.lanes.find((lane) => lane.status === 'waiting_for_answers');
      const blockedLane = task.lanes.find((lane) => lane.status === 'system_blocked');
      const pendingDependencies = task.dependency_gate_open
        ? []
        : task.dependencies.filter((dependency) => !requirementDependencySatisfied(dependency.agile_status));
      const waitingForDependencies = pendingDependencies.length > 0;
      const requirementAnswers = task.run_state === 'waiting_for_answers'
        && ['idea-context-agent', 'business-design-agent', 'backlog-agent'].includes(task.current_subagent || '');
      const needsAttention = !task.is_paused && (requirementAnswers || runtimeLane || answerLane || blockedLane);
      const label = task.is_paused ? '已暂停'
        : waitingForDependencies ? '等待前置需求'
        : requirementAnswers
        ? task.current_subagent === 'idea-context-agent' ? '等待需求意图确认'
          : task.current_subagent === 'business-design-agent' ? '等待业务方案决策'
            : '等待需求澄清'
        : runtimeLane ? runtimeLane.current_agent === 'test-agent' ? '等待验证协助' : '等待运行信息' : answerLane ? '等待关键决策' : blockedLane ? `${blockedLane.lane === 'analysis' ? '交付分析' : '开发验证'}阻塞`
          : inBusinessAnalysis(task)
            ? task.agile_status === 'ready_to_close' ? '等待阅读需求规格' : task.current_subagent ? agentLabel(task.current_subagent).replace(' Agent', '') : statusLabel(task.agile_status)
            : statusLabel(task.agile_status);
      const progress = task.is_paused
        ? `暂停推进 · ${task.paused_reason || '暂缓推进'}`
        : waitingForDependencies
          ? `等待 ${pendingDependencies.length} 个前置需求进入等待阅读`
          : phase(task);
      const nextStep = task.is_paused
        ? '恢复后从原步骤继续'
        : waitingForDependencies
          ? `前置需求进入等待阅读后自动调度 · ${pendingDependencies.map((dependency) => dependency.title).join('、')}`
          : terminologyText(task.next_step);
      return <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}><span><strong>{task.title}</strong><small>{task.task_id} · 优先级 {requirementPriorityLabel(task.priority)}</small></span><span className={`badge ${task.is_paused || waitingForDependencies || task.agile_status === 'blocked' || needsAttention ? 'amber' : 'blue'}`}><CircleDot size={13}/>{label}</span><span>{progress}</span><span>{nextStep}</span></Link>;
    })}</div></section></>;
}
