'use client';

import { Children, type ReactNode, useState } from 'react';

export type SettingsNavigationItem = {
  id: string;
  group: string;
  label: string;
  description: string;
  value: string;
};

export function SettingsNavigator({ items, children }: { items: SettingsNavigationItem[]; children: ReactNode }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const panels = Children.toArray(children);
  const groups = items.reduce<Array<{ label: string; items: Array<{ item: SettingsNavigationItem; index: number }> }>>((result, item, index) => {
    const group = result.at(-1);
    if (!group || group.label !== item.group) result.push({ label: item.group, items: [{ item, index }] });
    else group.items.push({ item, index });
    return result;
  }, []);

  return <div className="settings-layout">
    <nav className="card settings-navigation" aria-label="设置分类">
      <div className="settings-navigation-head"><strong>设置目录</strong><small>按领域选择配置项</small></div>
      {groups.map((group, groupIndex) => <section className="settings-navigation-section" key={group.label}>
        <div className="settings-navigation-group"><span>{groupIndex + 1}</span><strong>{group.label}</strong></div>
        <div className="settings-navigation-items">
          {group.items.map(({ item, index }) => <button
            type="button"
            className={activeIndex === index ? 'active' : undefined}
            aria-current={activeIndex === index ? 'page' : undefined}
            onClick={() => setActiveIndex(index)}
            key={item.id}
          >
            <span><strong>{item.label}</strong><small>{item.description}</small></span>
            <em>{item.value}</em>
          </button>)}
        </div>
      </section>)}
    </nav>
    <div className="settings-editor-region">
      {panels.map((panel, index) => <div
        className="settings-editor-panel"
        hidden={activeIndex !== index}
        aria-hidden={activeIndex !== index}
        key={items[index]?.id || index}
      >{panel}</div>)}
    </div>
  </div>;
}
