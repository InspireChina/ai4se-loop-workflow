import type { DelegationEnvelope } from '../application/tasks';
import { databaseConnection } from '../infrastructure/database';
import { acquireResourceClaimsInDb } from '../application/resource-claims';
import { markTaskLaneRunningInDb } from '../application/task-lanes';

export async function markTestDelegationRunning(delegation: DelegationEnvelope, executionId: string) {
  const db = await databaseConnection();
  db.transaction(() => {
    acquireResourceClaimsInDb(db, {
      resourceKeys: delegation.resources,
      taskId: delegation.taskId,
      lane: delegation.lane,
      storyIndex: delegation.storyIndex,
      executionId,
    });
    if (delegation.lane !== 'control') {
      markTaskLaneRunningInDb(db, {
        taskId: delegation.taskId,
        lane: delegation.lane,
        agent: delegation.agent,
        storyIndex: delegation.storyIndex,
      });
    }
  }).immediate();
}
