import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AdminManagementStore } from './admin-management-store';
import { databaseConnection } from './database';
import { createManagedLoopRunLifecycle } from './runtime-supervision';
import type { LoopRunLifecycleOptions } from '../application/loop-run-lifecycle';
import type { RunStatus } from '../application/loop-runs';
import { createTaskInDb, createTaskSchema } from '../application/tasks';
import { claimNextIntervention, openInterventionInDb } from '../application/interventions';
import type { AdminRuntimeConfiguration } from '../domain/admin-runtime-configuration';
import type { AgentExecutor } from './agent-executor';

const runtime: AdminRuntimeConfiguration = { configurationId: 'configured-system', sourceVersion: 'fixture-version', executorId: 'claude', executionOptions: { model: 'configured-model' } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(desired: 'running' | 'stopped' = 'stopped') {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused=1').run();
  db.prepare('DELETE FROM loop_supervisor_lease').run();
  db.prepare(`UPDATE loop_lifecycle_state SET desired_intent=?,mode='normal',actual_phase='stopped',active_run_id=NULL,retry_at=NULL WHERE singleton=1`).run(desired);
  const ownerId = `fixture-${randomUUID()}`;
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'management.db'));
  const starts: string[] = [];
  let run: RunStatus = null;
  const dependencies: LoopRunLifecycleOptions['dependencies'] = {
    database: async () => db,
    createEventHub: (_owner, token) => ({ token, start: async () => undefined, close: async () => undefined }),
    appendLog: async () => undefined,
    runs: {
      begin: async () => {
        const runId = randomUUID();
        db.prepare("INSERT INTO loop_runs(run_id,owner,status) VALUES(?,?,'starting')").run(runId, ownerId);
        return runId;
      },
      start: async (runId, token) => {
        starts.push(runId);
        db.prepare("UPDATE loop_runs SET supervision_token=?,status='running' WHERE run_id=?").run(token, runId);
        run = { runId, owner: ownerId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
          processKind: 'agent-runner', status: 'running', pid: null, active: true,
          health: { starting: false, pidAlive: true, heartbeatFresh: true, heartbeatAgeMs: 0, generationActive: true } };
      },
      status: async () => run,
      end: async runId => { db.prepare("UPDATE loop_runs SET status='stopped' WHERE run_id=?").run(runId); run = null; },
    },
  };
  return { db, store, starts, ownerId, dependencies };
}
const source = { adapter: 'cli' as const, actor: 'human' as const, instanceId: 'fixture' };
const idleManagement = async () => ({ completion: Promise.resolve({ outcome: 'failed' as const, exitConfirmed: true, reason: 'diagnostic fixture' }), stop: async () => true });
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Expected management state did not converge');
    await delay(10);
  }
}

test('production restart and manual update resume cannot bypass a pending external candidate guard', async () => {
  const h = await fixture('running');
  h.store.setIntent('running','original-start');
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const request={ updateId:randomUUID(),caseId:'original-runtime-case',
    before:{root:join(root,'known-good'),sourceId:'a'.repeat(64),artifactId:'b'.repeat(64),version:'0.1.20'},
    candidate:{root:join(root,'candidate'),sourceId:'c'.repeat(64),artifactId:'d'.repeat(64),version:'0.1.21'} };
  h.store.beginRuntimeUpdate(request);
  h.db.prepare("UPDATE loop_lifecycle_state SET mode='update-silence',update_target_version='0.1.21' WHERE singleton=1").run();
  let managementCalls=0;
  const host=createManagedLoopRunLifecycle({ownerId:h.ownerId,adapter:'cli',installedVersion:'0.1.21',dependencies:h.dependencies,
    management:{store:h.store,refreshRuntime:async()=>runtime,launch:async()=>{managementCalls++;return idleManagement();},confirmStopped:async()=>true}});
  try {
    await host.start();
    assert.equal(h.store.control().management_mode,'update-silence');
    assert.equal((await host.status()).mode.kind,'update-silence');
    assert.equal(h.starts.length,0);assert.equal(managementCalls,0);
    const resumed=await host.command({requestId:'ordinary-resume',source,action:{kind:'resume-after-update'}});
    assert.equal(resumed.outcome,'update-in-progress');
    assert.equal((await host.status()).mode.kind,'update-silence');
    const started=await host.command({requestId:'ordinary-start',source,action:{kind:'start'}});
    assert.equal(started.outcome,'update-in-progress');assert.equal(h.starts.length,0);
    assert.equal(h.store.runtimeUpdate(request.updateId)!.phase,'stopping');
  }finally{await host.shutdown();h.store.close();}
});

test('only the current external activating lease clears business update state; dispatch stays held until external health completion', async () => {
  const h=await fixture('running');h.store.setIntent('running','original-start');
  const request={updateId:randomUUID(),caseId:'original-case',
    before:{root:join(process.env.LOOP_DATA_ROOT!,randomUUID()),sourceId:'a'.repeat(64),artifactId:'b'.repeat(64),version:'before'},
    candidate:{root:process.cwd(),sourceId:'c'.repeat(64),artifactId:'d'.repeat(64),version:'0.1.20'}};
  h.store.beginRuntimeUpdate(request);
  h.db.prepare("UPDATE loop_lifecycle_state SET mode='update-silence',update_target_version='0.1.20' WHERE singleton=1").run();
  const host=createManagedLoopRunLifecycle({ownerId:h.ownerId,adapter:'cli',installedVersion:'0.1.20',dependencies:h.dependencies,
    management:{store:h.store,refreshRuntime:async()=>runtime,launch:idleManagement,confirmStopped:async()=>true}});
  try {
    await host.start();const authority=h.store.acquireRuntimeUpdate(request.updateId,'actual-external-controller')!;
    await assert.rejects(host.activateExternalRuntimeUpdate(authority),/其他阶段/);
    h.store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
    h.store.advanceRuntimeUpdate(authority,'candidate-starting','candidate-activating');
    await assert.rejects(host.activateExternalRuntimeUpdate({...authority,token:authority.token+1}),/所有权/);
    await host.activateExternalRuntimeUpdate(authority);
    assert.equal((await host.status()).mode.kind,'normal');assert.equal(h.store.control().management_mode,'update-silence');assert.equal(h.starts.length,0);
    h.store.advanceRuntimeUpdate(authority,'candidate-activating','candidate-observing',{selected:request.candidate});
    h.store.advanceRuntimeUpdate(authority,'candidate-observing','succeeded');
    await host.reconcile({source:{adapter:'cli',instanceId:h.ownerId},trigger:'manual-reconcile'});
    assert.equal(h.starts.length,1);assert.equal(h.store.control().desired_intent,'running');
    assert.equal(h.store.runtimeUpdate(request.updateId)!.request.caseId,'original-case');
  }finally{await host.shutdown();h.store.close();}
});

test('production composition migrates existing running intent once, shares actual business supervision and preserves newer stop on restart', async () => {
  const h = await fixture('running');
  const host = createManagedLoopRunLifecycle({ ownerId: h.ownerId, adapter: 'cli', dependencies: h.dependencies,
    management: { store: h.store, refreshRuntime: async () => runtime, launch: idleManagement, confirmStopped: async () => true } });
  try {
    await host.start();
    assert.equal(h.store.control().desired_intent, 'running');
    assert.equal(h.starts.length, 1, 'saved receipts and initialization must not duplicate Runner invocation');
    assert.deepEqual(h.store.runtimeConfiguration()?.configuration, runtime);
    const stopped = await host.command({ requestId: 'stop', source, action: { kind: 'stop', reason: 'user-stop' } });
    assert.equal(stopped.outcome, 'stopped');
    assert.equal(h.store.control().desired_intent, 'stopped');
    await host.shutdown();
    // A stale business mirror must not overwrite the independently saved stop.
    h.db.prepare("UPDATE loop_lifecycle_state SET desired_intent='running' WHERE singleton=1").run();
    const restarted = createManagedLoopRunLifecycle({ ownerId: `${h.ownerId}-restart`, adapter: 'cli', dependencies: h.dependencies,
      management: { store: h.store, refreshRuntime: async () => runtime, launch: idleManagement, confirmStopped: async () => true } });
    try {
      await restarted.start();
      assert.equal(h.store.control().desired_intent, 'stopped');
      assert.equal((await restarted.status()).intent.desired, 'stopped');
      assert.equal(h.starts.length, 1);
    } finally { await restarted.shutdown(); }
  } finally { await host.shutdown(); h.store.close(); }
});

test('production stop is durable before a blocked business DB read returns; bootstrap cannot restore its stale running intent', async () => {
  const h = await fixture('running');
  const entered = deferred(); const release = deferred();
  const host = createManagedLoopRunLifecycle({ ownerId: h.ownerId, adapter: 'cli', dependencies: {
    ...h.dependencies, database: async () => { entered.resolve(); await release.promise; return h.db; },
  }, management: { store: h.store, refreshRuntime: async () => runtime, launch: idleManagement, confirmStopped: async () => true } });
  try {
    const starting = host.start();
    await entered.promise;
    const stopping = host.command({ requestId: 'stop', source, action: { kind: 'stop', reason: 'user-stop' } });
    assert.equal(h.store.control().desired_intent, 'stopped');
    release.resolve();
    await Promise.all([starting, stopping]);
    assert.equal(h.starts.length, 0);
    assert.equal((await host.status()).intent.desired, 'stopped');
  } finally { release.resolve(); await host.shutdown(); h.store.close(); }
});

test('production discovery bridges original agent faults to the independent invocation, never ordinary arbitration or human inputs', async () => {
  const h = await fixture('running');
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(h.db, createTaskSchema.parse({ title: 'Production discovery fixture', itemType: 'direct' }), taskId);
  const item = h.db.prepare('SELECT item_id FROM workflow_items WHERE task_id=?').get(taskId) as { item_id: string };
  const fault = openInterventionInDb(h.db, { taskId, itemId: item.item_id, requestedBy: 'dev-agent', authority: 'arbitration',
    dedupeKey: 'original-fault', summary: 'Original behavior missing', context: { acceptance: 'original target' } });
  const human = openInterventionInDb(h.db, { taskId, requestedBy: 'human', resolverStrategy: 'human_only',
    dedupeKey: 'real-human', summary: 'Real human decision' });
  const executor: AgentExecutor = { id: 'claude', label: 'Actual independent CLI fixture', command: process.execPath, promptMode: 'argument',
    buildArgs: (_prompt, _workspace, options) => {
      assert.equal(options?.model, 'configured-model');
      return ['-e', 'console.log("independent diagnostic started");setTimeout(()=>process.exit(1),400)'];
    }, formatCommand: () => 'node diagnostic', parseStdout: line => line, parseStderr: line => line };
  const host = createManagedLoopRunLifecycle({ ownerId: h.ownerId, adapter: 'cli', dependencies: h.dependencies,
    management: { store: h.store, refreshRuntime: async () => runtime, resolveExecutor: () => executor } });
  try {
    await host.start();
    const linked = h.db.prepare('SELECT repair_case_id FROM interventions WHERE intervention_id=?').get(fault.intervention_id) as { repair_case_id: string };
    assert.ok(linked.repair_case_id);
    await eventually(() => h.store.attempts(linked.repair_case_id).some(attempt => attempt.status === 'failed'));
    const attempt = h.store.attempts(linked.repair_case_id)[0]!;
    assert.ok(attempt.pid);
    assert.throws(() => process.kill(attempt.pid!, 0));
    assert.equal(h.store.getCase(linked.repair_case_id)?.status, 'queued');
    const evidence = h.store.observations(linked.repair_case_id)[0] as { evidence_json: string };
    assert.equal(JSON.parse(evidence.evidence_json).context.acceptance, 'original target');
    assert.equal(await claimNextIntervention({ runId: 'ordinary', executorId: 'claude', executionOptions: {} }), null);
    const remainingHuman = h.db.prepare('SELECT repair_case_id,status FROM interventions WHERE intervention_id=?').get(human.intervention_id);
    assert.deepEqual(remainingHuman, { repair_case_id: null, status: 'awaiting_human' });
  } finally { await host.command({ requestId: 'stop', source, action: { kind: 'stop', reason: 'user-stop' } }); await host.shutdown(); h.store.close(); }
});

test('production update gates independent management exit, preserves running intent and invalidates old credentials until resume', async () => {
  const h = await fixture('running');
  h.store.setIntent('running', 'start');
  h.store.observe({ observationId: 'fault', scope: 'runtime', scopeKey: 'runtime', fingerprint: 'fault', sourceVersion: 'v1', origin: 'runtime', summary: 'Fault', evidence: {} });
  let confirmed = false;
  let blockers = 0;
  const host = createManagedLoopRunLifecycle({ ownerId: h.ownerId, adapter: 'cli', dependencies: h.dependencies,
    inhibitIdleSleep: async () => { blockers++; return { isActive: () => true, release: async () => { blockers--; } }; },
    management: { store: h.store, refreshRuntime: async () => runtime, confirmStopped: async () => confirmed,
      launch: async (_claim, bind) => { bind(888888, 'fixture-root'); return { completion: new Promise(() => undefined), stop: async () => confirmed }; } } });
  try {
    await host.start();
    assert.equal(blockers, 1);
    const claim = h.store.attempts()[0]!;
    const authority = { ownerId: h.ownerId, token: h.store.control().fencing_token };
    const credential = h.store.issueCommandCredential({ authority, attempt: claim, repairCase: h.store.getCase(claim.caseId)! });
    const blocked = await host.command({ requestId: 'update', source, action: { kind: 'prepare-update', attemptId: 'u1', targetVersion: 'v2' } });
    assert.equal(blocked.outcome, 'blocked');
    assert.equal(h.store.control().desired_intent, 'running');
    assert.equal(h.store.control().management_mode, 'update-silence');
    assert.equal(blockers, 0, 'update silence releases power independently of unconfirmed Admin exit');
    assert.throws(() => h.store.commandStatus(credential), /运行意图/);
    const frozen = await host.command({ requestId: 'start-during-update', source, action: { kind: 'start' } });
    assert.equal(frozen.outcome, 'update-in-progress');
    confirmed = true;
    const ready = await host.command({ requestId: 'update', source, action: { kind: 'prepare-update', attemptId: 'u1', targetVersion: 'v2' } });
    assert.equal(ready.outcome, 'ready-for-update');
    assert.equal((await host.verifyUpdateReadiness()).outcome, 'ready-for-update');
    const stop = await host.command({ requestId: 'stop-during-update', source, action: { kind: 'stop', reason: 'user-stop' } });
    assert.equal(stop.outcome, 'stopped');
    assert.equal(h.store.control().desired_intent, 'stopped');
    await host.command({ requestId: 'resume', source, action: { kind: 'resume-after-update' } });
    assert.equal(h.store.control().management_mode, 'normal');
    assert.equal(h.store.control().desired_intent, 'stopped');
    assert.equal(blockers, 0, 'resume after update cannot resurrect a user-stopped assertion');
  } finally { confirmed = true; await host.shutdown(); h.store.close(); }
});

test('production idle sleep assertion uses independent management intent while business initialization and cancellation are blocked', async () => {
  const h = await fixture('running');
  h.store.setIntent('running', 'initial-intent');
  h.store.acquireSupervisor(h.ownerId);
  const entered = deferred(); const release = deferred();
  let blockers = 0;
  const host = createManagedLoopRunLifecycle({ ownerId: h.ownerId, adapter: 'cli', dependencies: {
    ...h.dependencies, database: async () => { entered.resolve(); await release.promise; return h.db; },
  }, inhibitIdleSleep: async () => { blockers++; return { isActive: () => true, release: async () => { blockers--; } }; },
    management: { store: h.store, refreshRuntime: async () => runtime, launch: idleManagement, confirmStopped: async () => true } });
  try {
    const started = host.start(); await entered.promise;
    assert.equal(blockers, 1, 'power startup must not await a business DB query');
    const stopped = host.command({ requestId: 'stop-with-blocked-db', source, action: { kind: 'stop', reason: 'user-stop' } });
    await eventually(() => blockers === 0);
    assert.equal(h.store.control().desired_intent, 'stopped');
    release.resolve(); await Promise.all([started, stopped]);
    assert.equal(blockers, 0); assert.equal(h.starts.length, 0);
  } finally { release.resolve(); await host.shutdown(); h.store.close(); }
});
