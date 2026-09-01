'use client';

import { FormEvent, Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, BrainCircuit, Check, CheckCircle2, CircleAlert, CopyPlus, LoaderCircle, MessageSquareText, Play, Save, Send, Terminal, Trash2, Workflow } from 'lucide-react';
import type { AgentConfigurationSet } from '../../../src/application/agent-configurations';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type ConfigurationChatProgressEvent = {
  kind: 'thinking' | 'tool' | 'status';
  label: string;
  detail?: string;
  status: 'running' | 'completed' | 'error';
};
type ConfigurationChatStreamEvent = {
  type: 'accepted' | 'progress' | 'result' | 'error';
  event?: ConfigurationChatProgressEvent;
  yaml?: string;
  explanation?: string;
  error?: string;
};

function ConfigurationChatProgress({ busy, items }: {
  busy: boolean;
  items: Array<ConfigurationChatProgressEvent & { id: string }>;
}) {
  if (!busy && items.length === 0) return null;
  return <div className="context-chat-live-progress">
    <div className={`context-chat-live-head ${busy ? '' : 'completed'}`}>{busy ? <LoaderCircle size={14}/> : <CheckCircle2 size={14}/>}<strong>{busy ? '系统辅助 Agent 正在处理' : '本轮处理完成'}</strong><small>配置事件</small></div>
    {items.length === 0
      ? <div className="context-chat-progress-placeholder"><BrainCircuit size={14}/>正在分析当前 YAML 与修改要求…</div>
      : <div className="context-chat-progress-list">{items.map((item) => <div className={`context-chat-progress-item ${item.kind} ${item.status}`} key={item.id}>
        <span>{item.kind === 'thinking' ? <BrainCircuit size={13}/> : item.status === 'completed' ? <CheckCircle2 size={13}/> : item.status === 'error' ? <CircleAlert size={13}/> : <Terminal size={13}/>}</span>
        <div><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</div>
      </div>)}</div>}
  </div>;
}

export function AgentConfigurationEditor({ agentId, initialConfigurations }: {
  agentId: string;
  initialConfigurations: AgentConfigurationSet[];
}) {
  const router = useRouter();
  const [configurations, setConfigurations] = useState(initialConfigurations);
  const [configurationId, setConfigurationId] = useState(initialConfigurations.find((item) => item.active)?.configurationId || initialConfigurations[0]?.configurationId || '');
  const selectedConfiguration = configurations.find((item) => item.configurationId === configurationId) || configurations[0];
  const [commandChainId, setCommandChainId] = useState(selectedConfiguration?.documents[0]?.commandChainId || '');
  const selectedDocument = selectedConfiguration?.documents.find((item) => item.commandChainId === commandChainId) || selectedConfiguration?.documents[0];
  const [draftByDocument, setDraftByDocument] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'yaml' | 'chat'>('yaml');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newName, setNewName] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatProgress, setChatProgress] = useState<Array<ConfigurationChatProgressEvent & { id: string }>>([]);
  const documentKey = selectedConfiguration && selectedDocument ? `${selectedConfiguration.configurationId}:${selectedDocument.commandChainId}` : '';
  const yaml = documentKey ? draftByDocument[documentKey] ?? selectedDocument?.yaml ?? '' : '';
  const dirty = Boolean(selectedDocument && yaml !== selectedDocument.yaml);
  const sortedConfigurations = useMemo(() => [...configurations].sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt)), [configurations]);
  const configurationLabel = (configuration: AgentConfigurationSet) => `${configuration.name}${configuration.builtinKey ? ' · 预置' : ''}${configuration.active ? ' · 生效中' : ''}`;
  const progressAfterMessage = chatMessages.at(-1)?.role === 'assistant' ? chatMessages.length - 2 : chatMessages.length - 1;

  async function mutate(body: Record<string, unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/configurations`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json() as { configurations?: AgentConfigurationSet[]; error?: string };
      if (!response.ok || !result.configurations) throw new Error(result.error || '配置操作失败');
      setConfigurations(result.configurations);
      setNotice(success);
      router.refresh();
      return result.configurations;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally { setBusy(false); }
  }

  function selectConfiguration(nextId: string) {
    const next = configurations.find((item) => item.configurationId === nextId);
    setConfigurationId(nextId);
    setCommandChainId(next?.documents[0]?.commandChainId || '');
    setChatMessages([]); setChatProgress([]); setError(''); setNotice('');
  }

  async function createConfiguration(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name || !selectedConfiguration) return;
    const next = await mutate({ action: 'create', name, fromConfigurationId: selectedConfiguration.configurationId }, `已创建“${name}”。`);
    const created = next?.find((item) => item.name === name);
    if (created) {
      setConfigurationId(created.configurationId);
      setCommandChainId(created.documents[0]?.commandChainId || '');
      setChatMessages([]);
      setChatProgress([]);
    }
    setNewName('');
  }

  async function save() {
    if (!selectedConfiguration || !selectedDocument) return;
    const next = await mutate({
      action: 'save', configurationId: selectedConfiguration.configurationId,
      commandChainId: selectedDocument.commandChainId, yaml,
    }, 'YAML 已通过 Harness 校验并保存。');
    if (next) setDraftByDocument((current) => { const copy = { ...current }; delete copy[documentKey]; return copy; });
  }

  async function chat(event: FormEvent) {
    event.preventDefault();
    const message = chatDraft.trim();
    if (!message || !selectedDocument || busy) return;
    const userMessage: ChatMessage = { role: 'user', content: message };
    setChatMessages((current) => [...current, userMessage]);
    setChatDraft(''); setChatProgress([]); setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/configuration-chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandChainId: selectedDocument.commandChainId, yaml, message, history: chatMessages }),
      });
      if (!response.ok || !response.body) throw new Error('系统辅助 Agent 无法建立实时连接');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let completed = false;
      const receive = (streamEvent: ConfigurationChatStreamEvent) => {
        if (streamEvent.type === 'progress' && streamEvent.event) {
          setChatProgress((current) => [...current, {
            ...streamEvent.event!,
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          }].slice(-80));
          return;
        }
        if (streamEvent.type === 'error') throw new Error(streamEvent.error || '系统辅助 Agent 执行失败');
        if (streamEvent.type === 'result' && streamEvent.yaml) {
          completed = true;
          setDraftByDocument((current) => ({ ...current, [documentKey]: streamEvent.yaml! }));
          setChatMessages((current) => [...current, { role: 'assistant', content: streamEvent.explanation || '已更新 YAML。' }]);
        }
      };
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        const lines = pending.split(/\r?\n/);
        pending = chunk.done ? '' : lines.pop() || '';
        for (const line of lines.filter(Boolean)) receive(JSON.parse(line) as ConfigurationChatStreamEvent);
        if (chunk.done) {
          if (pending.trim()) receive(JSON.parse(pending) as ConfigurationChatStreamEvent);
          break;
        }
      }
      if (!completed) throw new Error('系统辅助 Agent 实时连接结束，但没有返回有效 YAML');
      setNotice('系统辅助 Agent 已生成一份通过 Harness 校验的草稿；检查后点击保存才会写入配置。');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  if (!selectedConfiguration) return <section className="card settings agent-section-card"><strong>Agent 配置尚未初始化</strong></section>;
  if (!selectedDocument) return <section className="card settings agent-section-card agent-configuration-editor">
    <div className="settings-section-head"><span className="executor-icon"><Workflow size={18}/></span><div><strong>Agent 行为配置</strong><p className="muted settings-description">配置保存在 LoopWork 安装数据中，并且只对当前 Agent 生效；该 Agent 尚未迁移到 YAML 命令链。</p></div><span className={`badge ${selectedConfiguration.active ? 'green' : 'blue'}`}>{selectedConfiguration.active ? '当前生效' : '未启用'}</span></div>
    <div className="agent-config-toolbar"><div className="agent-config-choice-row"><label>配置集<select value={selectedConfiguration.configurationId} onChange={(event) => selectConfiguration(event.target.value)}>{sortedConfigurations.map((configuration) => <option value={configuration.configurationId} key={configuration.configurationId}>{configurationLabel(configuration)}</option>)}</select></label><form className="agent-config-inline-create" onSubmit={createConfiguration}><label>新配置<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="配置名称" maxLength={80}/></label><button className="button secondary" type="submit" disabled={busy || !newName.trim()}><CopyPlus size={14}/>复制</button></form></div><div className="form-actions compact">{!selectedConfiguration.active && <button className="button secondary" type="button" disabled={busy} onClick={() => void mutate({ action: 'activate', configurationId: selectedConfiguration.configurationId }, `当前 Agent 已切换到“${selectedConfiguration.name}”。`)}><Play size={14}/>启用</button>}{!selectedConfiguration.active && !selectedConfiguration.builtinKey && configurations.length > 1 && <button className="button danger-ghost" type="button" disabled={busy} onClick={() => { if (window.confirm(`删除配置“${selectedConfiguration.name}”？`)) void mutate({ action: 'delete', configurationId: selectedConfiguration.configurationId }, '配置已删除。'); }}><Trash2 size={14}/>删除</button>}</div></div>
    <p className="muted">可在 Prompt 页面编辑当前配置的 Prompt。切换后，当前 Agent 的新 execution 会使用对应 Prompt。</p>
    {error && <p className="context-chat-error">{error}</p>}{notice && <p className="agent-config-notice"><Check size={14}/>{notice}</p>}
  </section>;

  return <section className="card settings agent-section-card agent-configuration-editor">
    <div className="settings-section-head"><span className="executor-icon"><Workflow size={18}/></span><div><strong>Agent 行为配置</strong><p className="muted settings-description">每个 Agent 独立选择配置集；配置保存在 LoopWork 安装数据中，不随当前项目切换。</p></div><span className={`badge ${selectedConfiguration.active ? 'green' : 'blue'}`}>{selectedConfiguration.active ? '当前生效' : '未启用'}</span></div>
    <div className="agent-config-toolbar">
      <div className="agent-config-choice-row"><label>配置集<select value={selectedConfiguration.configurationId} onChange={(event) => selectConfiguration(event.target.value)}>{sortedConfigurations.map((configuration) => <option value={configuration.configurationId} key={configuration.configurationId}>{configurationLabel(configuration)}</option>)}</select></label><form className="agent-config-inline-create" onSubmit={createConfiguration}><label>新配置<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="配置名称" maxLength={80}/></label><button className="button secondary" type="submit" disabled={busy || !newName.trim()}><CopyPlus size={14}/>复制</button></form></div>
      {selectedConfiguration.documents.length > 1 && <label>命令链<select value={selectedDocument.commandChainId} onChange={(event) => { setCommandChainId(event.target.value); setChatMessages([]); setChatProgress([]); }}>{selectedConfiguration.documents.map((document) => <option value={document.commandChainId} key={document.commandChainId}>{document.label}</option>)}</select></label>}
      <div className="form-actions compact">
        {!selectedConfiguration.active && <button className="button secondary" type="button" disabled={busy || dirty} onClick={() => void mutate({ action: 'activate', configurationId: selectedConfiguration.configurationId }, `当前 Agent 已切换到“${selectedConfiguration.name}”。`)}><Play size={14}/>启用</button>}
        {!selectedConfiguration.active && !selectedConfiguration.builtinKey && configurations.length > 1 && <button className="button danger-ghost" type="button" disabled={busy} onClick={() => { if (window.confirm(`删除配置“${selectedConfiguration.name}”？`)) void mutate({ action: 'delete', configurationId: selectedConfiguration.configurationId }, '配置已删除。'); }}><Trash2 size={14}/>删除</button>}
      </div>
    </div>
    <div className="agent-config-mode-tabs" role="tablist"><button type="button" className={mode === 'yaml' ? 'active' : ''} onClick={() => setMode('yaml')}><Workflow size={14}/>原始 YAML</button><button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><MessageSquareText size={14}/>Chat 编辑</button></div>
    {selectedDocument.validationError && !dirty && <p className="agent-config-validation-error"><CircleAlert size={15}/><span><strong>当前 YAML 已失效</strong>{selectedDocument.validationError}</span></p>}
    {mode === 'yaml' ? <textarea className="code-editor agent-config-yaml" value={yaml} onChange={(event) => setDraftByDocument((current) => ({ ...current, [documentKey]: event.target.value }))} spellCheck={false}/> : <div className="agent-config-chat">
      <div className="agent-config-chat-messages">{chatMessages.length ? chatMessages.map((message, index) => <Fragment key={`${message.role}-${index}`}><article className={`context-chat-message ${message.role}`}><small>{message.role === 'user' ? '你' : '系统辅助 Agent'}</small><p>{message.content}</p></article>{index === progressAfterMessage && <ConfigurationChatProgress busy={busy} items={chatProgress}/>}</Fragment>) : <div className="context-chat-empty"><Bot size={20}/><strong>用自然语言调整命令链</strong><p>系统辅助 Agent 已预置当前 YAML 格式、允许字段、内置 Phase 和 Harness 校验规则。它只生成草稿，不会自动保存。</p></div>}</div>
      <form className="context-chat-form" onSubmit={chat}><textarea value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} disabled={busy} placeholder="例如：在影响扫描之后增加一个确认阶段，提醒 Agent 检查范围是否完整" maxLength={20_000}/><button className="button" type="submit" disabled={busy || !chatDraft.trim()}><Send size={15}/></button></form>
    </div>}
    {error && <p className="context-chat-error">{error}</p>}
    {notice && <p className="agent-config-notice"><Check size={14}/>{notice}</p>}
    <div className="agent-config-savebar"><span><code>{selectedDocument.commandChainId}</code> · r{selectedDocument.revision}{dirty ? ' · 有未保存修改' : ''}</span><button className="button" type="button" disabled={busy || !dirty} onClick={() => void save()}><Save size={14}/>校验并保存</button></div>
  </section>;
}
