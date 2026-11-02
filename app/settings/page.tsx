import { documentFilesRoot } from '../../src/infrastructure/document-files';
import Link from 'next/link';
import { Activity, ArrowRight, Bot, Check, FolderKanban, Gauge } from 'lucide-react';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS, MAX_AGENT_CONCURRENCY, OMP_THINKING_LEVELS, getAgentConcurrency, getAgentExecutorSettings, getFlowAgentDefaultRuntimeSettings, getLangfuseSettings } from '../../src/application/project-settings';
import { saveDocumentStorageAction, saveAgentConcurrencyAction, saveAgentExecutorAction, saveFlowAgentDefaultRuntimeAction, saveLangfuseSettingsAction, } from '../actions';
import { SettingsNavigator, type SettingsNavigationItem } from './settings-navigator';
import { getConfiguredWorkspaceRoot } from '../../src/infrastructure/database';

export const dynamic = 'force-dynamic';

function runtimeSummary(settings: { executorId: string; codexModel: string; claudeModel: string; ompModel: string }) {
  const executor = AGENT_EXECUTOR_OPTIONS.find((option) => option.id === settings.executorId)?.label || settings.executorId;
  if (settings.executorId === 'codex') {
    const model = CODEX_MODEL_OPTIONS.find((option) => option.id === settings.codexModel)?.label || settings.codexModel;
    return `${executor} · ${model}`;
  }
  if (settings.executorId === 'claude') return `${executor}${settings.claudeModel ? ` · ${settings.claudeModel}` : ''}`;
  if (settings.executorId === 'omp') return `${executor}${settings.ompModel ? ` · ${settings.ompModel}` : ''}`;
  return executor;
}

function RuntimeParameterHeader() {
  return <header><span>运行参数</span><strong className="runtime-executor-name"><i className="omp">Oh My Pi</i></strong><small>只显示当前执行器会使用的参数。</small></header>;
}


export default async function SettingsPage() {
  const [settings, flowDefaults, agentConcurrency, langfuse] = await Promise.all([
    getAgentExecutorSettings(), getFlowAgentDefaultRuntimeSettings(), getAgentConcurrency(), getLangfuseSettings(),
  ]);
  const flowRuntimeSummary = runtimeSummary(flowDefaults);
  const systemRuntimeSummary = runtimeSummary(settings);
  const langfuseStatus = langfuse.status === 'enabled' ? '已启用' : langfuse.status === 'disabled' ? '未启用' : '需配置';
  const navigationItems: SettingsNavigationItem[] = [
    { id: 'workspace', group: '工作目录与调度', label: '工作目录', description: '当前实例的唯一工作目录', value: '单工作目录' },
    { id: 'concurrency', group: '工作目录与调度', label: 'Agent 并发', description: '当前实例运行容量', value: `上限 ${agentConcurrency}` },
    { id: 'flow-runtime', group: 'Agent Runtime', label: '流程 Agent 默认', description: '流程 Profile 继承', value: flowRuntimeSummary },
    { id: 'system-runtime', group: 'Agent Runtime', label: '系统辅助 Agent', description: '上下文对话、验证协助等能力', value: systemRuntimeSummary },
    { id: 'langfuse', group: '集成', label: 'Langfuse', description: 'Trace 与诊断', value: langfuseStatus },
  ];

  return <>
    <header><p className="eyebrow">LOOPWORK SETTINGS</p><h1>设置</h1><p className="muted">当前实例只运行一个工作目录，所有 Workflow Agent 从该目录加载外部定义。</p></header>
    <SettingsNavigator items={navigationItems}>
      <section className="card settings-editor" aria-labelledby="workspace-settings-title">
        <div className="settings-editor-head"><span className="executor-icon"><FolderKanban size={18}/></span><div><p className="eyebrow">WORKSPACE</p><h2 id="workspace-settings-title">当前工作目录</h2><p>任务、定时计划、Agent 定义和 Skill 使用同一个工作目录。</p></div><span className="settings-current">单工作目录</span></div>
        <p className="path-line">{getConfiguredWorkspaceRoot()}</p>
        <p className="muted">默认使用启动时的工作目录。可用 <code>./start.sh --workspace /path/to/repository</code> 指定；更换目录需要重启实例，并为已有任务使用独立数据目录。</p>
        <form action={saveDocumentStorageAction} className="settings settings-editor-form">
          <h3>文件存放目录</h3><label>文件存放目录<input name="documentFilesRoot" required defaultValue={documentFilesRoot()} spellCheck={false}/></label>
          <small className="muted">文档、对话、日志、内容快照和 OMP 会话写到此文件夹。数据库保存 Workflow 状态、索引和文件引用。修改后新文件使用新目录，已有文件仍可读取。</small>
          <button className="button secondary" type="submit">保存文件目录</button>
        </form>
      </section>

      <section className="card settings-editor" aria-labelledby="concurrency-settings-title">
        <div className="settings-editor-head"><span className="executor-icon"><Gauge size={18}/></span><div><p className="eyebrow">SCHEDULING</p><h2 id="concurrency-settings-title">流程 Agent 并发</h2><p>统一限制所有流程 Agent 的运行总数；代码工作区仍保持互斥，浏览器由各 Agent 通过独立标签页共享。</p></div><span className="settings-current">上限 {agentConcurrency}</span></div>
        <form action={saveAgentConcurrencyAction} className="settings settings-editor-form">
          <div className="fields"><label>Agent 最大并发数<input name="agentConcurrency" type="number" min="1" max={MAX_AGENT_CONCURRENCY} step="1" required defaultValue={agentConcurrency}/><small className="muted">可设置 1–{MAX_AGENT_CONCURRENCY}。所有 Agent 都计入；浏览器标签页不额外占用调度名额。</small></label></div>
          <small className="muted">保存后立即影响新的派发；已运行的 Agent 不会被终止。若当前占用超过新上限，系统会等待其自然结束。</small>
          <button className="button" type="submit">保存并发设置</button>
        </form>
      </section>

      <section className="card settings-editor" aria-labelledby="flow-runtime-settings-title">
        <div className="settings-editor-head"><span className="executor-icon"><Bot size={18}/></span><div><p className="eyebrow">FLOW RUNTIME</p><h2 id="flow-runtime-settings-title">流程 Agent Runtime · 全局默认</h2><p>所有选择“跟随流程默认”的 Agent 会立即继承这里的执行器及对应参数，适用于当前实例。</p></div><span className="settings-current">{flowRuntimeSummary}</span></div>
        <form action={saveFlowAgentDefaultRuntimeAction} className="settings settings-editor-form">
          <div className="settings-panel-toolbar"><p className="muted">需要单独配置时，可进入对应 Agent 保存多套 Runtime 并快速切换。</p><Link className="button secondary" href="/agents">Agent Runtime 配置 <ArrowRight size={14}/></Link></div>
          <div className="agent-runtime-workbench">
            <fieldset className="executor-settings agent-runtime-executor-list"><legend>默认执行器</legend><div className="executor-options">
              {AGENT_EXECUTOR_OPTIONS.map((option) => <label className="executor-option" key={option.id}><input type="radio" name="agentExecutor" value={option.id} defaultChecked={flowDefaults.executorId === option.id}/><span className="executor-icon"><Bot size={18}/></span><span><strong>{option.label}</strong><small>{option.description}</small></span><Check className="executor-check" size={17}/></label>)}
            </div></fieldset>
            <div className="agent-runtime-parameters"><RuntimeParameterHeader/>


              <fieldset className="omp-settings"><legend>默认 Oh My Pi 执行参数</legend><p className="muted">模型留空则使用 OMP 的默认模型配置。</p><div className="fields"><label>模型<input name="ompModel" defaultValue={flowDefaults.ompModel} placeholder="例如 ollama/qwen3.6:35b、opus" spellCheck={false}/><small className="muted">支持 OMP 的模糊模型名或完整 provider/model。</small></label><label>思考强度<select name="ompThinking" defaultValue={flowDefaults.ompThinking}>{OMP_THINKING_LEVELS.map((level) => <option value={level} key={level}>{level === 'default' ? '跟随 OMP 默认值' : level}</option>)}</select></label></div><small>运行方式：<code>--mode rpc</code>。</small></fieldset>
            </div>
          </div>
          <button className="button" type="submit">保存流程 Agent 默认 Runtime</button>
        </form>
      </section>

      <section className="card settings-editor" aria-labelledby="system-runtime-settings-title">
        <div className="settings-editor-head"><span className="executor-icon"><Bot size={18}/></span><div><p className="eyebrow">SYSTEM RUNTIME</p><h2 id="system-runtime-settings-title">系统辅助 Agent Runtime</h2><p>全局用于上下文对话等没有独立 Agent Profile 的能力，不会覆盖流程 Agent 的 Runtime 配置。</p></div><span className="settings-current">{systemRuntimeSummary}</span></div>
        <form action={saveAgentExecutorAction} className="settings settings-editor-form">
          <div className="agent-runtime-workbench">
            <fieldset className="executor-settings agent-runtime-executor-list"><legend>系统辅助执行器</legend><p className="muted">用于上下文对话及验证协助自动排障；所选 CLI 需要已在本机登录。</p><div className="executor-options">
              {AGENT_EXECUTOR_OPTIONS.map((option) => <label className="executor-option" key={option.id}><input type="radio" name="agentExecutor" value={option.id} defaultChecked={settings.executorId === option.id}/><span className="executor-icon"><Bot size={18}/></span><span><strong>{option.label}</strong><small>{option.description}</small></span><Check className="executor-check" size={17}/></label>)}
            </div></fieldset>
            <div className="agent-runtime-parameters"><RuntimeParameterHeader/>


              <fieldset className="omp-settings"><legend>Oh My Pi 执行参数</legend><p className="muted">模型留空时使用 OMP 默认配置。</p><div className="fields"><label>模型<input name="ompModel" defaultValue={settings.ompModel} placeholder="例如 ollama/qwen3.6:35b、opus" spellCheck={false}/><small className="muted">支持 OMP 的模糊模型名或完整 provider/model。</small></label><label>思考强度<select name="ompThinking" defaultValue={settings.ompThinking}>{OMP_THINKING_LEVELS.map((level) => <option value={level} key={level}>{level === 'default' ? '跟随 OMP 默认值' : level}</option>)}</select></label></div><small>通过 <code>--approval-mode yolo</code> 自动批准工具；每次任务执行隔离原生会话，上下文对话继续原会话。Agent 文件声明的参数优先于本页默认值。</small></fieldset>
            </div>
          </div>
          <button className="button" type="submit">保存系统 Runtime</button>
        </form>
      </section>

      <section className="card settings-editor" aria-labelledby="observability-settings-title">
        <div className="settings-editor-head"><span className="executor-icon"><Activity size={18}/></span><div><p className="eyebrow">OBSERVABILITY</p><h2 id="observability-settings-title">可观测性 · Langfuse</h2><p>记录 Agent trace、工具调用、输出摘要和诊断事件。</p></div><span className={`badge ${langfuse.status === 'enabled' ? 'green' : langfuse.status === 'disabled' ? 'blue' : 'amber'}`}>{langfuseStatus}</span></div>
        <form action={saveLangfuseSettingsAction} className="settings settings-editor-form">
          <p className="path-line">{langfuse.statusMessage} 当前来源：{langfuse.source === 'project' ? '项目设置' : '环境变量'}。</p>
          <div className="fields"><label className="checkbox"><input type="checkbox" name="langfuseEnabled" defaultChecked={langfuse.enabled}/>启用 Langfuse trace</label><label className="checkbox"><input type="checkbox" name="langfuseCapturePrompts" defaultChecked={langfuse.capturePrompts}/>采集 Prompt（会脱敏，默认建议关闭）</label><label>Public Key<input name="langfusePublicKey" defaultValue={langfuse.publicKey} placeholder="pk-..." spellCheck={false}/></label><label>Secret Key<input name="langfuseSecretKey" type="password" placeholder={langfuse.hasSecretKey ? '已保存；留空则不修改' : 'sk-...'} spellCheck={false}/><small className="muted">{langfuse.hasSecretKey ? 'Secret Key 已保存，不会在页面回显。' : '尚未保存 Secret Key。'}</small></label><label>Base URL<input name="langfuseBaseUrl" defaultValue={langfuse.baseUrl} placeholder="https://cloud.langfuse.com" spellCheck={false}/></label><label>采样率<input name="langfuseSampleRate" type="number" min="0" max="1" step="0.01" defaultValue={langfuse.sampleRate}/><small className="muted">1 表示全量采集，0 表示完全不采集。</small></label></div>
          <small className="muted">保存后只影响新的 Agent 执行；已经完成的历史任务不会补传 trace。</small>
          <button className="button" type="submit">保存可观测性设置</button>
        </form>
      </section>
    </SettingsNavigator>
  </>;
}
