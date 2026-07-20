export const ACTORS = ['human', 'system', 'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent', 'dev-agent', 'test-agent', 'review-agent'] as const;
export const TASK_STATUSES = ['backlog', 'in plan', 'in repro', 'ready for dev', 'in dev', 'in review', 'ready_to_close', 'done', 'cancelled', 'blocked'] as const;
export const RUN_STATES = ['runnable', 'waiting_for_answers', 'waiting_for_runtime_input', 'system_blocked', 'idle'] as const;
export type Actor = typeof ACTORS[number];
export type TaskStatus = typeof TASK_STATUSES[number];
export type RunState = typeof RUN_STATES[number];

export type TaskState = {
  task_id: string;
  agile_status: TaskStatus;
  current_subagent: string | null;
  analysis_index: number;
  dev_index: number;
  test_index: number;
  total_stories: number;
  spec_resolved_index: number;
  run_state: RunState;
  closure_status: 'none' | 'awaiting_read' | 'acknowledged';
  review_revision: number;
  review_document_id: string | null;
  closure_acknowledged_at: string | null;
  resume_status: TaskStatus | null;
  resume_pending: number;
  blocked_reason: string | null;
};

const transitions: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['backlog', 'in plan', 'in repro', 'blocked'],
  'in repro': ['in repro', 'in plan', 'blocked'],
  'in plan': ['in plan', 'ready for dev', 'blocked'],
  'ready for dev': ['ready for dev', 'in dev', 'blocked'],
  'in dev': ['in dev', 'in review', 'blocked'],
  'in review': ['in review', 'ready_to_close', 'blocked'],
  ready_to_close: ['ready_to_close', 'done', 'cancelled'],
  done: ['done'],
  cancelled: ['cancelled'],
  blocked: ['blocked'],
};

const fieldPermissions: Partial<Record<Actor, string[]>> = {
  'backlog-agent': ['title', 'agile_status', 'current_subagent', 'next_step', 'item_type', 'priority'],
  'story-splitter-agent': ['agile_status', 'current_subagent', 'analysis_index', 'dev_index', 'test_index', 'total_stories', 'next_step'],
  'analyst-agent': ['agile_status', 'current_subagent', 'analysis_index', 'spec_resolved_index', 'next_step'],
  'repro-agent': ['agile_status', 'current_subagent', 'next_step'],
  'dev-agent': ['agile_status', 'current_subagent', 'dev_index', 'next_step'],
  'test-agent': ['agile_status', 'current_subagent', 'test_index', 'next_step'],
  'review-agent': ['agile_status', 'current_subagent', 'next_step', 'run_state', 'closure_status', 'review_revision', 'review_document_id'],
};

const statusPermissions: Partial<Record<Actor, TaskStatus[]>> = {
  'backlog-agent': ['backlog', 'in plan', 'in repro'],
  'story-splitter-agent': ['in plan', 'ready for dev', 'in dev'],
  'analyst-agent': ['ready for dev', 'in dev'],
  'repro-agent': ['in repro', 'in plan'],
  'dev-agent': ['in dev'],
  'test-agent': ['in dev', 'in review'],
  'review-agent': ['in review', 'ready_to_close'],
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
    throw new Error('无效交付单元游标：必须满足 verification <= implementation <= analysis <= total');
  }
  if (state.spec_resolved_index !== state.analysis_index) throw new Error('方案分析进度必须对应已解决的 Slice Spec');
  if (state.agile_status === 'ready for dev' && state.total_stories === 0) throw new Error('进入单元推进前必须已有交付单元');
  if (state.agile_status === 'in review' && !(state.total_stories > 0 && state.test_index === state.dev_index && state.dev_index === state.analysis_index && state.analysis_index === state.total_stories)) {
    throw new Error('进入整体验收前必须完成全部交付单元');
  }
  if (state.agile_status === 'ready_to_close' && (state.closure_status !== 'awaiting_read' || state.current_subagent !== null || !state.review_document_id || state.review_revision < 1 || state.run_state !== 'idle')) {
    throw new Error('等待结卡必须存在当前版本的 Review 报告且不再运行 Agent');
  }
  if (state.agile_status === 'done' && state.closure_status !== 'acknowledged') throw new Error('需求完成前必须阅读当前结卡报告');
  if (state.agile_status === 'blocked' && (!state.current_subagent || !state.blocked_reason)) {
    throw new Error('blocked 必须包含当前 Agent 和原因');
  }
}

export function assertUpdate(before: TaskState, actor: Actor, next: Partial<TaskState>, changedFields: string[]) {
  if (actor !== 'human' && actor !== 'system') {
    const allowed = fieldPermissions[actor];
    if (!allowed) throw new Error(`${actor} 无权更新需求`);
    const forbidden = changedFields.filter((field) => !allowed.includes(field));
    if (forbidden.length) throw new Error(`${actor} 无权更新字段：${forbidden.join(', ')}`);
    if (next.agile_status && !statusPermissions[actor]?.includes(next.agile_status)) throw new Error(`${actor} 无权设置状态 ${next.agile_status}`);
    if (next.current_subagent && !agentPermissions[actor]?.includes(next.current_subagent)) throw new Error(`${actor} 无权交接给 ${next.current_subagent}`);
  }
  if (before.resume_pending && actor !== 'system' && actor !== before.current_subagent) throw new Error(`恢复仅保留给 ${before.current_subagent}`);
  if (before.agile_status === 'blocked' && next.agile_status && next.agile_status !== 'blocked') {
    throw new Error('系统阻塞必须通过恢复用例解除');
  }
  if (next.agile_status && next.agile_status !== 'cancelled' && !transitions[before.agile_status].includes(next.agile_status)) {
    throw new Error(`禁止状态回退 ${before.agile_status} -> ${next.agile_status}；请使用 rewind`);
  }
  for (const key of ['analysis_index', 'dev_index', 'test_index'] as const) {
    if (next[key] !== undefined && (next[key]! < before[key] || next[key]! > before[key] + 1)) {
      throw new Error(`${key} 只能前进一个交付单元；回退请使用专用操作`);
    }
  }
  if (next.total_stories !== undefined && next.total_stories < before.total_stories) {
    throw new Error('total_stories 不能通过普通更新减少；请使用 rewind 到 plan');
  }
}

export function assertActorCanCreate(actor: Actor, status: TaskStatus, currentSubagent: string | null) {
  if (actor !== 'human') throw new Error(`${actor} 无权创建需求`);
  if (status !== 'backlog' || currentSubagent) throw new Error('Web 新建需求只能进入待梳理状态且不预先分配 Agent');
}

export function occupiesCodeSlot(task: TaskState) {
  return (task.run_state === 'waiting_for_runtime_input' && task.current_subagent === 'dev-agent')
    || task.agile_status === 'in dev'
    || (task.agile_status === 'blocked' && task.resume_status === 'in dev');
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
  if (status === 'done' || status === 'cancelled' || status === 'blocked' || status === 'ready_to_close' || task.run_state !== 'runnable') return null;
  if (task.resume_pending) {
    const agent = task.current_subagent!;
    if (agent === 'dev-agent' && !codeSlotAvailable) return null;
    const storyIndex = agent === 'analyst-agent' && a < total ? a + 1 : agent === 'dev-agent' && d < a ? d + 1 : agent === 'test-agent' && t < d ? t + 1 : null;
    return line('resume', agent, storyIndex, '读取人工输入，并安全恢复需求推进');
  }
  if (status === 'backlog') return line('backlog', 'backlog-agent', null, '收集上下文并完成分类');
  if (status === 'in repro') return line('repro', 'repro-agent', null, '复现 Bug 并定位根因');
  if (status === 'in plan') return line('split', 'story-splitter-agent', null, '拆分为可独立验收的交付单元');
  if (status === 'ready for dev') {
    if (d < a && codeSlotAvailable) return line('dev', 'dev-agent', d + 1, `实现交付单元 ${d + 1}，并占用代码槽`);
    if (a < total) return line('analysis', 'analyst-agent', a + 1, `分析交付单元 ${a + 1} 的需求和方案`);
    if (total === 0) return line('split', 'story-splitter-agent', null, '拆分为可独立验收的交付单元');
    return null;
  }
  if (status === 'in review') return line('review', 'review-agent', null, '汇总全部交付单元并进行整体验收');
  if (t === d && d === a && a === total && total > 0) return line('review', 'review-agent', null, '全部交付单元已完成，进入整体验收');
  if (t < d) return line('test', 'test-agent', t + 1, `验证交付单元 ${t + 1}`);
  if (d < a) return line('dev', 'dev-agent', d + 1, `实现交付单元 ${d + 1}`);
  if (a < total) return line('analysis', 'analyst-agent', a + 1, `分析交付单元 ${a + 1} 的需求和方案`);
  if (total === 0) return line('split', 'story-splitter-agent', null, '拆分为可独立验收的交付单元');
  return null;
}
