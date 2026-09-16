import Link from 'next/link';
import { ArrowUpRight, CalendarClock, ChevronDown, CirclePause, CirclePlay, History, Trash2 } from 'lucide-react';
import {
  listScheduledRequirementOccurrences,
  listScheduledRequirements,
} from '../../src/application/scheduled-requirements';
import { formatScheduleInstant, systemTimeZone } from '../../src/domain/scheduled-requirement';
import {
  deleteScheduledRequirementAction,
  pauseScheduledRequirementAction,
  resumeScheduledRequirementAction,
} from '../actions';
import { CreateScheduleDialog, EditScheduleDialog } from './create-schedule-dialog';
import { listProjects } from '../../src/application/projects';
import { REQUIREMENT_PIPELINES } from '../../src/domain/pipeline-catalog';

export const dynamic = 'force-dynamic';

const recurrenceLabels: Record<string, string> = {
  once: '单次', daily: '每天', weekdays: '每个工作日', weekly: '每周', monthly: '每月',
};

export default async function SchedulesPage() {
  const [plans, projects] = await Promise.all([listScheduledRequirements(), listProjects()]);
  const projectNames = new Map(projects.map((project) => [project.project_id, project.name]));
  const histories = new Map(await Promise.all(plans.map(async (plan) => [plan.plan_id, await listScheduledRequirementOccurrences(plan.plan_id, 5)] as const)));
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf;
  const currentTimezone = systemTimeZone();
  const timezones = supportedValuesOf ? supportedValuesOf('timeZone') : [currentTimezone, 'UTC'];
  if (!timezones.includes(currentTimezone)) timezones.unshift(currentTimezone);

  return <>
    <header className="page-header schedule-page-header"><div><p className="eyebrow">SCHEDULED REQUIREMENTS</p><h1>定时需求</h1><p className="muted">按计划自动创建需求，每次独立推进。</p></div><CreateScheduleDialog timezones={timezones} projects={projects}/></header>
    <section>
      <div className="schedule-list-heading"><h2>全部计划 <span>{plans.length}</span></h2><span>{plans.filter((plan) => plan.enabled && plan.next_trigger_at).length} 个已启用</span></div>
      <div className="schedule-list">
        {plans.map((plan) => <article className="card schedule-card" key={plan.plan_id}>
          <div className="schedule-card-head">
            <div className="schedule-plan-icon"><CalendarClock size={21}/></div>
            <div className="schedule-plan-main">
              <div className="schedule-title-line"><h3>{plan.template_title}</h3><span className={`badge ${!plan.enabled ? 'amber' : plan.next_trigger_at ? 'green' : ''}`}>{!plan.enabled ? '已暂停' : plan.next_trigger_at ? '已启用' : '已结束'}</span></div>
              <div className="schedule-plan-meta"><span>{projectNames.get(plan.project_id) || '未找到项目'}</span><span>{REQUIREMENT_PIPELINES.find((pipeline) => pipeline.id === plan.template_pipeline)?.label || plan.template_pipeline}</span><span>{recurrenceLabels[plan.recurrence_kind]}{plan.recurrence_kind === 'weekly' ? ` · 星期${['日', '一', '二', '三', '四', '五', '六'][plan.weekday ?? 1]}` : plan.recurrence_kind === 'monthly' ? ` · ${plan.day_of_month} 日` : ''}{plan.local_time ? ` ${plan.local_time}` : ''}</span></div>
              {plan.template_description && <p className="schedule-description">{plan.template_description}</p>}
            </div>
            <div className="schedule-next"><small>下次执行</small><strong>{!plan.enabled ? '恢复后继续执行' : formatScheduleInstant(plan.next_trigger_at, plan.timezone)}</strong><small>{plan.timezone}</small></div>
            <div className="schedule-actions">
              <EditScheduleDialog plan={plan} timezones={timezones} projects={projects}/>
              <form action={plan.enabled ? pauseScheduledRequirementAction : resumeScheduledRequirementAction}><input type="hidden" name="planId" value={plan.plan_id}/><button className="icon-button schedule-action" type="submit" aria-label={`${plan.enabled ? '暂停' : '恢复'}计划：${plan.template_title}`} title={plan.enabled ? '暂停计划' : '恢复计划'}>{plan.enabled ? <CirclePause size={17}/> : <CirclePlay size={17}/>}</button></form>
              <form action={deleteScheduledRequirementAction}><input type="hidden" name="planId" value={plan.plan_id}/><button className="icon-button schedule-action schedule-delete" type="submit" aria-label={`删除计划：${plan.template_title}`} title="删除计划"><Trash2 size={16}/></button></form>
            </div>
          </div>
          {plan.last_error && <p className="schedule-error">{plan.last_error}</p>}
          <div className="schedule-card-footer">
          <details className="schedule-details"><summary><History size={14}/><span>{plan.last_trigger_at ? `上次执行 ${formatScheduleInstant(plan.last_trigger_at, plan.timezone)}` : '尚未执行'}</span><span className="schedule-history-label">执行记录</span><ChevronDown size={14}/></summary>
            <div className="schedule-history">
              {(histories.get(plan.plan_id) || []).map((occurrence) => <div key={occurrence.scheduled_for}><span className={`badge ${occurrence.status === 'created' ? 'green' : 'amber'}`}>{occurrence.status === 'created' ? '已创建' : '失败'}</span><span>{formatScheduleInstant(occurrence.scheduled_for, plan.timezone)}</span>{occurrence.task_id && <Link href={`/tasks/${occurrence.task_id}`}>查看需求 <ArrowUpRight size={13}/></Link>}{occurrence.error && <small>{occurrence.error}</small>}</div>)}
              {!histories.get(plan.plan_id)?.length && <p className="muted">还没有执行记录。</p>}
            </div>
          </details>
          {plan.last_task_id && <Link className="schedule-latest-task" href={`/tasks/${plan.last_task_id}`}>最近需求<ArrowUpRight size={14}/></Link>}
          </div>
        </article>)}
        {!plans.length && <div className="card empty">还没有定时需求计划。</div>}
      </div>
    </section>
  </>;
}
