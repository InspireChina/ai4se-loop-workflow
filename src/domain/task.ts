export const ACTORS = ['human', 'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent'] as const;
export const TASK_STATUSES = ['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'done', 'cancelled', 'blocked'] as const;
export type Actor = typeof ACTORS[number];
export type TaskStatus = typeof TASK_STATUSES[number];

export type TaskState = {
  task_id: string;
  agile_status: TaskStatus;
  current_subagent: string | null;
  analysis_index: number;
  dev_index: number;
  test_index: number;
  total_stories: number;
  analysis_approved_index: number;
  review_approved: number;
  resume_status: TaskStatus | null;
  resume_pending: number;
  blocked_reason: string | null;
  work_dir: string;
};

const transitions: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['backlog', 'in plan', 'in repro', 'blocked'],
  'in repro': ['in repro', 'in plan', 'blocked'],
  'in plan': ['in plan', 'ready for dev', 'blocked'],
  'ready for dev': ['ready for dev', 'in dev', 'blocked'],
  'in dev': ['in dev', 'in review', 'blocked'],
  'in review': ['in review', 'done', 'blocked'],
  done: ['done'],
  cancelled: ['cancelled'],
  blocked: ['blocked'],
};

const fieldPermissions: Partial<Record<Actor, string[]>> = {
  'backlog-agent': ['title', 'agile_status', 'current_subagent', 'next_step', 'blocked_reason', 'work_dir', 'item_type', 'priority'],
  'story-splitter-agent': ['agile_status', 'current_subagent', 'analysis_index', 'dev_index', 'test_index', 'total_stories', 'next_step', 'blocked_reason'],
  'analyst-agent': ['agile_status', 'current_subagent', 'analysis_index', 'next_step', 'blocked_reason', 'approval_file'],
  'repro-agent': ['agile_status', 'current_subagent', 'next_step', 'blocked_reason'],
  'dev-agent': ['agile_status', 'current_subagent', 'dev_index', 'next_step', 'blocked_reason'],
  'test-agent': ['agile_status', 'current_subagent', 'test_index', 'next_step', 'blocked_reason'],
  'review-agent': ['agile_status', 'current_subagent', 'next_step', 'blocked_reason', 'work_dir', 'approval_file'],
};

const statusPermissions: Partial<Record<Actor, TaskStatus[]>> = {
  'backlog-agent': ['backlog', 'in plan', 'in repro', 'blocked'],
  'story-splitter-agent': ['in plan', 'ready for dev', 'in dev', 'blocked'],
  'analyst-agent': ['ready for dev', 'in dev', 'blocked'],
  'repro-agent': ['in repro', 'in plan', 'blocked'],
  'dev-agent': ['in dev', 'blocked'],
  'test-agent': ['in dev', 'in review', 'blocked'],
  'review-agent': ['in review', 'blocked', 'done'],
};

const agentPermissions: Partial<Record<Actor, string[]>> = {
  'backlog-agent': ['backlog-agent', 'story-splitter-agent', 'repro-agent'],
  'story-splitter-agent': ['story-splitter-agent', 'analyst-agent'],
  'analyst-agent': ['analyst-agent'],
  'repro-agent': ['repro-agent', 'story-splitter-agent'],
  'dev-agent': ['dev-agent'],
  'test-agent': ['test-agent', 'review-agent'],
  'review-agent': ['review-agent'],
};

export function assertState(state: TaskState) {
  if (!(0 <= state.test_index && state.test_index <= state.dev_index && state.dev_index <= state.analysis_index && state.analysis_index <= state.total_stories)) {
    throw new Error('无效 Story 游标：必须满足 test <= dev <= analysis <= total');
  }
  if (!(state.analysis_index <= state.analysis_approved_index && state.analysis_approved_index <= Math.min(state.analysis_index + 1, state.total_stories))) {
    throw new Error('无效 analysis approval 游标');
  }
  if (state.agile_status === 'ready for dev' && state.total_stories === 0) throw new Error('ready for dev 必须已有 Story');
  if (state.agile_status === 'in review' && !(state.total_stories > 0 && state.test_index === state.dev_index && state.dev_index === state.analysis_index && state.analysis_index === state.total_stories)) {
    throw new Error('进入 review 前必须完成全部 Story');
  }
  if (state.agile_status === 'blocked' && (!state.current_subagent || !state.blocked_reason)) {
    throw new Error('blocked 必须包含当前 Agent 和原因');
  }
}

export function assertUpdate(before: TaskState, actor: Actor, next: Partial<TaskState>, changedFields: string[]) {
  if (actor !== 'human') {
    const allowed = fieldPermissions[actor];
    if (!allowed) throw new Error(`${actor} 无权更新 Task`);
    const forbidden = changedFields.filter((field) => !allowed.includes(field));
    if (forbidden.length) throw new Error(`${actor} 无权更新字段：${forbidden.join(', ')}`);
    if (next.agile_status && !statusPermissions[actor]?.includes(next.agile_status)) throw new Error(`${actor} 无权设置状态 ${next.agile_status}`);
    if (next.current_subagent && !agentPermissions[actor]?.includes(next.current_subagent)) throw new Error(`${actor} 无权交接给 ${next.current_subagent}`);
  }
  if (before.resume_pending && actor !== before.current_subagent) throw new Error(`恢复仅保留给 ${before.current_subagent}`);
  if (before.agile_status === 'blocked' && next.agile_status && next.agile_status !== 'blocked') {
    throw new Error('blocked Task 必须通过 block-release 恢复');
  }
  if (next.agile_status && next.agile_status !== 'cancelled' && !transitions[before.agile_status].includes(next.agile_status)) {
    throw new Error(`禁止状态回退 ${before.agile_status} -> ${next.agile_status}；请使用 rewind`);
  }
  for (const key of ['analysis_index', 'dev_index', 'test_index'] as const) {
    if (next[key] !== undefined && (next[key]! < before[key] || next[key]! > before[key] + 1)) {
      throw new Error(`${key} 只能前进一个 Story；回退请使用 rewind`);
    }
  }
  if (next.total_stories !== undefined && next.total_stories < before.total_stories) {
    throw new Error('total_stories 不能通过普通更新减少；请使用 rewind 到 plan');
  }
}

export function assertActorCanCreate(actor: Actor, status: TaskStatus, currentSubagent: string | null) {
  if (actor !== 'human') throw new Error(`${actor} 无权创建 Task`);
  if (status !== 'backlog' || currentSubagent) throw new Error('Web 新建 Task 只能创建未分配 backlog Task');
}

export function occupiesCodeSlot(task: TaskState) {
  return task.agile_status === 'in dev' || task.agile_status === 'in review' || (task.agile_status === 'blocked' && (task.resume_status === 'in dev' || task.resume_status === 'in review' || task.current_subagent === 'review-agent'));
}

export type Delegation = { taskId: string; pipeline: string; agent: string; storyIndex: number | null; resource: 'none' | 'browser'; description: string };

export function nextDelegation(task: TaskState, codeSlotAvailable: boolean): Delegation | null {
  const line = (pipeline: string, agent: string, storyIndex: number | null, description: string): Delegation => ({
    taskId: task.task_id,
    pipeline,
    agent,
    storyIndex,
    resource: ['backlog-agent', 'repro-agent', 'test-agent'].includes(agent) ? 'browser' : 'none',
    description,
  });
  const { analysis_index: a, dev_index: d, test_index: t, total_stories: total, agile_status: status } = task;
  if (status === 'done' || status === 'cancelled' || status === 'blocked') return null;
  if (task.resume_pending) {
    const agent = task.current_subagent!;
    const storyIndex = agent === 'analyst-agent' && a < total ? a + 1 : agent === 'dev-agent' && d < a ? d + 1 : agent === 'test-agent' && t < d ? t + 1 : null;
    return line('resume', agent, storyIndex, '读取人工输入，并安全恢复任务');
  }
  if (status === 'backlog') return line('backlog', 'backlog-agent', null, '收集上下文并完成分类');
  if (status === 'in repro') return line('repro', 'repro-agent', null, '复现 Bug 并定位根因');
  if (status === 'in plan') return line('split', 'story-splitter-agent', null, '拆分为可推进的 Story');
  if (status === 'ready for dev') {
    if (d < a && codeSlotAvailable) return line('dev', 'dev-agent', d + 1, `开发 Story-${d + 1}，并占用代码槽`);
    if (a < total) return line('analysis', 'analyst-agent', a + 1, `分析 Story-${a + 1} 的需求和方案`);
    if (total === 0) return line('split', 'story-splitter-agent', null, '拆分为可推进的 Story');
    return null;
  }
  if (status === 'in review') return line('review', 'review-agent', null, '汇总全部 Story 并准备交付审查');
  if (t === d && d === a && a === total && total > 0) return line('review', 'review-agent', null, '全部 Story 已完成，进入最终审查');
  if (t < d) return line('test', 'test-agent', t + 1, `对 Story-${t + 1} 做黑盒测试`);
  if (d < a) return line('dev', 'dev-agent', d + 1, `开发 Story-${d + 1}`);
  if (a < total) return line('analysis', 'analyst-agent', a + 1, `分析 Story-${a + 1} 的需求和方案`);
  if (total === 0) return line('split', 'story-splitter-agent', null, '拆分为可推进的 Story');
  return null;
}
