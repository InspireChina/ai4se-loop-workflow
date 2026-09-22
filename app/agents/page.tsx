import Link from 'next/link';
import { Bot, BrainCircuit, Database, GitBranch, LockKeyhole, ShieldCheck, Zap } from 'lucide-react';
import { listAgentProfiles } from '../../src/application/agent-profiles';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, listAgentRuntimeSettings } from '../../src/application/project-settings';
import { AGENT_PROFILE_DEFINITIONS, type FlowAgentId } from '../../src/domain/agent-profile';
import { INTERNAL_AGENT_DEFINITIONS } from '../../src/domain/internal-agent-catalog';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const [profiles, runtimes] = await Promise.all([listAgentProfiles(), listAgentRuntimeSettings()]);
  const runtimeByAgent = new Map(runtimes.map((runtime) => [runtime.agentId, runtime]));
  return <>
    <header><p className="eyebrow">AGENT CATALOG</p><h1>Agent 配置</h1><p className="muted">流程 Agent 可以配置命令链、Prompt、Runtime、Memory 与演化；内置 Agent 由 Harness 协议固定，只读展示其触发方式和权限边界。</p></header>
    <section className="agent-catalog-section" aria-labelledby="flow-agent-heading">
      <div className="agent-catalog-heading"><div><p className="eyebrow">CONFIGURABLE</p><h2 id="flow-agent-heading">流程 Agent</h2></div><p className="muted">参与需求与交付工作流，可按项目维护 Prompt、Memory 和演化策略。</p></div>
      <div className="agent-grid">
        {profiles.map((profile) => {
        const definition = AGENT_PROFILE_DEFINITIONS[profile.agent_id as FlowAgentId];
        const runtime = runtimeByAgent.get(profile.agent_id);
        const executorLabel = AGENT_EXECUTOR_OPTIONS.find((option) => option.id === runtime?.executorId)?.label || runtime?.executorId;
        const modelLabel = runtime?.executorId === 'codex'
          ? CODEX_MODEL_OPTIONS.find((option) => option.id === runtime.codexModel)?.label || runtime.codexModel
          : runtime?.executorId === 'claude'
            ? runtime.claudeModel || 'CLI 默认'
            : runtime?.executorId === 'omp'
              ? `${runtime.ompModel || 'OMP 默认'} · ${runtime.ompThinking === 'default' ? '默认思考强度' : runtime.ompThinking}`
            : 'CLI 默认';
        const runtimeLabel = `${executorLabel} · ${modelLabel} · ${runtime?.source === 'agent_configuration' ? runtime.configurationName : '流程默认'}`;
          return <Link href={`/agents/${profile.agent_id}`} className="card agent-card" key={profile.agent_id}>
            <div className="agent-card-head"><span className="executor-icon"><Bot size={18}/></span><span className="agent-card-badges"><span className="badge">{runtimeLabel}</span><span className={`badge ${profile.candidate_prompt_version ? 'amber' : profile.auto_evolve ? 'green' : 'blue'}`}>{profile.candidate_prompt_version ? `Canary · ${profile.canary_remaining}` : profile.auto_evolve ? '自动演化' : '仅手工'}</span></span></div>
            <div><h2>{definition.label}</h2><p className="muted">{definition.description}</p></div>
            <div className="agent-stats">
              <span><GitBranch size={14}/>Prompt r{profile.current_prompt_version}</span>
              <span><Database size={14}/>Memory r{profile.current_memory_revision}</span>
              <span><BrainCircuit size={14}/>{profile.observation_count} 条观察</span>
            </div>
            <small>{profile.execution_count} 次执行 · {profile.promoted_count} 条已提升经验</small>
          </Link>;
        })}
      </div>
    </section>
    <section className="agent-catalog-section builtin-agent-section" aria-labelledby="builtin-agent-heading">
      <div className="agent-catalog-heading"><div><p className="eyebrow">SYSTEM BUILT-IN</p><h2 id="builtin-agent-heading">内置 Agent</h2></div><p className="muted">验证协助、学习和交互使用的内部模型角色。权限和 Prompt 属于 Harness 协议，不开放编辑。</p></div>
      <div className="agent-grid builtin-agent-grid">
        {INTERNAL_AGENT_DEFINITIONS.map((agent) => <article className="card agent-card builtin-agent-card" key={agent.id}>
          <div className="agent-card-head"><span className="executor-icon"><LockKeyhole size={18}/></span><span className="agent-card-badges"><span className="badge blue">系统内置</span><span className="badge">只读</span></span></div>
          <div><p className="builtin-agent-id">{agent.id}</p><h2>{agent.label}</h2><p className="muted">{agent.description}</p></div>
          <div className="builtin-agent-facts">
            <span><Zap size={14}/><span><small>触发方式</small><strong>{agent.trigger}</strong></span></span>
            <span><ShieldCheck size={14}/><span><small>权限边界</small><strong>{agent.authority}</strong></span></span>
          </div>
          <small className="builtin-agent-runtime">运行身份：<code>{agent.runtimeIdentity}</code></small>
        </article>)}
      </div>
    </section>
  </>;
}
