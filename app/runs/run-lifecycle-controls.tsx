'use client';

import { LoaderCircle, LockKeyhole, Route } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Action = { kind: 'start' } | { kind: 'stop'; reason: 'user-stop' } | { kind: 'resume-after-update' };
type LifecycleSnapshot = { mode?: { kind: string } };
type Receipt = { outcome: string; error?: string; warning?: string; snapshot?: LifecycleSnapshot };
type LifecycleBridge = {
  status(): Promise<LifecycleSnapshot>;
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

async function lifecycleStatus() {
  if (window.loopworkLifecycle) return window.loopworkLifecycle.status();
  const response = await fetch('/api/loop/lifecycle/status');
  if (!response.ok) throw new Error('无法读取运行状态');
  return response.json() as Promise<LifecycleSnapshot>;
}

export function RunLifecycleControls({ active, detail }: { active: boolean; detail: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [updateSilence, setUpdateSilence] = useState(false);

  useEffect(() => {
    void lifecycleStatus().then((snapshot) => {
      const staleUpdate = snapshot.mode?.kind === 'update-silence';
      setUpdateSilence(staleUpdate);
      if (staleUpdate) setError('上次更新未完成清理，可以恢复运行控制后继续使用。');
    }).catch(() => undefined);
  }, []);

  const invoke = async (action: Action) => {
    setPending(true);
    setError('');
    try {
      const receipt = await command(action);
      if (receipt.outcome === 'update-in-progress') {
        setUpdateSilence(true);
        throw new Error('检测到上次更新遗留的静默状态，请先恢复运行控制');
      }
      if (receipt.outcome === 'failed' || receipt.outcome === 'blocked') throw new Error(receipt.error || '生命周期操作失败');
      if (action.kind === 'resume-after-update') setUpdateSilence(false);
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
    {updateSilence
      ? <button className="button" type="button" disabled={pending} onClick={() => void invoke({ kind: 'resume-after-update' })}>
        {pending ? <LoaderCircle className="spin" size={15}/> : <Route size={15}/>}恢复运行控制
      </button>
      : active
      ? <button className="button secondary" type="button" disabled={pending} onClick={() => void invoke({ kind: 'stop', reason: 'user-stop' })}>
        {pending ? <LoaderCircle className="spin" size={15}/> : <LockKeyhole size={15}/>}结束本轮
      </button>
      : <button className="button" type="button" disabled={pending} onClick={() => void invoke({ kind: 'start' })}>
        {pending ? <LoaderCircle className="spin" size={15}/> : <Route size={15}/>}开始运行
      </button>}
    {error && <small className="run-lifecycle-error">{error}</small>}
  </div>;
}
