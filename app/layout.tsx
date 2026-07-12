import './globals.css';
import Link from 'next/link';
import { LayoutDashboard, ListTodo, ScrollText, Settings } from 'lucide-react';

export const metadata = { title: 'Loop Engineering', description: '本地交付循环工作台' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><div className="shell"><aside className="nav-rail"><div className="brand"><span>LE</span><div><strong>Loop Engineering</strong><small>本地工作区</small></div></div><nav><Link href="/"><LayoutDashboard size={17}/>工作台</Link><Link href="/runs"><ScrollText size={17}/>运行面板</Link><Link href="/tasks"><ListTodo size={17}/>Task</Link><Link href="/settings"><Settings size={17}/>项目设置</Link></nav><footer>SQLite · Local files</footer></aside><main>{children}</main></div></body></html>;
}
