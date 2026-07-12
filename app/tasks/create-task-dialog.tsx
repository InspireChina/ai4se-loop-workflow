'use client';

import { useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { createTaskAction } from '../actions';

export default function CreateTaskDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return <>
    <button className="button" type="button" onClick={() => dialogRef.current?.showModal()}><Plus size={15}/>创建 Task</button>
    <dialog className="task-create-dialog" ref={dialogRef} onClick={(event) => {
      if (event.target === event.currentTarget) dialogRef.current?.close();
    }}>
      <div className="dialog-head">
        <div><p className="eyebrow">NEW TASK</p><h2>创建 Task</h2></div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={() => dialogRef.current?.close()}><X size={18}/></button>
      </div>
      <form action={createTaskAction} className="form-panel dialog-form">
        <label>标题<input name="title" required autoFocus placeholder="例如：项目列表支持按 PIC 筛选"/></label>
        <div className="fields">
          <label>类型<select name="itemType" defaultValue="feature"><option value="feature">feature</option><option value="bug">bug</option><option value="tech">tech</option><option value="intake">intake</option><option value="other">other</option></select></label>
          <label>优先级<input name="priority" placeholder="P1"/></label>
        </div>
        <label>原始 URL<input name="link" placeholder="https://..."/></label>
        <div className="fields">
          <label>External ID<input name="externalId"/></label>
          <label>External Status<input name="externalStatus"/></label>
        </div>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={() => dialogRef.current?.close()}>取消</button>
          <button className="button" type="submit">创建 Task</button>
        </div>
      </form>
    </dialog>
  </>;
}
