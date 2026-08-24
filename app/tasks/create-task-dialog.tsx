'use client';

import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Plus, Trash2, X } from 'lucide-react';
import { REQUIREMENT_PIPELINES } from '../../src/domain/pipeline-catalog';
import { DEFAULT_REQUIREMENT_PRIORITY, REQUIREMENT_PRIORITY_OPTIONS } from '../../src/domain/requirement-priority';
import { REQUIREMENT_METADATA_DEFINITIONS, type RequirementMetadataKey } from '../../src/domain/requirement-metadata';
import { createTaskAction } from '../actions';
import type { RequirementDependencyCandidate } from '../../src/application/task-dependencies';

function CreateTaskButton() {
  const { pending } = useFormStatus();
  return <button className="button" type="submit" disabled={pending}>{pending ? '创建中…' : '创建需求'}</button>;
}

export default function CreateTaskDialog({ dependencyCandidates }: { dependencyCandidates: RequirementDependencyCandidate[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [metadataKeys, setMetadataKeys] = useState<RequirementMetadataKey[]>([]);
  const [dependencyQuery, setDependencyQuery] = useState('');
  const [selectedDependencyIds, setSelectedDependencyIds] = useState<string[]>([]);
  const visibleDependencyCandidates = dependencyCandidates.filter((candidate) => {
    const query = dependencyQuery.trim().toLocaleLowerCase();
    return !query || candidate.title.toLocaleLowerCase().includes(query) || candidate.task_id.toLocaleLowerCase().includes(query);
  });

  function addMetadata() {
    const available = REQUIREMENT_METADATA_DEFINITIONS.find((definition) => !metadataKeys.includes(definition.key));
    if (available) setMetadataKeys((current) => [...current, available.key]);
  }

  function changeMetadata(index: number, key: RequirementMetadataKey) {
    setMetadataKeys((current) => current.map((item, itemIndex) => itemIndex === index ? key : item));
  }

  function removeMetadata(index: number) {
    setMetadataKeys((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function toggleDependency(taskId: string, selected: boolean) {
    setSelectedDependencyIds((current) => selected
      ? current.includes(taskId) ? current : [...current, taskId]
      : current.filter((item) => item !== taskId));
  }

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
        <label>标题<input name="title" required autoFocus placeholder="例如：项目列表支持按 PIC 筛选"/></label>
        <label>描述（可选）<textarea name="description" rows={4} placeholder="补充背景、目标或验收要求"/></label>
        <div className="fields">
          <label>PIPELINE<select name="pipeline" defaultValue="feature">{REQUIREMENT_PIPELINES.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.label}</option>)}</select></label>
          <label>优先级（9 最高）<select name="priority" defaultValue={DEFAULT_REQUIREMENT_PRIORITY}>{REQUIREMENT_PRIORITY_OPTIONS.map((priority) => <option value={priority.value} key={priority.value}>{priority.label}</option>)}</select></label>
        </div>
        <div className="metadata-editor">
          {metadataKeys.map((key, index) => {
            const definition = REQUIREMENT_METADATA_DEFINITIONS.find((item) => item.key === key)!;
            return <div className="metadata-row" key={`${key}-${index}`}>
              <label>Metadata
                <select name="metadataKey" value={key} onChange={(event) => changeMetadata(index, event.target.value as RequirementMetadataKey)}>
                  {REQUIREMENT_METADATA_DEFINITIONS.map((option) => <option
                    value={option.key}
                    key={option.key}
                    disabled={option.key !== key && metadataKeys.includes(option.key)}
                  >{option.label}</option>)}
                </select>
              </label>
              <label>{definition.label}
                {definition.inputType === 'select'
                  ? <select name="metadataValue" defaultValue="balanced">
                      {definition.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                    </select>
                  : <input name="metadataValue" type={definition.inputType} placeholder={definition.placeholder}/>
                }
              </label>
              <button className="icon-button metadata-remove" type="button" aria-label={`删除${definition.label}`} onClick={() => removeMetadata(index)}><Trash2 size={16}/></button>
            </div>;
          })}
          <button className="metadata-add" type="button" onClick={addMetadata} disabled={metadataKeys.length >= REQUIREMENT_METADATA_DEFINITIONS.length}><Plus size={14}/>添加 metadata</button>
        </div>
        <fieldset className="dependency-picker">
          <legend>前置需求（可选）</legend>
          <small>只有所选需求全部完成后，这个需求才会首次进入调度。</small>
          {selectedDependencyIds.map((taskId) => <input type="hidden" name="dependsOnTaskId" value={taskId} key={taskId}/>)}
          {dependencyCandidates.length > 0 && <input
            className="dependency-search"
            type="search"
            value={dependencyQuery}
            onChange={(event) => setDependencyQuery(event.target.value)}
            placeholder="搜索需求标题或 ID"
            aria-label="搜索前置需求"
          />}
          <div className="dependency-options">
            {visibleDependencyCandidates.map((candidate) => <label className="dependency-option" key={candidate.task_id}>
              <input
                type="checkbox"
                checked={selectedDependencyIds.includes(candidate.task_id)}
                onChange={(event) => toggleDependency(candidate.task_id, event.target.checked)}
              />
              <span>
                <strong>{candidate.title}</strong>
                <small>{candidate.task_id} · 进行中</small>
              </span>
            </label>)}
            {dependencyCandidates.length === 0
              ? <span className="dependency-empty">当前没有可选的前置需求。</span>
              : visibleDependencyCandidates.length === 0
                ? <span className="dependency-empty">没有匹配的需求。</span>
                : null}
          </div>
        </fieldset>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={() => dialogRef.current?.close()}>取消</button>
          <CreateTaskButton/>
        </div>
      </form>
    </dialog>
  </>;
}
