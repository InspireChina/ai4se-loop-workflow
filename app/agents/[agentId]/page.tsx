import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Activity, BookOpenText, BrainCircuit, CalendarDays, Check, CircleAlert, CircleDot, FolderCog, Gauge, MemoryStick, PencilLine, RotateCcw, Sparkles } from 'lucide-react';
import { getAgentProfile } from '../../../src/application/agent-profiles';
import { listAgentConfigurations } from '../../../src/application/agent-configurations';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS, OMP_THINKING_LEVELS, getAgentRuntimeSettings, getFlowAgentDefaultRuntimeSettings, listAgentRuntimeConfigurations } from '../../../src/application/project-settings';
import { AGENT_PROMPT_SEED_REVISION, isFlowAgentId } from '../../../src/domain/agent-profile';
import { MarkdownContent } from '../../../src/ui/markdown-content';
import { agentCommandChains, agentPipelineLabel } from '../../../src/domain/agent-command-profile';
import { resetAgentPromptAction, saveAgentMemoryAction, saveAgentPromptAction, setAgentAutoEvolutionAction } from '../../actions';
import { AgentConfigurationEditor } from './agent-configuration-editor';
import { AgentRuntimeConfigurationEditor } from './agent-runtime-configuration-editor';
import { listProjects } from '../../../src/application/projects';

export const dynamic = 'force-dynamic';

const agentSections = [
  { id: 'runtime', label: '运行参数', description: '全局 CLI、模型与配置切换', icon: Gauge },
  { id: 'commands', label: '命令链', description: '阶段顺序与终止动作', icon: CircleDot },
  { id: 'prompt', label: 'Prompt', description: '当前项目 Agent Overlay', icon: BrainCircuit },
  { id: 'memory', label: 'Memory', description: '当前项目长期经验与观察', icon: MemoryStick },
  { id: 'evolution', label: '演化', description: '策略、候选与观察', icon: Sparkles },
  { id: 'diagnostics', label: '诊断', description: '生效输入与 Runtime 文件', icon: Activity },
] as const;

const agentSectionGroups = [
  { label: '角色与运行', items: agentSections.slice(0, 2) },
  { label: '知识与优化', items: agentSections.slice(2, 4) },
  { label: '诊断', items: agentSections.slice(4) },
] as const;

type AgentSection = typeof agentSections[number]['id'];

function selectedSection(input: string | string[] | undefined): AgentSection {
  const value = Array.isArray(input) ? input[0] : input;
  return agentSections.some((section) => section.id === value) ? value as AgentSection : 'runtime';
}

function dailyMemoryLabel(name: string) {
  return name.replace(/\.md$/i, '');
}

function dailyMemoryBody(content: string) {
  return content
    .replace(/^#\s+[^\n]+\n*/u, '')
    .replace(/<!--[^]*?-->\s*/gu, '')
    .trim();
}

export default async function AgentDetailPage({ params, searchParams }: { params: Promise<{ agentId: string }>; searchParams: Promise<{ section?: string | string[]; project?: string | string[]; memoryMode?: string | string[]; memoryError?: string | string[]; memoryPromoted?: string | string[] }> }) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);
  if (!isFlowAgentId(agentId)) notFound();
  const projects = await listProjects();
  const requestedProjectId = Array.isArray(query.project) ? query.project[0] : query.project;
  const currentProject = projects.find((project) => project.project_id === requestedProjectId)
    || projects.find((project) => project.is_default)
    || projects[0];
  if (!currentProject) notFound();
  const [detail, runtimeSettings, flowDefaults, runtimeConfigurations, agentConfigurations] = await Promise.all([
    getAgentProfile(agentId, true, currentProject.project_id),
    getAgentRuntimeSettings(agentId),
    getFlowAgentDefaultRuntimeSettings(),
    Promise.resolve(listAgentRuntimeConfigurations(agentId)),
    Promise.resolve(listAgentConfigurations(agentId)),
  ]);
  const section = selectedSection(query.section);
  const memoryMode = Array.isArray(query.memoryMode) ? query.memoryMode[0] : query.memoryMode;
  const editingMemory = memoryMode === 'edit';
  const memoryError = Array.isArray(query.memoryError) ? query.memoryError[0] : query.memoryError;
  const memoryPromoted = Array.isArray(query.memoryPromoted) ? query.memoryPromoted[0] : query.memoryPromoted;
  const overlayUsesGlobalBaseline = detail.projectOverlay.content.trim() === detail.currentPrompt.content.trim() && !detail.candidatePrompt;
  const selectedOverlay = detail.candidatePrompt || detail.projectOverlay;
  const agentHref = (targetSection: AgentSection, extra: Record<string, string> = {}) => {
    const parameters = new URLSearchParams({ section: targetSection, project: currentProject.project_id, ...extra });
    return `/agents/${agentId}?${parameters}`;
  };
  const effectivePrompt = [
    '# Harness Core Contract（只读）',
    '流程调度、权限、状态机和最小结果协议由 Harness 执行，专业语义由对应 Agent 判断，Agent Prompt 无权扩大权限。',
    '',
    `# ${currentProject.name} · Project Prompt Overlay · r${selectedOverlay.revision}${detail.candidatePrompt ? ' Canary' : ''}`,
    `# 基线：全局角色模板 V${AGENT_PROMPT_SEED_REVISION}`,
    selectedOverlay.content,
    '',
    `# Durable Memory · r${detail.currentMemory.revision}`,
    detail.currentMemory.content,
  ].join('\n');
  const commandChains = agentCommandChains(agentId);

  return <>
    <header className="page-header agent-page-header"><div><Link className="crumb" href="/agents">Agent 配置</Link><p className="eyebrow">{agentId}</p><h1>{detail.definition.label}</h1><p className="muted">{detail.definition.description}</p></div><div className="agent-header-actions"><form className="agent-project-switcher" method="get"><input type="hidden" name="section" value={section}/><label><span className="agent-project-label"><FolderCog size={14}/>项目</span><select aria-label="当前项目" name="project" defaultValue={currentProject.project_id}>{projects.map((project) => <option value={project.project_id} key={project.project_id}>{project.name}{project.is_default ? '（默认）' : ''}</option>)}</select></label><button className="button secondary" type="submit">应用</button></form><span className={`badge agent-evolution-badge ${detail.candidatePrompt ? 'amber' : detail.profile.auto_evolve ? 'green' : 'blue'}`}>{detail.candidatePrompt ? `Overlay Canary r${detail.candidatePrompt.revision}` : detail.profile.auto_evolve ? '项目演化已开启' : '项目演化已关闭'}</span></div></header>

    <div className="settings-layout agent-settings-layout">
      <nav className="card settings-navigation agent-section-nav" aria-label="Agent 配置目录">
        <div className="settings-navigation-head"><strong>配置目录</strong><small>管理当前 Agent</small></div>
        {agentSectionGroups.map((group, groupIndex) => <section className="settings-navigation-section" key={group.label}>
          <div className="settings-navigation-group"><span>{groupIndex + 1}</span><strong>{group.label}</strong></div>
          <div className="settings-navigation-items">
            {group.items.map((item) => {
              const Icon = item.icon;
              return <Link className="agent-section-link" key={item.id} href={agentHref(item.id)} aria-current={section === item.id ? 'page' : undefined}>
                <Icon size={16}/><span><strong>{item.label}</strong><small>{item.description}</small></span>
              </Link>;
            })}
          </div>
        </section>)}
      </nav>

      <div className="agent-workspace">
        <section className="agent-profile-summary" aria-label="Agent 配置摘要">
          <div><span>Runtime</span><strong>{runtimeSettings.executorId}</strong><small>{runtimeSettings.source === 'global_default' ? '跟随流程默认' : runtimeSettings.configurationName}</small></div>
          <div><span>Project Overlay</span><strong>r{detail.projectOverlay.revision}</strong><small>{currentProject.name} · {overlayUsesGlobalBaseline ? '使用全局基线' : '已覆盖'}</small></div>
          <div><span>Project Memory</span><strong>r{detail.currentMemory.revision}</strong><small>{detail.dailyFiles.length} 个 daily 文件</small></div>
          <div><span>演化证据</span><strong>{detail.observations.length}</strong><small>条可复用观察</small></div>
        </section>
      {section === 'runtime' && <AgentRuntimeConfigurationEditor
        agentId={agentId}
        initialConfigurations={runtimeConfigurations}
        initialEffective={runtimeSettings}
        flowDefault={flowDefaults}
        executorOptions={AGENT_EXECUTOR_OPTIONS}
        codexModelOptions={CODEX_MODEL_OPTIONS}
        reasoningEfforts={CODEX_REASONING_EFFORTS}
        ompThinkingLevels={OMP_THINKING_LEVELS}
      />}

      {section === 'commands' && <div className="agent-command-layout">
        <div className="agent-command-main"><AgentConfigurationEditor agentId={agentId} initialConfigurations={agentConfigurations}/></div>
        <aside className="agent-section-aside agent-command-aside">
          <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><CircleDot size={18}/></span><div><strong>当前生效调用链</strong><p className="muted settings-description">根据当前启用配置编译，只展示 Agent 实际经历的阶段。</p></div><span className="badge">生效中</span></div>
          <div className="command-chain-list">{commandChains.map((chain) => <article className="command-chain" key={chain.pipeline}>
            <div className="command-chain-head"><div><span className="badge">{agentPipelineLabel(chain.pipeline)}</span></div><small>{chain.phases.length} 个阶段</small></div>
            {chain.configurationError ? <div className="agent-command-configuration-error"><CircleAlert size={16}/><div><strong>当前命令链配置无效</strong><p>{chain.configurationError}</p></div></div> : <><div className="command-chain-phases" aria-label={`${agentPipelineLabel(chain.pipeline)} 阶段顺序`}>
              {chain.phases.map((phase, index) => <div className="command-chain-phase-wrap" key={`${chain.pipeline}:${phase.id}`}>
                <section className="command-chain-phase">
                  <header><span className="command-chain-index">{index + 1}</span><div><strong>{phase.title}</strong></div><span className={`badge command-chain-type ${phase.type}`}>{phase.type}</span></header>
                </section>
              </div>)}
            </div>
            <div className="command-chain-terminal"><span className="command-chain-terminal-icon"><Check size={14}/></span><div><strong>完成</strong><small>最终阶段通过后结束本次执行</small></div></div></>}
          </article>)}</div>
          </section>
        </aside>
      </div>}

      {section === 'prompt' && <div className="agent-section-layout">
        <form action={saveAgentPromptAction} className="card settings agent-editor agent-section-card">
          <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="projectId" value={currentProject.project_id}/><input type="hidden" name="section" value="prompt"/>
          <div className="settings-section-head"><span className="executor-icon"><BrainCircuit size={18}/></span><div><strong>{currentProject.name} · Agent Overlay</strong><p className="muted settings-description">基于全局角色模板初始化完整 Prompt；保存修改后，当前项目直接使用这里的版本覆盖全局基线。</p></div><span className="badge">r{detail.projectOverlay.revision}</span></div>
          <textarea className="code-editor" name="content" defaultValue={detail.projectOverlay.content}/>
          <label>修改原因<input name="reason" placeholder="例如：补充当前项目的浏览器验证顺序"/></label>
          <button className="button" type="submit">保存项目 Overlay</button>
        </form>
        <aside className="agent-section-aside">
          <section className="card settings agent-context-note"><strong>作用范围</strong><p className="muted settings-description">已发生的 execution 保留当时的输入快照；这里的修改只影响 {currentProject.name} 此后新启动的执行。</p><span className="badge green">仅当前项目</span></section>
          <form action={resetAgentPromptAction} className="card settings agent-danger-card">
            <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="projectId" value={currentProject.project_id}/><input type="hidden" name="section" value="prompt"/>
            <div className="settings-section-head"><span className="executor-icon"><RotateCcw size={18}/></span><div><strong>恢复全局基线</strong><p className="muted settings-description">用当前全局角色模板覆盖项目版本；当前项目 Memory 不变。</p></div></div>
            <span className={`badge ${overlayUsesGlobalBaseline ? 'green' : 'amber'}`}>{overlayUsesGlobalBaseline ? '正在使用基线' : '项目已覆盖'}</span>
            <label className="checkbox"><input type="checkbox" name="confirm" required disabled={overlayUsesGlobalBaseline}/>我确认恢复当前项目 Prompt</label>
            <button className="button secondary" type="submit" disabled={overlayUsesGlobalBaseline}>恢复全局基线</button>
          </form>
        </aside>
      </div>}

      {section === 'memory' && <div className="memory-section-stack">
        {memoryError && <p className="memory-operation-message error">加入 Durable Memory 失败：{memoryError}</p>}
        {memoryPromoted === '1' && <p className="memory-operation-message success"><Check size={15}/>观察已加入 Durable Memory。</p>}
        <section className="card settings agent-section-card memory-card">
          <div className="settings-section-head memory-section-head">
            <span className="executor-icon"><MemoryStick size={18}/></span>
            <div><strong>{currentProject.name} · Durable Memory</strong><p className="muted settings-description">仅在当前项目内跨任务复用的稳定经验。默认以文档方式阅读，需要修改时再进入编辑模式。</p></div>
            <div className="memory-head-actions"><span className="badge">r{detail.currentMemory.revision}</span>{editingMemory
              ? <Link className="button secondary memory-mode-button" href={agentHref('memory')}><BookOpenText size={15}/>返回阅读</Link>
              : <Link className="button secondary memory-mode-button" href={agentHref('memory', { memoryMode: 'edit' })}><PencilLine size={15}/>编辑</Link>}
            </div>
          </div>
          {editingMemory ? <form action={saveAgentMemoryAction} className="agent-editor memory-edit-form">
            <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="projectId" value={currentProject.project_id}/><input type="hidden" name="section" value="memory"/>
            <textarea className="code-editor memory-editor" name="content" defaultValue={detail.currentMemory.content}/>
            <label>修改原因<input name="reason" placeholder="例如：补充项目测试工具的稳定用法"/></label>
            <div className="form-actions"><button className="button" type="submit">保存长期记忆</button><Link className="button secondary" href={agentHref('memory')}>取消</Link></div>
          </form> : <div className="memory-document"><MarkdownContent content={detail.currentMemory.content}/></div>}
        </section>

        <section className="card settings agent-section-card daily-memory-card">
          <div className="settings-section-head">
            <span className="executor-icon"><CalendarDays size={18}/></span>
            <div><strong>{currentProject.name} · Daily Memory</strong><p className="muted settings-description">按日期浏览当前项目的短期观察；最新一天默认展开，内容以 Markdown 排版显示。</p></div>
            <span className="badge">最近 {detail.dailyMemories.length} / {detail.dailyFiles.length} 天</span>
          </div>
          <div className="daily-memory-list">{detail.dailyMemories.length ? detail.dailyMemories.map((memory, index) => {
            return <details key={memory.name} open={index === 0}>
              <summary><span className="daily-memory-icon"><CalendarDays size={16}/></span><span><strong>{dailyMemoryLabel(memory.name)}</strong><small>{memory.observations.length} 条观察</small></span>{index === 0 && <span className="badge green">最新</span>}</summary>
              <div className="daily-memory-observations">{memory.observations.length ? memory.observations.map((observation) => <article className="daily-observation" key={`${observation.executionId}:${observation.fingerprint}`}>
                <div className="daily-observation-actions">{observation.promoted
                  ? <span className="badge green"><Check size={13}/>已加入 Durable Memory</span>
                  : <form action={`/agents/${agentId}/memory/promote`} method="post">
                    <input type="hidden" name="projectId" value={currentProject.project_id}/><input type="hidden" name="memoryName" value={memory.name}/><input type="hidden" name="executionId" value={observation.executionId}/><input type="hidden" name="fingerprint" value={observation.fingerprint}/>
                    <button className="button secondary daily-promote-button" type="submit"><MemoryStick size={14}/>加入 Durable Memory</button>
                  </form>}
                </div>
                <div className="daily-memory-document"><MarkdownContent content={observation.content}/></div>
              </article>) : <div className="daily-memory-document"><MarkdownContent content={dailyMemoryBody(memory.content)}/></div>}</div>
            </details>;
          }) : <div className="memory-empty"><CalendarDays size={20}/><p className="muted">尚无 daily memory；Agent 产生可复用观察后会按日期显示在这里。</p></div>}</div>
        </section>
      </div>}

      {section === 'evolution' && <div className="agent-section-layout">
        <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><Sparkles size={18}/></span><div><strong>{currentProject.name} · 演化观察</strong><p className="muted settings-description">Evaluator 从当前项目的真实 execution 中提取候选经验；Harness 决定是否提升。</p></div><span className="badge">{detail.observations.length} 条</span></div>
          <div className="observation-list">{detail.observations.length ? detail.observations.map((observation) => <div key={observation.observation_id}>
            <span className="badge">{observation.target}</span><b>{observation.summary}</b>
            <p>{observation.guidance}</p><small>{observation.fingerprint} · {observation.occurrence_count} 次 · confidence {observation.confidence.toFixed(2)}</small>
          </div>) : <p className="muted">尚未产生可复用观察。</p>}</div>
        </section>
        <aside className="agent-section-aside">
          <form action={setAgentAutoEvolutionAction} className="card settings">
            <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="projectId" value={currentProject.project_id}/><input type="hidden" name="section" value="evolution"/>
            <strong>自动演化策略</strong>
            <p className="muted settings-description">仅对当前项目提升 Memory 和生成 Overlay 候选；用户保存 Overlay 会立即取代候选。</p>
            <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={Boolean(detail.profile.auto_evolve)}/>启用自动演化</label>
            <button className="button secondary" type="submit">保存演化设置</button>
          </form>
          <section className="card settings"><strong>当前 Overlay 候选</strong>{detail.candidatePrompt ? <><span className="badge amber">Canary r{detail.candidatePrompt.revision}</span><p className="muted settings-description">仍需 {detail.profile.canary_remaining} 次当前项目的成功执行。</p></> : <p className="muted settings-description">当前项目没有等待验证的 Overlay Canary。</p>}</section>
        </aside>
      </div>}

      {section === 'diagnostics' && <div className="agent-section-layout">
        <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><Activity size={18}/></span><div><strong>Effective Prompt 预览</strong><p className="muted settings-description">实际运行时还会追加当前任务上下文、相关 daily memory 和输出 Schema。</p></div><span className="badge">只读</span></div>
          <pre className="effective-prompt">{effectivePrompt}</pre>
        </section>
        <aside className="agent-section-aside">
          <section className="card settings"><div className="settings-section-head"><span className="executor-icon"><FolderCog size={18}/></span><div><strong>Runtime Workspace</strong><p className="muted settings-description">项目隔离的运行时物化目录。</p></div></div><p className="path-line">{detail.runtimeDirectory}</p><small>{detail.dailyFiles.length} 个 daily memory 文件。PROMPT.md 由数据库单向物化，不进入目标仓库 Git。</small></section>
          <section className="card settings"><strong>输入版本</strong><div className="diagnostic-facts"><span>Role</span><b>V{detail.currentPrompt.template_version}</b><span>Overlay</span><b>r{selectedOverlay.revision}</b><span>Memory</span><b>r{detail.currentMemory.revision}</b></div></section>
        </aside>
      </div>}
      </div>
    </div>
  </>;
}
