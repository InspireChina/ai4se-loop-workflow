'use client';

import { LoaderCircle, LockKeyhole, Route } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Action = { kind: 'start' } | { kind: 'stop'; reason: 'user-stop' } | { kind: 'resume-after-update' };
type Receipt = { outcome: string; error?: string; warning?: string };
type LifecycleBridge = {
  status(): Promise<unknown>;
  command(action: Action): Promise<Receipt>;
};

declare global {
  interface Window { loopworkLifecycle?: LifecycleBridge }
}

async function command(action: Action) {
  if (window.loopworkLifecycle) return window.loopworkLifecycle.command(action);
  const response = await fetch('/api/loop/lifecycle/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  const receipt = await response.json() as Receipt;
  if (!response.ok) throw new Error(receipt.error || 'Lifecycle command failed');
  return receipt;
}

export function RunLifecycleControls({ active, detail }: { active: boolean; detail: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const invoke = async (action: Action) => {
    setPending(true);
    setError('');
    try {
      const receipt = await command(action);
      if (receipt.outcome === 'update-in-progress') throw new Error('应用正在更新，当前不能修改运行状态');
      if (receipt.outcome === 'failed' || receipt.outcome === 'blocked') throw new Error(receipt.error || '生命周期操作失败');
      if (receipt.warning) setError(receipt.warning);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  return <div className="run-lifecycle-controls">
    <div>
      <span className={`badge ${active ? 'amber' : 'green'}`}>{active ? '运行中' : '已停止'}</span>
      <small>{detail}</small>
    </div>
    {active
      ? <button className="button secondary" type="button" disabled={pending} onClick={() => void invoke({ kind: 'stop', reason: 'user-stop' })}>
        {pending ? <LoaderCircle className="spin" size={15}/> : <LockKeyhole size={15}/>}结束本轮
      </button>
      : <button className="button" type="button" disabled={pending} onClick={() => void invoke({ kind: 'start' })}>
        {pending ? <LoaderCircle className="spin" size={15}/> : <Route size={15}/>}开始运行
      </button>}
    {error && <small className="run-lifecycle-error">{error}</small>}
  </div>;
}
