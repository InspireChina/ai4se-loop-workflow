import { Info, FolderOpen, Workflow } from 'lucide-react';
import Link from 'next/link';
import pkg from '../../package.json';
import { documentFilesRoot } from '../../src/infrastructure/document-files';
import { getConfiguredWorkspaceRoot, paths } from '../../src/infrastructure/database';
export const dynamic='force-dynamic';
export default function AboutPage(){
  return <><header><p className="eyebrow">LOOPWORK / DJI</p><h1>关于 LoopWork</h1><p className="muted">保留完整 Workflow 与 Web 工作台，由 OMP 执行外部 Agent 和 Skill。</p></header>
    <section className="about-grid">
      <div className="card about-product"><span className="about-mark">LW</span><div><h2>LoopWork DJI</h2><p>Web · OMP 原生 RPC · v{pkg.version}</p><small>任务编排、角色交接、执行监督和幂等状态管理。</small></div></div>
      <div className="card settings"><span className="executor-icon"><Workflow size={18}/></span><h2>OMP 执行环境</h2><p>Agent、模型、工具和 Skill 从当前工作目录的 .omp 配置加载。会话按角色与 execution 隔离，专业 Prompt 不在内部编辑。</p><p className="path-line">{getConfiguredWorkspaceRoot()}/.omp</p><Link className="button secondary" href="/agents">Agent 定义与诊断</Link></div>
      <div className="card settings"><span className="executor-icon"><FolderOpen size={18}/></span><h2>文件与状态</h2><p>文档、对话、日志和执行快照落文件；SQLite 保留 Workflow 状态与文件引用。</p><p className="path-line">{documentFilesRoot()}</p><small>状态目录：{paths.dataRoot}</small><Link className="button secondary" href="/settings">工作目录与文件夹设置</Link></div>
      <div className="card settings"><span className="executor-icon"><Info size={18}/></span><h2>启动与部署</h2><pre>./start.sh{`\n`}./start.sh --production --port 8000</pre><p className="muted">部署前运行 npm run build。此版本使用全新独立数据根目录。</p></div>
    </section></>;
}
