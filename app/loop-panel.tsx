import Link from 'next/link';
import { LockKeyhole, Route, ScrollText } from 'lucide-react';
import { getRunStatus } from '../src/application/tasks';
import { endLoopRunAction, startLoopRunAction } from './actions';

export default async function LoopPanel() {
  const run = await getRunStatus();
  return <aside className="loop-panel">
    <div className="loop-panel-head">
      <p className="eyebrow">LOOP</p>
      <h2>运行面板</h2>
    </div>
    {run?.active ? <form action={endLoopRunAction} className="loop-run active">
      <LockKeyhole size={17}/>
      <div><strong>本轮运行中</strong><small>{run.owner} · {run.leaseUntil}</small></div>
      <input type="hidden" name="leaseId" value={run.leaseId}/>
      <input type="hidden" name="redirectTo" value="/runs"/>
      <button className="button secondary" type="submit">结束本轮</button>
    </form> : <form action={startLoopRunAction} className="loop-run">
      <Route size={17}/>
      <div><strong>开始 Loop</strong><small>日志将在运行面板中显示</small></div>
      <input type="hidden" name="redirectTo" value="/runs"/>
      <button className="button" type="submit">开始运行</button>
    </form>}

    <section className="side-section">
      <Link href="/runs" className="button secondary side-panel-link"><ScrollText size={14}/>打开运行面板</Link>
    </section>
  </aside>;
}
