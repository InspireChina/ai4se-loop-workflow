import { Check, CircleAlert, Clock3, RotateCw } from 'lucide-react';
import { formatEventTime } from '../../../src/application/event-time';
import type { AgentCommandProgress as AgentCommandProgressModel } from '../../../src/application/agent-command-progress';
import { agentLabel, deliveryUnitLabel, flowLabel } from '../../../src/domain/terminology';

function StateIcon({ state }: { state: AgentCommandProgressModel['state'] }) {
  if (state === 'blocked') return <CircleAlert size={15}/>;
  if (state === 'retrying') return <RotateCw size={15}/>;
  return <Clock3 size={15}/>;
}

export function AgentCommandProgress({ chains }: { chains: AgentCommandProgressModel[] }) {
  return <section className="card agent-command-progress" aria-labelledby="agent-command-progress-title">
    <div className="agent-command-progress-head">
      <div>
        <p className="eyebrow">LIVE COMMAND CHAIN</p>
        <h2 id="agent-command-progress-title">Agent 命令链</h2>
      </div>
      <span className="agent-command-progress-live"><span/>{chains.length ? '实时跟随' : '等待执行'}</span>
    </div>
    {chains.length === 0
      ? <div className="agent-command-progress-empty">当前没有正在运行的 Agent。</div>
      : <div className="agent-command-chain-list">{chains.map((chain) => <article className="agent-command-chain" key={`${chain.executionId || 'draft'}-${chain.agent}-${chain.storyIndex ?? 'task'}`}>
        <header>
          <div>
            <strong>{agentLabel(chain.agent)}</strong>
            <small>{[chain.pipeline ? flowLabel(chain.pipeline) : '', deliveryUnitLabel(chain.storyIndex)].filter(Boolean).join(' · ') || '需求级工作'}</small>
          </div>
          <span className={`agent-command-state ${chain.state}`}><StateIcon state={chain.state}/>{chain.stateLabel}</span>
        </header>
        <ol className="agent-command-stages">
          {chain.stages.map((stage, index) => <li className={stage.status} key={stage.id} aria-current={stage.status === 'current' ? 'step' : undefined}>
            <span>{stage.status === 'completed' ? <Check size={12}/> : index + 1}</span>
            <strong>{stage.label}</strong>
          </li>)}
        </ol>
        <div className="agent-command-latest">
          <span className={`agent-command-latest-dot ${chain.latestCommand?.status || 'idle'}`}/>
          <div>
            <small>最近命令</small>
            <strong>{chain.latestCommand?.label || '等待 Agent 执行第一个领域命令'}</strong>
          </div>
          <time>{formatEventTime(chain.latestCommand?.createdAt || chain.updatedAt)}</time>
        </div>
      </article>)}</div>}
  </section>;
}
