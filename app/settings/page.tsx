import { paths } from '../../src/infrastructure/database';

export const dynamic = 'force-dynamic';

export default function SettingsPage() { return <><header><p className="eyebrow">PROJECT SETTINGS</p><h1>项目设置</h1><p className="muted">V1 只展示本地、安全且可追溯的运行配置。</p></header><section className="card settings"><label>工作区根目录<input readOnly value={paths.root}/></label><label>Repo 短 Hash<input readOnly value={paths.repoHash}/></label><label>应用数据目录<input readOnly value={paths.dataDir}/></label><label>SQLite 数据库<input readOnly value={paths.dbPath}/></label><label>Inbox<input readOnly value={paths.inboxPath}/></label><label>运行模式<input readOnly value="本地单体 · 同步操作"/></label><label>文档存储<input readOnly value="业务工作文件仍在 repo .project/ 目录"/></label></section></> }
