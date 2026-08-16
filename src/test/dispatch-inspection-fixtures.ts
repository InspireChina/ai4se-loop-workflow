import { databaseConnection } from '../infrastructure/database';
import { planDispatchInDb, projectRequirementWorkInDb } from '../application/dispatch-planner';

/** Read-only domain projection for tests; it does not reserve or authorize execution. */
export async function inspectTaskDispatch(requirementId: string) {
  return projectRequirementWorkInDb(await databaseConnection(), requirementId);
}

/** Read-only global selection for tests; runtime callers must use ProgressDispatcher.reserveNext. */
export async function inspectAllDispatch() {
  return planDispatchInDb(await databaseConnection());
}
