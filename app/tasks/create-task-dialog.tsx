'use client';

import { useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { Plus, X } from 'lucide-react';
import { createTaskAction } from '../actions';
import type { RequirementDependencyCandidate } from '../../src/application/task-dependencies';
import { RequirementInputFields } from './requirement-input-fields';

function CreateTaskButton() {
  const { pending } = useFormStatus();
  return <button className="button" type="submit" disabled={pending}>{pending ? '创建中…' : '创建需求'}</button>;
}

export default function CreateTaskDialog({ dependencyCandidates }: { dependencyCandidates: RequirementDependencyCandidate[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  async function createAndOpenTask(formData: FormData) {
    const taskId = await createTaskAction(formData);
    // A hard navigation avoids Next's client router retaining a transient
    // not-found payload while the create action and SSE refresh overlap.
    window.location.assign(`/tasks/${encodeURIComponent(taskId)}`);
  }

  return <>
    <button className="button" type="button" onClick={() => dialogRef.current?.showModal()}><Plus size={15}/>创建需求</button>
    <dialog className="task-create-dialog" ref={dialogRef} onClick={(event) => {
      if (event.target === event.currentTarget) dialogRef.current?.close();
    }}>
      <div className="dialog-head">
        <div><p className="eyebrow">NEW REQUIREMENT</p><h2>创建需求</h2></div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={() => dialogRef.current?.close()}><X size={18}/></button>
      </div>
      <form action={createAndOpenTask} className="form-panel dialog-form">
        <RequirementInputFields dependencyCandidates={dependencyCandidates} autoFocus/>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={() => dialogRef.current?.close()}>取消</button>
          <CreateTaskButton/>
        </div>
      </form>
    </dialog>
  </>;
}
