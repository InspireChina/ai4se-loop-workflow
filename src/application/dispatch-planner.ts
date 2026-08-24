import type Database from 'better-sqlite3';
import {
  CODE_WORKSPACE_RESOURCE,
  RESOURCE_DEFINITIONS,
  resourcesForAgent,
  type ResourceKey,
} from '../domain/resource';
import { requirementPriorityRank } from '../domain/requirement-priority';
import { nextDelegation, type Delegation } from '../domain/task';
import {
  activeResourceClaimInDb,
  type ResourceClaim,
} from './resource-claims';
import {
  laneCanDispatch,
  refreshTaskLaneStatesInDb,
  taskLanesInDb,
  type TaskLane,
} from './task-lanes';
import { taskContextChatTurnIsRunning } from './task-context-chat';
import { nextFeedbackDispatchInDb, type FeedbackDispatch } from './feedback';
import type { DelegationEnvelope, Task } from './tasks';
import { agentConcurrencyInDb } from './project-settings';
import { requirementDependencyGateOpenInDb } from './task-dependencies';

type Db = Database.Database;

const dispatchTaskSelect = `
  SELECT task_id, title, description, link, external_id, external_status, item_type, priority,
         agile_status, current_subagent, analysis_index, dev_index, test_index,
         total_stories, spec_resolved_index, resume_status,
         resume_pending, next_step, blocked_reason, run_state, closure_status,
         review_revision, review_document_id, closure_acknowledged_at,
         last_actor, owner, evidence, risk, is_paused, paused_reason, paused_at,
         created_at, updated_at, completed_at, retry_cycle
  FROM tasks
`;

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

function feedbackCanDispatch(task: Task, lanes: TaskLane[]) {
  if (task.is_paused || task.agile_status === 'blocked') return false;
  if (!['runnable', 'idle'].includes(task.run_state)) return false;
  return !lanes.some((lane) => lane.resume_pending
    || ['waiting_for_answers', 'waiting_for_runtime_input', 'system_blocked'].includes(lane.status));
}

function toEnvelope(task: Task, delegation: Delegation, retryCycle = task.retry_cycle): DelegationEnvelope {
  return {
    ...delegation,
    title: task.title || '',
    taskDescription: task.description,
    itemType: task.item_type || 'other',
    priority: task.priority || '',
    link: task.link || '',
    externalId: task.external_id || '',
    externalStatus: task.external_status || '',
    agileStatus: task.agile_status,
    currentSubagent: task.current_subagent || '',
    resumePending: task.resume_pending,
    specResolvedIndex: task.spec_resolved_index,
    runState: task.run_state,
    closureStatus: task.closure_status,
    reviewRevision: task.review_revision,
    reviewDocumentId: task.review_document_id || '',
    lastActor: task.last_actor || '',
    analysisIndex: task.analysis_index,
    devIndex: task.dev_index,
    testIndex: task.test_index,
    totalStories: task.total_stories,
    nextStep: task.next_step || '',
    blockedReason: task.blocked_reason || '',
    owner: task.owner || '',
    evidence: task.evidence || '',
    risk: task.risk || '',
    retryCycle,
  };
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

function activeAgentExecutionCount(db: Db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_attempts
    WHERE status IN ('planned', 'running')
  `).get() as { count: number };
  return row.count;
}

function laneLine(task: Task, lane: TaskLane, codeSlotAvailable: boolean): Delegation | null {
  const line = (pipeline: string, agent: string, storyIndex: number | null, description: string): Delegation => ({
    taskId: task.task_id,
    lane: lane.lane,
    pipeline,
    agent,
    storyIndex,
    resources: resourcesForAgent(agent),
    description,
  });
  if (!laneCanDispatch(lane)) return null;
  if (lane.lane === 'analysis') {
    if (lane.resume_pending && lane.current_agent) {
      const storyIndex = lane.current_story_index || Math.min(task.total_stories, task.analysis_index + 1);
      return line('resume', lane.current_agent, storyIndex, '读取人工输入或恢复信息，并继续交付分析通道');
    }
    if (task.analysis_index >= task.total_stories) return null;
    return line('analysis', 'analyst-agent', task.analysis_index + 1,
      `收敛交付单元 ${task.analysis_index + 1} 的实际影响、关键决策与冻结交付契约`);
  }
  if (lane.resume_pending && lane.current_agent) {
    const storyIndex = lane.current_story_index
      || (lane.current_agent === 'test-agent' ? task.test_index + 1 : task.dev_index + 1);
    if (['dev-agent', 'test-agent'].includes(lane.current_agent) && !codeSlotAvailable) return null;
    return line('resume', lane.current_agent, storyIndex, '读取人工输入，并恢复开发验证通道');
  }
  if (task.test_index < task.dev_index && codeSlotAvailable) {
    return line('test', 'test-agent', task.test_index + 1, `验证交付单元 ${task.test_index + 1}`);
  }
  if (task.dev_index < task.analysis_index && codeSlotAvailable) {
    return line('dev', 'dev-agent', task.dev_index + 1, `实现交付单元 ${task.dev_index + 1}`);
  }
  return null;
}

function controlLine(task: Task, codeSlotAvailable: boolean, lanes: TaskLane[]) {
  const deliveryComplete = task.total_stories > 0
    && task.analysis_index === task.total_stories
    && task.dev_index === task.total_stories
    && task.test_index === task.total_stories;
  const lanesCompleted = lanes.length === 2 && lanes.every((lane) => lane.status === 'completed');
  if (task.agile_status === 'in review' && (!deliveryComplete || !lanesCompleted)) return null;
  if (task.total_stories > 0 && ['ready for dev', 'in dev', 'blocked'].includes(task.agile_status)) {
    if (lanesCompleted && deliveryComplete && task.run_state === 'runnable') {
      return {
        taskId: task.task_id,
        lane: 'control',
        pipeline: 'review',
        agent: 'review-agent',
        storyIndex: null,
        resources: resourcesForAgent('review-agent'),
        description: '全部交付单元已完成，进入整体验收',
      } satisfies Delegation;
    }
    if (!task.resume_pending) return null;
  }
  if (task.resume_pending || task.total_stories === 0
    || ['backlog', 'in repro', 'in plan', 'in review'].includes(task.agile_status)) {
    return nextDelegation(task, codeSlotAvailable);
  }
  return null;
}

function attachBusinessAnalysisRevisionFeedback(db: Db, task: Task, delegation: Delegation) {
  if (task.item_type !== 'business-analysis'
    || !['requirement-spec-agent', 'spec-review-agent'].includes(delegation.agent)) return delegation;
  const comments = db.prepare(`
    SELECT comment_id FROM document_comments
    WHERE task_id = ? AND status = 'open'
      AND feedback_status = 'in_progress'
      AND target_agent = 'requirement-spec-agent'
    ORDER BY created_at, comment_id
  `).all(task.task_id) as { comment_id: string }[];
  if (!comments.length) return delegation;
  const feedbackIds = comments.map((comment) => comment.comment_id);
  return { ...delegation, feedbackId: feedbackIds[0], feedbackIds };
}

function compareAnalysisCandidates(a: { task: Task; lane: TaskLane }, b: { task: Task; lane: TaskLane }) {
  const leftReadyAt = a.lane.ready_at || a.lane.updated_at || a.task.updated_at;
  const rightReadyAt = b.lane.ready_at || b.lane.updated_at || b.task.updated_at;
  return requirementPriorityRank(b.task.priority) - requirementPriorityRank(a.task.priority)
    || leftReadyAt.localeCompare(rightReadyAt)
    || a.task.task_id.localeCompare(b.task.task_id);
}

function schedulingResourceClaims(db: Db) {
  const claims = new Map<ResourceKey, ResourceClaim>();
  for (const resourceKey of Object.keys(RESOURCE_DEFINITIONS) as ResourceKey[]) {
    const claim = activeResourceClaimInDb(db, resourceKey);
    if (claim) claims.set(resourceKey, claim);
  }
  return claims;
}

function resourcesAvailable(
  delegation: Delegation,
  claims: Map<ResourceKey, ResourceClaim>,
  reserved: Set<ResourceKey>,
) {
  return delegation.resources.every((resourceKey) => {
    const claim = claims.get(resourceKey);
    if (claim) {
      return RESOURCE_DEFINITIONS[resourceKey].ownerScope === 'task'
        && claim.owner_task_id === delegation.taskId;
    }
    return !reserved.has(resourceKey);
  });
}

function reserveResources(delegation: Delegation, reserved: Set<ResourceKey>) {
  for (const resourceKey of delegation.resources) reserved.add(resourceKey);
}

export function planDispatchInDb(db: Db): DelegationEnvelope[] {
  const tasks = db.prepare(`${dispatchTaskSelect} WHERE agile_status NOT IN ('done', 'cancelled') AND is_paused = 0`)
    .all() as Task[];
  tasks.sort(compareDispatchTasks);
  const active = activeLaneExecutions(db);
  const activeKeys = new Set(active.map((item) => `${item.task_id}:${item.lane}`));
  let agentSlots = Math.max(0, agentConcurrencyInDb(db) - activeAgentExecutionCount(db));
  const resourceClaims = schedulingResourceClaims(db);
  const codeClaim = resourceClaims.get(CODE_WORKSPACE_RESOURCE);
  const reservedResources = new Set<ResourceKey>();
  const lines: DelegationEnvelope[] = [];
  const analysisCandidates: { task: Task; lane: TaskLane }[] = [];

  for (const task of tasks) {
    if (!requirementDependencyGateOpenInDb(db, task.task_id)) continue;
    refreshTaskLaneStatesInDb(db, task);
    const lanes = taskLanesInDb(db, task);
    const taskCodeAvailable = codeClaim?.owner_task_id === task.task_id
      || (!codeClaim && !reservedResources.has(CODE_WORKSPACE_RESOURCE));
    const feedback = taskContextChatTurnIsRunning(db, task.task_id)
      ? undefined
      : nextFeedbackDispatchInDb(db, task.task_id);
    const taskHasActive = active.some((item) => item.task_id === task.task_id);
    if (feedback && feedbackCanDispatch(task, lanes)) {
      const delegation = feedbackDelegation(task, feedback);
      if (!taskHasActive
        && agentSlots > 0
        && resourcesAvailable(delegation, resourceClaims, reservedResources)) {
        reserveResources(delegation, reservedResources);
        lines.push(delegation);
        agentSlots -= 1;
      }
      continue;
    }
    if (task.agile_status === 'blocked') continue;
    const rawControl = controlLine(task, taskCodeAvailable, lanes);
    const control = rawControl ? attachBusinessAnalysisRevisionFeedback(db, task, rawControl) : null;
    if (control) {
      if (!taskHasActive
        && agentSlots > 0
        && resourcesAvailable(control, resourceClaims, reservedResources)) {
        reserveResources(control, reservedResources);
        lines.push(toEnvelope(task, control));
        agentSlots -= 1;
      }
      continue;
    }
    const analysis = lanes.find((lane) => lane.lane === 'analysis');
    if (analysis && !activeKeys.has(`${task.task_id}:analysis`) && laneLine(task, analysis, taskCodeAvailable)) {
      analysisCandidates.push({ task, lane: analysis });
    }
    const delivery = lanes.find((lane) => lane.lane === 'delivery');
    if (!delivery || activeKeys.has(`${task.task_id}:delivery`)) continue;
    const deliveryWork = laneLine(task, delivery, taskCodeAvailable);
    if (!deliveryWork || !agentSlots || !resourcesAvailable(deliveryWork, resourceClaims, reservedResources)) continue;
    reserveResources(deliveryWork, reservedResources);
    lines.push(toEnvelope(task, deliveryWork, delivery.retry_cycle));
    agentSlots -= 1;
  }

  for (const candidate of analysisCandidates.sort(compareAnalysisCandidates)) {
    if (!agentSlots) break;
    const work = laneLine(candidate.task, candidate.lane, true);
    if (!work || !resourcesAvailable(work, resourceClaims, reservedResources)) continue;
    reserveResources(work, reservedResources);
    lines.push(toEnvelope(candidate.task, work, candidate.lane.retry_cycle));
    agentSlots -= 1;
  }
  return lines;
}

export function projectRequirementWorkInDb(db: Db, taskId: string): Delegation[] {
  const task = db.prepare(`${dispatchTaskSelect} WHERE task_id = ?`).get(taskId) as Task | undefined;
  if (!task) throw new Error('需求不存在');
  if (task.is_paused) return [];
  if (!requirementDependencyGateOpenInDb(db, taskId)) return [];
  refreshTaskLaneStatesInDb(db, task);
  const active = activeLaneExecutions(db).filter((item) => item.task_id === taskId);
  const lanes = taskLanesInDb(db, task);
  const resourceClaims = schedulingResourceClaims(db);
  const feedback = taskContextChatTurnIsRunning(db, taskId) ? undefined : nextFeedbackDispatchInDb(db, taskId);
  if (feedback && feedbackCanDispatch(task, lanes)) {
    const work = feedbackDelegation(task, feedback);
    return active.length || !resourcesAvailable(work, resourceClaims, new Set()) ? [] : [work];
  }
  if (task.agile_status === 'blocked') return [];
  const codeClaim = resourceClaims.get(CODE_WORKSPACE_RESOURCE);
  const codeSlotAvailable = !codeClaim || codeClaim.owner_task_id === taskId;
  const rawControl = controlLine(task, codeSlotAvailable, lanes);
  const control = rawControl ? attachBusinessAnalysisRevisionFeedback(db, task, rawControl) : null;
  if (control) return active.length || !resourcesAvailable(control, resourceClaims, new Set()) ? [] : [control];
  return lanes
    .filter((lane) => !active.some((item) => item.lane === lane.lane))
    .map((lane) => laneLine(task, lane, codeSlotAvailable))
    .filter((work): work is Delegation => Boolean(work))
    .filter((work) => resourcesAvailable(work, resourceClaims, new Set()));
}
