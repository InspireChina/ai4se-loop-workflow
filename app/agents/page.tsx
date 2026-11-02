import { discoverExternalAgents } from '../../src/infrastructure/external-agents';
import Link from 'next/link';
import { Bot, BrainCircuit, Database, GitBranch, LockKeyhole, ShieldCheck, Zap } from 'lucide-react';
import { listAgentProfiles } from '../../src/application/agent-profiles';
import { AGENT_EXECUTOR_OPTIONS, listAgentRuntimeSettings } from '../../src/application/project-settings';
import { AGENT_PROFILE_DEFINITIONS, type FlowAgentId } from '../../src/domain/agent-profile';
import { INTERNAL_AGENT_DEFINITIONS } from '../../src/domain/internal-agent-catalog';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const [profiles, runtimes] = await Promise.all([listAgentProfiles(), listAgentRuntimeSettings()]);
  const workspace = profiles[0]?.project.workspace_root;
  const detected = workspace ? discoverExternalAgents(workspace) : [];
  const fixedIds = new Set<string>([...Object.keys(AGENT_PROFILE_DEFINITIONS), ...INTERNAL_AGENT_DEFINITIONS.map(agent => agent.definitionId)]);
  const bound = detected.filter(agent => fixedIds.has(agent.id));
  const unbound = detected.filter(agent => !fixedIds.has(agent.id));
  const runtimeByAgent = new Map(runtimes.map((runtime) => [runtime.agentId, runtime]));
  return <>
    <header><p className="eyebrow">AGENT CATALOG</p><h1>Agent 配置</h1><p className="muted">流程 Agent 保留阶段协议、Runtime、Memory 与诊断；专业 Prompt 从外部 .omp/agents 加载，辅助角色保留原有 Harness 权限边界。</p></header>
    <section className="card settings"><strong>当前工作目录自动检测</strong><p className="path-line">{workspace}/.omp/agents</p><p className="muted">已绑定 {bound.length} 个固定角色定义。角色及 Workflow 不变，仅从外部文件动态加载 Prompt 和运行参数。</p>{bound.length > 0 && <small>{bound.map((agent) => `${agent.id}${agent.error ? '（定义异常）' : ''}`).join(' · ')}</small>}{unbound.length > 0 && <p className="muted">另有 {unbound.length} 个文件未绑定固定角色，不会新增 Workflow Agent。</p>}</section>
    <section className="agent-catalog-section" aria-labelledby="flow-agent-heading">
      <div className="agent-catalog-heading"><div><p className="eyebrow">CONFIGURABLE</p><h2 id="flow-agent-heading">流程 Agent</h2></div><p className="muted">参与原有需求与交付工作流；Prompt 在外部 Agent 文件管理，Runtime 与 Memory 沿用原有配置。</p></div>
      <div className="agent-grid">
        {profiles.map((profile) => {
        const definition = AGENT_PROFILE_DEFINITIONS[profile.agent_id as FlowAgentId];
        const runtime = runtimeByAgent.get(profile.agent_id);
        const executorLabel = AGENT_EXECUTOR_OPTIONS.find((option) => option.id === runtime?.executorId)?.label || runtime?.executorId;
        const modelLabel = `${runtime?.ompModel || 'OMP 默认'} · ${runtime?.ompThinking === 'default' ? '默认思考强度' : runtime?.ompThinking}`;
        const runtimeLabel = `${executorLabel} ${runtime?.source === 'agent_configuration' ? '自定义' : '默认'} · ${modelLabel} · ${runtime?.source === 'agent_configuration' ? runtime.configurationName : '流程默认'}`;
          return <Link href={`/agents/${profile.agent_id}`} className="card agent-card" key={profile.agent_id}>
            <div className="agent-card-head"><span className="executor-icon"><Bot size={18}/></span><span className="agent-card-badges"><span className="badge">{runtimeLabel}</span><span className="badge blue">外部定义</span></span></div>
            <div><h2>{definition.label}</h2><p className="muted">{definition.description}</p></div>
            <div className="agent-stats">
              <span><GitBranch size={14}/>{profile.externalAgentError ? '未检测到有效定义' : '已加载外部定义'}</span>
              <span><Database size={14}/>Memory r{profile.current_memory_revision}</span>
              <span><BrainCircuit size={14}/>{profile.observation_count} 条观察</span>
            </div>
            <small>{profile.execution_count} 次执行 · {profile.promoted_count} 条已提升经验</small>
          </Link>;
        })}
      </div>
    </section>
    <section className="agent-catalog-section builtin-agent-section" aria-labelledby="builtin-agent-heading">
      <div className="agent-catalog-heading"><div><p className="eyebrow">SUPPORTING ROLES</p><h2 id="builtin-agent-heading">辅助 Agent</h2></div><p className="muted">验证协助和交互角色的专业 Prompt 同样来自 .omp/agents；权限及触发方式由 Harness 管理。</p></div>
      <div className="agent-grid builtin-agent-grid">
        {INTERNAL_AGENT_DEFINITIONS.map((agent) => <article className="card agent-card builtin-agent-card" key={agent.id}>
          <div className="agent-card-head"><span className="executor-icon"><LockKeyhole size={18}/></span><span className="agent-card-badges"><span className="badge blue">外部定义</span><span className="badge">{agent.id === 'prompt-evolution-agent' && process.env.LOOP_ENABLE_EVALUATOR !== '1' ? '默认停用' : '流程驱动'}</span></span></div>
          <div><p className="builtin-agent-id">{agent.id}</p><h2>{agent.label}</h2><p className="muted">{agent.description}</p></div>
          <div className="builtin-agent-facts">
            <span><Zap size={14}/><span><small>触发方式</small><strong>{agent.trigger}</strong></span></span>
            <span><ShieldCheck size={14}/><span><small>权限边界</small><strong>{agent.authority}</strong></span></span>
          </div>
          <small className="builtin-agent-runtime">定义来源：<code>{detected.find((file) => file.id === agent.definitionId)?.path || `${workspace}/.omp/agents/${agent.definitionId}.md`}</code></small><small>{detected.some((file) => file.id === agent.definitionId && !file.error) ? '已检测到外部定义' : '未检测到有效定义'}</small>
        </article>)}
      </div>
    </section>
  </>;
}
