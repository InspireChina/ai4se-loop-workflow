import { paths } from '../../src/infrastructure/database';
import { Bot, Check } from 'lucide-react';
import { AGENT_EXECUTOR_OPTIONS, getAgentExecutorId } from '../../src/application/project-settings';
import { saveProjectSettingsAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const selectedExecutor = await getAgentExecutorId();
  return <>
    <header><p className="eyebrow">PROJECT SETTINGS</p><h1>项目设置</h1><p className="muted">设置当前项目与执行 pipeline agent 的 CLI。</p></header>
    <form action={saveProjectSettingsAction} className="card settings">
      <label>工作区根目录<input readOnly value={paths.root}/></label>
      <fieldset className="executor-settings">
        <legend>Agent 执行器</legend>
        <p className="muted">每条 delegation 仍然逐个执行，只切换底层使用的 CLI。所选 CLI 需要已在本机登录。</p>
        <div className="executor-options">
          {AGENT_EXECUTOR_OPTIONS.map((option) => <label className="executor-option" key={option.id}>
            <input type="radio" name="agentExecutor" value={option.id} defaultChecked={selectedExecutor === option.id}/>
            <span className="executor-icon"><Bot size={18}/></span>
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
            <Check className="executor-check" size={17}/>
          </label>)}
        </div>
      </fieldset>
      <button className="button" type="submit">保存设置</button>
    </form>
  </>;
}
