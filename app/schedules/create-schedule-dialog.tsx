'use client';

import { useRef } from 'react';
import { CalendarClock, Plus, X } from 'lucide-react';
import { ScheduleForm } from './schedule-form';

export function CreateScheduleDialog({ timezones }: { timezones: string[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const close = () => dialogRef.current?.close();

  return <>
    <button className="button" type="button" onClick={() => dialogRef.current?.showModal()}>
      <Plus size={15}/>新建计划
    </button>
    <dialog className="task-create-dialog schedule-create-dialog" ref={dialogRef} onClick={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div className="dialog-head">
        <div><p className="eyebrow">NEW SCHEDULE</p><h2><CalendarClock size={19}/>新建定时计划</h2></div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={close}><X size={18}/></button>
      </div>
      <ScheduleForm timezones={timezones} onCancel={close}/>
    </dialog>
  </>;
}
