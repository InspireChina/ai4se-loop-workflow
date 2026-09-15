/** Historical migration fixture ONLY. Never import this selector in runtime code. */
import type Database from 'better-sqlite3';
import type { Task, DelegationEnvelope } from '../application/tasks';
import type { TaskLane } from '../application/task-lanes';
import { taskLanesInDb, refreshTaskLaneStatesInDb } from '../application/task-lanes';
import type { Delegation } from '../domain/task';
import { resourcesForAgent } from '../domain/resource';
import { agentCommandProfile } from '../domain/agent-command-profile';
import { nativeTaskHoldInDb } from '../application/work-item-controls';
import { syncLegacyDeliveryWorkItemsInDb } from '../application/work-items';
import type { FeedbackDispatch } from './legacy-feedback-dispatch';
import type { FeedbackItemContext } from '../application/work-item-feedback';
import { requirementPriorityRank } from '../domain/requirement-priority';
import { agentConcurrencyInDb } from '../application/project-settings';
import { requirementDependencyGateOpenInDb } from '../application/task-dependencies';
import { readyWorkflowItemsForTaskInDb, type WorkflowItemRow } from '../application/work-items';
import { nativeWorkflowEndedInDb, workflowBlockedInDb } from '../application/work-item-controls';
import { nextFeedbackDispatchInDb } from './legacy-feedback-dispatch';
import { taskContextChatTurnIsRunning } from '../application/task-context-chat';
import { dispatchProjectionSupport, planDispatchInDb, projectRequirementWorkInDb, toEnvelope } from '../application/dispatch-planner';
type Db = Database.Database;
function feedbackCanDispatch(db: Db, task: Task, lanes: TaskLane[]) {
  if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(task.task_id)) {
    return !task.is_paused && !nativeTaskHoldInDb(db, task.task_id);
  }
  if (task.is_paused || task.agile_status === 'blocked') return false;
  if (!['runnable', 'idle'].includes(task.run_state)) return false;
  return !lanes.some((lane) => lane.resume_pending
    || ['waiting_for_answers', 'waiting_for_runtime_input', 'system_blocked'].includes(lane.status));
}

function feedbackDelegation(task: Task, work: FeedbackDispatch): DelegationEnvelope {
  const agent = work.kind === 'repro' ? 'repro-agent'
    : work.kind === 'split' ? 'story-splitter-agent'
      : work.kind === 'report' ? 'review-agent'
        : 'feedback-agent';
  const pipeline = work.kind === 'triage' ? 'feedback-triage'
    : work.kind === 'verify' ? 'feedback-verify'
      : work.kind === 'repro' ? 'feedback-repro'
        : work.kind === 'split' ? 'feedback-split'
          : 'feedback-report';
  return {
    ...toEnvelope(task, {
      taskId: task.task_id,
      lane: 'control',
      pipeline,
      agent,
      storyIndex: null,
      resources: resourcesForAgent(agent),
      feedbackId: work.feedbackId,
      feedbackIds: work.commentIds,
      feedbackBatchId: work.batchId,
      feedbackGroupId: 'groupId' in work ? work.groupId : null,
      description: work.description,
    }),
    feedbackId: work.feedbackId,
    feedbackIds: work.commentIds,
    feedbackBatchId: work.batchId,
    feedbackGroupId: 'groupId' in work ? work.groupId : null,
  };
}

type ActiveLaneExecution = { task_id: string; lane: string; agent: string };

function activeLaneExecutions(db: Db) {
  return db.prepare(`
    SELECT task_id, lane, MAX(agent) AS agent
    FROM (
      SELECT task_id, COALESCE(lane, CASE
        WHEN agent = 'analyst-agent' THEN 'analysis'
        WHEN agent IN ('dev-agent', 'test-agent') THEN 'delivery'
        ELSE 'control'
      END) AS lane, agent
      FROM execution_attempts
      WHERE status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
      UNION ALL
      SELECT task_id, CASE
        WHEN agent = 'analyst-agent' THEN 'analysis'
        WHEN agent IN ('dev-agent', 'test-agent') THEN 'delivery'
        ELSE 'control'
      END AS lane, agent
      FROM agent_results
      WHERE application_status = 'pending'
    ) active
    GROUP BY task_id, lane
  `).all() as ActiveLaneExecution[];
}

function workItemLine(task: Task, item: WorkflowItemRow, lanes: TaskLane[]): Delegation | null {
  if (!item.agent || !item.pipeline || !['control', 'analysis', 'delivery'].includes(item.lane || '')) return null;
  const lane = item.lane as Delegation['lane'];
  const laneState = lane === 'control' ? null : lanes.find((candidate) => candidate.lane === lane);
  const resumableControlAgent = ['idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent', 'backlog-agent', 'repro-agent']
    .includes(item.agent);
  const pipeline = item.origin === 'native'
    ? item.resume_pending && !item.pipeline.startsWith('feedback-') && agentCommandProfile(item.agent, 'resume') ? 'resume' : item.pipeline
    : lane === 'control'
    ? task.resume_pending && task.current_subagent === item.agent && resumableControlAgent ? 'resume' : item.pipeline
    : laneState?.resume_pending && laneState.current_agent === item.agent ? 'resume' : item.pipeline;
  const descriptions: Record<string, string> = {
    'direct:execute': '直接执行当前需求并提交最终结果',
    'ba:intent': '确认需求意图并关闭目标歧义',
    'ba:design': '探索并确定唯一业务方案',
    'ba:spec': '编写并验证需求规格说明书',
    'ba:review': '独立审查需求规格并批准或分类回流',
    'delivery:context': '澄清业务变化上下文',
    'delivery:repro': '复现 Bug 并定位根因',
    'delivery:plan': '拆分为可独立验收的交付单元',
    'delivery:review': '全部交付单元已完成，进入整体验收',
  };
  const description = pipeline === 'resume'
    ? lane === 'control'
      ? '读取人工输入，并安全恢复任务级流程'
      : lane === 'analysis'
        ? '读取人工输入或恢复信息，并继续交付分析通道'
        : '读取人工输入，并恢复开发验证通道'
    : descriptions[item.work_key]
      || (item.agent === 'analyst-agent' ? `收敛交付单元 ${item.story_index} 的实际影响、关键决策与冻结交付契约`
        : item.agent === 'dev-agent' ? `实现交付单元 ${item.story_index}`
          : item.agent === 'test-agent' ? `验证交付单元 ${item.story_index}`
            : item.title);
  const feedback = item.kind === 'feedback' ? JSON.parse(item.context_json || '{}') as FeedbackItemContext : undefined;
  return {
    taskId: task.task_id,
    lane,
    pipeline,
    agent: item.agent,
    storyIndex: item.story_index,
    resources: resourcesForAgent(item.agent),
    description,
    ...(feedback ? { feedbackId: feedback.feedbackId, feedbackIds: feedback.feedbackIds,
      feedbackBatchId: feedback.feedbackBatchId, feedbackGroupId: feedback.feedbackGroupId || null } : {}),
    ...(item.origin === 'native' ? {
      workItemId: item.item_id, workItemRevision: item.revision, workItemEpoch: item.dispatch_epoch,
    } : {}),
  };
}
const { dispatchTaskSelect, activeAgentExecutionCount, schedulingResourceClaims,
  resourcesAvailable, reserveResources, attachBusinessAnalysisRevisionFeedback } = dispatchProjectionSupport;
function refreshWorkflowForDispatchInDb(db: Db, task: Task) {
  if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(task.task_id)) {
    dispatchProjectionSupport.refreshWorkflowForDispatchInDb(db, task);
  } else {
    refreshTaskLaneStatesInDb(db, task);
    syncLegacyDeliveryWorkItemsInDb(db, task.task_id);
  }
}
function dispatchStageRank(status: string) {
  return ({
    blocked: 0,
    'in dev': 1,
    'in review': 2,
    'in plan': 4,
    'in repro': 5,
    backlog: 6,
  } as Record<string, number>)[status] ?? 7;
}

function compareDispatchTasks(left: Task, right: Task) {
  return requirementPriorityRank(right.priority) - requirementPriorityRank(left.priority)
    || dispatchStageRank(left.agile_status) - dispatchStageRank(right.agile_status)
    || right.updated_at.localeCompare(left.updated_at)
    || left.task_id.localeCompare(right.task_id);
}

function compareAnalysisCandidates(a: { task: Task; lane: TaskLane; item: WorkflowItemRow }, b: { task: Task; lane: TaskLane; item: WorkflowItemRow }) {
  const leftReadyAt = a.item.origin === 'native' ? a.item.ready_at || a.item.updated_at : a.lane.ready_at || a.lane.updated_at || a.task.updated_at;
  const rightReadyAt = b.item.origin === 'native' ? b.item.ready_at || b.item.updated_at : b.lane.ready_at || b.lane.updated_at || b.task.updated_at;
  return requirementPriorityRank(b.task.priority) - requirementPriorityRank(a.task.priority)
    || leftReadyAt.localeCompare(rightReadyAt)
    || a.task.task_id.localeCompare(b.task.task_id);
}

function planLegacyDispatchInDb(db: Db): DelegationEnvelope[] {
  const tasks = db.prepare(`${dispatchTaskSelect}
    WHERE workflow_engine = 'legacy' AND agile_status NOT IN ('done', 'cancelled') AND is_paused = 0
      AND EXISTS (
        SELECT 1 FROM projects project
        WHERE project.project_id = tasks.project_id AND project.deleted_at IS NULL
      )`)
    .all() as Task[];
  tasks.sort(compareDispatchTasks);
  const active = activeLaneExecutions(db);
  const activeKeys = new Set(active.map((item) => `${item.task_id}:${item.lane}`));
  let agentSlots = Math.max(0, agentConcurrencyInDb(db) - activeAgentExecutionCount(db));
  const resourceClaims = schedulingResourceClaims(db);
  const reservedResources = new Set<string>();
  const lines: DelegationEnvelope[] = [];
  const analysisCandidates: { task: Task; lane: TaskLane; item: WorkflowItemRow }[] = [];

  for (const task of tasks) {
    if (!requirementDependencyGateOpenInDb(db, task.task_id)) continue;
    refreshWorkflowForDispatchInDb(db, task);
    if (nativeWorkflowEndedInDb(db, task.task_id) || workflowBlockedInDb(db, task.task_id)) continue;
    const lanes = taskLanesInDb(db, task);
    const readyItems = readyWorkflowItemsForTaskInDb(db, task.task_id);
    const feedback = taskContextChatTurnIsRunning(db, task.task_id)
      ? undefined
      : nextFeedbackDispatchInDb(db, task.task_id);
    const taskHasActive = active.some((item) => item.task_id === task.task_id);
    if (feedback && feedbackCanDispatch(db, task, lanes)) {
      const delegation = feedbackDelegation(task, feedback);
      if (!taskHasActive
        && agentSlots > 0
        && resourcesAvailable(db, delegation, resourceClaims, reservedResources)) {
        reserveResources(db, delegation, reservedResources);
        lines.push(delegation);
        agentSlots -= 1;
      }
      continue;
    }
    const controlItem = readyItems.find((item) => item.kind === 'feedback' && item.lane === 'control')
      || readyItems.find((item) => item.lane === 'control');
    const rawControl = controlItem ? workItemLine(task, controlItem, lanes) : null;
    const control = rawControl ? attachBusinessAnalysisRevisionFeedback(db, task, rawControl) : null;
    if (control) {
      if (!taskHasActive
        && agentSlots > 0
        && resourcesAvailable(db, control, resourceClaims, reservedResources)) {
        reserveResources(db, control, reservedResources);
        lines.push(toEnvelope(task, control));
        agentSlots -= 1;
      }
      continue;
    }
    const analysis = lanes.find((lane) => lane.lane === 'analysis');
    const analysisItem = readyItems.find((item) => item.lane === 'analysis');
    if (analysis && analysisItem && !activeKeys.has(`${task.task_id}:analysis`)) {
      analysisCandidates.push({ task, lane: analysis, item: analysisItem });
    }
    const delivery = lanes.find((lane) => lane.lane === 'delivery');
    if (!delivery || activeKeys.has(`${task.task_id}:delivery`)) continue;
    const deliveryItem = readyItems.find((item) => item.lane === 'delivery');
    const deliveryWork = deliveryItem ? workItemLine(task, deliveryItem, lanes) : null;
    if (!deliveryWork || !agentSlots || !resourcesAvailable(db, deliveryWork, resourceClaims, reservedResources)) continue;
    reserveResources(db, deliveryWork, reservedResources);
    lines.push(toEnvelope(task, deliveryWork, delivery.retry_cycle));
    agentSlots -= 1;
  }

  for (const candidate of analysisCandidates.sort(compareAnalysisCandidates)) {
    if (!agentSlots) break;
    const lanes = taskLanesInDb(db, candidate.task);
    const work = workItemLine(candidate.task, candidate.item, lanes);
    if (!work || !resourcesAvailable(db, work, resourceClaims, reservedResources)) continue;
    reserveResources(db, work, reservedResources);
    lines.push(toEnvelope(candidate.task, work, candidate.lane.retry_cycle));
    agentSlots -= 1;
  }
  return lines;
}


export function planHistoricalFixturesInDb(db: Db): DelegationEnvelope[] {
  const native = planDispatchInDb(db);
  const historical = planLegacyDispatchInDb(db);
  const queue = [...historical, ...native].map((work, index) => ({ work, index,
    createdAt: (db.prepare('SELECT created_at FROM tasks WHERE task_id = ?').get(work.taskId) as { created_at: string }).created_at }));
  queue.sort((a,b) => requirementPriorityRank(b.work.priority) - requirementPriorityRank(a.work.priority)
    || a.createdAt.localeCompare(b.createdAt) || a.work.taskId.localeCompare(b.work.taskId) || a.index-b.index);
  const claims = schedulingResourceClaims(db); const reserved = new Set<string>();
  let slots = Math.max(0, agentConcurrencyInDb(db) - activeAgentExecutionCount(db));
  const selected: DelegationEnvelope[] = [];
  for (const candidate of queue) {
    if (!slots) break;
    if (!resourcesAvailable(db,candidate.work,claims,reserved)) continue;
    reserveResources(db,candidate.work,reserved); selected.push(candidate.work); slots--;
  }
  return selected;
}

/** Old display/scheduling expectations used only to verify adoption history. */
export function projectHistoricalRequirementWorkInDb(db: Db, taskId: string): import('../domain/task').Delegation[] {
  if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId)) {
    return projectRequirementWorkInDb(db, taskId);
  }
  const task = db.prepare(dispatchTaskSelect+' WHERE task_id = ?').get(taskId) as Task | undefined;
  if (!task) throw new Error('需求不存在');
  if (task.is_paused || !requirementDependencyGateOpenInDb(db,taskId)) return [];
  if (!db.prepare('SELECT 1 FROM projects WHERE project_id = (SELECT project_id FROM tasks WHERE task_id = ?) AND deleted_at IS NULL').get(taskId)) return [];
  refreshWorkflowForDispatchInDb(db,task);
  if (workflowBlockedInDb(db,taskId) || nativeWorkflowEndedInDb(db,taskId)) return [];
  const active = activeLaneExecutions(db).filter((item) => item.task_id === taskId);
  const lanes = taskLanesInDb(db, task);
  const readyItems = readyWorkflowItemsForTaskInDb(db, taskId);
  const resourceClaims = schedulingResourceClaims(db);
  const feedback = taskContextChatTurnIsRunning(db, taskId) ? undefined : nextFeedbackDispatchInDb(db, taskId);
  if (feedback && feedbackCanDispatch(db, task, lanes)) {
    const work = feedbackDelegation(task, feedback);
    return active.length || !resourcesAvailable(db, work, resourceClaims, new Set()) ? [] : [work];
  }
  const controlItem = readyItems.find((item) => item.kind === 'feedback' && item.lane === 'control')
    || readyItems.find((item) => item.lane === 'control');
  const rawControl = controlItem ? workItemLine(task, controlItem, lanes) : null;
  const control = rawControl ? attachBusinessAnalysisRevisionFeedback(db, task, rawControl) : null;
  if (control) return active.length || !resourcesAvailable(db, control, resourceClaims, new Set()) ? [] : [control];
  return readyItems
    .filter((item) => item.lane !== 'control')
    .filter((item) => !active.some((activeItem) => activeItem.lane === item.lane))
    .map((item) => workItemLine(task, item, lanes))
    .filter((work): work is import('../domain/task').Delegation => Boolean(work))
    .filter((work) => resourcesAvailable(db, work, resourceClaims, new Set()));
}
