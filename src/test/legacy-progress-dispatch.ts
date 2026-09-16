/** Historical QA dependency injection, never a runtime engine option. */
import { createProgressDispatcher, createProgressDispatchInspector } from '../application/progress-dispatch';
import { planHistoricalFixturesInDb } from './legacy-dispatch-planner';
export const progressDispatcher = createProgressDispatcher(planHistoricalFixturesInDb, bindHistoricalWork);
export const progressDispatchInspector = createProgressDispatchInspector(planHistoricalFixturesInDb, inspectHistorical);

import { workflowEndedInDb, workflowBlockedInDb } from '../application/work-item-controls';
import { requirementDependencyGateOpenInDb } from '../application/task-dependencies';
import type { databaseConnection } from '../infrastructure/database';
import type { Task } from '../application/tasks';
import type { TaskLaneKind } from '../application/task-lanes';
import type { DispatchDecision, DispatchExplanation } from '../application/progress-dispatch';
import type { DelegationEnvelope } from '../application/tasks';
import { activeWorkflowItemForLegacyExecutionInDb, syncLegacyDeliveryWorkItemsInDb, type WorkflowItemRow } from '../application/work-items';
function bindHistoricalWork(db: Awaited<ReturnType<typeof databaseConnection>>, work: DelegationEnvelope) {
  if (work.workItemId) return db.prepare('SELECT * FROM workflow_items WHERE item_id = ? AND task_id = ?')
    .get(work.workItemId, work.taskId) as WorkflowItemRow | undefined;
  syncLegacyDeliveryWorkItemsInDb(db, work.taskId);
  return activeWorkflowItemForLegacyExecutionInDb(db, { taskId: work.taskId, agent: work.agent,
    pipeline: work.pipeline, storyIndex: work.storyIndex }) || undefined;
}
function inspectHistorical(db: Awaited<ReturnType<typeof databaseConnection>>, requirementId: string, active: DispatchDecision[]): DispatchExplanation {
  const input = {requirementId}; const decisions = [...active];
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(requirementId) as Task;
  if (workflowEndedInDb(db,requirementId)) return {requirementId,decisions:[{lane:'control',state:'completed'}]};
  if(task.is_paused) return {requirementId,decisions:[{lane:'control',state:'waiting',reason:'paused-only'}]};
  if(workflowBlockedInDb(db,requirementId)||task.run_state==='system_blocked') return {requirementId,decisions:[{lane:'control',state:'waiting',reason:'system-blocked'}]};
  if(!requirementDependencyGateOpenInDb(db,requirementId)) return {requirementId,decisions:[{lane:'control',state:'waiting',reason:'dependencies-pending'}]};
  db.exec('SAVEPOINT legacy_inspect');
  try {
    const occupied = new Set(decisions.map(decision=>decision.lane));
    for(const work of planHistoricalFixturesInDb(db).filter(work=>work.taskId===requirementId)) {
      if(!occupied.has(work.lane)) decisions.push({lane:work.lane,state:'selected',work});
    }
  } finally { db.exec('ROLLBACK TO legacy_inspect'); db.exec('RELEASE legacy_inspect'); }
  const selectedLanes = new Set(decisions.map((decision) => decision.lane));
  const pending = db.prepare(`
    SELECT CASE WHEN agent = 'analyst-agent' THEN 'analysis'
                WHEN agent IN ('dev-agent', 'test-agent') THEN 'delivery'
                ELSE 'control' END AS lane
    FROM agent_results WHERE task_id = ? AND application_status = 'pending'
  `).all(input.requirementId) as { lane: TaskLaneKind | 'control' }[];
  for (const row of pending) {
    if (!selectedLanes.has(row.lane)) decisions.push({ lane: row.lane, state: 'waiting', reason: 'pending-result' });
  }
  const controlStage = task.total_stories === 0
    || selectedLanes.has('control')
    || Boolean(task.current_subagent && !['analyst-agent', 'dev-agent', 'test-agent'].includes(task.current_subagent));
  if (controlStage) {
    if (!decisions.some((decision) => decision.lane === 'control')) {
      const foreignClaim = db.prepare('SELECT 1 FROM resource_claims WHERE owner_task_id != ? LIMIT 1').get(input.requirementId);
      decisions.push({
        lane: 'control',
        state: 'waiting',
        reason: ['waiting_for_answers', 'waiting_for_runtime_input'].includes(task.run_state)
          ? 'waiting-for-input'
          : foreignClaim ? 'resources-busy' : 'no-runnable-work',
      });
    }
    return { requirementId: input.requirementId, decisions };
  }
  const lanes = db.prepare('SELECT lane, status FROM task_lanes WHERE task_id = ? ORDER BY lane')
    .all(input.requirementId) as { lane: TaskLaneKind; status: string }[];
  const foreignClaim = db.prepare('SELECT 1 FROM resource_claims WHERE owner_task_id != ? LIMIT 1').get(input.requirementId);
  for (const lane of lanes) {
    if (selectedLanes.has(lane.lane) || decisions.some((decision) => decision.lane === lane.lane)) continue;
    if (lane.status === 'completed') decisions.push({ lane: lane.lane, state: 'completed' });
    else if (['waiting_for_answers', 'waiting_for_runtime_input'].includes(lane.status)) {
      decisions.push({ lane: lane.lane, state: 'waiting', reason: 'waiting-for-input' });
    } else if (lane.status === 'system_blocked') {
      decisions.push({ lane: lane.lane, state: 'waiting', reason: 'system-blocked' });
    } else {
      const hasCandidate = lane.lane === 'analysis'
        ? task.analysis_index < task.total_stories
        : task.test_index < task.dev_index || task.dev_index < task.analysis_index;
      decisions.push({
        lane: lane.lane,
        state: 'waiting',
        reason: hasCandidate ? (foreignClaim && lane.lane === 'delivery' ? 'resources-busy' : 'lower-priority') : 'no-runnable-work',
      });
    }
  }
  if (decisions.length) return { requirementId: input.requirementId, decisions };
  return {
    requirementId: input.requirementId,
    decisions: [{
      lane: 'control',
      state: 'waiting',
      reason: foreignClaim ? 'resources-busy' : ['waiting_for_answers', 'waiting_for_runtime_input'].includes(task.run_state)
        ? 'waiting-for-input'
        : 'no-runnable-work',
    }],
  };
}
