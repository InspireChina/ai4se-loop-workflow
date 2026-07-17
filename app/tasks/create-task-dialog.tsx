'use client';

import { useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { createTaskAction } from '../actions';

export default function CreateTaskDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return <>
    <button className="button" type="button" onClick={() => dialogRef.current?.showModal()}><Plus size={15}/>创建需求</button>
    <dialog className="task-create-dialog" ref={dialogRef} onClick={(event) => {
      if (event.target === event.currentTarget) dialogRef.current?.close();
    }}>
      <div className="dialog-head">
        <div><p className="eyebrow">NEW REQUIREMENT</p><h2>创建需求</h2></div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={() => dialogRef.current?.close()}><X size={18}/></button>
      </div>
      <form action={createTaskAction} className="form-panel dialog-form">
        <label>标题<input name="title" required autoFocus placeholder="例如：项目列表支持按 PIC 筛选"/></label>
        <label>描述（可选）<textarea name="description" rows={4} placeholder="补充背景、目标或验收要求"/></label>
        <div className="fields">
          <label>类型<select name="itemType" defaultValue="feature"><option value="feature">功能需求</option><option value="bug">缺陷</option><option value="tech">技术改进</option><option value="intake">待梳理</option><option value="other">其他</option></select></label>
          <label>优先级<input name="priority" placeholder="P1"/></label>
        </div>
        <label>原始 URL<input name="link" placeholder="https://..."/></label>
        <div className="fields">
          <label>External ID<input name="externalId"/></label>
          <label>External Status<input name="externalStatus"/></label>
        </div>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={() => dialogRef.current?.close()}>取消</button>
          <button className="button" type="submit">创建需求</button>
        </div>
      </form>
    </dialog>
  </>;
}
