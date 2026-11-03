'use client';

import { FormEvent, Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, BrainCircuit, Check, CheckCircle2, CircleAlert, LoaderCircle, MessageSquareText, Download, RefreshCw, Save, Send, Terminal, Workflow } from 'lucide-react';
import type { AgentCommandFile } from '../../../src/application/agent-configurations';

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
  content?: string;
  explanation?: string;
  error?: string;
};

function ConfigurationChatProgress({ busy, items }: {
  busy: boolean;
  items: Array<ConfigurationChatProgressEvent & { id: string }>;
}) {
  if (!busy && items.length === 0) return null;
  return <div className="context-chat-live-progress">
    <div className={`context-chat-live-head ${busy ? '' : 'completed'}`}>{busy ? <LoaderCircle size={14}/> : <CheckCircle2 size={14}/>}<strong>{busy ? '系统辅助 Agent 正在处理' : '本轮处理完成'}</strong><small>脚本事件</small></div>
    {items.length === 0
      ? <div className="context-chat-progress-placeholder"><BrainCircuit size={14}/>正在分析脚本源码 与修改要求…</div>
      : <div className="context-chat-progress-list">{items.map((item) => <div className={`context-chat-progress-item ${item.kind} ${item.status}`} key={item.id}>
        <span>{item.kind === 'thinking' ? <BrainCircuit size={13}/> : item.status === 'completed' ? <CheckCircle2 size={13}/> : item.status === 'error' ? <CircleAlert size={13}/> : <Terminal size={13}/>}</span>
        <div><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</div>
      </div>)}</div>}
  </div>;
}

export function AgentConfigurationEditor({ agentId, source }: { agentId: string; source: AgentCommandFile }) {
  const router = useRouter();
  const [current, setCurrent] = useState(source);
  useEffect(() => { setCurrent(source); }, [source]);
  const [selectedPath, setSelectedPath] = useState(source.files[0]?.relativePath || '');
  const selectedFile = current.files.find(file => file.relativePath === selectedPath) || current.files[0];
  const documentKey = selectedFile?.relativePath || '';
  const [draftByDocument, setDraftByDocument] = useState<Record<string, string>>({});
  const [draftBaseHashes, setDraftBaseHashes] = useState<Record<string, string>>({});
  const content = draftByDocument[documentKey] ?? selectedFile?.content ?? '';
  const dirty = Boolean(selectedFile && content !== selectedFile.content);
  const [mode, setMode] = useState<'code' | 'chat'>('code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatProgress, setChatProgress] = useState<Array<ConfigurationChatProgressEvent & { id: string }>>([]);
  const progressAfterMessage = chatMessages.at(-1)?.role === 'assistant' ? chatMessages.length - 2 : chatMessages.length - 1;

  async function operate(action: 'validate' | 'save') {
    if (!selectedFile) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/configurations`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, relativePath: selectedFile.relativePath, content, expectedHash: draftBaseHashes[documentKey] ?? selectedFile.hash }),
      });
      const result = await response.json() as { source?: AgentCommandFile; valid?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || '脚本操作失败');
      if (result.source) {
        setCurrent(result.source);
        setDraftByDocument(current => { const next = { ...current }; delete next[documentKey]; return next; });
        setDraftBaseHashes(current => { const next = { ...current }; delete next[documentKey]; return next; });
        router.refresh();
      }
      setNotice(action === 'save' ? '已保存到工作目录源文件；接口和阶段在重新加载时校验。' : 'JavaScript 语法检查通过；检查过程不会运行草稿。');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  function download() {
    if (!selectedFile) return;
    const url = URL.createObjectURL(new Blob([content], { type: 'application/javascript;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = selectedFile.relativePath.split('/').at(-1)!; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function chat(event: FormEvent) {
    event.preventDefault();
    const message = chatDraft.trim();
    if (!message || !selectedFile || busy) return;
    const userMessage: ChatMessage = { role: 'user', content: message };
    setChatMessages((current) => [...current, userMessage]);
    setChatDraft(''); setChatProgress([]); setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/configuration-chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relativePath: selectedFile.relativePath, content, message, history: chatMessages }),
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
        if (streamEvent.type === 'result' && streamEvent.content) {
          completed = true;
          setDraftByDocument((current) => ({ ...current, [documentKey]: streamEvent.content! }));
          setDraftBaseHashes(current => ({ ...current, [documentKey]: current[documentKey] ?? selectedFile.hash }));
          setChatMessages((current) => [...current, { role: 'assistant', content: streamEvent.explanation || '已生成脚本草稿。' }]);
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
      if (!completed) throw new Error('系统辅助 Agent 实时连接结束，但没有返回有效脚本');
      setNotice('系统辅助 Agent 已生成一份通过语法检查的脚本草稿；保存到外部源文件后生效。');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }


  return <section className="card settings agent-section-card agent-configuration-editor">
    <div className="settings-section-head"><span className="executor-icon"><Workflow size={18}/></span><div><strong>命令链原始脚本</strong><p className="muted settings-description">从工作目录 .omp/commands 加载 Agent 入口和共享实现。可直接修改执行、校验与结果组装源码，Workflow 通过版本化接口调度。</p></div><span className="badge">JavaScript · API v1</span></div>
    <div className="agent-config-toolbar">
      {current.files.length > 0 && <label>源码文件<select aria-label="源码文件" value={selectedFile?.relativePath} onChange={event => { setSelectedPath(event.target.value); setChatMessages([]); setChatProgress([]); setNotice(''); setError(''); }}>{current.files.map(file => <option key={file.relativePath} value={file.relativePath}>{file.relativePath}</option>)}</select></label>}
      <button className="button secondary" type="button" disabled={busy} onClick={() => { setDraftByDocument({}); setDraftBaseHashes({}); setChatMessages([]); setChatProgress([]); setError(''); setNotice(''); router.refresh(); }}><RefreshCw size={14}/>重新加载源码</button>
    </div>
    <p className="path-value"><code>{selectedFile?.path || current.path}</code></p>
    {current.error && <p className="agent-config-validation-error"><CircleAlert size={15}/><span><strong>当前磁盘脚本无法加载</strong>{current.error}</span></p>}
    {selectedFile && <>
      <div className="agent-config-mode-tabs" role="tablist"><button type="button" className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Terminal size={14}/>原始源码</button><button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}><MessageSquareText size={14}/>Chat 辅助</button></div>
      {mode === 'code' ? <textarea aria-label="命令脚本源码" className="code-editor agent-config-source" value={content} onChange={event => { setDraftByDocument(current => ({ ...current, [documentKey]: event.target.value })); setDraftBaseHashes(current => ({ ...current, [documentKey]: current[documentKey] ?? selectedFile.hash })); }} spellCheck={false}/> : <div className="agent-config-chat">
        <div className="agent-config-chat-messages">{chatMessages.length ? chatMessages.map((message, index) => <Fragment key={`${message.role}-${index}`}><article className={`context-chat-message ${message.role}`}><small>{message.role === 'user' ? '你' : '系统辅助 Agent'}</small><p>{message.content}</p></article>{index === progressAfterMessage && <ConfigurationChatProgress busy={busy} items={chatProgress}/>}</Fragment>) : <div className="context-chat-empty"><Bot size={20}/><strong>辅助修改原始脚本</strong><p>生成完整源码草稿，保存后才写入当前外部文件。</p></div>}</div>
        <form className="context-chat-form" onSubmit={chat}><textarea value={chatDraft} onChange={event => setChatDraft(event.target.value)} disabled={busy} placeholder="描述希望调整的执行步骤或校验逻辑" maxLength={20_000}/><button className="button" type="submit" disabled={busy || !chatDraft.trim()}><Send size={15}/></button></form>
      </div>}
      <p className="muted">入口接口：apiVersion、agent、describe、initialize、execute、validate、result、restore、help。Direct 使用 executeDirect。修改共享实现会作用于引用它的 Agent；保存使用文件版本校验防止覆盖其他编辑。</p>
      <div className="agent-config-savebar"><span>{selectedFile.hash.slice(0, 12)}{dirty ? ' · 未保存' : ''}</span><div className="form-actions compact"><button className="button secondary" disabled={busy} onClick={() => void operate('validate')}>检查语法</button><button className="button secondary" disabled={busy} onClick={download}><Download size={14}/>下载源码</button><button className="button" disabled={busy || !dirty} onClick={() => void operate('save')}><Save size={14}/>保存脚本</button></div></div>
    </>}
    {error && <p className="context-chat-error">{error}</p>}
    {notice && <p className="agent-config-notice"><Check size={14}/>{notice}</p>}
  </section>;
}
