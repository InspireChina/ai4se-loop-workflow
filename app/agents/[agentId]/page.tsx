import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BrainCircuit, MemoryStick, Sparkles } from 'lucide-react';
import { composeRolePrompt, getAgentProfile } from '../../../src/application/agent-profiles';
import { isFlowAgentId } from '../../../src/domain/agent-profile';
import { saveAgentMemoryAction, saveAgentPromptOverlayAction, setAgentAutoEvolutionAction } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  if (!isFlowAgentId(agentId)) notFound();
  const detail = await getAgentProfile(agentId);
  const selectedOverlay = detail.candidatePrompt || detail.currentOverlay;
  const effectivePrompt = [
    '# Harness Core Contract（只读）',
    '流程调度、权限、状态机和最小结果协议由 Harness 执行，专业语义由对应 Agent 判断，Agent Prompt 无权扩大权限。',
    '',
    `# Role Prompt · Base v${detail.currentPrompt.version} · Overlay r${selectedOverlay?.revision || 0}${detail.candidatePrompt ? ' Canary' : ''}`,
    composeRolePrompt(detail.currentPrompt, selectedOverlay),
    '',
    `# Durable Memory · r${detail.currentMemory.revision}`,
    detail.currentMemory.content,
  ].join('\n');

  return <>
    <header className="page-header"><div><Link className="crumb" href="/agents">Agent 配置</Link><p className="eyebrow">{agentId}</p><h1>{detail.definition.label}</h1><p className="muted">{detail.definition.description}</p></div><span className={`badge ${detail.candidatePrompt ? 'amber' : detail.profile.auto_evolve ? 'green' : 'blue'}`}>{detail.candidatePrompt ? `Overlay Canary r${detail.candidatePrompt.revision}` : detail.profile.auto_evolve ? '自动演化已开启' : '自动演化已关闭'}</span></header>

    <div className="agent-detail-grid">
      <div className="agent-editor-column">
        <section className="card settings agent-editor">
          <div className="settings-section-head"><span className="executor-icon"><BrainCircuit size={18}/></span><div><strong>Base Role Prompt</strong><p className="muted settings-description">由应用版本管理，只定义角色的稳定职责和原则；应用升级时会自动更新。</p></div><span className="badge">v{detail.currentPrompt.version}</span></div>
          <pre className="effective-prompt">{detail.currentPrompt.content}</pre>
        </section>

        <form action={saveAgentPromptOverlayAction} className="card settings agent-editor">
          <input type="hidden" name="agentId" value={agentId}/>
          <div className="settings-section-head"><span className="executor-icon"><Sparkles size={18}/></span><div><strong>Project Prompt Overlay</strong><p className="muted settings-description">保存当前项目特有的工作约束和演化规则；Base Prompt 升级时不会被覆盖。留空表示不追加项目规则。</p></div><span className="badge">r{detail.currentOverlay?.revision || 0}</span></div>
          <textarea className="code-editor" name="content" defaultValue={detail.currentOverlay?.content || ''} placeholder="例如：本项目的浏览器验证必须先启动测试数据服务。"/>
          <label>修改原因<input name="reason" placeholder="例如：明确浏览器验证前的环境探测顺序"/></label>
          <button className="button" type="submit">保存 Overlay</button>
        </form>

        <form action={saveAgentMemoryAction} className="card settings agent-editor">
          <input type="hidden" name="agentId" value={agentId}/>
          <div className="settings-section-head"><span className="executor-icon"><MemoryStick size={18}/></span><div><strong>Durable Memory</strong><p className="muted settings-description">只保存跨任务可复用、已经有证据支持的经验；运行观察保存在 daily memory。</p></div><span className="badge">r{detail.currentMemory.revision}</span></div>
          <textarea className="code-editor memory-editor" name="content" defaultValue={detail.currentMemory.content}/>
          <label>修改原因<input name="reason" placeholder="例如：补充项目测试工具的稳定用法"/></label>
          <button className="button" type="submit">保存长期记忆</button>
        </form>

        <section className="card settings">
          <div className="settings-section-head"><span className="executor-icon"><Sparkles size={18}/></span><div><strong>Effective Prompt 预览</strong><p className="muted settings-description">实际运行时还会追加当前任务上下文、相关 daily memory 和输出 Schema。</p></div></div>
          <pre className="effective-prompt">{effectivePrompt}</pre>
        </section>
      </div>

      <aside className="agent-side-column">
        <form action={setAgentAutoEvolutionAction} className="card settings">
          <input type="hidden" name="agentId" value={agentId}/>
          <strong>自动演化</strong>
          <p className="muted settings-description">Evaluator 只提出结构化经验；Harness 验证、累计证据并自动执行 Canary，失败时丢弃候选，不需要人工审批。</p>
          <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={Boolean(detail.profile.auto_evolve)}/>允许自动提升 Memory 和 Prompt Overlay</label>
          <button className="button secondary" type="submit">保存演化设置</button>
        </form>

        <section className="card settings">
          <strong>演化观察</strong>
          <div className="observation-list">{detail.observations.length ? detail.observations.map((observation) => <div key={observation.observation_id}>
            <span className="badge">{observation.target}</span><b>{observation.summary}</b>
            <p>{observation.guidance}</p><small>{observation.fingerprint} · {observation.occurrence_count} 次 · confidence {observation.confidence.toFixed(2)}</small>
          </div>) : <p className="muted">尚未产生可复用观察。</p>}</div>
        </section>

        <section className="card settings">
          <strong>Daily Memory</strong>
          <p className="muted settings-description">每轮观察先进入按日期记录的短期层；只有重复、跨需求且高置信的经验才会提升。</p>
          <div className="daily-memory-list">{detail.dailyMemories.length ? detail.dailyMemories.map((memory) => <details key={memory.name}>
            <summary>{memory.name}</summary><pre>{memory.content}</pre>
          </details>) : <p className="muted">尚无 daily memory。</p>}</div>
        </section>

        <section className="card settings">
          <strong>Runtime Workspace</strong>
          <p className="path-line">{detail.runtimeDirectory}</p>
          <small>{detail.dailyFiles.length} 个 daily memory 文件。PROMPT.md 是 Base 与 Overlay 的组合结果，只由数据库单向物化；该目录不进入目标仓库 Git。</small>
        </section>
      </aside>
    </div>
  </>;
}
