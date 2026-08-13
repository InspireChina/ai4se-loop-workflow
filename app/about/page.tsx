import { ExternalLink, Info } from 'lucide-react';
import { UpdatePanel } from './update-panel';

export default function AboutPage() {
  return <>
    <header><p className="eyebrow">ABOUT LOOPWORK</p><h1>关于 LoopWork</h1><p className="muted">查看当前桌面版本，并通过 GitHub Releases 检查、下载和安装更新。</p></header>
    <section className="about-grid">
      <div className="card about-product">
        <span className="about-mark">LW</span>
        <div><h2>LoopWork</h2><p>面向本地交付循环的桌面工作台。</p><small>数据保存在本机，桌面应用只在本机随机端口运行内部服务。</small></div>
      </div>
      <UpdatePanel />
      <div className="card about-links">
        <span className="executor-icon"><Info size={18}/></span>
        <div><strong>项目与发行说明</strong><p className="muted settings-description">安装包和版本说明由 GitHub Releases 托管。</p></div>
        <a className="button secondary" href="https://github.com/InspireChina/ai4se-loop-workflow/releases" target="_blank" rel="noreferrer">打开 Releases <ExternalLink size={14}/></a>
      </div>
    </section>
  </>;
}
