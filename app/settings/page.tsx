import { paths } from '../../src/infrastructure/database';

export const dynamic = 'force-dynamic';

export default function SettingsPage() { return <><header><p className="eyebrow">PROJECT SETTINGS</p><h1>项目设置</h1><p className="muted">选择当前正在开发的项目。</p></header><section className="card settings"><label>工作区根目录<input readOnly value={paths.root}/></label></section></> }
