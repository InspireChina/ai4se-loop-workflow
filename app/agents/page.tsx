import Link from 'next/link';
import { Bot, BrainCircuit, Database, GitBranch } from 'lucide-react';
import { listAgentProfiles } from '../../src/application/agent-profiles';
import { AGENT_PROFILE_DEFINITIONS, type FlowAgentId } from '../../src/domain/agent-profile';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const profiles = await listAgentProfiles();
  return <>
    <header><p className="eyebrow">AGENT RUNTIME</p><h1>Agent 配置</h1><p className="muted">管理当前项目实际使用的 Prompt、长期记忆和自动演化状态。文件保存在项目隔离的本地 Runtime Workspace，不进入目标仓库 Git。</p></header>
    <section className="agent-grid">
      {profiles.map((profile) => {
        const definition = AGENT_PROFILE_DEFINITIONS[profile.agent_id as FlowAgentId];
        return <Link href={`/agents/${profile.agent_id}`} className="card agent-card" key={profile.agent_id}>
          <div className="agent-card-head"><span className="executor-icon"><Bot size={18}/></span><span className={`badge ${profile.candidate_prompt_version ? 'amber' : profile.auto_evolve ? 'green' : 'blue'}`}>{profile.candidate_prompt_version ? `Canary · ${profile.canary_remaining}` : profile.auto_evolve ? '自动演化' : '仅手工'}</span></div>
          <div><h2>{definition.label}</h2><p className="muted">{definition.description}</p></div>
          <div className="agent-stats">
            <span><GitBranch size={14}/>Prompt v{profile.current_prompt_version}</span>
            <span><Database size={14}/>Memory r{profile.current_memory_revision}</span>
            <span><BrainCircuit size={14}/>{profile.observation_count} 条观察</span>
          </div>
          <small>{profile.execution_count} 次执行 · {profile.promoted_count} 条已提升经验</small>
        </Link>;
      })}
    </section>
  </>;
}
