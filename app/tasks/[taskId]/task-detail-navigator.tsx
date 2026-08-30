'use client';

import { Children, type ReactNode, useState } from 'react';
import { Activity, FileCheck2, GitBranch, LayoutDashboard, PackageOpen, ShieldCheck, SlidersHorizontal } from 'lucide-react';

const icons = {
  overview: LayoutDashboard,
  decisions: GitBranch,
  deliverables: PackageOpen,
  activity: Activity,
  closure: FileCheck2,
  actions: SlidersHorizontal,
  audit: ShieldCheck,
};

export type TaskDetailNavigationItem = {
  id: keyof typeof icons;
  label: string;
  description: string;
  value: string;
  attention?: boolean;
};

export function TaskDetailNavigator({
  items,
  initialActiveId = 'overview',
  children,
}: {
  items: TaskDetailNavigationItem[];
  initialActiveId?: TaskDetailNavigationItem['id'];
  children: ReactNode;
}) {
  const [activeId, setActiveId] = useState<TaskDetailNavigationItem['id']>(initialActiveId);
  const panels = Children.toArray(children);
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeId));

  return <div className="task-detail-layout">
    <nav className="card task-detail-navigation" aria-label="需求详情分类">
      <div className="task-detail-navigation-head">
        <strong>需求详情</strong>
        <small>按内容分区查看</small>
      </div>
      <div className="task-detail-navigation-items">
        {items.map((item, index) => {
          const Icon = icons[item.id];
          const active = index === activeIndex;
          return <button
            type="button"
            className={`${active ? 'active' : ''}${item.attention ? ' attention' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => setActiveId(item.id)}
            key={item.id}
          >
            <span className="task-detail-navigation-icon"><Icon size={16}/></span>
            <span className="task-detail-navigation-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
            <em>{item.value}</em>
          </button>;
        })}
      </div>
    </nav>
    <div className="task-detail-content">
      {panels.map((panel, index) => <div
        className="task-detail-panel"
        hidden={activeIndex !== index}
        aria-hidden={activeIndex !== index}
        key={items[index]?.id || index}
      >{panel}</div>)}
    </div>
  </div>;
}
