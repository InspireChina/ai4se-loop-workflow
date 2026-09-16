import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { createProject } from './projects';
import { createTaskInDb, createTaskSchema } from './tasks';
import { inspectDispatchInDb } from './dispatch-planner';
import { inspectDispatchReadonlyInDb, inspectPersistedDispatchInDb } from './dispatch-query-reader';
import { acquireResourceClaimInDb } from './resource-claims';
import { prepareExecutionProcessInDb, finishExecutionProcessInDb } from './execution-processes';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { transitionWorkItemInDb } from './work-item-transitions';
import type { WorkflowItemRow } from './work-items';
import { agentResultSchema } from '../domain/agent-result';
import { markExecutionOutput, completeExecution } from './executions';
import { applyAgentResult } from './agent-results';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused=1').run();
  const workspace = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
  mkdirSync(workspace, { recursive: true });
  const projectId = await createProject({ name: 'Actual readonly eligibility', workspaceRoot: workspace });
  const taskIds = [0, 1, 2].map(() => `REQ-${randomUUID()}`);
  for (const [index, taskId] of taskIds.entries()) createTaskInDb(db, createTaskSchema.parse({
    title: `Actual query ${index}`, description: 'Readonly scheduling evidence', projectId,
    itemType: index === 2 ? 'business-analysis' : 'direct',
  }), taskId);
  db.prepare("UPDATE tasks SET priority='9' WHERE task_id=?").run(taskIds[0]);
  db.prepare("INSERT INTO project_settings(setting_key,setting_value) VALUES('agent_concurrency','2') ON CONFLICT(setting_key) DO UPDATE SET setting_value='2'").run();
  const reader = new Database(db.name, { readonly: true, fileMustExist: true });
  const read = () => {
    const lines = inspectDispatchReadonlyInDb(reader);
    assert.deepEqual(lines, inspectDispatchInDb(db));
    return lines;
  };
  return { db, reader, read, taskIds };
}

test('actual readonly adapter honors stale claims, capacity and unexited process barriers without cleaning business rows', async () => {
  const h = await fixture();
  let allocationId: string | undefined;
  try {
    assert.throws(() => inspectDispatchReadonlyInDb(h.db), /readonly/);
    assert.equal(h.read().length, 2);
    acquireResourceClaimInDb(h.db, { resourceKey: 'code:workspace', taskId: h.taskIds[1], lane: 'control' });
    assert.ok(!h.read().some(line => line.taskId === h.taskIds[0]));
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(h.taskIds[1]);
    assert.ok(h.read().some(line => line.taskId === h.taskIds[0]));
    assert.equal((h.db.prepare('SELECT count(*) AS n FROM resource_claims WHERE owner_task_id=?').get(h.taskIds[1]) as { n: number }).n, 1,
      'readers ignore stale claims without deleting them');
    h.db.prepare('UPDATE tasks SET is_paused=0 WHERE task_id=?').run(h.taskIds[1]);
    const delegation = h.read().find(line => line.taskId === h.taskIds[1])!;
    const execution = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation, prompt: 'Controlled process barrier fixture' });
    allocationId = prepareExecutionProcessInDb(h.db, execution.attempt.execution_id, process.pid, 7);
    h.db.prepare("UPDATE execution_attempts SET status='cancelled' WHERE execution_id=?").run(execution.attempt.execution_id);
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(h.taskIds[1]);
    assert.deepEqual(h.read().map(line => line.taskId), [h.taskIds[2]], 'cancelled/paused is not process exit evidence');
    finishExecutionProcessInDb(h.db, allocationId, true);
    assert.ok(h.read().some(line => line.taskId === h.taskIds[0]));
    h.db.prepare("UPDATE project_settings SET setting_value='1' WHERE setting_key='agent_concurrency'").run();
    assert.deepEqual(h.read().map(line => line.taskId), [h.taskIds[0]]);
    let checks = 0;
    assert.throws(() => inspectDispatchReadonlyInDb(h.reader, () => {
      if (++checks === 2) throw new Error('STOP during readonly observation');
    }), /STOP/);
    assert.equal(checks, 2);
  } finally {
    if (allocationId) finishExecutionProcessInDb(h.db, allocationId, true);
    h.reader.close();
  }
});

test('actual readonly first-dispatch dependency gate rejects terminal display labels without native delivery facts', async () => {
  const h = await fixture();
  try {
    h.db.prepare('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)').run(h.taskIds[0], h.taskIds[2]);
    h.db.prepare("UPDATE tasks SET agile_status='ready_to_close',closure_status='awaiting_read' WHERE task_id=?").run(h.taskIds[2]);
    assert.ok(!h.read().some(line => line.taskId === h.taskIds[0]));
    h.db.prepare("UPDATE tasks SET agile_status='done' WHERE task_id=?").run(h.taskIds[2]);
    assert.ok(!h.read().some(line => line.taskId === h.taskIds[0]));
    h.db.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(h.taskIds[0]);
    assert.ok(h.read().some(line => line.taskId === h.taskIds[0]));
  } finally { h.reader.close(); }
});

test('compiled production readonly adapter uses actual graph, dependency, capacity and resource queries without loading corrupt bootstrap stores', async () => {
  const h = await fixture();
  try {
    acquireResourceClaimInDb(h.db, { resourceKey: 'code:workspace', taskId: h.taskIds[1], lane: 'control' });
    h.db.prepare('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)').run(h.taskIds[2], h.taskIds[0]);
    const expected = inspectPersistedDispatchInDb(h.db);
    assert.deepEqual(expected.map(line => line.taskId), [h.taskIds[1]]);
    const bundle = await build({ entryPoints: [resolve('src/application/dispatch-query-reader.ts')], bundle: true,
      platform: 'node', format: 'esm', write: false, metafile: true });
    const dependencies = Object.keys(bundle.metafile!.inputs);
    assert.ok(dependencies.includes('src/application/work-item-artifacts.ts'));
    assert.ok(dependencies.includes('src/application/execution-delegation.ts'));
    assert.ok(!dependencies.some(path => /(?:infrastructure\/database\.ts|agent-configuration-store|command-chain-definition|native-workflow-projection|page-invalidation)/.test(path)),
      `reader imported bootstrap/configuration/mutation adapters: ${dependencies.join(',')}`);
    const guardRoot = join(process.env.LOOP_DATA_ROOT!, randomUUID());
    mkdirSync(guardRoot, { recursive: true });
    const businessGuard = join(guardRoot, 'loop-ui.db'), configGuard = join(guardRoot, 'loopwork.db');
    writeFileSync(businessGuard, 'corrupt production business bootstrap guard');
    writeFileSync(configGuard, 'corrupt production config bootstrap guard');
    const before = [readFileSync(businessGuard), readFileSync(configGuard), readFileSync(h.db.name), readFileSync(`${h.db.name}-wal`)];
    const entry = join(guardRoot, 'actual-readonly-query.mjs');
    writeFileSync(entry, `import Database from ${JSON.stringify(resolve('node_modules/better-sqlite3/lib/database.js'))};
${bundle.outputFiles![0].text}
const db = new Database(${JSON.stringify(h.db.name)}, {readonly:true,fileMustExist:true});
console.log(JSON.stringify(inspectDispatchReadonlyInDb(db)));
db.close();`);
    const child = spawnSync(process.execPath, [entry], { cwd: process.cwd(), timeout: 15000, encoding: 'utf8',
      env: { ...process.env, LOOP_DATA_ROOT: guardRoot, LOOP_GLOBAL_DB_PATH: businessGuard,
        LOOP_LEGACY_DB_PATH: businessGuard, LOOP_APP_ROOT: guardRoot, NODE_TEST_CONTEXT: 'actual-reader-guard' } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), expected);
    assert.deepEqual([readFileSync(businessGuard), readFileSync(configGuard), readFileSync(h.db.name), readFileSync(`${h.db.name}-wal`)], before);
    // Actual shared query functions, not injected simplified port values.
    // Task/claim/graph inputs are controlled fixtures; no model recovery or
    // physical CLI termination is claimed by this standalone reader test.
  } finally { h.reader.close(); }
});

test('actual readonly dependency dispatch validates published artifact, frozen publisher source and applied result instead of a mutable document head', async () => {
  const h = await fixture();
  try {
    h.db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id IN (?,?)').run(h.taskIds[0], h.taskIds[1]);
    const projectId = (h.db.prepare('SELECT project_id FROM tasks WHERE task_id=?').get(h.taskIds[2]) as { project_id: string }).project_id;
    const dependentId = `REQ-${randomUUID()}`;
    createTaskInDb(h.db, createTaskSchema.parse({ title: 'Await actually published specification', description: 'Do not trust a poisoned head',
      itemType: 'direct', projectId, dependsOnTaskIds: [h.taskIds[2]] }), dependentId);
    assert.ok(!h.read().some(line => line.taskId === dependentId));
    // Complete fixture predecessors through their real transition API, then
    // publish the result through the normal frozen execution/result APIs.
    // These controlled submissions are not a real model acceptance trial.
    for (;;) {
      const item = h.db.prepare("SELECT * FROM workflow_items WHERE task_id=? AND status='ready' AND agent IS NOT NULL AND agent!='spec-review-agent' LIMIT 1")
        .get(h.taskIds[2]) as WorkflowItemRow | undefined;
      if (!item) break;
      transitionWorkItemInDb(h.db, { itemId: item.item_id, action: 'complete', eventKey: `fixture:${item.item_id}`,
        actor: 'human', authority: 'human', reason: 'Controlled specification publication prerequisite' });
    }
    const publisher = h.read().find(line => line.taskId === h.taskIds[2])!;
    assert.equal(publisher.agent, 'spec-review-agent');
    const runId = `RUN-${randomUUID()}`;
    const execution = await beginTestExecutionAttempt({ runId, delegation: publisher, prompt: 'Controlled actual artifact publication' });
    const result = agentResultSchema.parse({ outcome: 'completed', summary: 'Specification approved in fixture',
      businessAnalysis: { stage: 'review', disposition: 'approved' },
      artifact: { title: 'Actual published fixture specification', content: 'Original acceptance requirements' } });
    await markExecutionOutput(execution.attempt.execution_id, result);
    assert.equal(await applyAgentResult(runId, publisher, result, { executionId: execution.attempt.execution_id }), 'advanced');
    await completeExecution(execution.attempt.execution_id);
    assert.ok(h.read().some(line => line.taskId === dependentId));
    const head = h.db.prepare('SELECT review_document_id FROM tasks WHERE task_id=?').get(h.taskIds[2]) as { review_document_id: string };
    const content = (h.db.prepare('SELECT content FROM documents WHERE document_id=?').get(head.review_document_id) as { content: string }).content;
    h.db.prepare("UPDATE documents SET content='poisoned after publication' WHERE document_id=?").run(head.review_document_id);
    assert.ok(!h.read().some(line => line.taskId === dependentId));
    h.db.prepare('UPDATE documents SET content=? WHERE document_id=?').run(content, head.review_document_id);
    const frozen = (h.db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id=?').get(execution.attempt.execution_id) as { input_json: string }).input_json;
    h.db.prepare("UPDATE execution_attempts SET input_json='{broken' WHERE execution_id=?").run(execution.attempt.execution_id);
    assert.ok(!h.read().some(line => line.taskId === dependentId));
    h.db.prepare('UPDATE execution_attempts SET input_json=? WHERE execution_id=?').run(frozen, execution.attempt.execution_id);
    h.db.prepare("UPDATE agent_results SET application_status='failed' WHERE execution_id=?").run(execution.attempt.execution_id);
    assert.ok(!h.read().some(line => line.taskId === dependentId));
    h.db.prepare("UPDATE agent_results SET application_status='applied' WHERE execution_id=?").run(execution.attempt.execution_id);
    assert.ok(h.read().some(line => line.taskId === dependentId));
    assert.equal((h.db.prepare("SELECT status FROM workflow_items WHERE task_id=? AND kind='closure'").get(h.taskIds[2]) as { status: string }).status, 'waiting',
      'reading acknowledgement remains human-controlled; actual delivery readiness can unblock dependents');
  } finally { h.reader.close(); }
});
