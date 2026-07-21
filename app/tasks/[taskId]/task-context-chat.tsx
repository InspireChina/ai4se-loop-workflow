'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { Bot, LoaderCircle, Send, ShieldCheck } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaskContextChatMessage, TaskContextChatSession } from '../../../src/application/task-context-chat';
import type { AgentExecutorId } from '../../../src/domain/agent-executor';

export function TaskContextChat({
  taskId,
  initialSession,
  initialMessages,
}: {
  taskId: string;
  initialSession: TaskContextChatSession | null;
  initialMessages: TaskContextChatMessage[];
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [executor, setExecutor] = useState(initialSession?.executor || null);
  const [sending, setSending] = useState(false);
  const [sessionState, setSessionState] = useState(initialSession?.state || 'idle');
  const [error, setError] = useState(initialSession?.lastError || '');
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const busy = sending || sessionState === 'running';

  useEffect(() => {
    if (sending) return;
    setMessages(initialMessages);
    setExecutor(initialSession?.executor || null);
    setSessionState(initialSession?.state || 'idle');
    setError(initialSession?.lastError || '');
  }, [initialMessages, initialSession]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages, sending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    const optimistic: TaskContextChatMessage = {
      messageId: `pending-${Date.now()}`,
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setDraft('');
    setError('');
    setSending(true);
    setSessionState('running');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const body = await response.json() as { message?: TaskContextChatMessage; executor?: AgentExecutorId; error?: string };
      if (!response.ok || !body.message) throw new Error(body.error || '上下文 Agent 未返回回答');
      setMessages((current) => [...current, body.message!]);
      setExecutor(body.executor || executor);
      setSessionState('idle');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSessionState('idle');
    } finally {
      setSending(false);
    }
  }

  return <section className="card task-context-chat">
    <div className="context-chat-head">
      <div>
        <h2><Bot size={16}/>上下文对话</h2>
        <small>当前需求唯一会话{executor ? ` · ${executor}` : ''}</small>
      </div>
      <span className="read-only-chip"><ShieldCheck size={13}/>只读</span>
    </div>
    <div className="context-chat-messages" aria-live="polite">
      {messages.length === 0 && <div className="context-chat-empty">
        <Bot size={22}/>
        <strong>询问当前需求或代码上下文</strong>
        <p>Agent 会重新读取交付文档、活动记录和仓库代码，不会修改 Loop 状态。</p>
      </div>}
      {messages.map((message) => <article className={`context-chat-message ${message.role}`} key={message.messageId}>
        <small>{message.role === 'user' ? '你' : '上下文 Agent'}</small>
        {message.role === 'assistant'
          ? <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
          : <p>{message.content}</p>}
      </article>)}
      {busy && <div className="context-chat-thinking"><LoaderCircle size={14}/>正在读取最新上下文…</div>}
      <div ref={endRef}/>
    </div>
    {error && <p className="context-chat-error">{error}</p>}
    <form className="context-chat-form" onSubmit={submit}>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={busy}
        maxLength={20_000}
        placeholder="例如：为什么这个交付单元还没有进入开发？"
        aria-label="向上下文 Agent 提问"
      />
      <button className="button" type="submit" disabled={busy || !draft.trim()} aria-label="发送">
        <Send size={15}/>
      </button>
    </form>
    <small className="context-chat-note">Enter 发送 · Shift + Enter 换行 · 对话不会直接改变 Loop</small>
  </section>;
}
