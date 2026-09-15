import type { WorkItemProjection, WorkItemDependencyProjection } from './workflow-item';

/** New work is planned from the selected pipeline, not inferred from task
 * status, cursors, current Agent or a legacy Lane. Units are appended later
 * by the explicit delivery-plan result. */
export function builtinWorkflow(itemType: string) {
  const items: WorkItemProjection[] = [];
  const dependencies: WorkItemDependencyProjection[] = [];
  const add = (workKey: string, kind: string, title: string, agent: string | null, pipeline: string | null, upstream?: string) => {
    items.push({ workKey, kind, title, agent, pipeline, storyIndex: null, lane: 'control', status: 'pending' });
    if (upstream) dependencies.push({ workKey, dependsOnWorkKey: upstream, dependencyKind: 'completion' });
    return workKey;
  };
  if (itemType === 'direct') {
    add('direct:execute', 'direct', '直接执行', 'direct-agent', 'direct');
    return { items, dependencies };
  }
  let upstream: string | undefined;
  if (['business-analysis', 'end-to-end'].includes(itemType)) {
    upstream = add('ba:intent', 'ba-intent', '需求意图确认', 'idea-context-agent', 'ba-intent');
    upstream = add('ba:design', 'ba-design', '业务方案设计', 'business-design-agent', 'ba-design', upstream);
    upstream = add('ba:spec', 'ba-spec', '需求规格编写', 'requirement-spec-agent', 'ba-spec', upstream);
    upstream = add('ba:review', 'ba-review', '规格独立审查', 'spec-review-agent', 'ba-review', upstream);
    if (itemType === 'business-analysis') {
      add('ba:closure', 'closure', '阅读需求规格', null, null, upstream);
      return { items, dependencies };
    }
  }
  upstream = add('delivery:context', 'requirement-context', '需求梳理', 'backlog-agent', 'backlog', upstream);
  if (itemType === 'bug') upstream = add('delivery:repro', 'reproduction', '问题复现', 'repro-agent', 'repro', upstream);
  upstream = add('delivery:plan', 'delivery-plan', '交付规划', 'story-splitter-agent', 'split', upstream);
  upstream = add('delivery:review', 'review', '整体验收', 'review-agent', 'review', upstream);
  add('delivery:closure', 'closure', '阅读结卡报告', null, null, upstream);
  return { items, dependencies };
}
