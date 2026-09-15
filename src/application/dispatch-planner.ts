import type Database from 'better-sqlite3';
import {
  RESOURCE_DEFINITIONS,
  resourcesForAgent,
  resourcesRequiringClaims,
  type ResourceKey,
} from '../domain/resource';
import { requirementPriorityRank } from '../domain/requirement-priority';
import { agentCommandProfile } from '../domain/agent-command-profile';
import type { Delegation } from '../domain/task';
import {
  activeResourceClaimInDb,
  resourceIdentityInDb,
  type ResourceClaim,
} from './resource-claims';
import { taskContextChatTurnIsRunning } from './task-context-chat';
import { ensureFeedbackBatchInDb } from './feedback';
import { adoptFeedbackWorkItemsInDb, type FeedbackItemContext } from './work-item-feedback';
import type { DelegationEnvelope, Task } from './tasks';
import { agentConcurrencyInDb } from './project-settings';
import { requirementDependencyGateOpenInDb } from './task-dependencies';
import {
  readyWorkflowItemsForTaskInDb,
  type WorkflowItemRow,
} from './work-items';
import { reconcileNativeWorkItemExecutionsInDb } from './work-item-transitions';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import { nativeWorkflowEndedInDb, workflowBlockedInDb } from './work-item-controls';

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


export function toEnvelope(task: Task, delegation: Delegation, retryCycle = task.retry_cycle): DelegationEnvelope {
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



function activeAgentExecutionCount(db: Db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM execution_attempts
    WHERE status IN ('planned', 'running')
  `).get() as { count: number };
  return row.count;
}

function workItemLine(task: Task, item: WorkflowItemRow): Delegation | null {
  if (item.origin !== 'native' || !item.agent || !item.pipeline || !['control', 'analysis', 'delivery'].includes(item.lane || '')) return null;
  const lane = item.lane as Delegation['lane'];
  const pipeline = item.resume_pending && !item.pipeline.startsWith('feedback-') && agentCommandProfile(item.agent, 'resume')
    ? 'resume' : item.pipeline;
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
    workItemId: item.item_id, workItemRevision: item.revision, workItemEpoch: item.dispatch_epoch,
  };
}

function refreshWorkflowForDispatchInDb(db: Db, task: Task) {
  const native = (db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(task.task_id) as { workflow_engine: string })
    .workflow_engine === 'native';
  if (native) {
    ensureFeedbackBatchInDb(db, task.task_id);
    adoptFeedbackWorkItemsInDb(db, task.task_id);
    reconcileNativeWorkItemExecutionsInDb(db, task.task_id);
    projectNativeWorkflowDisplayInDb(db, task.task_id);
    Object.assign(task, db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(task.task_id));
  }
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

function schedulingResourceClaims(db: Db, releaseStale = true) {
  const claims = new Map<string, ResourceClaim>();
  const rows = db.prepare('SELECT resource_key, owner_task_id FROM resource_claims')
    .all() as { resource_key: ResourceKey; owner_task_id: string }[];
  for (const row of rows) {
    const claim = activeResourceClaimInDb(db, row.resource_key, row.owner_task_id, { releaseStale });
    if (claim) claims.set(resourceIdentityInDb(db, row.resource_key, row.owner_task_id), claim);
  }
  return claims;
}

function resourcesAvailable(
  db: Db,
  delegation: Delegation,
  claims: Map<string, ResourceClaim>,
  reserved: Set<string>,
) {
  return resourcesRequiringClaims(delegation.resources).every((resourceKey) => {
    const identity = resourceIdentityInDb(db, resourceKey, delegation.taskId);
    if (reserved.has(identity)) return false;
    const claim = claims.get(identity);
    if (claim) {
      if (claim.owner_execution_id && db.prepare(`SELECT 1 FROM execution_attempts WHERE execution_id = ?
        AND status IN ('planned', 'running', 'output_received', 'verifying', 'applying')`).get(claim.owner_execution_id)) return false;
      return RESOURCE_DEFINITIONS[resourceKey].ownerScope === 'task'
        && claim.owner_task_id === delegation.taskId;
    }
    return !reserved.has(identity);
  });
}

function reserveResources(db: Db, delegation: Delegation, reserved: Set<string>) {
  for (const resourceKey of resourcesRequiringClaims(delegation.resources)) {
    reserved.add(resourceIdentityInDb(db, resourceKey, delegation.taskId));
  }
}

function nativeItemSourceBusyInDb(db: Db, itemId: string) {
  return Boolean(db.prepare(`SELECT 1 FROM execution_attempts execution WHERE execution.work_item_id = ?
    AND execution.pipeline != 'intervention'
    AND (execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
      OR (execution.status != 'cancelled' AND EXISTS (SELECT 1 FROM agent_results result
        WHERE result.execution_id = execution.execution_id AND result.application_status = 'pending'))) LIMIT 1`)
    .get(itemId));
}

/** Native scheduling has one queue of exact Work Items. Lane labels never
 * determine occupancy or exclusivity; the graph, source bindings and actual
 * resource ownership do. Historical cursor selection is confined to test fixtures. */
export function planDispatchInDb(db: Db, options: { refresh?: boolean } = {}): DelegationEnvelope[] {
  const tasks = db.prepare(`${dispatchTaskSelect} WHERE workflow_engine = 'native' AND is_paused = 0
    AND EXISTS (SELECT 1 FROM projects project WHERE project.project_id = tasks.project_id AND project.deleted_at IS NULL)`)
    .all() as Task[];
  const candidates: { task: Task; item: WorkflowItemRow; work: DelegationEnvelope }[] = [];
  for (const task of tasks) {
    if (!requirementDependencyGateOpenInDb(db, task.task_id)) continue;
    if (options.refresh !== false) refreshWorkflowForDispatchInDb(db, task);
    if (nativeWorkflowEndedInDb(db, task.task_id) || workflowBlockedInDb(db, task.task_id)) continue;
    for (const item of readyWorkflowItemsForTaskInDb(db, task.task_id)) {
      if (item.kind === 'feedback' && taskContextChatTurnIsRunning(db, task.task_id)) continue;
      if (nativeItemSourceBusyInDb(db, item.item_id)) continue;
      const line = workItemLine(task, item);
      if (!line) continue;
      const work = toEnvelope(task, attachBusinessAnalysisRevisionFeedback(db, task, line));
      candidates.push({ task, item, work });
    }
  }
  const queue = candidates.map(({ task, item, work }, index) => ({ work, index,
    priority: requirementPriorityRank(task.priority), readyAt: item.ready_at || item.created_at }));
  queue.sort((a, b) => b.priority - a.priority || a.readyAt.localeCompare(b.readyAt)
    || a.work.taskId.localeCompare(b.work.taskId)
    || (a.work.workItemId && b.work.workItemId
      ? a.work.workItemId.localeCompare(b.work.workItemId) : a.index - b.index));
  const claims = schedulingResourceClaims(db, options.refresh !== false);
  const reserved = new Set<string>();
  let slots = Math.max(0, agentConcurrencyInDb(db) - activeAgentExecutionCount(db));
  const lines: DelegationEnvelope[] = [];
  for (const candidate of queue) {
    if (!slots) break;
    if (!resourcesAvailable(db, candidate.work, claims, reserved)) continue;
    reserveResources(db, candidate.work, reserved);
    lines.push(candidate.work);
    slots -= 1;
  }
  return lines;
}

/** Read the persisted queue without reconciling or writing display projections. */
export function inspectDispatchInDb(db: Db): DelegationEnvelope[] {
  return planDispatchInDb(db, { refresh: false });
}

export function projectRequirementWorkInDb(db: Db, taskId: string): Delegation[] {
  const task = db.prepare(`${dispatchTaskSelect}
    WHERE task_id = ? AND EXISTS (
      SELECT 1 FROM projects project
      WHERE project.project_id = tasks.project_id AND project.deleted_at IS NULL
    )`).get(taskId) as Task | undefined;
  if (!task) {
    const exists = db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(taskId);
    if (exists) return [];
    throw new Error('需求不存在');
  }
  if (!db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId)) return [];
  if (task.is_paused) return [];
  if (!requirementDependencyGateOpenInDb(db, taskId)) return [];
  refreshWorkflowForDispatchInDb(db, task);
  if (nativeWorkflowEndedInDb(db, taskId) || workflowBlockedInDb(db, taskId)) return [];
  if (db.prepare("SELECT 1 FROM tasks WHERE task_id = ? AND workflow_engine = 'native'").get(taskId)) {
    // This projection is used for diagnostics, not global capacity selection.
    // Do not reconstruct native candidates through the legacy Lane adapter.
    const claims = schedulingResourceClaims(db);
    return readyWorkflowItemsForTaskInDb(db, taskId)
      .filter(item => !(item.kind === 'feedback' && taskContextChatTurnIsRunning(db, taskId)))
      .filter(item => !nativeItemSourceBusyInDb(db, item.item_id))
      .map(item => workItemLine(task, item))
      .filter((work): work is Delegation => Boolean(work))
      .filter(work => resourcesAvailable(db, work, claims, new Set()));
  }
  return [];
}

/** Shared historical display-projection primitives. The runtime has no legacy
 * scheduler; historical QA assembles its own selector outside application code. */
export const dispatchProjectionSupport = { dispatchTaskSelect,
  activeAgentExecutionCount, schedulingResourceClaims, resourcesAvailable, reserveResources,
  refreshWorkflowForDispatchInDb,
  attachBusinessAnalysisRevisionFeedback };
