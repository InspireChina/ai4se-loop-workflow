import { databaseConnection } from '../infrastructure/database';
import { toEnvelope } from '../application/dispatch-planner';
import { planHistoricalFixturesInDb, projectHistoricalRequirementWorkInDb } from './legacy-dispatch-planner';
import type { Task } from '../application/tasks';

/** Read-only domain projection for tests; it does not reserve or authorize execution. */
export async function inspectTaskDispatch(requirementId: string) {
  return projectHistoricalRequirementWorkInDb(await databaseConnection(), requirementId);
}

/** Full snapshot for tests which execute a delegation, rather than just inspect its scheduling fields. */
export async function inspectTaskDispatchEnvelope(requirementId: string) {
  const db = await databaseConnection();
  const work = projectHistoricalRequirementWorkInDb(db, requirementId);
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(requirementId) as Task;
  return work.map((delegation) => toEnvelope(task, delegation));
}

/** Read-only global selection for tests; runtime callers must use ProgressDispatcher.reserveNext. */
export async function inspectAllDispatch() {
  return planHistoricalFixturesInDb(await databaseConnection());
}
