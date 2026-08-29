import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Activity, ArrowRight, BookOpenText, Bot, BrainCircuit, CalendarDays, Check, CircleDot, FolderCog, Gauge, MemoryStick, PencilLine, RotateCcw, Sparkles } from 'lucide-react';
import { getAgentProfile } from '../../../src/application/agent-profiles';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS, OMP_THINKING_LEVELS, getAgentRuntimeSettings, getFlowAgentDefaultRuntimeSettings } from '../../../src/application/project-settings';
import { AGENT_PROMPT_SEED_REVISION, isFlowAgentId } from '../../../src/domain/agent-profile';
import { MarkdownContent } from '../../../src/ui/markdown-content';
import { agentCommandChains, agentCommandProfile, agentContextCommandPrefix, agentPipelineLabel, loopAgentCommandPrefix } from '../../../src/domain/agent-command-profile';
import { resetAgentPromptAction, saveAgentMemoryAction, saveAgentPromptAction, saveAgentRuntimeAction, setAgentAutoEvolutionAction } from '../../actions';

export const dynamic = 'force-dynamic';

const agentSections = [
  { id: 'runtime', label: '运行参数', description: 'CLI、模型与思考强度', icon: Gauge },
  { id: 'commands', label: '命令链', description: '阶段顺序与终止动作', icon: CircleDot },
  { id: 'prompt', label: 'Prompt', description: '项目角色指令与系统模板', icon: BrainCircuit },
  { id: 'memory', label: 'Memory', description: '长期经验与每日观察', icon: MemoryStick },
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

export default async function AgentDetailPage({ params, searchParams }: { params: Promise<{ agentId: string }>; searchParams: Promise<{ section?: string | string[]; runtimeMode?: string | string[]; memoryMode?: string | string[]; memoryError?: string | string[]; memoryPromoted?: string | string[] }> }) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);
  if (!isFlowAgentId(agentId)) notFound();
  const [detail, runtimeSettings, flowDefaults] = await Promise.all([
    getAgentProfile(agentId),
    getAgentRuntimeSettings(agentId),
    getFlowAgentDefaultRuntimeSettings(),
  ]);
  const section = selectedSection(query.section);
  const runtimeMode = Array.isArray(query.runtimeMode) ? query.runtimeMode[0] : query.runtimeMode;
  const editingIndependentRuntime = runtimeSettings.source === 'agent_override' || runtimeMode === 'override';
  const memoryMode = Array.isArray(query.memoryMode) ? query.memoryMode[0] : query.memoryMode;
  const editingMemory = memoryMode === 'edit';
  const memoryError = Array.isArray(query.memoryError) ? query.memoryError[0] : query.memoryError;
  const memoryPromoted = Array.isArray(query.memoryPromoted) ? query.memoryPromoted[0] : query.memoryPromoted;
  const flowRuntimeSummary = flowDefaults.executorId === 'codex'
    ? `${flowDefaults.executorId} · ${flowDefaults.codexModel} · ${flowDefaults.codexReasoningEffort}${flowDefaults.codexWebSearch ? ' · 实时网页搜索' : ''}`
    : flowDefaults.executorId === 'claude'
      ? `${flowDefaults.executorId} · ${flowDefaults.claudeModel || 'CLI 默认模型'}`
      : flowDefaults.executorId === 'omp'
        ? `Oh My Pi · ${flowDefaults.ompModel || 'OMP 默认模型'} · ${flowDefaults.ompThinking === 'default' ? '默认思考强度' : flowDefaults.ompThinking}`
      : `${flowDefaults.executorId} · CLI 默认模型`;
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
  const commandChains = agentCommandChains(agentId);
  const commandProfile = commandChains.length ? agentCommandProfile(agentId, commandChains[0].pipeline) : null;
  const commandPrefix = loopAgentCommandPrefix(process.cwd());
  const contextPrefix = agentContextCommandPrefix(process.cwd());

  return <>
    <header className="page-header agent-page-header"><div><Link className="crumb" href="/agents">Agent 配置</Link><p className="eyebrow">{agentId}</p><h1>{detail.definition.label}</h1><p className="muted">{detail.definition.description}</p></div><span className={`badge ${detail.candidatePrompt ? 'amber' : detail.profile.auto_evolve ? 'green' : 'blue'}`}>{detail.candidatePrompt ? `Prompt Canary r${detail.candidatePrompt.revision}` : detail.profile.auto_evolve ? '自动演化已开启' : '自动演化已关闭'}</span></header>

    <div className="settings-layout agent-settings-layout">
      <nav className="card settings-navigation agent-section-nav" aria-label="Agent 配置目录">
        <div className="settings-navigation-head"><strong>配置目录</strong><small>管理当前 Agent</small></div>
        {agentSectionGroups.map((group, groupIndex) => <section className="settings-navigation-section" key={group.label}>
          <div className="settings-navigation-group"><span>{groupIndex + 1}</span><strong>{group.label}</strong></div>
          <div className="settings-navigation-items">
            {group.items.map((item) => {
              const Icon = item.icon;
              return <Link className="agent-section-link" key={item.id} href={`/agents/${agentId}?section=${item.id}`} aria-current={section === item.id ? 'page' : undefined}>
                <Icon size={16}/><span><strong>{item.label}</strong><small>{item.description}</small></span>
              </Link>;
            })}
          </div>
        </section>)}
      </nav>

      <div className="agent-workspace">
        <section className="agent-profile-summary" aria-label="Agent 配置摘要">
          <div><span>Runtime</span><strong>{runtimeSettings.executorId}</strong><small>{runtimeSettings.source === 'project_default' ? '跟随项目默认' : 'Agent 独立覆盖'}</small></div>
          <div><span>Project Prompt</span><strong>r{detail.currentPrompt.version}</strong><small>{detail.candidatePrompt ? `Canary r${detail.candidatePrompt.revision}` : '当前生效版本'}</small></div>
          <div><span>Durable Memory</span><strong>r{detail.currentMemory.revision}</strong><small>{detail.dailyFiles.length} 个 daily 文件</small></div>
          <div><span>演化证据</span><strong>{detail.observations.length}</strong><small>条可复用观察</small></div>
        </section>
      {section === 'runtime' && !editingIndependentRuntime && <section className="card settings agent-section-card">
        <div className="settings-section-head"><span className="executor-icon"><Bot size={18}/></span><div><strong>Agent Runtime</strong><p className="muted settings-description">当前 Agent 跟随项目默认 Runtime；项目默认值发生变化时会自动生效。</p></div><span className="badge green">项目默认</span></div>
        <div><strong>当前生效配置</strong><p className="path-line">{flowRuntimeSummary}</p></div>
        <div className="form-actions"><Link className="button" href={`/agents/${agentId}?section=runtime&runtimeMode=override`}>改为独立配置</Link><Link className="button secondary" href="/settings">修改项目默认</Link></div>
      </section>}

      {section === 'commands' && <div className="agent-command-layout">
        <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><CircleDot size={18}/></span><div><strong>Agent 命令链</strong><p className="muted settings-description">只读展示 Harness 为当前 Agent 提供的正常推进路径，便于检查阶段是否过多、职责是否重复或终止条件是否清晰。</p></div><span className="badge">只读</span></div>
          <div className="command-chain-list">{commandChains.map((chain) => <article className="command-chain" key={chain.pipeline}>
            <div className="command-chain-head"><div><span className="badge">{agentPipelineLabel(chain.pipeline)}</span><code>{chain.pipeline}</code></div><small>{chain.phases.length} 个阶段</small></div>
            {chain.entryCommand && <div className="command-chain-entry"><span>统一入口</span><code>{chain.entryCommand}</code></div>}
            <div className="command-chain-phases" aria-label={`${agentPipelineLabel(chain.pipeline)} 阶段顺序`}>
              {chain.phases.map((phase, index) => <div className="command-chain-phase-wrap" key={`${chain.pipeline}:${phase.id}`}>
                <section className="command-chain-phase">
                  <header><span className="command-chain-index">{index + 1}</span><div><strong>{phase.title}</strong><code>{phase.id}</code></div><span className="badge">{phase.type}</span></header>
                  <div className="command-chain-phase-commands">{phase.commands.map((command) => <code key={`${phase.id}:${command}`}>{command}</code>)}</div>
                </section>
                {index < chain.phases.length - 1 && <ArrowRight className="command-chain-phase-arrow" size={15}/>}
              </div>)}
            </div>
            <div className="command-chain-terminal"><span>完成调用链的动作</span>{chain.terminalActions.map((action) => <code key={action}>{action}</code>)}<small>仅在最终阶段或 Harness 明确返回终止结果时结束 execution</small></div>
          </article>)}</div>
        </section>
        <aside className="agent-section-aside">
          <section className="card settings"><strong>调用入口</strong><p className="muted settings-description">执行时由 Runner 注入一次性权限，Agent 通过以下入口推进当前工作。</p><code className="command-block">{commandPrefix} {commandProfile?.namespace || agentId} status</code></section>
          <section className="card settings"><strong>按需读取上下文</strong><p className="muted settings-description">完整冻结快照不塞进启动 Prompt，按需使用 agent-context 查询。</p><code className="command-block">{contextPrefix} overview</code><code className="command-block">{contextPrefix} get &lt;context-ref&gt;</code><code className="command-block">{contextPrefix} search --query &lt;keyword&gt;</code></section>
        </aside>
      </div>}

      {section === 'runtime' && editingIndependentRuntime && <form action={saveAgentRuntimeAction} className="card settings agent-section-card">
        <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="runtime"/>
        <div className="settings-section-head"><span className="executor-icon"><Bot size={18}/></span><div><strong>Agent 独立 Runtime</strong><p className="muted settings-description">下面的配置只影响当前 Agent，不再随项目默认值变化。</p></div><span className="badge amber">{runtimeSettings.source === 'agent_override' ? '独立覆盖' : '准备独立配置'}</span></div>
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
          <label className="checkbox"><input type="checkbox" name="codexWebSearch" defaultChecked={runtimeSettings.codexWebSearch}/>启用实时网页搜索（启动参数 <code>--search</code>）</label>
        </fieldset>
        <fieldset className="claude-settings">
          <legend>Claude 执行参数</legend>
          <div className="fields"><label>模型<input name="claudeModel" defaultValue={runtimeSettings.claudeModel} placeholder="例如 sonnet、opus 或完整模型 ID" spellCheck={false}/><small className="muted">留空时跟随 Claude CLI 默认模型。</small></label></div>
        </fieldset>
        <fieldset className="omp-settings">
          <legend>Oh My Pi 执行参数</legend>
          <p className="muted">仅在选择 Oh My Pi 时生效；模型留空则使用 OMP 的默认模型配置。</p>
          <div className="fields">
            <label>模型<input name="ompModel" defaultValue={runtimeSettings.ompModel} placeholder="例如 ollama/qwen3.6:35b、opus" spellCheck={false}/><small className="muted">支持模糊模型名或完整 provider/model。</small></label>
            <label>思考强度<select name="ompThinking" defaultValue={runtimeSettings.ompThinking}>{OMP_THINKING_LEVELS.map((level) => <option value={level} key={level}>{level === 'default' ? '跟随 OMP 默认值' : level}</option>)}</select></label>
          </div>
          <small>以无会话 JSON 模式运行，并自动批准工具调用。</small>
        </fieldset>
        <div className="form-actions">
          <button className="button" type="submit">保存独立 Runtime</button>
          {runtimeSettings.source === 'agent_override'
            ? <button className="button secondary" type="submit" name="inheritProjectDefault" value="on">恢复跟随项目默认</button>
            : <Link className="button secondary" href={`/agents/${agentId}?section=runtime`}>取消</Link>}
        </div>
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

      {section === 'memory' && <div className="memory-section-stack">
        {memoryError && <p className="memory-operation-message error">加入 Durable Memory 失败：{memoryError}</p>}
        {memoryPromoted === '1' && <p className="memory-operation-message success"><Check size={15}/>观察已加入 Durable Memory。</p>}
        <section className="card settings agent-section-card memory-card">
          <div className="settings-section-head memory-section-head">
            <span className="executor-icon"><MemoryStick size={18}/></span>
            <div><strong>Durable Memory</strong><p className="muted settings-description">跨任务复用的稳定经验。默认以文档方式阅读，需要修改时再进入编辑模式。</p></div>
            <div className="memory-head-actions"><span className="badge">r{detail.currentMemory.revision}</span>{editingMemory
              ? <Link className="button secondary memory-mode-button" href={`/agents/${agentId}?section=memory`}><BookOpenText size={15}/>返回阅读</Link>
              : <Link className="button secondary memory-mode-button" href={`/agents/${agentId}?section=memory&memoryMode=edit`}><PencilLine size={15}/>编辑</Link>}
            </div>
          </div>
          {editingMemory ? <form action={saveAgentMemoryAction} className="agent-editor memory-edit-form">
            <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="memory"/>
            <textarea className="code-editor memory-editor" name="content" defaultValue={detail.currentMemory.content}/>
            <label>修改原因<input name="reason" placeholder="例如：补充项目测试工具的稳定用法"/></label>
            <div className="form-actions"><button className="button" type="submit">保存长期记忆</button><Link className="button secondary" href={`/agents/${agentId}?section=memory`}>取消</Link></div>
          </form> : <div className="memory-document"><MarkdownContent content={detail.currentMemory.content}/></div>}
        </section>

        <section className="card settings agent-section-card daily-memory-card">
          <div className="settings-section-head">
            <span className="executor-icon"><CalendarDays size={18}/></span>
            <div><strong>Daily Memory</strong><p className="muted settings-description">按日期浏览短期观察；最新一天默认展开，内容以 Markdown 排版显示。</p></div>
            <span className="badge">最近 {detail.dailyMemories.length} / {detail.dailyFiles.length} 天</span>
          </div>
          <div className="daily-memory-list">{detail.dailyMemories.length ? detail.dailyMemories.map((memory, index) => {
            return <details key={memory.name} open={index === 0}>
              <summary><span className="daily-memory-icon"><CalendarDays size={16}/></span><span><strong>{dailyMemoryLabel(memory.name)}</strong><small>{memory.observations.length} 条观察</small></span>{index === 0 && <span className="badge green">最新</span>}</summary>
              <div className="daily-memory-observations">{memory.observations.length ? memory.observations.map((observation) => <article className="daily-observation" key={`${observation.executionId}:${observation.fingerprint}`}>
                <div className="daily-observation-actions">{observation.promoted
                  ? <span className="badge green"><Check size={13}/>已加入 Durable Memory</span>
                  : <form action={`/agents/${agentId}/memory/promote`} method="post">
                    <input type="hidden" name="memoryName" value={memory.name}/><input type="hidden" name="executionId" value={observation.executionId}/><input type="hidden" name="fingerprint" value={observation.fingerprint}/>
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
    </div>
  </>;
}
