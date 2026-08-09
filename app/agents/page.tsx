import Link from 'next/link';
import { Bot, BrainCircuit, Database, GitBranch } from 'lucide-react';
import { listAgentProfiles } from '../../src/application/agent-profiles';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, listAgentRuntimeSettings } from '../../src/application/project-settings';
import { AGENT_PROFILE_DEFINITIONS, type FlowAgentId } from '../../src/domain/agent-profile';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const [profiles, runtimes] = await Promise.all([listAgentProfiles(), listAgentRuntimeSettings()]);
  const runtimeByAgent = new Map(runtimes.map((runtime) => [runtime.agentId, runtime]));
  return <>
    <header><p className="eyebrow">AGENT RUNTIME</p><h1>Agent 配置</h1><p className="muted">管理当前项目各 Agent 的 Runtime、完整 Prompt、长期记忆和自动演化状态。Runtime 默认继承项目设置，也可以按 Agent 独立覆盖。</p></header>
    <section className="agent-grid">
      {profiles.map((profile) => {
        const definition = AGENT_PROFILE_DEFINITIONS[profile.agent_id as FlowAgentId];
        const runtime = runtimeByAgent.get(profile.agent_id);
        const executorLabel = AGENT_EXECUTOR_OPTIONS.find((option) => option.id === runtime?.executorId)?.label || runtime?.executorId;
        const modelLabel = runtime?.executorId === 'codex'
          ? CODEX_MODEL_OPTIONS.find((option) => option.id === runtime.codexModel)?.label || runtime.codexModel
          : runtime?.executorId === 'claude'
            ? runtime.claudeModel || 'CLI 默认'
            : 'CLI 默认';
        const runtimeLabel = `${executorLabel} · ${modelLabel} · ${runtime?.source === 'agent_override' ? '独立' : '项目默认'}`;
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
    </section>
  </>;
}
