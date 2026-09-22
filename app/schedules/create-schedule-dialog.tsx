'use client';

import { useRef } from 'react';
import { CalendarClock, Pencil, Plus, X } from 'lucide-react';
import { ScheduleForm } from './schedule-form';
import type { Project } from '../../src/application/projects';
import type { ScheduledRequirementPlan } from '../../src/application/scheduled-requirements';

export function CreateScheduleDialog({ timezones, projects }: { timezones: string[]; projects: Project[] }) {
  return <ScheduleDialog timezones={timezones} projects={projects}/>;
}

export function EditScheduleDialog({ plan, timezones, projects }: { plan: ScheduledRequirementPlan; timezones: string[]; projects: Project[] }) {
  return <ScheduleDialog plan={plan} timezones={timezones} projects={projects}/>;
}

function ScheduleDialog({ plan, timezones, projects }: { plan?: ScheduledRequirementPlan; timezones: string[]; projects: Project[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const close = () => dialogRef.current?.close();

  return <>
    <button className={plan ? 'button secondary schedule-edit' : 'button'} type="button" aria-label={plan ? `编辑计划：${plan.template_title}` : undefined} onClick={() => dialogRef.current?.showModal()}>
      {plan ? <Pencil size={14}/> : <Plus size={15}/>}{plan ? '编辑' : '新建计划'}
    </button>
    <dialog className="task-create-dialog schedule-create-dialog" ref={dialogRef} onClick={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div className="dialog-head">
        <div><p className="eyebrow">{plan ? 'EDIT SCHEDULE' : 'NEW SCHEDULE'}</p><h2><CalendarClock size={19}/>{plan ? '编辑定时计划' : '新建定时计划'}</h2></div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={close}><X size={18}/></button>
      </div>
      <ScheduleForm plan={plan} timezones={timezones} projects={projects} onCancel={close}/>
    </dialog>
  </>;
}
