import { AlertTriangle, CheckCircle2, CircleDashed, Link2 } from 'lucide-react';
import type { AcceptanceRecord } from '../../../src/application/tasks';
import { agentLabel, deliveryUnitLabel } from '../../../src/domain/terminology';

type Assessment = AcceptanceRecord['assessments'][number];

function latestAssessment(acceptance: AcceptanceRecord, kind: Assessment['kind']) {
  return [...acceptance.assessments].reverse().find((item) => item.kind === kind);
}

function assessmentResultLabel(result: Assessment['result']) {
  return ({
    claimed: '已声明',
    passed: '已通过',
    failed: '未通过',
    blocked: '受阻',
  } as const)[result];
}

export function AcceptanceContracts({ acceptances }: { acceptances: AcceptanceRecord[] }) {
  if (acceptances.length === 0) {
    return <div className="card empty acceptance-empty">需求整理完成后，会在这里形成可跨 Agent 流转的验收契约。</div>;
  }

  return <div className="acceptance-contract-list">
    {acceptances.map((acceptance, index) => {
      const implementation = latestAssessment(acceptance, 'implementation');
      const verification = latestAssessment(acceptance, 'verification');
      const review = latestAssessment(acceptance, 'review');
      const failed = [implementation, verification, review].some((item) => item?.result === 'failed' || item?.result === 'blocked');
      const state = failed ? 'failed' : verification?.result === 'passed' ? 'verified' : implementation?.result === 'claimed' ? 'implemented' : 'pending';
      const stateLabel = failed ? '存在缺口' : state === 'verified' ? '验证通过' : state === 'implemented' ? '已声明实现' : '等待实现';
      const assessments = [
        { label: '实现声明', value: implementation },
        { label: '独立验证', value: verification },
        ...(review ? [{ label: '结卡对账', value: review }] : []),
      ];

      return <article className={`acceptance-contract ${state}`} key={acceptance.acceptance_id}>
        <header className="acceptance-contract-head">
          <span className="acceptance-contract-index">AC {String(index + 1).padStart(2, '0')}</span>
          <div className="acceptance-contract-title">
            <span className="acceptance-contract-scope">{acceptance.scope_type === 'requirement' ? '需求级契约' : `${deliveryUnitLabel(acceptance.story_index)}契约`}</span>
            <h3>{acceptance.statement}</h3>
          </div>
          <span className={`acceptance-contract-state ${state}`}>
            {failed ? <AlertTriangle size={14}/> : state === 'verified' ? <CheckCircle2 size={14}/> : <CircleDashed size={14}/>}
            {stateLabel}
          </span>
        </header>

        <div className="acceptance-contract-body">
          <section className="acceptance-oracle">
            <span>判定标准</span>
            <p>{acceptance.oracle}</p>
          </section>

          {acceptance.assigned_story_indexes.length > 0 && <div className="acceptance-assignments">
            <span><Link2 size={13}/>承接单元</span>
            <div>{acceptance.assigned_story_indexes.map((storyIndex) => <span key={storyIndex}>{deliveryUnitLabel(storyIndex)}</span>)}</div>
          </div>}

          <div className={`acceptance-assessments count-${assessments.length}`}>
            {assessments.map(({ label, value }) => <section className={`acceptance-assessment ${value?.result || 'pending'}`} key={label}>
              <div>
                <span>{label}</span>
                <strong>{value ? assessmentResultLabel(value.result) : '等待登记'}</strong>
              </div>
              {value ? <p>{value.evidence}</p> : <p>尚无对应 Agent 证据。</p>}
              {value && <small>{agentLabel(value.agent)}</small>}
            </section>)}
          </div>
        </div>

        <footer className="acceptance-contract-meta">
          <code>{acceptance.acceptance_key}</code>
          <span>revision {acceptance.revision}</span>
        </footer>
      </article>;
    })}
  </div>;
}
