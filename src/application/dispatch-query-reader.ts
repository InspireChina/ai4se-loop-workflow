import type Database from 'better-sqlite3';
import { agentCommandProfile } from '../domain/agent-command-profile-catalog';
import { createDispatchQuery } from './dispatch-query';
import { activeResourceClaimInDb, resourceIdentityInDb, resourceScopeInDb } from './resource-claims';
import { taskContextChatTurnIsRunning } from './task-context-chat-query';
import { agentConcurrencyInDb } from './agent-concurrency-query';
import { requirementDependencyGateOpenInDb } from './task-dependency-query';
import { readyWorkflowItemsForTaskInDb } from './work-item-query';
import { nativeWorkflowEndedInDb, workflowBlockedInDb } from './work-item-controls';
import { executionProcessBarrierInDb } from './execution-processes';
import { repairResourceClaimInDb } from './repair-resources';

// Same actual queries as ordinary admission, not approximate eligibility.
// Disable every stale-claim cleanup even for the business inspection caller.
const query = createDispatchQuery({
  activeResourceClaimInDb: (db, resource, taskId, options) => {
    if (options?.releaseStale !== false) throw new Error('只读派发适配器不能清理资源 claim');
    return activeResourceClaimInDb(db, resource, taskId, { releaseStale: false });
  }, resourceIdentityInDb, resourceScopeInDb, taskContextChatTurnIsRunning,
  agentConcurrencyInDb, requirementDependencyGateOpenInDb, readyWorkflowItemsForTaskInDb,
  nativeWorkflowEndedInDb, workflowBlockedInDb, executionProcessBarrierInDb, repairResourceClaimInDb,
  supportsResume: agent => Boolean(agentCommandProfile(agent, 'resume')),
});

/** Consistent persisted business inspection; no reconciliation, projections,
 * claim release or secondary DB connection. Can run inside a business txn. */
export function inspectPersistedDispatchInDb(db: Database.Database, assertCurrent: () => void = () => {}) {
  return db.transaction(() => {
    assertCurrent();
    const lines = query.inspectDispatchInDb(db);
    assertCurrent();
    return lines;
  })();
}

/** Root supplies its own existing readonly/fileMustExist connection and
 * authority checks. Schema/read errors never become empty/eligible work. */
export function inspectDispatchReadonlyInDb(db: Database.Database, assertCurrent: () => void = () => {}) {
  if (!db.readonly) throw new Error('独立派发观察必须使用 readonly 连接');
  return inspectPersistedDispatchInDb(db, assertCurrent);
}
