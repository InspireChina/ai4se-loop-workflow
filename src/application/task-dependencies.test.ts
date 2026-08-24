import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import { progressDispatchInspector } from './progress-dispatch';
import {
  configureRequirementDependenciesInDb,
  requirementDependencyGateOpenInDb,
} from './task-dependencies';
import { createTask, getTask } from './tasks';

test('holds a requirement until every prerequisite is done, then permanently opens its first-dispatch gate', async () => {
  const db = await databaseConnection();
  const firstId = await createTask({ title: 'Dependency first' });
  const secondId = await createTask({ title: 'Dependency second' });
  const dependentId = await createTask({
    title: 'Dependent requirement',
    itemType: 'direct',
    dependsOnTaskIds: [firstId, secondId],
  });

  const detail = await getTask(dependentId);
  assert.deepEqual(detail?.dependencies.map((dependency) => dependency.depends_on_task_id), [firstId, secondId]);
  assert.equal(detail?.dependencyGateOpen, false);
  assert.deepEqual(await inspectTaskDispatch(dependentId), []);
  assert.equal((await progressDispatchInspector.inspect({ requirementId: dependentId })).decisions[0]?.reason, 'dependencies-pending');

  db.prepare("UPDATE tasks SET agile_status = 'done', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(firstId);
  assert.equal(requirementDependencyGateOpenInDb(db, dependentId), false);
  db.prepare("UPDATE tasks SET agile_status = 'done', completed_at = CURRENT_TIMESTAMP WHERE task_id = ?").run(secondId);
  assert.equal(requirementDependencyGateOpenInDb(db, dependentId), true);
  assert.equal((await inspectTaskDispatch(dependentId))[0]?.agent, 'direct-agent');

  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('execution-dependency-latch', 'run-dependency-latch', ?, 'direct-agent', 'direct',
             'dependency-latch', 1, 'applied', 'dependency-latch-hash', '{}')
  `).run(dependentId);
  db.prepare("UPDATE tasks SET agile_status = 'backlog', completed_at = NULL WHERE task_id = ?").run(firstId);
  assert.equal(requirementDependencyGateOpenInDb(db, dependentId), true);
});

test('rejects invalid prerequisite configuration atomically and prevents dependency cycles', async () => {
  const db = await databaseConnection();
  await assert.rejects(
    () => createTask({ title: 'Missing prerequisite must roll back', dependsOnTaskIds: ['REQ-missing'] }),
    /前置需求不存在/,
  );
  assert.equal(db.prepare("SELECT 1 FROM tasks WHERE title = 'Missing prerequisite must roll back'").get(), undefined);

  const cancelledId = await createTask({ title: 'Cancelled prerequisite' });
  db.prepare("UPDATE tasks SET agile_status = 'cancelled' WHERE task_id = ?").run(cancelledId);
  await assert.rejects(
    () => createTask({ title: 'Cancelled dependency rejected', dependsOnTaskIds: [cancelledId] }),
    /不能依赖已取消的需求/,
  );

  const firstId = await createTask({ title: 'Cycle first' });
  const secondId = await createTask({ title: 'Cycle second' });
  configureRequirementDependenciesInDb(db, firstId, [secondId]);
  assert.throws(
    () => configureRequirementDependenciesInDb(db, secondId, [firstId]),
    /需求依赖不能形成环/,
  );
});
