import Link from 'next/link';
import { formatEventTime } from '../../src/application/event-time';
import { listCompletedTasks, listTasks, type TaskWithLanes } from '../../src/application/tasks';
import { agentLabel, itemTypeLabel, statusLabel } from '../../src/domain/terminology';
import { requirementPriorityLabel } from '../../src/domain/requirement-priority';
import CreateTaskDialog from './create-task-dialog';

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
        <div className="row heading"><span>标题</span><span>PIPELINE</span><span>状态</span><span>{completedView ? '时间' : '当前 Agent'}</span></div>
        {tasks.map((task) => {
          const hasCompletedAt = Boolean(task.completed_at);
          const timeLabel = hasCompletedAt ? '完成时间' : '更新时间';
          const timeValue = task.completed_at ?? task.updated_at;
          const waitingForRequirementAnswers = !completedView && task.run_state === 'waiting_for_answers'
            && ['idea-context-agent', 'business-design-agent', 'backlog-agent'].includes(task.current_subagent || '');
          const laneSummary = completedView ? '' : waitingForRequirementAnswers
            ? `${agentLabel(task.current_subagent)}（等待用户回答）`
            : task.item_type === 'business-analysis'
              ? task.current_subagent ? agentLabel(task.current_subagent) : '等待用户阅读需求规格'
            : (task as TaskWithLanes).lanes.map((lane) => `${lane.lane === 'analysis' ? '交付分析' : '开发验证'}：${agentLabel(lane.current_agent)}（${laneStatusLabels[lane.status] || lane.status}）`).join(' · ');
          const businessAnalysisStatus = task.item_type === 'business-analysis'
            ? task.agile_status === 'ready_to_close' ? '等待阅读规格'
              : task.current_subagent ? agentLabel(task.current_subagent).replace(' Agent', '')
                : task.agile_status === 'backlog' ? '等待需求意图确认' : statusLabel(task.agile_status)
            : null;
          const displayStatus = waitingForRequirementAnswers ? '等待需求确认' : businessAnalysisStatus || statusLabel(task.agile_status);

          return <Link href={`/tasks/${task.task_id}`} className="row" key={task.task_id}>
            <span><strong>{task.title}</strong><small>{task.task_id} · 优先级 {requirementPriorityLabel(task.priority)}</small></span>
            <span>{itemTypeLabel(task.item_type)}</span>
            <span className={`badge ${task.agile_status === 'done' ? 'green' : waitingForRequirementAnswers ? 'amber' : 'blue'}`}>{displayStatus}</span>
            <span>{completedView ? <><small>{timeLabel}</small><br />{formatEventTime(timeValue)}</> : laneSummary}</span>
          </Link>;
        })}
        {tasks.length === 0 && <div className="empty">{completedView ? '暂无已完成需求。' : '当前没有进行中的需求。'}</div>}
      </div>
    </section>
  </>;
}
