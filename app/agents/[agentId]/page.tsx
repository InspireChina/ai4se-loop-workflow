import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Activity, BookOpenText, BrainCircuit, CalendarDays, Check, CircleAlert, CircleDot, FolderCog, Gauge, MemoryStick, PencilLine, Sparkles } from 'lucide-react';
import { getAgentProfile } from '../../../src/application/agent-profiles';
import { listAgentConfigurations } from '../../../src/application/agent-configurations';
import { AGENT_EXECUTOR_OPTIONS, OMP_THINKING_LEVELS, getAgentRuntimeSettings, getFlowAgentDefaultRuntimeSettings, listAgentRuntimeConfigurations } from '../../../src/application/project-settings';
import { isFlowAgentId } from '../../../src/domain/agent-profile';
import { MarkdownContent } from '../../../src/ui/markdown-content';
import { agentCommandChains, agentPipelineLabel } from '../../../src/domain/agent-command-profile';
import { saveAgentMemoryAction } from '../../actions';
import { AgentConfigurationEditor } from './agent-configuration-editor';
import { AgentRuntimeConfigurationEditor } from './agent-runtime-configuration-editor';

export const dynamic = 'force-dynamic';

const agentSections = [
  { id: 'runtime', label: '运行参数', description: '独立 OMP 模型、思考强度与配置', icon: Gauge },
  { id: 'commands', label: '命令链', description: '阶段顺序与终止动作', icon: CircleDot },
  { id: 'prompt', label: 'Prompt', description: '外部 .omp/agents 定义', icon: BrainCircuit },
  { id: 'memory', label: 'Memory', description: '当前工作目录长期经验与观察', icon: MemoryStick },
  { id: 'evolution', label: '观察', description: '执行经验与证据', icon: Sparkles },
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

export default async function AgentDetailPage({ params, searchParams }: { params: Promise<{ agentId: string }>; searchParams: Promise<{ section?: string | string[]; memoryMode?: string | string[]; memoryError?: string | string[]; memoryPromoted?: string | string[] }> }) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);
  if (!isFlowAgentId(agentId)) notFound();
  const [detail, runtimeSettings, flowDefaults, runtimeConfigurations, agentConfigurations] = await Promise.all([
    getAgentProfile(agentId, true),
    getAgentRuntimeSettings(agentId),
    getFlowAgentDefaultRuntimeSettings(),
    Promise.resolve(listAgentRuntimeConfigurations(agentId)),
    Promise.resolve(listAgentConfigurations(agentId)),
  ]);
  const currentProject = detail.project;
  const section = selectedSection(query.section);
  const memoryMode = Array.isArray(query.memoryMode) ? query.memoryMode[0] : query.memoryMode;
  const editingMemory = memoryMode === 'edit';
  const memoryError = Array.isArray(query.memoryError) ? query.memoryError[0] : query.memoryError;
  const memoryPromoted = Array.isArray(query.memoryPromoted) ? query.memoryPromoted[0] : query.memoryPromoted;
  const agentHref = (targetSection: AgentSection, extra: Record<string, string> = {}) => {
    const parameters = new URLSearchParams({ section: targetSection, ...extra });
    return `/agents/${agentId}?${parameters}`;
  };
  const effectivePrompt = [
    '# Harness Core Contract（只读）',
    '流程调度、权限、状态机和最小结果协议由 Harness 执行，专业语义由对应 Agent 判断，Agent Prompt 无权扩大权限。',
    '',
    `# ${currentProject.name} · 外部 Agent 定义`,
    `# 来源：${detail.externalAgentPath}`,
    detail.currentPrompt.content,
    '',
    `# Durable Memory · r${detail.currentMemory.revision}`,
    detail.currentMemory.content,
  ].join('\n');
  const commandChains = agentCommandChains(agentId);

  return <>
    <header className="page-header agent-page-header"><div><Link className="crumb" href="/agents">Agent 配置</Link><p className="eyebrow">{agentId}</p><h1>{detail.definition.label}</h1><p className="muted">{detail.definition.description}</p></div><div className="agent-header-actions"><span className="badge blue">外部 Agent · OMP</span></div></header>

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
          <div><span>Agent 定义</span><strong>外部 Markdown</strong><small>{currentProject.name} · 文件来源</small></div>
          <div><span>Workspace Memory</span><strong>r{detail.currentMemory.revision}</strong><small>{detail.dailyFiles.length} 个 daily 文件</small></div>
          <div><span>演化证据</span><strong>{detail.observations.length}</strong><small>条可复用观察</small></div>
        </section>
      {section === 'runtime' && <AgentRuntimeConfigurationEditor
        agentId={agentId}
        initialConfigurations={runtimeConfigurations}
        initialEffective={runtimeSettings}
        flowDefault={flowDefaults}
        executorOptions={AGENT_EXECUTOR_OPTIONS}
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
        <section className="card settings agent-editor agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><BrainCircuit size={18}/></span><div><strong>{currentProject.name} · 外部 Agent 定义</strong><p className="muted settings-description">自动检测当前工作目录的 .omp/agents，实际文件路径见下方。修改文件后，下一次执行直接读取；原有 Workflow、角色职责和状态流转保持。</p></div><span className="badge">文件管理</span></div>
          <p className="path-value"><code>{detail.externalAgentPath}</code></p>
          {detail.externalAgentError ? <p className="memory-operation-message error">{detail.externalAgentError}</p> : <MarkdownContent content={detail.currentPrompt.content}/>}
        </section>
        <aside className="agent-section-aside"><section className="card settings agent-context-note"><strong>编辑方式</strong><p className="muted settings-description">在文件系统编辑此 Agent Markdown 正文，可引用 Skill 和 Markdown 模板。LoopWork 不在数据库维护另一套 Prompt，也不覆盖外部文件。</p><p className="muted settings-description">Agent frontmatter 可声明 model、thinking、tools 和 skills；OMP Runtime 页面可单独覆盖模型和思考强度；Harness 的流程边界和执行契约继续生效。</p></section></aside>
      </div>}

      {section === 'memory' && <div className="memory-section-stack">
        {memoryError && <p className="memory-operation-message error">加入 Durable Memory 失败：{memoryError}</p>}
        {memoryPromoted === '1' && <p className="memory-operation-message success"><Check size={15}/>观察已加入 Durable Memory。</p>}
        <section className="card settings agent-section-card memory-card">
          <div className="settings-section-head memory-section-head">
            <span className="executor-icon"><MemoryStick size={18}/></span>
            <div><strong>{currentProject.name} · Durable Memory</strong><p className="muted settings-description">仅在当前工作目录内跨任务复用的稳定经验。默认以文档方式阅读，需要修改时再进入编辑模式。</p></div>
            <div className="memory-head-actions"><span className="badge">r{detail.currentMemory.revision}</span>{editingMemory
              ? <Link className="button secondary memory-mode-button" href={agentHref('memory')}><BookOpenText size={15}/>返回阅读</Link>
              : <Link className="button secondary memory-mode-button" href={agentHref('memory', { memoryMode: 'edit' })}><PencilLine size={15}/>编辑</Link>}
            </div>
          </div>
          {editingMemory ? <form action={saveAgentMemoryAction} className="agent-editor memory-edit-form">
            <input type="hidden" name="agentId" value={agentId}/><input type="hidden" name="section" value="memory"/>
            <textarea className="code-editor memory-editor" name="content" defaultValue={detail.currentMemory.content}/>
            <label>修改原因<input name="reason" placeholder="例如：补充项目测试工具的稳定用法"/></label>
            <div className="form-actions"><button className="button" type="submit">保存长期记忆</button><Link className="button secondary" href={agentHref('memory')}>取消</Link></div>
          </form> : <div className="memory-document"><MarkdownContent content={detail.currentMemory.content}/></div>}
        </section>

        <section className="card settings agent-section-card daily-memory-card">
          <div className="settings-section-head">
            <span className="executor-icon"><CalendarDays size={18}/></span>
            <div><strong>{currentProject.name} · Daily Memory</strong><p className="muted settings-description">按日期浏览当前工作目录的短期观察；最新一天默认展开，内容以 Markdown 排版显示。</p></div>
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

      {section === 'evolution' && <div className="agent-section-layout"><section className="card settings"><strong>外部 Agent Prompt</strong><p className="muted">Prompt 由工作目录 .omp/agents 维护。内部学习不会生成、提升或覆盖 Prompt 候选。</p></section>
        <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><Sparkles size={18}/></span><div><strong>{currentProject.name} · 演化观察</strong><p className="muted settings-description">保留执行经验和证据查看。DJI 默认不启动独立 Evaluator；专业知识和角色行为由 .omp Agent / Skill 维护。</p></div><span className="badge">{detail.observations.length} 条</span></div>
          <div className="observation-list">{detail.observations.length ? detail.observations.map((observation) => <div key={observation.observation_id}>
            <span className="badge">{observation.target}</span><b>{observation.summary}</b>
            <p>{observation.guidance}</p><small>{observation.fingerprint} · {observation.occurrence_count} 次 · confidence {observation.confidence.toFixed(2)}</small>
          </div>) : <p className="muted">尚未产生可复用观察。</p>}</div>
        </section>
        <aside className="agent-section-aside">
          <section className="card settings"><strong>知识维护</strong><p className="muted settings-description">在 .omp/agents 和 Skill 中维护专业知识、规则及模板引用。LoopWork 不自动改写外部 Prompt。</p></section>
          <section className="card settings"><strong>独立 Evaluator</strong><p className="muted settings-description">默认停用，任务完成后不额外调用模型。需要诊断性经验提取时，可显式设置 LOOP_ENABLE_EVALUATOR=1。</p></section>
        </aside>
      </div>}

      {section === 'diagnostics' && <div className="agent-section-layout">
        <section className="card settings agent-section-card">
          <div className="settings-section-head"><span className="executor-icon"><Activity size={18}/></span><div><strong>Effective Prompt 预览</strong><p className="muted settings-description">实际运行时还会追加当前任务上下文、相关 daily memory 和输出 Schema。</p></div><span className="badge">只读</span></div>
          <pre className="effective-prompt">{effectivePrompt}</pre>
        </section>
        <aside className="agent-section-aside">
          <section className="card settings"><div className="settings-section-head"><span className="executor-icon"><FolderCog size={18}/></span><div><strong>Runtime Workspace</strong><p className="muted settings-description">当前实例的运行时文件目录。</p></div></div><p className="path-line">{detail.runtimeDirectory}</p><small>{detail.dailyFiles.length} 个 daily memory 文件。Agent Prompt 直接读取工作目录的 .omp/agents，不在 Runtime 目录生成副本。</small></section>
          <section className="card settings"><strong>输入版本</strong><div className="diagnostic-facts"><span>定义 Hash</span><b>{detail.currentPrompt.content_hash.slice(0, 12)}</b><span>来源</span><b>.omp/agents</b><span>Memory</span><b>r{detail.currentMemory.revision}</b></div></section>
        </aside>
      </div>}
      </div>
    </div>
  </>;
}
