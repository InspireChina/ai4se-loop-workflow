import type Database from 'better-sqlite3';
import { agentCommandProfile } from '../domain/agent-command-profile-catalog';
import { activeResourceClaimInDb, resourceIdentityInDb, resourceScopeInDb } from './resource-claims';
import { taskContextChatTurnIsRunning } from './task-context-chat';
import { ensureFeedbackBatchInDb } from './feedback';
import { adoptFeedbackWorkItemsInDb } from './work-item-feedback';
import type { Task } from './tasks';
import { agentConcurrencyInDb } from './project-settings';
import { requirementDependencyGateOpenInDb } from './task-dependencies';
import { readyWorkflowItemsForTaskInDb } from './work-items';
import { reconcileNativeWorkItemExecutionsInDb } from './work-item-transitions';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';
import { nativeWorkflowEndedInDb, workflowBlockedInDb } from './work-item-controls';
import { executionProcessBarrierInDb } from './execution-processes';
import { repairResourceClaimInDb } from './repair-resources';
import { createDispatchQuery } from './dispatch-query';

export { toEnvelope } from './dispatch-query';
type Db = Database.Database;

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


// Ordinary admission retains reconciliation and stale-claim cleanup.
// Independent management readers must not import this business adapter.
const query = createDispatchQuery({
  activeResourceClaimInDb, resourceIdentityInDb, resourceScopeInDb,
  taskContextChatTurnIsRunning, agentConcurrencyInDb, requirementDependencyGateOpenInDb,
  readyWorkflowItemsForTaskInDb, nativeWorkflowEndedInDb, workflowBlockedInDb,
  executionProcessBarrierInDb, repairResourceClaimInDb,
  supportsResume: agent => Boolean(agentCommandProfile(agent, 'resume')),
  refreshWorkflowForDispatchInDb,
});
export const { planDispatchInDb, inspectDispatchInDb, projectRequirementWorkInDb, dispatchProjectionSupport } = query;
