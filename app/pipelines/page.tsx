import { ArrowRight, GitBranch, LockKeyhole } from 'lucide-react';
import { REQUIREMENT_PIPELINES } from '../../src/domain/pipeline-catalog';

export default function PipelinesPage() {
  return <>
    <header><p className="eyebrow">PIPELINE CATALOG</p><h1>PIPELINE</h1><p className="muted">当前需求入口实际使用的两条只读交付流程。</p></header>
    <div className="pipeline-readonly-note"><LockKeyhole size={16}/><span>只读配置 · 此页面不提供启停、编辑或排序操作</span></div>
    <section className="pipeline-catalog-grid">
      {REQUIREMENT_PIPELINES.map((pipeline) => <article className="card pipeline-definition" key={pipeline.id}>
        <div className="pipeline-definition-head">
          <div className={`pipeline-definition-icon ${pipeline.id}`}><GitBranch size={20}/></div>
          <div><p className="eyebrow">{pipeline.id === 'bug' ? 'BUG PIPELINE' : 'REQUIREMENT PIPELINE'}</p><h2>{pipeline.label}</h2><p className="muted">{pipeline.summary}</p></div>
          <span className="badge green">已启用</span>
        </div>
        <div className="pipeline-stage-list">
          {pipeline.stages.map((stage, index) => <div className="pipeline-stage-row" key={stage.key}>
            <div className="pipeline-stage-index">{String(index + 1).padStart(2, '0')}</div>
            <div className="pipeline-stage-content">
              <div><strong>{stage.title}</strong><span className="badge">{stage.lane}</span></div>
              <p>{stage.description}</p>
              <small>{stage.owner}</small>
            </div>
            {index < pipeline.stages.length - 1 && <ArrowRight className="pipeline-stage-arrow" size={16}/>} 
          </div>)}
        </div>
        <footer><span>{pipeline.stages.length} 个阶段</span><span>交付单元阶段按依赖流水化推进</span></footer>
      </article>)}
    </section>
  </>;
}
