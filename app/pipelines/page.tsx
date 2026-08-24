import Link from 'next/link';
import { ArrowDown, ArrowRight, ExternalLink, GitMerge } from 'lucide-react';
import { REQUIREMENT_PIPELINES, type RequirementPipelineStage } from '../../src/domain/pipeline-catalog';

const pipelines = new Map(REQUIREMENT_PIPELINES.map((pipeline) => [pipeline.id, pipeline] as const));
const businessAnalysis = pipelines.get('business-analysis')!;
const endToEnd = pipelines.get('end-to-end')!;
const feature = pipelines.get('feature')!;
const bug = pipelines.get('bug')!;

function sharedStageSuffix(left: readonly RequirementPipelineStage[], right: readonly RequirementPipelineStage[]) {
  let count = 0;
  while (count < left.length && count < right.length && left.at(-1 - count)?.key === right.at(-1 - count)?.key) count += 1;
  return left.slice(left.length - count);
}

const sharedStages = sharedStageSuffix(feature.stages, bug.stages);
const featureEntryStages = feature.stages.slice(0, feature.stages.length - sharedStages.length);
const bugEntryStages = bug.stages.slice(0, bug.stages.length - sharedStages.length);

function StageNode({ stage, tone }: { stage: RequirementPipelineStage; tone?: 'feature' | 'bug' | 'analysis' | 'end-to-end' }) {
  const content = <>
    <strong>{stage.title}</strong>
    <small>{stage.owner}{stage.agentId && <ExternalLink size={11} aria-hidden="true"/>}</small>
  </>;
  const className = `pipeline-stage ${tone || ''}${stage.agentId ? ' linked' : ''}`;
  const title = stage.agentId ? `${stage.owner}：${stage.description}。点击打开 Agent 配置。` : `${stage.owner}：${stage.description}`;
  return stage.agentId
    ? <Link className={className} href={`/agents/${stage.agentId}`} title={title} aria-label={`${stage.title}：打开${stage.owner}配置`}>{content}</Link>
    : <article className={className} title={title}>{content}</article>;
}

function StageSequence({ stages, tone }: { stages: readonly RequirementPipelineStage[]; tone?: 'feature' | 'bug' | 'analysis' | 'end-to-end' }) {
  return <div className="pipeline-stage-sequence">
    {stages.map((stage, index) => <div className="pipeline-stage-step" key={stage.key}>
      {index > 0 && <ArrowRight className="pipeline-arrow" size={17} aria-hidden="true"/>}
      <StageNode stage={stage} tone={tone}/>
    </div>)}
  </div>;
}

function EntryRoute({ label, summary, stages, tone }: { label: string; summary: string; stages: readonly RequirementPipelineStage[]; tone: 'feature' | 'bug' }) {
  return <section className={`pipeline-entry-route ${tone}`}>
    <div className="pipeline-route-label"><strong>{label}</strong><small>{summary}</small></div>
    <ArrowRight className="pipeline-arrow" size={17} aria-hidden="true"/>
    <StageSequence stages={stages} tone={tone}/>
  </section>;
}

export default function PipelinesPage() {
  return <>
    <header><p className="eyebrow">WORKFLOW CATALOG</p><h1>流水线</h1><p className="muted">四类入口共享一张流程地图：End to End 自动贯通 Business Analysis 与 Develop，其他入口也可独立使用。</p></header>
    <section className="card pipeline-board" aria-labelledby="pipeline-board-title">
      <div className="pipeline-board-head">
        <div><span className="eyebrow">END-TO-END MAP</span><h2 id="pipeline-board-title">从想法到可信交付</h2></div>
        <div className="pipeline-legend" aria-label="路线图例"><span className="end-to-end">{endToEnd.label}</span><span className="analysis">{businessAnalysis.label}</span><span className="feature">{feature.label}</span><span className="bug">{bug.label}</span></div>
      </div>

      <section className="pipeline-track pipeline-end-to-end-track">
        <div className="pipeline-track-head"><div><span className="pipeline-track-index">01</span><strong>自动端到端</strong></div><p>{endToEnd.summary}</p></div>
        <div className="pipeline-scroll-region">
          <div className="pipeline-route-flow">
            <div className="pipeline-route-label end-to-end"><strong>想法</strong><small>End to End</small></div>
            <ArrowRight className="pipeline-arrow" size={17} aria-hidden="true"/>
            <StageSequence stages={endToEnd.stages} tone="end-to-end"/>
          </div>
        </div>
      </section>

      <section className="pipeline-track pipeline-analysis-track">
        <div className="pipeline-track-head"><div><span className="pipeline-track-index">02</span><strong>独立需求定义</strong></div><p>{businessAnalysis.summary}</p></div>
        <div className="pipeline-scroll-region">
          <div className="pipeline-route-flow">
            <div className="pipeline-route-label analysis"><strong>想法</strong><small>Business Analysis</small></div>
            <ArrowRight className="pipeline-arrow" size={17} aria-hidden="true"/>
            <StageSequence stages={businessAnalysis.stages} tone="analysis"/>
          </div>
        </div>
      </section>

      <div className="pipeline-handoff"><ArrowDown size={16}/><span>审查通过的规格成为后续需求梳理的权威输入</span></div>

      <section className="pipeline-track pipeline-delivery-track">
        <div className="pipeline-track-head"><div><span className="pipeline-track-index">03</span><strong>独立交付执行</strong></div><p>不同入口先完成各自的事实准备，再汇入稳定的公共交付主干。</p></div>
        <div className="pipeline-entry-lanes">
          <div className="pipeline-scroll-region"><EntryRoute label={feature.label} summary={feature.summary} stages={featureEntryStages} tone="feature"/></div>
          <div className="pipeline-scroll-region"><EntryRoute label={bug.label} summary={bug.summary} stages={bugEntryStages} tone="bug"/></div>
        </div>
        <div className="pipeline-merge"><GitMerge size={17}/><span>汇入公共交付主干</span></div>
        <div className="pipeline-scroll-region pipeline-shared-region">
          <StageSequence stages={sharedStages}/>
        </div>
      </section>
    </section>
  </>;
}
