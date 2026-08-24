'use client';

import { useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { Pencil, X } from 'lucide-react';
import type { RequirementDependencyCandidate } from '../../../src/application/task-dependencies';
import type { RequirementMetadataKey } from '../../../src/domain/requirement-metadata';
import type { RequirementPipelineId } from '../../../src/domain/pipeline-catalog';
import { updateUnstartedTaskInputAction } from '../../actions';
import { RequirementInputFields } from '../requirement-input-fields';

function SaveButton() {
  const { pending } = useFormStatus();
  return <button className="button" type="submit" disabled={pending}>{pending ? '保存中…' : '保存输入'}</button>;
}

type EditTaskInputDialogProps = {
  taskId: string;
  title: string;
  description: string;
  pipeline: RequirementPipelineId;
  priority: string;
  metadata: { key: RequirementMetadataKey; value: string }[];
  dependencyIds: string[];
  dependencyCandidates: RequirementDependencyCandidate[];
};

export function EditTaskInputDialog(props: EditTaskInputDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return <>
    <button className="button secondary task-input-edit-button" type="button" onClick={() => dialogRef.current?.showModal()}><Pencil size={14}/>编辑输入</button>
    <dialog className="task-create-dialog" ref={dialogRef} onClick={(event) => {
      if (event.target === event.currentTarget) dialogRef.current?.close();
    }}>
      <div className="dialog-head">
        <div><p className="eyebrow">EDIT REQUIREMENT</p><h2>编辑需求输入</h2></div>
        <button className="icon-button" type="button" aria-label="关闭" onClick={() => dialogRef.current?.close()}><X size={18}/></button>
      </div>
      <form action={updateUnstartedTaskInputAction} className="form-panel dialog-form">
        <input type="hidden" name="taskId" value={props.taskId}/>
        <RequirementInputFields
          dependencyCandidates={props.dependencyCandidates}
          excludedTaskId={props.taskId}
          autoFocus
          initial={{
            title: props.title,
            description: props.description,
            pipeline: props.pipeline,
            priority: props.priority,
            metadata: props.metadata,
            dependencyIds: props.dependencyIds,
          }}
        />
        <p className="task-input-edit-note">仅在尚无任何 Agent 执行记录时允许保存；保存后首次派发会使用新的完整输入。</p>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={() => dialogRef.current?.close()}>取消</button>
          <SaveButton/>
        </div>
      </form>
    </dialog>
  </>;
}
