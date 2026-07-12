'use client';

import { useEffect, useState } from 'react';
import type { ParsedRunLog } from '../src/application/run-log';

type LogTreeNode = {
  id: string;
  title: string;
  detail: string;
  status: ParsedRunLog['status'];
  kind: ParsedRunLog['kind'] | 'group';
  timestamp: string;
  meta: Record<string, string>;
  children: LogTreeNode[];
};

function shouldMergeEvent(previous: ParsedRunLog, next: ParsedRunLog) {
  if (previous.kind !== 'cursor' || next.kind !== 'cursor') return false;
  if (previous.status !== 'info' || next.status !== 'info') return false;
  if (previous.title !== next.title) return false;
  if (previous.title !== 'Agent 思考' && previous.title !== 'Agent 输出') return false;
  if (Object.keys(previous.meta).length > 0 || Object.keys(next.meta).length > 0) return false;
  return previous.detail.length + next.detail.length <= 5000;
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

function makeNode(event: ParsedRunLog, index: number): LogTreeNode {
  return {
    id: `${event.timestamp}-${index}-${event.title}-${event.detail.slice(0, 24)}`,
    title: event.title,
    detail: event.detail,
    status: event.status,
    kind: event.kind,
    timestamp: event.timestamp,
    meta: event.meta,
    children: [],
  };
}

function shouldMergeNode(previous: LogTreeNode, next: LogTreeNode) {
  if (previous.children.length || next.children.length) return false;
  if (previous.kind !== 'cursor' || next.kind !== 'cursor') return false;
  if (previous.status !== 'info' || next.status !== 'info') return false;
  if (previous.title !== next.title) return false;
  if (previous.title !== 'Agent 思考' && previous.title !== 'Agent 输出') return false;
  if (Object.keys(previous.meta).length > 0 || Object.keys(next.meta).length > 0) return false;
  return previous.detail.length + next.detail.length <= 5000;
}

function appendChild(parent: LogTreeNode, child: LogTreeNode) {
  const previous = parent.children[parent.children.length - 1];
  if (previous && shouldMergeNode(previous, child)) {
    parent.children[parent.children.length - 1] = {
      ...previous,
      timestamp: child.timestamp || previous.timestamp,
      detail: joinDetail(previous.detail, child.detail),
    };
    return;
  }
  parent.children.push(child);
}

function agentNameFromEvent(event: ParsedRunLog) {
  if (event.meta.agent) return event.meta.agent;
  const titleAgent = event.title.match(/^(.+?)\s+(?:开始|完成|进展)$/)?.[1];
  if (titleAgent && titleAgent !== 'Agent') return titleAgent;
  return '';
}

function mergeStatus(current: ParsedRunLog['status'], next: ParsedRunLog['status']) {
  if (next === 'error' || current === 'error') return 'error';
  if (next === 'running' || current === 'running') return 'running';
  if (next === 'success' || current === 'success') return 'success';
  return 'info';
}

function buildLogTree(events: ParsedRunLog[]) {
  const roots: LogTreeNode[] = [];
  const cursorRoot: LogTreeNode = {
    id: 'cursor-agent-root',
    title: 'Cursor CLI',
    detail: '逐个执行 Agent',
    status: 'running',
    kind: 'group',
    timestamp: '',
    meta: {},
    children: [],
  };
  const agentNodes = new Map<string, LogTreeNode>();
  let hasCursorRoot = false;
  let currentAgent = '';

  const ensureCursorRoot = () => {
    if (!hasCursorRoot) {
      roots.push(cursorRoot);
      hasCursorRoot = true;
    }
    return cursorRoot;
  };

  const ensureAgent = (agent: string, seed?: ParsedRunLog, index = 0) => {
    const root = ensureCursorRoot();
    const existing = agentNodes.get(agent);
    if (existing) {
      if (seed) {
        existing.status = existing.status === 'error' ? 'error' : seed.status;
        existing.timestamp = seed.timestamp || existing.timestamp;
        existing.detail = seed.detail || existing.detail;
      }
      return existing;
    }
    const node: LogTreeNode = {
      id: `agent-${agent}-${index}`,
      title: agent,
      detail: seed?.detail || 'Agent 运行中',
      status: seed?.status || 'running',
      kind: 'agent',
      timestamp: seed?.timestamp || '',
      meta: seed?.meta || { agent },
      children: [],
    };
    appendChild(root, node);
    agentNodes.set(agent, node);
    return node;
  };

  events.forEach((event, index) => {
    if (event.kind === 'run' || event.kind === 'dispatch' || event.kind === 'error') {
      roots.push(makeNode(event, index));
      return;
    }

    if (event.kind === 'agent') {
      const agent = agentNameFromEvent(event) || currentAgent || 'Agent';
      currentAgent = agent;
      const agentNode = ensureAgent(agent, event, index);
      appendChild(agentNode, makeNode(event, index));
      return;
    }

    if (event.kind === 'tool') {
      const agent = event.meta.agent || currentAgent;
      const parent = agent ? ensureAgent(agent, undefined, index) : ensureCursorRoot();
      appendChild(parent, makeNode(event, index));
      parent.status = mergeStatus(parent.status, event.status);
      parent.timestamp = event.timestamp || parent.timestamp;
      return;
    }

    if (event.kind === 'cursor') {
      const parent = currentAgent && (event.title === 'Agent 思考' || event.title === 'Agent 输出')
        ? ensureAgent(currentAgent, undefined, index)
        : ensureCursorRoot();
      appendChild(parent, makeNode(event, index));
      parent.status = mergeStatus(parent.status, event.status);
      parent.timestamp = event.timestamp || parent.timestamp;
      return;
    }

    roots.push(makeNode(event, index));
  });

  if (hasCursorRoot && cursorRoot.children.every((child) => child.status === 'success')) cursorRoot.status = 'success';
  return roots;
}

function formatTime(timestamp: string) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : '';
}

function metaText(meta: Record<string, string>) {
  return [meta.agent, meta.task, meta.pipeline, meta.tool].filter(Boolean).join(' · ');
}

function LogLeaf({ node }: { node: LogTreeNode }) {
  return <div className={`friendly-event tree-leaf ${node.kind} ${node.status}`}>
    <span className="event-dot"/>
    <div>
      <div className="event-head"><strong>{node.title}</strong><time>{formatTime(node.timestamp)}</time></div>
      {Object.keys(node.meta).length > 0 && <small>{metaText(node.meta)}</small>}
      <p>{node.detail}</p>
    </div>
  </div>;
}

function LogNodeView({ node }: { node: LogTreeNode }) {
  if (!node.children.length) return <LogLeaf node={node}/>;
  return <details className={`log-tree-node ${node.kind} ${node.status}`} open>
    <summary>
      <span className="event-dot"/>
      <span>
        <strong>{node.title}</strong>
        {node.detail && <em>{node.detail}</em>}
      </span>
      <small>{node.children.length} 项</small>
      <time>{formatTime(node.timestamp)}</time>
    </summary>
    <div className="log-tree-children">
      {node.children.map((child) => <LogNodeView node={child} key={child.id}/>)}
    </div>
  </details>;
}

export default function LoopLogStream({ leaseId }: { leaseId: string }) {
  const [rawContent, setRawContent] = useState('');
  const [events, setEvents] = useState<ParsedRunLog[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [connected, setConnected] = useState(false);

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

  return <div className="run-log-box">
    <div className="run-log-status">
      <span className={connected ? 'live-dot' : 'live-dot idle'}/>
      <small>{connected ? '实时连接中' : '等待日志'}</small>
      <button type="button" className="text-toggle" onClick={() => setShowRaw((value) => !value)}>{showRaw ? '友好视图' : '原始日志'}</button>
    </div>
    {showRaw ? <pre>{rawContent || 'waiting for app log...\n'}</pre> : <div className="friendly-log tree-log">
      {events.length === 0 ? <p className="friendly-empty">等待 pipeline 进展...</p> : buildLogTree(events).map((node) => <LogNodeView node={node} key={node.id}/>)}
    </div>}
  </div>;
}
