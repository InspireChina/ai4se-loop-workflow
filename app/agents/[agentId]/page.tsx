import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Activity, Bot, BrainCircuit, Check, FolderCog, Gauge, MemoryStick, RotateCcw, Sparkles } from 'lucide-react';
import { getAgentProfile } from '../../../src/application/agent-profiles';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS, getAgentRuntimeSettings } from '../../../src/application/project-settings';
import { AGENT_PROMPT_SEED_REVISION, isFlowAgentId } from '../../../src/domain/agent-profile';
import { resetAgentPromptAction, saveAgentMemoryAction, saveAgentPromptAction, saveAgentRuntimeAction, setAgentAutoEvolutionAction } from '../../actions';

export const dynamic = 'force-dynamic';

const agentSections = [
  { id: 'runtime', label: '运行参数', description: 'CLI、模型与思考强度', icon: Gauge },
  { id: 'prompt', label: 'Prompt', description: '项目角色指令与系统模板', icon: BrainCircuit },
  { id: 'memory', label: 'Memory', description: '长期经验与每日观察', icon: MemoryStick },
  { id: 'evolution', label: '演化', description: '策略、候选与观察', icon: Sparkles },
  { id: 'diagnostics', label: '诊断', description: '生效输入与 Runtime 文件', icon: Activity },
] as const;

type AgentSection = typeof agentSections[number]['id'];

function selectedSection(input: string | string[] | undefined): AgentSection {
  const value = Array.isArray(input) ? input[0] : input;
  return agentSections.some((section) => section.id === value) ? value as AgentSection : 'runtime';
}

export default async function AgentDetailPage({ params, searchParams }: { params: Promise<{ agentId: string }>; searchParams: Promise<{ section?: string | string[] }> }) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);
  if (!isFlowAgentId(agentId)) notFound();
  const [detail, runtimeSettings] = await Promise.all([
    getAgentProfile(agentId),
    getAgentRuntimeSettings(agentId),
  ]);
  const section = selectedSection(query.section);
  const usesLatestSystemTemplate = detail.currentPrompt.content.trim() === detail.definition.prompt.trim()
    && detail.currentPrompt.template_version === AGENT_PROMPT_SEED_REVISION
    && !detail.candidatePrompt;
  const selectedPrompt = detail.candidatePrompt || detail.currentPrompt;
  const effectivePrompt = [
    '# Harness Core Contract（只读）',
    '流程调度、权限、状态机和最小结果协议由 Harness 执行，专业语义由对应 Agent 判断，Agent Prompt 无权扩大权限。',
    '',
    `# Project Agent Prompt · r${detail.candidatePrompt?.revision || detail.currentPrompt.version}${detail.candidatePrompt ? ' Canary' : ''}`,
    selectedPrompt.content,
    '',
    `# Durable Memory · r${detail.currentMemory.revision}`,
    detail.currentMemory.content,
  ].join('\n');

  return <>
    <header className="page-header agent-page-header"><div><Link className="crumb" href="/agents">Agent 配置</Link><p className="eyebrow">{agentId}</p><h1>{detail.definition.label}</h1><p className="muted">{detail.definition.description}</p></div><span className={`badge ${detail.candidatePrompt ? 'amber' : detail.profile.auto_evolve ? 'green' : 'blue'}`}>{detail.candidatePrompt ? `Prompt Canary r${detail.candidatePrompt.revision}` : detail.profile.auto_evolve ? '自动演化已开启' : '自动演化已关闭'}</span></header>

    <section className="agent-profile-summary" aria-label="Agent 配置摘要">
      <div><span>Runtime</span><strong>{runtimeSettings.executorId}</strong><small>{runtimeSettings.codexModel}</small></div>
      <div><span>Project Prompt</span><strong>r{detail.currentPrompt.version}</strong><small>{detail.candidatePrompt ? `Canary r${detail.candidatePrompt.revision}` : '当前生效版本'}</small></div>
      <div><span>Durable Memory</span><strong>r{detail.currentMemory.revision}</strong><small>{detail.dailyFiles.length} 个 daily 文件</small></div>
      <div><span>演化证据</span><strong>{detail.observations.length}</strong><small>条可复用观察</small></div>
    </section>

    <nav className="card agent-section-nav" aria-label="Agent 详情分区">
      {agentSections.map((item) => {
        const Icon = item.icon;
        return <Link key={item.id} href={`/agents/${agentId}?section=${item.id}`} aria-current={section === item.id ? 'page' : undefined}>
          <Icon size={17}/><span><strong>{item.label}</strong><small>{item.description}</small></span>
        </Link>;
      })}
    </nav>

    <div className="agent-workspace">
      {section === 'runtime' && <form action={saveAgentRuntimeAction} className="card settings agent-section-card">
        <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="runtime"/>
        <div className="settings-section-head"><span className="executor-icon"><Bot size={18}/></span><div><strong>Agent Runtime</strong><p className="muted settings-description">只控制当前 Agent 的执行 CLI 和模型参数。该 Agent 产生的 Prompt 演化评估也沿用这组配置。</p></div><span className="badge">{runtimeSettings.executorId}</span></div>
        <fieldset className="executor-settings">
          <legend>执行器</legend>
          <p className="muted">所选 CLI 需要已在本机登录；修改只影响此后新启动的执行。</p>
          <div className="executor-options">
            {AGENT_EXECUTOR_OPTIONS.map((option) => <label className="executor-option" key={option.id}>
              <input type="radio" name="agentExecutor" value={option.id} defaultChecked={runtimeSettings.executorId === option.id}/>
              <span className="executor-icon"><Bot size={18}/></span>
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
              <Check className="executor-check" size={17}/>
            </label>)}
          </div>
        </fieldset>
        <fieldset className="codex-settings">
          <legend>Codex 执行参数</legend>
          <div className="fields">
            <label>模型
              <select name="codexModel" defaultValue={runtimeSettings.codexModel}>
                {CODEX_MODEL_OPTIONS.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
              </select>
            </label>
            <label>思考强度
              <select name="codexReasoningEffort" defaultValue={runtimeSettings.codexReasoningEffort}>
                {CODEX_REASONING_EFFORTS.map((effort) => <option value={effort} key={effort}>{effort === 'default' ? '跟随 Codex 默认值' : effort}</option>)}
              </select>
            </label>
          </div>
        </fieldset>
        <fieldset className="claude-settings">
          <legend>Claude 执行参数</legend>
          <div className="fields"><label>模型<input name="claudeModel" defaultValue={runtimeSettings.claudeModel} placeholder="例如 sonnet、opus 或完整模型 ID" spellCheck={false}/><small className="muted">留空时跟随 Claude CLI 默认模型。</small></label></div>
        </fieldset>
        <button className="button" type="submit">保存运行参数</button>
      </form>}

      {section === 'prompt' && <div className="agent-section-layout">
        <form action={saveAgentPromptAction} className="card settings agent-editor agent-section-card">
          <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="prompt"/>
          <div className="settings-section-head"><span className="executor-icon"><BrainCircuit size={18}/></span><div><strong>Project Agent Prompt</strong><p className="muted settings-description">当前项目独立持有的完整 Prompt。首次由系统模板初始化，之后完全由当前项目管理。</p></div><span className="badge">r{detail.currentPrompt.version}</span></div>
          <textarea className="code-editor" name="content" defaultValue={detail.currentPrompt.content}/>
          <label>修改原因<input name="reason" placeholder="例如：明确浏览器验证前的环境探测顺序"/></label>
          <button className="button" type="submit">保存 Prompt</button>
        </form>
        <aside className="agent-section-aside">
          <section className="card settings agent-context-note"><strong>版本边界</strong><p className="muted settings-description">已发生的 execution 保留当时的 Prompt 快照；这里的修改只影响此后新启动的执行。</p><span className={`badge ${detail.candidatePrompt ? 'amber' : 'green'}`}>{detail.candidatePrompt ? `存在 Canary r${detail.candidatePrompt.revision}` : '无临时候选'}</span></section>
          <form action={resetAgentPromptAction} className="card settings agent-danger-card">
            <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="prompt"/>
            <div className="settings-section-head"><span className="executor-icon"><RotateCcw size={18}/></span><div><strong>系统模板</strong><p className="muted settings-description">替换当前项目 Prompt；Memory 不变，未完成 Canary 会被清除。</p></div></div>
            <span className={`badge ${usesLatestSystemTemplate ? 'green' : 'amber'}`}>{usesLatestSystemTemplate ? '已是最新' : `可重置到 V${AGENT_PROMPT_SEED_REVISION}`}</span>
            <label className="checkbox"><input type="checkbox" name="confirm" required disabled={usesLatestSystemTemplate}/>我确认覆盖当前 Prompt</label>
            <button className="button secondary" type="submit" disabled={usesLatestSystemTemplate}>重置为最新模板</button>
          </form>
        </aside>
      </div>}

      {section === 'memory' && <div className="agent-section-layout">
        <form action={saveAgentMemoryAction} className="card settings agent-editor agent-section-card">
          <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="memory"/>
          <div className="settings-section-head"><span className="executor-icon"><MemoryStick size={18}/></span><div><strong>Durable Memory</strong><p className="muted settings-description">只保存跨任务可复用、已经有证据支持的经验；运行观察保存在 daily memory。</p></div><span className="badge">r{detail.currentMemory.revision}</span></div>
          <textarea className="code-editor memory-editor" name="content" defaultValue={detail.currentMemory.content}/>
          <label>修改原因<input name="reason" placeholder="例如：补充项目测试工具的稳定用法"/></label>
          <button className="button" type="submit">保存长期记忆</button>
        </form>
        <aside className="card settings agent-section-aside-card">
          <div><strong>Daily Memory</strong><p className="muted settings-description">每轮观察先进入短期层；重复、跨需求且高置信的经验才会提升。</p></div>
          <div className="daily-memory-list">{detail.dailyMemories.length ? detail.dailyMemories.map((memory) => <details key={memory.name}><summary>{memory.name}</summary><pre>{memory.content}</pre></details>) : <p className="muted">尚无 daily memory。</p>}</div>
        </aside>
      </div>}

      {section === 'evolution' && <div className="agent-section-layout">
        <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><Sparkles size={18}/></span><div><strong>演化观察</strong><p className="muted settings-description">Evaluator 从真实 execution 中提取候选经验；Harness 决定是否提升。</p></div><span className="badge">{detail.observations.length} 条</span></div>
          <div className="observation-list">{detail.observations.length ? detail.observations.map((observation) => <div key={observation.observation_id}>
            <span className="badge">{observation.target}</span><b>{observation.summary}</b>
            <p>{observation.guidance}</p><small>{observation.fingerprint} · {observation.occurrence_count} 次 · confidence {observation.confidence.toFixed(2)}</small>
          </div>) : <p className="muted">尚未产生可复用观察。</p>}</div>
        </section>
        <aside className="agent-section-aside">
          <form action={setAgentAutoEvolutionAction} className="card settings">
            <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="evolution"/>
            <strong>自动演化策略</strong>
            <p className="muted settings-description">允许提升 Memory 和生成完整 Prompt 候选；用户保存 Prompt 会立即取代候选。</p>
            <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={Boolean(detail.profile.auto_evolve)}/>启用自动演化</label>
            <button className="button secondary" type="submit">保存演化设置</button>
          </form>
          <section className="card settings"><strong>当前候选</strong>{detail.candidatePrompt ? <><span className="badge amber">Canary r{detail.candidatePrompt.revision}</span><p className="muted settings-description">仍需 {detail.profile.canary_remaining} 次成功执行。</p></> : <p className="muted settings-description">当前没有等待验证的 Prompt Canary。</p>}</section>
        </aside>
      </div>}

      {section === 'diagnostics' && <div className="agent-section-layout">
        <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><Activity size={18}/></span><div><strong>Effective Prompt 预览</strong><p className="muted settings-description">实际运行时还会追加当前任务上下文、相关 daily memory 和输出 Schema。</p></div><span className="badge">只读</span></div>
          <pre className="effective-prompt">{effectivePrompt}</pre>
        </section>
        <aside className="agent-section-aside">
          <section className="card settings"><div className="settings-section-head"><span className="executor-icon"><FolderCog size={18}/></span><div><strong>Runtime Workspace</strong><p className="muted settings-description">项目隔离的运行时物化目录。</p></div></div><p className="path-line">{detail.runtimeDirectory}</p><small>{detail.dailyFiles.length} 个 daily memory 文件。PROMPT.md 由数据库单向物化，不进入目标仓库 Git。</small></section>
          <section className="card settings"><strong>输入版本</strong><div className="diagnostic-facts"><span>Prompt</span><b>r{detail.currentPrompt.version}</b><span>Memory</span><b>r{detail.currentMemory.revision}</b><span>Template</span><b>V{detail.currentPrompt.template_version}</b></div></section>
        </aside>
      </div>}
    </div>
  </>;
}
