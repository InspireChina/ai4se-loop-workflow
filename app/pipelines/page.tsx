import { REQUIREMENT_PIPELINES } from '../../src/domain/pipeline-catalog';

const stageTitles = new Map(REQUIREMENT_PIPELINES.flatMap((pipeline) => pipeline.stages.map((stage) => [stage.key, stage.title] as const)));

function stageTitle(key: string) {
  return stageTitles.get(key) ?? key;
}

export default function PipelinesPage() {
  return <>
    <header><h1>流水线</h1><p className="muted">Business Analysis 负责从想法形成需求规格；功能需求和 BUG 负责从规格核对到代码交付。</p></header>
    <section className="card pipeline-map">
      <svg className="pipeline-map-desktop" viewBox="0 0 1000 110" role="img" aria-labelledby="ba-pipeline-title ba-pipeline-description">
        <title id="ba-pipeline-title">Business Analysis 流水线</title>
        <desc id="ba-pipeline-description">模糊想法依次经过需求意图确认、业务方案设计、需求规格编写、规格独立审查和阅读规格。</desc>
        <path className="pipeline-map-line feature" d="M115 55 H155 M305 55 H345 M495 55 H535 M685 55 H725 M875 55 H910"/>
        <path className="pipeline-map-arrow" d="M149 51 L156 55 L149 59 Z M339 51 L346 55 L339 59 Z M529 51 L536 55 L529 59 Z M719 51 L726 55 L719 59 Z M904 51 L911 55 L904 59 Z"/>
        <rect className="pipeline-map-node pipeline-map-entry feature" x="15" y="33" width="100" height="44" rx="8"/>
        <text className="pipeline-map-label" x="65" y="55">想法</text>
        <rect className="pipeline-map-node" x="155" y="33" width="150" height="44" rx="8"/>
        <text className="pipeline-map-label" x="230" y="55">{stageTitle('idea-context')}</text>
        <rect className="pipeline-map-node" x="345" y="33" width="150" height="44" rx="8"/>
        <text className="pipeline-map-label" x="420" y="55">{stageTitle('business-design')}</text>
        <rect className="pipeline-map-node" x="535" y="33" width="150" height="44" rx="8"/>
        <text className="pipeline-map-label" x="610" y="55">{stageTitle('requirement-spec')}</text>
        <rect className="pipeline-map-node" x="725" y="33" width="150" height="44" rx="8"/>
        <text className="pipeline-map-label" x="800" y="55">{stageTitle('spec-review')}</text>
        <rect className="pipeline-map-node" x="910" y="33" width="75" height="44" rx="8"/>
        <text className="pipeline-map-label" x="947" y="55">阅读规格</text>
      </svg>
    </section>
    <section className="card pipeline-map">
      <svg className="pipeline-map-desktop" viewBox="0 0 1000 190" role="img" aria-labelledby="pipeline-map-title pipeline-map-description">
        <title id="pipeline-map-title">功能需求与 BUG 流水线</title>
        <desc id="pipeline-map-description">功能需求经过需求梳理后进入公共交付主干；BUG 在需求梳理后增加问题复现阶段，再汇入公共交付主干。</desc>

        <path className="pipeline-map-line feature" d="M90 45 H110 M196 45 H302 Q320 45 320 63 V95"/>
        <path className="pipeline-map-line bug" d="M90 145 H110 M196 145 H215 M301 145 H302 Q320 145 320 127 V95"/>
        <path className="pipeline-map-line" d="M320 95 H340 M430 95 H445 M535 95 H550 M640 95 H655 M745 95 H760 M850 95 H865"/>

        <path className="pipeline-map-arrow" d="M104 41 L111 45 L104 49 Z M209 141 L216 145 L209 149 Z M334 91 L341 95 L334 99 Z M439 91 L446 95 L439 99 Z M544 91 L551 95 L544 99 Z M649 91 L656 95 L649 99 Z M754 91 L761 95 L754 99 Z M859 91 L866 95 L859 99 Z"/>

        <rect className="pipeline-map-node pipeline-map-entry feature" x="14" y="23" width="76" height="44" rx="8"/>
        <text className="pipeline-map-label" x="52" y="45">功能需求</text>
        <rect className="pipeline-map-node" x="110" y="23" width="86" height="44" rx="8"/>
        <text className="pipeline-map-label" x="153" y="45">{stageTitle('requirement-context')}</text>

        <rect className="pipeline-map-node pipeline-map-entry bug" x="14" y="123" width="76" height="44" rx="8"/>
        <text className="pipeline-map-label" x="52" y="145">BUG</text>
        <rect className="pipeline-map-node" x="110" y="123" width="86" height="44" rx="8"/>
        <text className="pipeline-map-label" x="153" y="145">{stageTitle('requirement-context')}</text>
        <rect className="pipeline-map-node pipeline-map-reproduction" x="215" y="123" width="86" height="44" rx="8"/>
        <text className="pipeline-map-label" x="258" y="145">{stageTitle('reproduction')}</text>

        <circle className="pipeline-map-join" cx="320" cy="95" r="4"/>
        <rect className="pipeline-map-node" x="340" y="73" width="90" height="44" rx="8"/>
        <text className="pipeline-map-label" x="385" y="95">{stageTitle('delivery-plan')}</text>
        <rect className="pipeline-map-node" x="445" y="73" width="90" height="44" rx="8"/>
        <text className="pipeline-map-label" x="490" y="95">{stageTitle('delivery-analysis')}</text>
        <rect className="pipeline-map-node" x="550" y="73" width="90" height="44" rx="8"/>
        <text className="pipeline-map-label" x="595" y="95">{stageTitle('implementation')}</text>
        <rect className="pipeline-map-node" x="655" y="73" width="90" height="44" rx="8"/>
        <text className="pipeline-map-label" x="700" y="95">{stageTitle('verification')}</text>
        <rect className="pipeline-map-node" x="760" y="73" width="90" height="44" rx="8"/>
        <text className="pipeline-map-label" x="805" y="95">{stageTitle('review')}</text>
        <rect className="pipeline-map-node" x="865" y="73" width="90" height="44" rx="8"/>
        <text className="pipeline-map-label" x="910" y="95">{stageTitle('acknowledgement')}</text>
      </svg>

      <div className="pipeline-map-mobile">
        {REQUIREMENT_PIPELINES.map((pipeline) => <div className="pipeline-mobile-route" key={pipeline.id}>
          <strong>{pipeline.label}</strong>
          <div>{pipeline.stages.map((stage) => <span key={stage.key}>{stage.title}</span>)}</div>
        </div>)}
      </div>
    </section>
  </>;
}
