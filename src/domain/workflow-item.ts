export const WORK_ITEM_STATUSES = [
  'pending',
  'ready',
  'running',
  'waiting',
  'completed',
  'superseded',
  'cancelled',
] as const;

export type WorkItemStatus = typeof WORK_ITEM_STATUSES[number];

export type WorkItemProjection = {
  workKey: string;
  kind: string;
  title: string;
  storyIndex: number | null;
  agent: string | null;
  pipeline: string | null;
  lane: 'control' | 'analysis' | 'delivery';
  status: WorkItemStatus;
};

export type WorkItemDependencyProjection = {
  workKey: string;
  dependsOnWorkKey: string;
  dependencyKind: 'completion' | 'ordering';
};

export type LegacyLaneProjection = {
  status: 'pending' | 'runnable' | 'running' | 'waiting_for_answers' | 'waiting_for_runtime_input' | 'system_blocked' | 'completed';
  currentAgent: string | null;
  currentStoryIndex: number | null;
  resumePending?: number;
};

export type LegacyDeliveryProjectionInput = {
  taskId: string;
  itemType?: string;
  taskStatus: string;
  runState?: string;
  currentAgent: string | null;
  totalStories: number;
  analysisIndex: number;
  devIndex: number;
  testIndex: number;
  analysisLane?: LegacyLaneProjection;
  deliveryLane?: LegacyLaneProjection;
};

export type LegacyDeliveryProjection = {
  items: WorkItemProjection[];
  dependencies: WorkItemDependencyProjection[];
};

export type LegacyExecutionIdentity = {
  agent: string;
  pipeline: string;
  storyIndex: number | null;
};

/**
 * Historical adoption adapter. Legacy cursors no longer drive production
 * dispatch; this key identifies old sources while importing their graph.
 */
export function legacyWorkKeyForExecution(input: LegacyExecutionIdentity) {
  if (input.agent === 'direct-agent' && input.pipeline === 'direct') return 'direct:execute';
  if (input.agent === 'idea-context-agent') return 'ba:intent';
  if (input.agent === 'business-design-agent') return 'ba:design';
  if (input.agent === 'requirement-spec-agent') return 'ba:spec';
  if (input.agent === 'spec-review-agent') return 'ba:review';
  if (input.agent === 'backlog-agent') return 'delivery:context';
  if (input.agent === 'repro-agent') return 'delivery:repro';
  if (input.agent === 'story-splitter-agent' && ['split', 'resume'].includes(input.pipeline)) {
    return 'delivery:plan';
  }
  if (input.storyIndex && input.agent === 'analyst-agent') return `delivery:analysis:${input.storyIndex}`;
  if (input.storyIndex && input.agent === 'dev-agent') return `delivery:dev:${input.storyIndex}`;
  if (input.storyIndex && input.agent === 'test-agent') return `delivery:test:${input.storyIndex}`;
  if (input.agent === 'review-agent' && input.pipeline === 'review') return 'delivery:review';
  return null;
}

function laneItemStatus(
  lane: LegacyLaneProjection | undefined,
  agent: string,
  storyIndex: number,
) {
  if (lane?.currentAgent !== agent || lane.currentStoryIndex !== storyIndex) return null;
  if (lane.status === 'runnable' && lane.resumePending) return 'ready' as const;
  if (lane.status === 'running') return 'running' as const;
  if (['waiting_for_answers', 'waiting_for_runtime_input', 'system_blocked'].includes(lane.status)) {
    return 'waiting' as const;
  }
  return null;
}

function remainingStatus(taskStatus: string) {
  return taskStatus === 'cancelled' ? 'cancelled' as const : 'pending' as const;
}

/**
 * Builds the historical delivery graph at the explicit adoption boundary.
 * This pure projection never authorizes native dispatch or overwrites native
 * nodes from compatibility cursor and Lane fields.
 */
export function projectLegacyDeliveryWorkflow(input: LegacyDeliveryProjectionInput): LegacyDeliveryProjection {
  const items: WorkItemProjection[] = [];
  const dependencies: WorkItemDependencyProjection[] = [];
  const itemType = input.itemType || 'feature';
  const total = Math.max(0, input.totalStories);
  const terminalStatus = input.taskStatus === 'cancelled' ? 'cancelled' as const : null;
  const activeControlStatus: WorkItemStatus = input.runState && input.runState !== 'runnable'
    ? 'waiting'
    : 'ready';

  if (itemType === 'direct') {
    items.push({
      workKey: 'direct:execute',
      kind: 'direct',
      title: '直接执行',
      storyIndex: null,
      agent: 'direct-agent',
      pipeline: 'direct',
      lane: 'control',
      status: input.taskStatus === 'done' ? 'completed' : terminalStatus || activeControlStatus,
    });
    return { items, dependencies };
  }

  const hasBusinessAnalysis = itemType === 'business-analysis' || itemType === 'end-to-end';
  if (hasBusinessAnalysis) {
    const stages = [
      { key: 'ba:intent', kind: 'ba-intent', title: '需求意图确认', agent: 'idea-context-agent', pipeline: 'ba-intent' },
      { key: 'ba:design', kind: 'ba-design', title: '业务方案设计', agent: 'business-design-agent', pipeline: 'ba-design' },
      { key: 'ba:spec', kind: 'ba-spec', title: '需求规格编写', agent: 'requirement-spec-agent', pipeline: 'ba-spec' },
      { key: 'ba:review', kind: 'ba-review', title: '规格独立审查', agent: 'spec-review-agent', pipeline: 'ba-review' },
    ] as const;
    const currentIndex = stages.findIndex((stage) => stage.agent === input.currentAgent);
    const analysisFinished = ['ready_to_close', 'done'].includes(input.taskStatus)
      || (itemType === 'end-to-end' && currentIndex < 0 && (
        input.currentAgent === 'backlog-agent'
        || total > 0
        || !['backlog', 'blocked', 'cancelled'].includes(input.taskStatus)
      ));
    for (const [index, stage] of stages.entries()) {
      const status: WorkItemStatus = terminalStatus
        || (analysisFinished
          ? 'completed'
          : currentIndex < 0
            ? index === 0 ? activeControlStatus : 'pending'
            : index < currentIndex
              ? 'completed'
              : index === currentIndex ? activeControlStatus : 'pending');
      items.push({
        workKey: stage.key,
        kind: stage.kind,
        title: stage.title,
        storyIndex: null,
        agent: stage.agent,
        pipeline: stage.pipeline,
        lane: 'control',
        status,
      });
      if (index > 0) dependencies.push({
        workKey: stage.key,
        dependsOnWorkKey: stages[index - 1]!.key,
        dependencyKind: 'completion',
      });
    }
    if (itemType === 'business-analysis') {
      items.push({
        workKey: 'ba:closure',
        kind: 'closure',
        title: '阅读需求规格',
        storyIndex: null,
        agent: null,
        pipeline: null,
        lane: 'control',
        status: input.taskStatus === 'done'
          ? 'completed'
          : terminalStatus || (input.taskStatus === 'ready_to_close' ? 'waiting' : 'pending'),
      });
      dependencies.push({ workKey: 'ba:closure', dependsOnWorkKey: 'ba:review', dependencyKind: 'completion' });
      return { items, dependencies };
    }
  }

  // Cancellation/blocking is a control intent, not proof that a role finished.
  const contextCompleted = total > 0 || !['backlog', 'cancelled', 'blocked'].includes(input.taskStatus)
    || ['repro-agent', 'story-splitter-agent', 'analyst-agent', 'dev-agent', 'test-agent', 'review-agent'].includes(input.currentAgent || '');
  items.push({
    workKey: 'delivery:context',
    kind: 'requirement-context',
    title: '需求梳理',
    storyIndex: null,
    agent: 'backlog-agent',
    pipeline: 'backlog',
    lane: 'control',
    status: contextCompleted
      ? 'completed'
      : terminalStatus || (input.currentAgent === 'backlog-agent' || !input.currentAgent ? activeControlStatus : 'pending'),
  });
  if (hasBusinessAnalysis) dependencies.push({
    workKey: 'delivery:context',
    dependsOnWorkKey: 'ba:review',
    dependencyKind: 'completion',
  });

  const requiresRepro = itemType === 'bug';
  if (requiresRepro) {
    const reproCompleted = total > 0 || !['backlog', 'in repro', 'cancelled', 'blocked'].includes(input.taskStatus)
      || input.currentAgent === 'story-splitter-agent';
    items.push({
      workKey: 'delivery:repro',
      kind: 'reproduction',
      title: '问题复现',
      storyIndex: null,
      agent: 'repro-agent',
      pipeline: 'repro',
      lane: 'control',
      status: reproCompleted
        ? 'completed'
        : terminalStatus || (input.currentAgent === 'repro-agent' || input.taskStatus === 'in repro' ? activeControlStatus : 'pending'),
    });
    dependencies.push({ workKey: 'delivery:repro', dependsOnWorkKey: 'delivery:context', dependencyKind: 'completion' });
  }
  const planCompleted = total > 0;
  const planStatus: WorkItemStatus = planCompleted
    ? 'completed'
    : input.taskStatus === 'cancelled'
      ? 'cancelled'
      : input.taskStatus === 'in plan'
        ? 'ready'
        : 'pending';

  items.push({
    workKey: 'delivery:plan',
    kind: 'delivery-plan',
    title: '交付规划',
    storyIndex: null,
    agent: 'story-splitter-agent',
    pipeline: 'split',
    lane: 'control',
    status: planStatus,
  });
  dependencies.push({
    workKey: 'delivery:plan',
    dependsOnWorkKey: requiresRepro ? 'delivery:repro' : 'delivery:context',
    dependencyKind: 'completion',
  });

  for (let storyIndex = 1; storyIndex <= total; storyIndex += 1) {
    const analysisKey = `delivery:analysis:${storyIndex}`;
    const devKey = `delivery:dev:${storyIndex}`;
    const testKey = `delivery:test:${storyIndex}`;
    const analysisOverride = laneItemStatus(input.analysisLane, 'analyst-agent', storyIndex);
    const devOverride = laneItemStatus(input.deliveryLane, 'dev-agent', storyIndex);
    const testOverride = laneItemStatus(input.deliveryLane, 'test-agent', storyIndex);

    items.push({
      workKey: analysisKey,
      kind: 'delivery-analysis',
      title: `交付分析 #${storyIndex}`,
      storyIndex,
      agent: 'analyst-agent',
      pipeline: 'analysis',
      lane: 'analysis',
      status: analysisOverride || (storyIndex <= input.analysisIndex
        ? 'completed'
        : remainingStatus(input.taskStatus)),
    });
    items.push({
      workKey: devKey,
      kind: 'development',
      title: `开发 #${storyIndex}`,
      storyIndex,
      agent: 'dev-agent',
      pipeline: 'dev',
      lane: 'delivery',
      status: devOverride || (storyIndex <= input.devIndex
        ? 'completed'
        : remainingStatus(input.taskStatus)),
    });
    items.push({
      workKey: testKey,
      kind: 'verification',
      title: `验证 #${storyIndex}`,
      storyIndex,
      agent: 'test-agent',
      pipeline: 'test',
      lane: 'delivery',
      status: testOverride || (storyIndex <= input.testIndex
        ? 'completed'
        : remainingStatus(input.taskStatus)),
    });

    dependencies.push({ workKey: analysisKey, dependsOnWorkKey: 'delivery:plan', dependencyKind: 'completion' });
    if (storyIndex > 1) {
      dependencies.push({
        workKey: analysisKey,
        dependsOnWorkKey: `delivery:analysis:${storyIndex - 1}`,
        dependencyKind: 'ordering',
      });
    }
    dependencies.push({ workKey: devKey, dependsOnWorkKey: analysisKey, dependencyKind: 'completion' });
    if (storyIndex > 1) {
      dependencies.push({
        workKey: devKey,
        dependsOnWorkKey: `delivery:test:${storyIndex - 1}`,
        dependencyKind: 'ordering',
      });
    }
    dependencies.push({ workKey: testKey, dependsOnWorkKey: devKey, dependencyKind: 'completion' });
  }

  const deliveryComplete = total > 0
    && input.analysisIndex === total
    && input.devIndex === total
    && input.testIndex === total;
  const lanesComplete = (!input.analysisLane || input.analysisLane.status === 'completed')
    && (!input.deliveryLane || input.deliveryLane.status === 'completed');
  const reviewCompleted = ['ready_to_close', 'done'].includes(input.taskStatus);
  items.push({
    workKey: 'delivery:review',
    kind: 'review',
    title: '整体验收',
    storyIndex: null,
    agent: 'review-agent',
    pipeline: 'review',
    lane: 'control',
    status: reviewCompleted
      ? 'completed'
      : input.taskStatus === 'cancelled'
        ? 'cancelled'
        : ['ready for dev', 'in dev', 'in review'].includes(input.taskStatus) && deliveryComplete && lanesComplete
          ? 'ready'
          : 'pending',
  });
  for (let storyIndex = 1; storyIndex <= total; storyIndex += 1) {
    dependencies.push({
      workKey: 'delivery:review',
      dependsOnWorkKey: `delivery:test:${storyIndex}`,
      dependencyKind: 'completion',
    });
  }

  items.push({
    workKey: 'delivery:closure',
    kind: 'closure',
    title: '阅读结卡',
    storyIndex: null,
    agent: null,
    pipeline: null,
    lane: 'control',
    status: input.taskStatus === 'done'
      ? 'completed'
      : input.taskStatus === 'cancelled'
        ? 'cancelled'
        : input.taskStatus === 'ready_to_close'
          ? 'waiting'
          : 'pending',
  });
  dependencies.push({
    workKey: 'delivery:closure',
    dependsOnWorkKey: 'delivery:review',
    dependencyKind: 'completion',
  });

  const activeAnalysis = items.some((item) => item.lane === 'analysis' && ['running', 'waiting'].includes(item.status));
  if (!activeAnalysis && input.analysisLane?.status === 'runnable') {
    const next = items.find((item) => item.workKey === `delivery:analysis:${input.analysisIndex + 1}`);
    if (next?.status === 'pending') next.status = 'ready';
  }

  const activeDelivery = items.some((item) => item.lane === 'delivery' && ['running', 'waiting'].includes(item.status));
  if (!activeDelivery && input.deliveryLane?.status === 'runnable') {
    const nextKey = input.testIndex < input.devIndex
      ? `delivery:test:${input.testIndex + 1}`
      : input.devIndex < input.analysisIndex
        ? `delivery:dev:${input.devIndex + 1}`
        : null;
    const next = nextKey ? items.find((item) => item.workKey === nextKey) : undefined;
    if (next?.status === 'pending') next.status = 'ready';
  }

  return { items, dependencies };
}
