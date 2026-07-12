'use client';

import { useEffect, useRef, useState } from 'react';

export default function LoopLogStream({ leaseId }: { leaseId: string }) {
  const [content, setContent] = useState('');
  const [connected, setConnected] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setContent('');
    setConnected(false);
    const source = new EventSource(`/api/loop/logs?leaseId=${encodeURIComponent(leaseId)}`);
    source.onopen = () => setConnected(true);
    source.onmessage = (event) => {
      const chunk = JSON.parse(event.data) as string;
      setContent((current) => {
        const next = current + chunk;
        return next.length > 30000 ? next.slice(-30000) : next;
      });
    };
    source.addEventListener('done', () => {
      setConnected(false);
      source.close();
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [leaseId]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [content]);

  return <div className="run-log-box">
    <div className="run-log-status">
      <span className={connected ? 'live-dot' : 'live-dot idle'}/>
      <small>{connected ? '实时连接中' : '等待日志'}</small>
    </div>
    <pre ref={preRef}>{content || 'waiting for app log...\n'}</pre>
  </div>;
}
