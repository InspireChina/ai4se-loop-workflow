'use client';

import { useEffect, useRef, useState } from 'react';
import type { ParsedRunLog } from '../src/application/run-log';

function eventTime(event: ParsedRunLog) {
  const time = Date.parse(event.timestamp);
  return Number.isFinite(time) ? time : 0;
}

function shouldMergeEvent(previous: ParsedRunLog, next: ParsedRunLog) {
  if (previous.kind !== 'cursor' || next.kind !== 'cursor') return false;
  if (previous.status !== 'info' || next.status !== 'info') return false;
  if (previous.title !== next.title) return false;
  if (previous.title !== 'Agent 思考' && previous.title !== 'Agent 输出') return false;
  if (Object.keys(previous.meta).length > 0 || Object.keys(next.meta).length > 0) return false;
  const previousTime = eventTime(previous);
  const nextTime = eventTime(next);
  if (!previousTime || !nextTime) return false;
  return Math.abs(nextTime - previousTime) <= 1500 && previous.detail.length + next.detail.length <= 1400;
}

function joinDetail(previous: string, next: string) {
  const left = previous.trimEnd();
  const right = next.trimStart();
  if (!left) return right;
  if (!right) return left;
  if (/^[，。；：！？、）)\]}》”’]/.test(right)) return `${left}${right}`;
  if (/[。；：！？.!?]$/.test(left)) return `${left} ${right}`;
  if (/[\u4e00-\u9fff]$/.test(left) && /^[\u4e00-\u9fff]/.test(right)) return `${left}${right}`;
  if (/[\u4e00-\u9fff]$/.test(left) && /^[A-Za-z0-9_./-]/.test(right)) return `${left} ${right}`;
  return `${left} ${right}`;
}

function appendMergedEvents(current: ParsedRunLog[], incoming: ParsedRunLog[]) {
  const next = [...current];
  for (const event of incoming) {
    const previous = next[next.length - 1];
    if (previous && shouldMergeEvent(previous, event)) {
      next[next.length - 1] = {
        ...previous,
        timestamp: event.timestamp || previous.timestamp,
        detail: joinDetail(previous.detail, event.detail),
        raw: `${previous.raw}\n${event.raw}`,
      };
    } else {
      next.push(event);
    }
  }
  return next.slice(-200);
}

export default function LoopLogStream({ leaseId }: { leaseId: string }) {
  const [rawContent, setRawContent] = useState('');
  const [events, setEvents] = useState<ParsedRunLog[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [connected, setConnected] = useState(false);
  const rawRef = useRef<HTMLPreElement>(null);
  const friendlyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRawContent('');
    setEvents([]);
    setConnected(false);
    const source = new EventSource(`/api/loop/logs?leaseId=${encodeURIComponent(leaseId)}`);
    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { raw?: string; events?: ParsedRunLog[] } | string;
      const raw = typeof payload === 'string' ? payload : payload.raw || '';
      const nextEvents = typeof payload === 'string' ? [] : payload.events || [];
      setRawContent((current) => {
        const next = current + raw;
        return next.length > 30000 ? next.slice(-30000) : next;
      });
      setEvents((current) => appendMergedEvents(current, nextEvents));
    };
    source.addEventListener('done', () => {
      setConnected(false);
      source.close();
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [leaseId]);

  useEffect(() => {
    if (showRaw && rawRef.current) rawRef.current.scrollTop = rawRef.current.scrollHeight;
    if (!showRaw && friendlyRef.current) friendlyRef.current.scrollTop = friendlyRef.current.scrollHeight;
  }, [rawContent, showRaw]);

  return <div className="run-log-box">
    <div className="run-log-status">
      <span className={connected ? 'live-dot' : 'live-dot idle'}/>
      <small>{connected ? '实时连接中' : '等待日志'}</small>
      <button type="button" className="text-toggle" onClick={() => setShowRaw((value) => !value)}>{showRaw ? '友好视图' : '原始日志'}</button>
    </div>
    {showRaw ? <pre ref={rawRef}>{rawContent || 'waiting for app log...\n'}</pre> : <div className="friendly-log" ref={friendlyRef}>
      {events.length === 0 ? <p className="friendly-empty">等待 pipeline 进展...</p> : events.map((item, index) => <div className={`friendly-event ${item.kind} ${item.status}`} key={`${item.timestamp}-${index}`}>
        <span className="event-dot"/>
        <div>
          <div className="event-head"><strong>{item.title}</strong><time>{item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : ''}</time></div>
          {Object.keys(item.meta).length > 0 && <small>{[item.meta.agent, item.meta.task, item.meta.pipeline, item.meta.tool].filter(Boolean).join(' · ')}</small>}
          <p>{item.detail}</p>
        </div>
      </div>)}
    </div>}
  </div>;
}
