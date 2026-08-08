'use client';

import { useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { REQUIREMENT_PIPELINES } from '../../src/domain/pipeline-catalog';
import { REQUIREMENT_PRIORITY_OPTIONS } from '../../src/domain/requirement-priority';
import { REQUIREMENT_METADATA_DEFINITIONS, type RequirementMetadataKey } from '../../src/domain/requirement-metadata';
import { createTaskAction } from '../actions';

export default function CreateTaskDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [metadataKeys, setMetadataKeys] = useState<RequirementMetadataKey[]>([]);

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
          <label>PIPELINE<select name="pipeline" defaultValue="feature">{REQUIREMENT_PIPELINES.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.label}</option>)}</select></label>
          <label>优先级<select name="priority" defaultValue="P2">{REQUIREMENT_PRIORITY_OPTIONS.map((priority) => <option value={priority.value} key={priority.value}>{priority.label}</option>)}</select></label>
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
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={() => dialogRef.current?.close()}>取消</button>
          <button className="button" type="submit">创建需求</button>
        </div>
      </form>
    </dialog>
  </>;
}
