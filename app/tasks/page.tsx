import Link from 'next/link';
import { formatEventTime } from '../../src/application/event-time';
import { listCompletedTasks, listRequirementDependencyCandidates, listTasks, type TaskWithLanes } from '../../src/application/tasks';
import { agentLabel, itemTypeLabel, statusLabel } from '../../src/domain/terminology';
import { requirementPriorityLabel } from '../../src/domain/requirement-priority';
import CreateTaskDialog from './create-task-dialog';
import { TaskAutoRefresh } from './task-auto-refresh';

export const dynamic = 'force-dynamic';

type TasksPageProps = {
  searchParams: Promise<{ view?: string | string[] }>;
};

const laneStatusLabels: Record<string, string> = {
  pending: '等待上游',
  runnable: '可运行',
  running: '运行中',
  waiting_for_answers: '等待澄清',
  waiting_for_runtime_input: '等待运行信息',
  system_blocked: '系统阻塞',
  completed: '已完成',
};

const businessAnalysisAgents = ['idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent'];

function inBusinessAnalysis(task: { item_type: string; current_subagent: string | null }) {
  return task.item_type === 'business-analysis'
    || (task.item_type === 'end-to-end' && businessAnalysisAgents.includes(task.current_subagent || ''));
}

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const { view } = await searchParams;
  const completedView = view === 'completed';
  const [tasks, dependencyCandidates] = await Promise.all([
    completedView ? listCompletedTasks() : listTasks(),
    listRequirementDependencyCandidates(),
  ]);

  return <>
    <header className="page-header"><div><p className="eyebrow">REQUIREMENTS</p><h1>需求</h1><p className="muted">{completedView ? '已经完成交付的需求。' : '当前项目中正在推进的全部需求。'}</p></div><CreateTaskDialog dependencyCandidates={dependencyCandidates}/></header>
    <section>
      <nav className="task-views" aria-label="需求视图">
        <Link href="/tasks" aria-current={!completedView ? 'page' : undefined}>进行中</Link>
        <Link href="/tasks?view=completed" aria-current={completedView ? 'page' : undefined}>已完成</Link>
        <TaskAutoRefresh/>
      </nav>
      <div className="card table task-table">
        <div className="row heading"><span>标题</span><span>PIPELINE</span><span>状态</span><span>{completedView ? '时间' : '当前 Agent'}</span></div>
        {tasks.map((task) => {
          const businessAnalysisActive = inBusinessAnalysis(task);
          const hasCompletedAt = Boolean(task.completed_at);
          const timeLabel = hasCompletedAt ? '完成时间' : '更新时间';
          const timeValue = task.completed_at ?? task.updated_at;
          const waitingForRequirementAnswers = !completedView && task.run_state === 'waiting_for_answers'
            && ['idea-context-agent', 'business-design-agent', 'backlog-agent'].includes(task.current_subagent || '');
          const pendingDependencies = completedView ? [] : (task as TaskWithLanes).dependency_gate_open
            ? []
            : (task as TaskWithLanes).dependencies.filter((dependency) => dependency.agile_status !== 'done');
          const waitingForDependencies = pendingDependencies.length > 0;
          const laneSummary = completedView ? '' : task.is_paused
            ? `暂停推进${task.paused_reason ? ` · ${task.paused_reason}` : ''}`
            : waitingForDependencies
            ? `等待前置需求 · ${pendingDependencies.map((dependency) => dependency.title).join('、')}`
            : waitingForRequirementAnswers
            ? `${agentLabel(task.current_subagent)}（等待用户回答）`
            : businessAnalysisActive
              ? task.current_subagent ? agentLabel(task.current_subagent) : '等待用户阅读需求规格'
            : task.item_type === 'direct'
              ? agentLabel(task.current_subagent)
            : (task as TaskWithLanes).lanes.map((lane) => `${lane.lane === 'analysis' ? '交付分析' : '开发验证'}：${agentLabel(lane.current_agent)}（${laneStatusLabels[lane.status] || lane.status}）`).join(' · ');
          const businessAnalysisStatus = businessAnalysisActive
            ? task.agile_status === 'ready_to_close' ? '等待阅读规格'
              : task.current_subagent ? agentLabel(task.current_subagent).replace(' Agent', '')
                : task.agile_status === 'backlog' ? '等待需求意图确认' : statusLabel(task.agile_status)
            : null;
          const directStatus = task.item_type === 'direct'
            ? task.agile_status === 'done' ? '已完成' : '直接执行'
            : null;
          const displayStatus = task.is_paused ? '已暂停' : waitingForDependencies ? '等待前置需求' : waitingForRequirementAnswers ? '等待需求确认' : directStatus || businessAnalysisStatus || statusLabel(task.agile_status);

          return <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}>
            <span><strong>{task.title}</strong><small>{task.task_id} · 优先级 {requirementPriorityLabel(task.priority)}</small></span>
            <span>{itemTypeLabel(task.item_type)}</span>
            <span className={`badge ${task.agile_status === 'done' ? 'green' : task.is_paused || waitingForDependencies || waitingForRequirementAnswers ? 'amber' : 'blue'}`}>{displayStatus}</span>
            <span>{completedView ? <><small>{timeLabel}</small><br />{formatEventTime(timeValue)}</> : laneSummary}</span>
          </Link>;
        })}
        {tasks.length === 0 && <div className="empty">{completedView ? '暂无已完成需求。' : '当前没有进行中的需求。'}</div>}
      </div>
    </section>
  </>;
}
