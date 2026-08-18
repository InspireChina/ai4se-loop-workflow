import Link from 'next/link';
import { CirclePause, CirclePlay, Trash2 } from 'lucide-react';
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
import { ScheduleForm } from './schedule-form';
import { CreateScheduleDialog } from './create-schedule-dialog';

export const dynamic = 'force-dynamic';

const recurrenceLabels: Record<string, string> = {
  once: '单次', daily: '每天', weekdays: '每个工作日', weekly: '每周', monthly: '每月',
};

export default async function SchedulesPage() {
  const plans = await listScheduledRequirements();
  const histories = new Map(await Promise.all(plans.map(async (plan) => [plan.plan_id, await listScheduledRequirementOccurrences(plan.plan_id, 5)] as const)));
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf;
  const currentTimezone = systemTimeZone();
  const timezones = supportedValuesOf ? supportedValuesOf('timeZone') : [currentTimezone, 'UTC'];
  if (!timezones.includes(currentTimezone)) timezones.unshift(currentTimezone);

  return <>
    <header className="page-header"><div><p className="eyebrow">SCHEDULED REQUIREMENTS</p><h1>定时需求</h1><p className="muted">Runner 到点后根据模板创建全新的需求；关闭 UI 不影响执行。</p></div><CreateScheduleDialog timezones={timezones}/></header>
    <section>
      <div className="section-heading"><div><h2>计划列表</h2><span className="badge blue">{plans.length}</span></div></div>
      <div className="schedule-list">
        {plans.map((plan) => <article className="card schedule-card" key={plan.plan_id}>
          <div className="schedule-card-head">
            <div><div className="schedule-title-line"><strong>{plan.template_title}</strong><span className={`badge ${plan.enabled ? 'green' : 'amber'}`}>{plan.enabled ? '运行中' : '已暂停'}</span></div><small>{recurrenceLabels[plan.recurrence_kind]} · {plan.timezone}{plan.local_time ? ` · ${plan.local_time}` : ''}</small></div>
            <div className="schedule-actions">
              <form action={plan.enabled ? pauseScheduledRequirementAction : resumeScheduledRequirementAction}><input type="hidden" name="planId" value={plan.plan_id}/><button className="button secondary" type="submit">{plan.enabled ? <CirclePause size={15}/> : <CirclePlay size={15}/>} {plan.enabled ? '暂停' : '恢复'}</button></form>
              <form action={deleteScheduledRequirementAction}><input type="hidden" name="planId" value={plan.plan_id}/><button className="button danger" type="submit"><Trash2 size={15}/>删除</button></form>
            </div>
          </div>
          <div className="schedule-facts">
            <div><small>下次执行</small><strong>{formatScheduleInstant(plan.next_trigger_at, plan.timezone)}</strong></div>
            <div><small>上次执行</small><strong>{formatScheduleInstant(plan.last_trigger_at, plan.timezone)}</strong></div>
            <div><small>最近需求</small>{plan.last_task_id ? <Link href={`/tasks/${plan.last_task_id}`}>{plan.last_task_id}</Link> : <strong>—</strong>}</div>
          </div>
          {plan.last_error && <p className="schedule-error">{plan.last_error}</p>}
          <details className="schedule-details"><summary>编辑计划</summary><ScheduleForm plan={plan} timezones={timezones}/></details>
          <details className="schedule-details"><summary>最近执行记录</summary>
            <div className="schedule-history">
              {(histories.get(plan.plan_id) || []).map((occurrence) => <div key={occurrence.scheduled_for}><span className={`badge ${occurrence.status === 'created' ? 'green' : 'amber'}`}>{occurrence.status === 'created' ? '已创建' : '失败'}</span><span>{formatScheduleInstant(occurrence.scheduled_for, plan.timezone)}</span>{occurrence.task_id && <Link href={`/tasks/${occurrence.task_id}`}>{occurrence.task_id}</Link>}{occurrence.error && <small>{occurrence.error}</small>}</div>)}
              {!histories.get(plan.plan_id)?.length && <p className="muted">还没有执行记录。</p>}
            </div>
          </details>
        </article>)}
        {!plans.length && <div className="card empty">还没有定时需求计划。</div>}
      </div>
    </section>
  </>;
}
