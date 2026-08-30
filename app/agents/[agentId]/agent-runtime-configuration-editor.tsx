'use client';

import { FormEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Check, CopyPlus, Play, Save, Trash2 } from 'lucide-react';
import type { AgentRuntimeSettings, GlobalRuntimeConfiguration } from '../../../src/application/project-settings';

type ExecutorOption = { id: GlobalRuntimeConfiguration['executorId']; label: string; description: string };
type ModelOption = { id: string; label: string };
const GLOBAL_DEFAULT = '__global_default__';

export function AgentRuntimeConfigurationEditor(props: {
  agentId: string;
  initialConfigurations: GlobalRuntimeConfiguration[];
  initialEffective: AgentRuntimeSettings;
  flowDefault: GlobalRuntimeConfiguration;
  executorOptions: readonly ExecutorOption[];
  codexModelOptions: readonly ModelOption[];
  reasoningEfforts: readonly string[];
  ompThinkingLevels: readonly string[];
}) {
  const router = useRouter();
  const initialConfiguration = props.initialConfigurations.find((item) => item.active) || null;
  const [configurations, setConfigurations] = useState(props.initialConfigurations);
  const [effective, setEffective] = useState(props.initialEffective);
  const [flowDefault, setFlowDefault] = useState(props.flowDefault);
  const [selectedId, setSelectedId] = useState(
    initialConfiguration?.configurationId || GLOBAL_DEFAULT,
  );
  const [executorId, setExecutorId] = useState(initialConfiguration?.executorId || props.flowDefault.executorId);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sorted = useMemo(() => [...configurations].sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt)), [configurations]);
  const selected = selectedId === GLOBAL_DEFAULT ? null : configurations.find((item) => item.configurationId === selectedId) || null;
  const preview = selected || flowDefault;
  const executor = props.executorOptions.find((option) => option.id === executorId);

  function selectConfiguration(configurationId: string) {
    const configuration = configurations.find((item) => item.configurationId === configurationId);
    setSelectedId(configurationId);
    setExecutorId(configuration?.executorId || flowDefault.executorId);
    setError('');
    setNotice('');
  }

  async function mutate(body: Record<string, unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(props.agentId)}/runtime-configurations`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json() as {
        configurations?: GlobalRuntimeConfiguration[];
        effective?: AgentRuntimeSettings;
        flowDefault?: GlobalRuntimeConfiguration;
        error?: string;
      };
      if (!response.ok || !result.configurations || !result.effective || !result.flowDefault) {
        throw new Error(result.error || 'Runtime 配置操作失败');
      }
      setConfigurations(result.configurations);
      setEffective(result.effective);
      setFlowDefault(result.flowDefault);
      setNotice(success);
      router.refresh();
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally { setBusy(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const result = await mutate({
      action: 'create', name,
      ...(selected ? { fromConfigurationId: selected.configurationId } : {}),
    }, `已保存 Runtime 配置“${name}”。`);
    const created = result?.configurations?.find((item) => item.name === name);
    if (created) {
      setSelectedId(created.configurationId);
      setExecutorId(created.executorId);
    }
    setNewName('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const values = new FormData(event.currentTarget);
    await mutate({
      action: 'save', configurationId: selected.configurationId,
      name: values.get('name'), executorId: values.get('executorId'),
      codexModel: values.get('codexModel'), codexReasoningEffort: values.get('codexReasoningEffort'),
      codexWebSearch: values.get('codexWebSearch') === 'on', claudeModel: values.get('claudeModel'),
      ompModel: values.get('ompModel'), ompThinking: values.get('ompThinking'),
    }, 'Runtime 配置已保存。');
  }

  return <section className="card settings agent-section-card agent-runtime-config-editor">
    <div className="settings-section-head"><span className="executor-icon"><Bot size={18}/></span><div><strong>全局 Agent Runtime</strong><p className="muted settings-description">保存在 LoopWork 安装数据中，不随项目切换。可保存多套配置并立即切换。</p></div><span className={`badge ${effective.source === 'agent_configuration' ? 'green' : 'blue'}`}>{effective.source === 'agent_configuration' ? effective.configurationName : '跟随流程默认'}</span></div>
    <div className="agent-config-toolbar">
      <div className="agent-config-choice-row agent-runtime-config-choice-row"><label>预览配置<select value={selectedId} onChange={(event) => selectConfiguration(event.target.value)}>
          <option value={GLOBAL_DEFAULT}>流程 Agent 默认 · {flowDefault.name}</option>
          {sorted.map((configuration) => <option key={configuration.configurationId} value={configuration.configurationId}>{configuration.name}{configuration.active ? ' · 生效中' : ''}</option>)}
        </select></label><form className="agent-config-inline-create" onSubmit={create}><label>新配置<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="配置名称" maxLength={80}/></label><button className="button secondary" type="submit" disabled={busy || !newName.trim()}><CopyPlus size={14}/>复制</button></form></div>
      <div className="form-actions compact">
        {selected ? !selected.active && <button className="button secondary" type="button" disabled={busy} onClick={() => void mutate({ action: 'activate', configurationId: selected.configurationId }, `已切换到“${selected.name}”。`)}><Play size={14}/>立即启用</button>
          : effective.source !== 'global_default' && <button className="button secondary" type="button" disabled={busy} onClick={() => void mutate({ action: 'inherit' }, '已恢复跟随流程 Agent 默认 Runtime。')}><Play size={14}/>使用默认</button>}
        {selected && !selected.active && <button className="button danger-ghost" type="button" disabled={busy} onClick={() => { if (window.confirm(`删除 Runtime 配置“${selected.name}”？`)) void mutate({ action: 'delete', configurationId: selected.configurationId }, 'Runtime 配置已删除。').then(() => setSelectedId(effective.source === 'agent_configuration' ? effective.configurationId : GLOBAL_DEFAULT)); }}><Trash2 size={14}/>删除</button>}
      </div>
    </div>
    <form className="settings agent-runtime-config-form" key={selected?.configurationId || GLOBAL_DEFAULT} onSubmit={save}>
      {selected && <label>配置名称<input name="name" required maxLength={80} defaultValue={selected.name}/></label>}
      <div className="agent-runtime-workbench">
        <fieldset className="executor-settings agent-runtime-executor-list" disabled={!selected || busy}><legend>执行器</legend><div className="executor-options">
          {props.executorOptions.map((option) => <label className="executor-option" key={option.id}><input type="radio" name="executorId" value={option.id} checked={executorId === option.id} onChange={() => setExecutorId(option.id)}/><span className="executor-icon"><Bot size={18}/></span><span><strong>{option.label}</strong><small>{option.description}</small></span><Check className="executor-check" size={17}/></label>)}
        </div></fieldset>
        <div className="agent-runtime-parameters">
          <header><span>运行参数</span><strong>{executor?.label || executorId}</strong><small>{selected ? '只显示当前执行器会使用的参数。' : '当前为只读预览。'}</small></header>
          {executorId === 'cursor' && <section className="agent-runtime-empty"><span className="executor-icon"><Bot size={20}/></span><div><strong>使用 Cursor CLI 默认参数</strong><p>Cursor 当前没有需要由 LoopWork 额外覆盖的模型或思考参数。</p></div></section>}
          {executorId === 'codex' && <fieldset className="codex-settings" disabled={!selected || busy}><legend>Codex 参数</legend><div className="fields"><label>模型<select name="codexModel" defaultValue={preview.codexModel}>{props.codexModelOptions.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}</select></label><label>思考强度<select name="codexReasoningEffort" defaultValue={preview.codexReasoningEffort}>{props.reasoningEfforts.map((effort) => <option value={effort} key={effort}>{effort === 'default' ? '跟随默认值' : effort}</option>)}</select></label></div><label className="checkbox"><input type="checkbox" name="codexWebSearch" defaultChecked={preview.codexWebSearch}/>启用实时网页搜索</label></fieldset>}
          {executorId === 'claude' && <fieldset className="claude-settings" disabled={!selected || busy}><legend>Claude 参数</legend><div className="fields"><label>模型<input name="claudeModel" defaultValue={preview.claudeModel} placeholder="留空时使用 CLI 默认模型" spellCheck={false}/></label></div></fieldset>}
          {executorId === 'omp' && <fieldset className="omp-settings" disabled={!selected || busy}><legend>Oh My Pi 参数</legend><div className="fields"><label>模型<input name="ompModel" defaultValue={preview.ompModel} placeholder="留空时使用 OMP 默认模型" spellCheck={false}/></label><label>思考强度<select name="ompThinking" defaultValue={preview.ompThinking}>{props.ompThinkingLevels.map((level) => <option value={level} key={level}>{level === 'default' ? '跟随默认值' : level}</option>)}</select></label></div></fieldset>}
          {executorId !== 'codex' && <><input type="hidden" name="codexModel" value={preview.codexModel}/><input type="hidden" name="codexReasoningEffort" value={preview.codexReasoningEffort}/><input type="hidden" name="codexWebSearch" value={preview.codexWebSearch ? 'on' : ''}/></>}
          {executorId !== 'claude' && <input type="hidden" name="claudeModel" value={preview.claudeModel}/>}
          {executorId !== 'omp' && <><input type="hidden" name="ompModel" value={preview.ompModel}/><input type="hidden" name="ompThinking" value={preview.ompThinking}/></>}
        </div>
      </div>
      {selected ? <button className="button" type="submit" disabled={busy}><Save size={14}/>保存配置</button> : <p className="muted">当前预览的是全局流程默认值。复制为新配置后即可修改并单独启用。</p>}
    </form>
    {error && <p className="context-chat-error">{error}</p>}{notice && <p className="agent-config-notice"><Check size={14}/>{notice}</p>}
  </section>;
}
