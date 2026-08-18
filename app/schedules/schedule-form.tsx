'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { REQUIREMENT_PIPELINES } from '../../src/domain/pipeline-catalog';
import { DEFAULT_REQUIREMENT_PRIORITY, REQUIREMENT_PRIORITY_OPTIONS } from '../../src/domain/requirement-priority';
import { REQUIREMENT_METADATA_DEFINITIONS, type RequirementMetadataKey } from '../../src/domain/requirement-metadata';
import type { ScheduledRequirementPlan } from '../../src/application/scheduled-requirements';
import { saveScheduledRequirementAction } from '../actions';

function localDateTimeValue(value: string | null | undefined, timezone: string) {
  if (!value) {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setSeconds(0, 0);
    return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T${String(tomorrow.getHours()).padStart(2, '0')}:${String(tomorrow.getMinutes()).padStart(2, '0')}`;
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function ScheduleForm({
  plan,
  timezones,
  onCancel,
}: {
  plan?: ScheduledRequirementPlan;
  timezones: string[];
  onCancel?: () => void;
}) {
  const initialMetadata = useMemo(() => {
    try {
      return JSON.parse(plan?.template_metadata_json || '[]') as Array<{ key: RequirementMetadataKey; value: string }>;
    } catch {
      return [];
    }
  }, [plan]);
  const [recurrence, setRecurrence] = useState(plan?.recurrence_kind || 'weekdays');
  const [timezone, setTimezone] = useState(plan?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [metadata, setMetadata] = useState(initialMetadata);

  function addMetadata() {
    const available = REQUIREMENT_METADATA_DEFINITIONS.find((definition) => !metadata.some((item) => item.key === definition.key));
    if (available) setMetadata((current) => [...current, { key: available.key, value: available.inputType === 'select' ? 'balanced' : '' }]);
  }

  function changeMetadata(index: number, key: RequirementMetadataKey) {
    const definition = REQUIREMENT_METADATA_DEFINITIONS.find((item) => item.key === key)!;
    setMetadata((current) => current.map((item, itemIndex) => itemIndex === index
      ? { key, value: definition.inputType === 'select' ? 'balanced' : '' }
      : item));
  }

  return <form action={saveScheduledRequirementAction} className="form-panel schedule-form">
    {plan && <input type="hidden" name="planId" value={plan.plan_id}/>}
    <div className="fields schedule-fields">
      <label>计划类型
        <select name="recurrenceKind" value={recurrence} onChange={(event) => setRecurrence(event.target.value as typeof recurrence)}>
          <option value="once">单次</option>
          <option value="daily">每天</option>
          <option value="weekdays">每个工作日</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
        </select>
      </label>
      <label>时区
        <select name="timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
          {timezones.map((item) => <option value={item} key={item}>{item}</option>)}
        </select>
      </label>
      {recurrence === 'once'
        ? <label>执行时间<input type="datetime-local" name="onceAtLocal" required defaultValue={localDateTimeValue(plan?.once_at, timezone)}/></label>
        : <label>执行时间<input type="time" name="localTime" required defaultValue={plan?.local_time || '09:30'}/></label>}
      {recurrence === 'weekly' && <label>星期
        <select name="weekday" defaultValue={String(plan?.weekday ?? 1)}>
          <option value="1">星期一</option><option value="2">星期二</option><option value="3">星期三</option>
          <option value="4">星期四</option><option value="5">星期五</option><option value="6">星期六</option><option value="0">星期日</option>
        </select>
      </label>}
      {recurrence === 'monthly' && <label>每月日期<input name="dayOfMonth" type="number" min="1" max="31" required defaultValue={plan?.day_of_month || 1}/></label>}
    </div>
    <label>需求标题<input name="title" required maxLength={300} defaultValue={plan?.template_title || ''} placeholder="例如：整理本周客户反馈"/></label>
    <label>需求描述（可选）<textarea name="description" rows={4} defaultValue={plan?.template_description || ''} placeholder="每次创建的新需求都会使用这里的描述"/></label>
    <div className="fields">
      <label>PIPELINE<select name="pipeline" defaultValue={plan?.template_pipeline || 'feature'}>{REQUIREMENT_PIPELINES.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.label}</option>)}</select></label>
      <label>优先级（9 最高）<select name="priority" defaultValue={plan?.template_priority || DEFAULT_REQUIREMENT_PRIORITY}>{REQUIREMENT_PRIORITY_OPTIONS.map((priority) => <option value={priority.value} key={priority.value}>{priority.label}</option>)}</select></label>
    </div>
    <div className="metadata-editor">
      {metadata.map((item, index) => {
        const definition = REQUIREMENT_METADATA_DEFINITIONS.find((candidate) => candidate.key === item.key)!;
        return <div className="metadata-row" key={`${item.key}-${index}`}>
          <label>Metadata
            <select name="metadataKey" value={item.key} onChange={(event) => changeMetadata(index, event.target.value as RequirementMetadataKey)}>
              {REQUIREMENT_METADATA_DEFINITIONS.map((option) => <option value={option.key} key={option.key} disabled={option.key !== item.key && metadata.some((candidate) => candidate.key === option.key)}>{option.label}</option>)}
            </select>
          </label>
          <label>{definition.label}
            {definition.inputType === 'select'
              ? <select name="metadataValue" value={item.value} onChange={(event) => setMetadata((current) => current.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, value: event.target.value } : candidate))}>{definition.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
              : <input name="metadataValue" type={definition.inputType} value={item.value} placeholder={definition.placeholder} onChange={(event) => setMetadata((current) => current.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, value: event.target.value } : candidate))}/>}
          </label>
          <button type="button" className="icon-button metadata-remove" aria-label={`删除${definition.label}`} onClick={() => setMetadata((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16}/></button>
        </div>;
      })}
      <button className="metadata-add" type="button" onClick={addMetadata} disabled={metadata.length >= REQUIREMENT_METADATA_DEFINITIONS.length}><Plus size={14}/>添加 metadata</button>
    </div>
    <div className="dialog-actions">
      {onCancel && <button className="button secondary" type="button" onClick={onCancel}>取消</button>}
      <button className="button" type="submit">{plan ? '保存计划' : '创建计划'}</button>
    </div>
  </form>;
}
