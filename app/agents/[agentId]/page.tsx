import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Bot, BrainCircuit, Check, MemoryStick, RotateCcw, Sparkles } from 'lucide-react';
import { getAgentProfile } from '../../../src/application/agent-profiles';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS, getAgentRuntimeSettings } from '../../../src/application/project-settings';
import { AGENT_PROMPT_SEED_REVISION, isFlowAgentId } from '../../../src/domain/agent-profile';
import { resetAgentPromptAction, saveAgentMemoryAction, saveAgentPromptAction, saveAgentRuntimeAction, setAgentAutoEvolutionAction } from '../../actions';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  if (!isFlowAgentId(agentId)) notFound();
  const [detail, runtimeSettings] = await Promise.all([
    getAgentProfile(agentId),
    getAgentRuntimeSettings(agentId),
  ]);
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
    <header className="page-header"><div><Link className="crumb" href="/agents">Agent 配置</Link><p className="eyebrow">{agentId}</p><h1>{detail.definition.label}</h1><p className="muted">{detail.definition.description}</p></div><span className={`badge ${detail.candidatePrompt ? 'amber' : detail.profile.auto_evolve ? 'green' : 'blue'}`}>{detail.candidatePrompt ? `Prompt Canary r${detail.candidatePrompt.revision}` : detail.profile.auto_evolve ? '自动演化已开启' : '自动演化已关闭'}</span></header>

    <div className="agent-detail-grid">
      <div className="agent-editor-column">
        <form action={saveAgentRuntimeAction} className="card settings">
          <input type="hidden" name="agentId" value={agentId}/>
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
            <div className="fields">
              <label>模型
                <input name="claudeModel" defaultValue={runtimeSettings.claudeModel} placeholder="例如 sonnet、opus 或完整模型 ID" spellCheck={false}/>
                <small className="muted">留空时跟随 Claude CLI 默认模型。</small>
              </label>
            </div>
          </fieldset>
          <button className="button" type="submit">保存 Agent Runtime</button>
        </form>

        <form action={saveAgentPromptAction} className="card settings agent-editor">
          <input type="hidden" name="agentId" value={agentId}/>
          <div className="settings-section-head"><span className="executor-icon"><BrainCircuit size={18}/></span><div><strong>Project Agent Prompt</strong><p className="muted settings-description">当前项目独立持有的完整 Prompt。首次由系统模板初始化，之后完全由当前项目管理，应用升级不会覆盖。</p></div><span className="badge">r{detail.currentPrompt.version}</span></div>
          <textarea className="code-editor" name="content" defaultValue={detail.currentPrompt.content}/>
          <label>修改原因<input name="reason" placeholder="例如：明确浏览器验证前的环境探测顺序"/></label>
          <button className="button" type="submit">保存 Prompt</button>
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
        <form action={resetAgentPromptAction} className="card settings">
          <input type="hidden" name="agentId" value={agentId}/>
          <div className="settings-section-head"><span className="executor-icon"><RotateCcw size={18}/></span><div><strong>系统模板</strong><p className="muted settings-description">用当前代码中的最新系统模板替换这个项目的 Prompt。Memory 不变，尚未完成的 Prompt Canary 会被清除。</p></div><span className={`badge ${usesLatestSystemTemplate ? 'green' : 'amber'}`}>{usesLatestSystemTemplate ? '已是最新' : `可重置到 V${AGENT_PROMPT_SEED_REVISION}`}</span></div>
          <label className="checkbox"><input type="checkbox" name="confirm" required disabled={usesLatestSystemTemplate}/>我确认覆盖当前项目保存的 Prompt</label>
          <button className="button secondary" type="submit" disabled={usesLatestSystemTemplate}>重置为最新系统模板</button>
        </form>

        <form action={setAgentAutoEvolutionAction} className="card settings">
          <input type="hidden" name="agentId" value={agentId}/>
          <strong>自动演化</strong>
          <p className="muted settings-description">Evaluator 基于当前项目 Prompt 生成完整候选；Harness 累计证据并执行 Canary。用户保存 Prompt 会立即取代候选。</p>
          <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={Boolean(detail.profile.auto_evolve)}/>允许自动提升 Memory 和 Project Prompt</label>
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
          <small>{detail.dailyFiles.length} 个 daily memory 文件。PROMPT.md 是当前项目 Prompt 的只读物化结果；该目录不进入目标仓库 Git。</small>
        </section>
      </aside>
    </div>
  </>;
}
