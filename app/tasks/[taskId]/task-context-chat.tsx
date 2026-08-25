'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, BrainCircuit, CheckCircle2, CircleAlert, LoaderCircle, Send, Terminal, WandSparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaskContextChatMessage, TaskContextChatSession } from '../../../src/application/task-context-chat';
import type { AgentExecutorId } from '../../../src/domain/agent-executor';
import type { TaskContextChatProgressEvent } from '../../../src/infrastructure/task-context-chat-executor';

type ContextChatStreamEvent = {
  type: 'accepted' | 'progress' | 'result' | 'error';
  executor?: AgentExecutorId;
  event?: TaskContextChatProgressEvent;
  message?: TaskContextChatMessage;
  changeRequestSubmitted?: boolean;
  changeRequestCount?: number;
  error?: string;
};

export function TaskContextChat({
  taskId,
  initialSession,
  initialMessages,
}: {
  taskId: string;
  initialSession: TaskContextChatSession | null;
  initialMessages: TaskContextChatMessage[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [executor, setExecutor] = useState(initialSession?.executor || null);
  const [sending, setSending] = useState(false);
  const [sessionState, setSessionState] = useState(initialSession?.state || 'idle');
  const [error, setError] = useState(initialSession?.lastError || '');
  const [progress, setProgress] = useState<Array<TaskContextChatProgressEvent & { id: string }>>([]);
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
    setProgress([]);
    setSending(true);
    setSessionState('running');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok || !response.body) throw new Error('上下文 Agent 无法建立实时连接');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let completed = false;
      const receive = (event: ContextChatStreamEvent) => {
        if (event.type === 'accepted') {
          setExecutor(event.executor || executor);
          return;
        }
        if (event.type === 'progress' && event.event) {
          setProgress((current) => [...current, {
            ...event.event!,
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          }].slice(-80));
          return;
        }
        if (event.type === 'error') throw new Error(event.error || '上下文 Agent 执行失败');
        if (event.type === 'result' && event.message) {
          completed = true;
          setMessages((current) => [...current, event.message!]);
          setExecutor(event.executor || executor);
          setSessionState('idle');
          if (event.changeRequestSubmitted) router.refresh();
        }
      };
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        const lines = pending.split(/\r?\n/);
        pending = chunk.done ? '' : lines.pop() || '';
        for (const line of lines.filter(Boolean)) receive(JSON.parse(line) as ContextChatStreamEvent);
        if (chunk.done) {
          if (pending.trim()) receive(JSON.parse(pending) as ContextChatStreamEvent);
          break;
        }
      }
      if (!completed) throw new Error('上下文 Agent 实时连接结束，但没有返回最终回答');
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
      <span className="read-only-chip"><WandSparkles size={13}/>轻改直达 · 业务变更追加</span>
    </div>
    <div className="context-chat-messages" aria-live="polite">
      {messages.length === 0 && <div className="context-chat-empty">
        <Bot size={22}/>
        <strong>查询上下文，或提出新的修改</strong>
        <p>不影响业务验收的局部 UI、排版和措辞调整可在安全窗口直接修改并验证；业务行为、范围或验收变化仍进入 Feedback 闭环。</p>
      </div>}
      {messages.map((message) => <article className={`context-chat-message ${message.role}`} key={message.messageId}>
        <small>{message.role === 'user' ? '你' : '上下文 Agent'}</small>
        {message.role === 'assistant'
          ? <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
          : <p>{message.content}</p>}
      </article>)}
      {busy && <div className="context-chat-live-progress">
        <div className="context-chat-live-head"><LoaderCircle size={14}/><strong>Agent 正在处理</strong><small>实时进展</small></div>
        {progress.length === 0
          ? <div className="context-chat-progress-placeholder"><BrainCircuit size={14}/>正在读取最新上下文并判断处理路径…</div>
          : <div className="context-chat-progress-list">{progress.map((item) => <div className={`context-chat-progress-item ${item.kind} ${item.status}`} key={item.id}>
            <span>{item.kind === 'thinking'
              ? <BrainCircuit size={13}/>
              : item.status === 'completed'
                ? <CheckCircle2 size={13}/>
                : item.status === 'error'
                  ? <CircleAlert size={13}/>
                  : <Terminal size={13}/>}</span>
            <div><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</div>
          </div>)}</div>}
      </div>}
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
        placeholder="例如：把这个按钮文案改得更清楚"
        aria-label="向上下文 Agent 提问"
      />
      <button className="button" type="submit" disabled={busy || !draft.trim()} aria-label="发送">
        <Send size={15}/>
      </button>
    </form>
    <small className="context-chat-note">Enter 发送 · Shift + Enter 换行 · 轻微调整直接完成，业务变化向前追加</small>
  </section>;
}
