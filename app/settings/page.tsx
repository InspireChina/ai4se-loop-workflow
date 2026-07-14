import { paths } from '../../src/infrastructure/database';
import { Activity, Bot, Check } from 'lucide-react';
import { AGENT_EXECUTOR_OPTIONS, CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORTS, getAgentExecutorSettings, getLangfuseSettings } from '../../src/application/project-settings';
import { changeWorkspaceRootAction, saveAgentExecutorAction, saveLangfuseSettingsAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const settings = await getAgentExecutorSettings();
  const langfuse = await getLangfuseSettings();
  return <>
    <header><p className="eyebrow">PROJECT SETTINGS</p><h1>项目设置</h1><p className="muted">设置当前项目与执行 pipeline agent 的 CLI。</p></header>
    <section className="settings-stack">
    <form action={changeWorkspaceRootAction} className="card settings">
      <div><strong>当前项目</strong><p className="muted settings-description">切换后，Task、运行记录和项目设置会自动使用该 Repo 对应的独立数据库。</p></div>
      <div className="workspace-switch"><label>工作区根目录<input name="workspaceRoot" required defaultValue={paths.root} spellCheck={false}/></label><button className="button" type="submit">切换项目</button></div>
    </form>
    <form action={saveAgentExecutorAction} className="card settings">
      <fieldset className="executor-settings">
        <legend>Agent 执行器</legend>
        <p className="muted">每条 delegation 仍然逐个执行，只切换底层使用的 CLI。所选 CLI 需要已在本机登录。</p>
        <div className="executor-options">
          {AGENT_EXECUTOR_OPTIONS.map((option) => <label className="executor-option" key={option.id}>
            <input type="radio" name="agentExecutor" value={option.id} defaultChecked={settings.executorId === option.id}/>
            <span className="executor-icon"><Bot size={18}/></span>
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
            <Check className="executor-check" size={17}/>
          </label>)}
        </div>
      </fieldset>
      <fieldset className="codex-settings">
        <legend>Codex 执行参数</legend>
        <p className="muted">仅在选择 Codex 执行器时生效。从 GPT-5.6 的三个性能档中选择。</p>
        <div className="fields">
          <label>模型
            <select name="codexModel" defaultValue={settings.codexModel}>
              {CODEX_MODEL_OPTIONS.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
            </select>
            <small className="muted">Sol 优先最高智能，Terra 平衡效果与成本，Luna 优先低成本。</small>
          </label>
          <label>思考强度
            <select name="codexReasoningEffort" defaultValue={settings.codexReasoningEffort}>
              {CODEX_REASONING_EFFORTS.map((effort) => <option value={effort} key={effort}>{effort === 'default' ? '跟随 Codex 默认值' : effort}</option>)}
            </select>
          </label>
        </div>
        <small className="muted">可选值：minimal、low、medium、high、xhigh。部分模型不支持所有强度。</small>
      </fieldset>
      <button className="button" type="submit">保存设置</button>
    </form>
    <form action={saveLangfuseSettingsAction} className="card settings">
      <div className="settings-section-head">
        <span className="executor-icon"><Activity size={18}/></span>
        <div>
          <strong>可观测性 · Langfuse</strong>
          <p className="muted settings-description">开启后，每个 agent delegation 会创建一个 <code>loop.delegation</code> trace，并记录工具调用、输出摘要和诊断事件。</p>
        </div>
        <span className={`badge ${langfuse.status === 'enabled' ? 'green' : langfuse.status === 'disabled' ? 'blue' : 'amber'}`}>
          {langfuse.status === 'enabled' ? '已启用' : langfuse.status === 'disabled' ? '未启用' : '需配置'}
        </span>
      </div>
      <p className="path-line">{langfuse.statusMessage} 当前来源：{langfuse.source === 'project' ? '项目设置' : '环境变量'}。</p>
      <div className="fields">
        <label className="checkbox"><input type="checkbox" name="langfuseEnabled" defaultChecked={langfuse.enabled}/>启用 Langfuse trace</label>
        <label className="checkbox"><input type="checkbox" name="langfuseCapturePrompts" defaultChecked={langfuse.capturePrompts}/>采集 Prompt（会脱敏，默认建议关闭）</label>
        <label>Public Key
          <input name="langfusePublicKey" defaultValue={langfuse.publicKey} placeholder="pk-..." spellCheck={false}/>
        </label>
        <label>Secret Key
          <input name="langfuseSecretKey" type="password" placeholder={langfuse.hasSecretKey ? '已保存；留空则不修改' : 'sk-...'} spellCheck={false}/>
          <small className="muted">{langfuse.hasSecretKey ? 'Secret Key 已保存，不会在页面回显。' : '尚未保存 Secret Key。'}</small>
        </label>
        <label>Base URL
          <input name="langfuseBaseUrl" defaultValue={langfuse.baseUrl} placeholder="https://cloud.langfuse.com" spellCheck={false}/>
        </label>
        <label>采样率
          <input name="langfuseSampleRate" type="number" min="0" max="1" step="0.01" defaultValue={langfuse.sampleRate}/>
          <small className="muted">1 表示全量采集，0 表示完全不采集。</small>
        </label>
      </div>
      <small className="muted">保存后只影响新的 agent 执行；已经完成的历史任务不会补传 trace。</small>
      <button className="button" type="submit">保存可观测性设置</button>
    </form>
    </section>
  </>;
}
