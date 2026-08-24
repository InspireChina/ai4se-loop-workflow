'use client';

import { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { RequirementDependencyCandidate } from '../../src/application/task-dependencies';
import { REQUIREMENT_METADATA_DEFINITIONS, type RequirementMetadataKey } from '../../src/domain/requirement-metadata';
import { REQUIREMENT_PIPELINES, type RequirementPipelineId } from '../../src/domain/pipeline-catalog';
import { DEFAULT_REQUIREMENT_PRIORITY, REQUIREMENT_PRIORITY_OPTIONS } from '../../src/domain/requirement-priority';

type MetadataEntry = {
  id: string;
  key: RequirementMetadataKey;
  value: string;
};

type RequirementInputFieldsProps = {
  dependencyCandidates: RequirementDependencyCandidate[];
  excludedTaskId?: string;
  initial?: {
    title?: string;
    description?: string;
    pipeline?: RequirementPipelineId;
    priority?: string;
    metadata?: { key: RequirementMetadataKey; value: string }[];
    dependencyIds?: string[];
  };
  autoFocus?: boolean;
};

function defaultMetadataValue(key: RequirementMetadataKey) {
  const definition = REQUIREMENT_METADATA_DEFINITIONS.find((item) => item.key === key)!;
  return definition.inputType === 'select' ? 'balanced' : '';
}

export function RequirementInputFields({ dependencyCandidates, excludedTaskId, initial, autoFocus = false }: RequirementInputFieldsProps) {
  const nextMetadataId = useRef(initial?.metadata?.length || 0);
  const [metadata, setMetadata] = useState<MetadataEntry[]>(() => (initial?.metadata || []).map((item, index) => ({
    id: `initial-${index}`,
    key: item.key,
    value: item.value,
  })));
  const [dependencyQuery, setDependencyQuery] = useState('');
  const [selectedDependencyIds, setSelectedDependencyIds] = useState<string[]>(initial?.dependencyIds || []);
  const candidates = dependencyCandidates.filter((candidate) => candidate.task_id !== excludedTaskId);
  const visibleDependencyCandidates = candidates.filter((candidate) => {
    const query = dependencyQuery.trim().toLocaleLowerCase();
    return !query || candidate.title.toLocaleLowerCase().includes(query) || candidate.task_id.toLocaleLowerCase().includes(query);
  });

  function addMetadata() {
    const available = REQUIREMENT_METADATA_DEFINITIONS.find((definition) => !metadata.some((item) => item.key === definition.key));
    if (!available) return;
    const id = `added-${nextMetadataId.current++}`;
    setMetadata((current) => [...current, { id, key: available.key, value: defaultMetadataValue(available.key) }]);
  }

  function changeMetadata(id: string, key: RequirementMetadataKey) {
    setMetadata((current) => current.map((item) => item.id === id
      ? { ...item, key, value: defaultMetadataValue(key) }
      : item));
  }

  function toggleDependency(taskId: string, selected: boolean) {
    setSelectedDependencyIds((current) => selected
      ? current.includes(taskId) ? current : [...current, taskId]
      : current.filter((item) => item !== taskId));
  }

  return <>
    <label>标题<input name="title" required autoFocus={autoFocus} defaultValue={initial?.title} placeholder="例如：项目列表支持按 PIC 筛选"/></label>
    <label>描述（可选）<textarea name="description" rows={4} defaultValue={initial?.description} placeholder="补充背景、目标或验收要求"/></label>
    <div className="fields">
      <label>PIPELINE<select name="pipeline" defaultValue={initial?.pipeline || 'feature'}>{REQUIREMENT_PIPELINES.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.label}</option>)}</select></label>
      <label>优先级（9 最高）<select name="priority" defaultValue={initial?.priority || DEFAULT_REQUIREMENT_PRIORITY}>{REQUIREMENT_PRIORITY_OPTIONS.map((priority) => <option value={priority.value} key={priority.value}>{priority.label}</option>)}</select></label>
    </div>
    <div className="metadata-editor">
      {metadata.map((item) => {
        const definition = REQUIREMENT_METADATA_DEFINITIONS.find((candidate) => candidate.key === item.key)!;
        return <div className="metadata-row" key={item.id}>
          <label>Metadata
            <select name="metadataKey" value={item.key} onChange={(event) => changeMetadata(item.id, event.target.value as RequirementMetadataKey)}>
              {REQUIREMENT_METADATA_DEFINITIONS.map((option) => <option
                value={option.key}
                key={option.key}
                disabled={option.key !== item.key && metadata.some((candidate) => candidate.key === option.key)}
              >{option.label}</option>)}
            </select>
          </label>
          <label>{definition.label}
            {definition.inputType === 'select'
              ? <select name="metadataValue" value={item.value} onChange={(event) => setMetadata((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, value: event.target.value } : candidate))}>
                  {definition.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
                </select>
              : <input name="metadataValue" type={definition.inputType} value={item.value} onChange={(event) => setMetadata((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, value: event.target.value } : candidate))} placeholder={definition.placeholder}/>
            }
          </label>
          <button className="icon-button metadata-remove" type="button" aria-label={`删除${definition.label}`} onClick={() => setMetadata((current) => current.filter((candidate) => candidate.id !== item.id))}><Trash2 size={16}/></button>
        </div>;
      })}
      <button className="metadata-add" type="button" onClick={addMetadata} disabled={metadata.length >= REQUIREMENT_METADATA_DEFINITIONS.length}><Plus size={14}/>添加 metadata</button>
    </div>
    <fieldset className="dependency-picker">
      <legend>前置需求（可选）</legend>
      <small>只有所选需求全部完成后，这个需求才会首次进入调度。</small>
      {selectedDependencyIds.map((taskId) => <input type="hidden" name="dependsOnTaskId" value={taskId} key={taskId}/>)}
      {candidates.length > 0 && <input
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
        {candidates.length === 0
          ? <span className="dependency-empty">当前没有可选的前置需求。</span>
          : visibleDependencyCandidates.length === 0
            ? <span className="dependency-empty">没有匹配的需求。</span>
            : null}
      </div>
    </fieldset>
  </>;
}
