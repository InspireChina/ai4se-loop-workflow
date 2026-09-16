import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createAdminController, type AdminExecutionCompletion } from './admin-controller';
import { databaseConnection } from '../infrastructure/database';
import { beginRun, endRun } from './loop-runs';
import { createTaskInDb, createTaskSchema } from './tasks';
import { setAgentConcurrency } from './project-settings';
import { progressDispatcher } from './progress-dispatch';
import { terminateProcessTree, waitForProcessIdentity } from '../infrastructure/process-tree';
import type {RepairClaim} from '../domain/repair-case';

function fixture(now: () => number = Date.now) {
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db');
  const store = new AdminManagementStore(filename, now);
  store.setIntent('running', randomUUID());
  const repair = store.observe({ observationId: randomUUID(), scope: 'runtime', scopeKey: 'runtime', fingerprint: 'fault',
    origin: 'runtime', sourceVersion: 'v1', summary: 'Runner unavailable', evidence: { runner: 'dead' } });
  return { store, filename, repair };
}

test('update silence suspends writers without stopping read-only update evidence, while STOP and shutdown drain everything',async()=>{
  const h=fixture();let suspends=0,stops=0,launches=0;
  h.store.setUpdateSilence(true,'update');
  const controller=createAdminController({store:h.store,ownerId:'host',confirmStopped:async()=>true,
    suspendCapabilities:async()=>{suspends++;},stopCapabilities:async()=>{stops++;},
    launch:async()=>{launches++;throw new Error('must not launch during silence');}});
  try{
    assert.equal(await controller.start(),'stopped');assert.equal(suspends,1);assert.equal(stops,0);
    assert.equal(await controller.reconcile(),'stopped');assert.equal(suspends,2);assert.equal(stops,0);
    await controller.stop('user-stop');assert.ok(stops>0);assert.equal(suspends,2);assert.equal(launches,0);
    const beforeShutdown=stops;await controller.shutdown();assert.ok(stops>beforeShutdown);assert.equal(h.store.control().owner_id,null);
  }finally{await controller.shutdown();h.store.close();}
});

test('failed write suspension cannot suppress all-capability cleanup on user STOP',async()=>{
  const h=fixture();let stopped=false;h.store.setUpdateSilence(true,'update');
  const controller=createAdminController({store:h.store,ownerId:'host',confirmStopped:async()=>true,
    suspendCapabilities:async()=>{throw new Error('writer exit unconfirmed');},stopCapabilities:async()=>{stopped=true;},
    launch:async()=>{throw new Error('must not launch');}});
  try{
    await assert.rejects(controller.reconcile(),/writer exit unconfirmed/);assert.equal(stopped,false);
    await controller.stop('user-stop');assert.equal(stopped,true);assert.equal(h.store.control().desired_intent,'stopped');
  }finally{await controller.shutdown();h.store.close();}
});

test('stop interrupts pending discovery via independent capability cancellation before serialized reconcile',async()=>{
  const h=fixture();let entered!:()=>void;let release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});const pending=new Promise<void>(resolve=>{release=resolve;});let launches=0;
  const controller=createAdminController({store:h.store,ownerId:'host',confirmStopped:async()=>false,
    discover:async()=>{entered();await pending;},stopCapabilities:async()=>{release();},
    launch:async()=>{launches++;throw new Error('must not dispatch after stop');}});
  try{
    const starting=controller.start();await ready;const stopping=controller.stop('user-stop');
    assert.equal(await starting,'stopped');assert.equal(await stopping,'stopped');assert.equal(launches,0);
    assert.equal(h.store.attempts().length,0);
  }finally{release();await controller.shutdown();h.store.close();}
});

test('failed capability cleanup cannot skip CLI cancellation or release management ownership; retry succeeds',async()=>{
  const h=fixture();let cliStops=0;let allowCapabilityExit=false;
  const controller=createAdminController({store:h.store,ownerId:'host',confirmStopped:async()=>false,
    stopCapabilities:async()=>{if(!allowCapabilityExit)throw new Error('actual capability still unconfirmed');},
    launch:async()=>({completion:new Promise(()=>{}),stop:async()=>{cliStops++;return true;}})});
  try{
    assert.equal(await controller.reconcile(),'launched');
    await assert.rejects(controller.shutdown(),/管理能力实际退出未确认/);assert.ok(cliStops>0);
    assert.equal(h.store.control().owner_id,'host');assert.equal(h.store.attempts()[0].status,'interrupted');
    allowCapabilityExit=true;await controller.shutdown();assert.equal(h.store.control().owner_id,null);
  }finally{allowCapabilityExit=true;await controller.shutdown();h.store.close();}
});

test('Controller schedules investigation and independent verification from the same fair persisted queue',async()=>{
  const h=fixture(()=>100_000);
  const other=h.store.observe({observationId:randomUUID(),scope:'runtime',scopeKey:'other',fingerprint:'other',
    origin:'runtime',sourceVersion:'v1',summary:'Independent queued fault',evidence:{}});
  const authority=h.store.acquireSupervisor('fair-host')!;
  const prepared=h.store.claimNext(authority)!;
  h.store.finishAttempt(prepared,{outcome:'verification-requested',exitConfirmed:true,reason:'controlled runtime fixture requests independent check'});
  const launches:{caseId:string;role:string}[]=[];
  const launch=async(claim:RepairClaim)=>{
    launches.push({caseId:claim.repairCase.caseId,role:claim.attempt.role});
    return {completion:Promise.resolve({outcome:'failed' as const,exitConfirmed:true,reason:'known pre-spawn fixture failure'}),stop:async()=>true};
  };
  const controller=createAdminController({store:h.store,ownerId:'fair-host',confirmStopped:async()=>true,launch,launchVerification:launch});
  try{
    await controller.reconcile();await controller.waitForSettlements();
    await controller.reconcile();await controller.waitForSettlements();
    assert.deepEqual(launches,[{caseId:other.caseId,role:'investigation'},{caseId:h.repair.caseId,role:'verification'}]);
  }finally{await controller.shutdown();h.store.close();}
});

test('shutdown refuses to release management supervision until the owned invocation physically confirms exit, and can retry',async()=>{
  const h=fixture();let allowExit=false;
  const controller=createAdminController({store:h.store,ownerId:'root-management',confirmStopped:async()=>allowExit,
    launch:async()=>({completion:new Promise(()=>{}),stop:async()=>allowExit})});
  try{
    assert.equal(await controller.reconcile(),'launched');
    await assert.rejects(controller.shutdown(),/实际进程退出未确认/);
    assert.equal(h.store.control().owner_id,'root-management');assert.equal(h.store.acquireSupervisor('competitor'),null);
    allowExit=true;await controller.shutdown();assert.equal(h.store.control().owner_id,null);
    assert.equal(h.store.attempts(h.repair.caseId)[0].status,'interrupted');assert.equal(h.store.getCase(h.repair.caseId)!.status,'queued');
  }finally{allowExit=true;await controller.shutdown();h.store.close();}
});

test('shutdown also retains a rejected launcher allocation outside active; later confirmed cleanup keeps the original failure',async()=>{
  const h=fixture();let allowExit=false;
  const controller=createAdminController({store:h.store,ownerId:'root-management',confirmStopped:async()=>allowExit,
    launch:async()=>{throw new Error('opaque launcher failed after possible spawn');}});
  try{
    assert.equal(await controller.reconcile(),'blocked');
    await assert.rejects(controller.shutdown(),/实际进程退出未确认/);
    assert.equal(h.store.control().owner_id,'root-management');assert.equal(h.store.attempts(h.repair.caseId)[0].status,'launching');
    allowExit=true;await controller.shutdown();assert.equal(h.store.control().owner_id,null);
    assert.match(h.store.attempts(h.repair.caseId)[0].lastError!,/opaque launcher failed/);
  }finally{allowExit=true;await controller.shutdown();h.store.close();}
});

test('stop, update and lease takeover during discovery do not claim or charge a repair attempt', async () => {
  for (const change of ['stop', 'update', 'fence'] as const) {
    let now = Date.now(); const h = fixture(() => now);
    let entered!: () => void; let release!: () => void;
    const discovered = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const errors: string[] = [];
    let actions = 0; let launches = 0;
    const controller = createAdminController({ store: h.store, ownerId: 'host', confirmStopped: async () => true,
      discover: async () => { entered(); await pending; },
      manageActions: async () => { actions++; }, onError: error => { errors.push(String(error)); },
      launch: async () => { launches++; throw new Error('Must not launch after cancellation'); } });
    try {
      const starting = controller.start(); await discovered;
      if (change === 'stop') h.store.setIntent('stopped', 'user-stop');
      else if (change === 'update') h.store.setUpdateSilence(true, 'update');
      else { now += 31_000; assert.ok(h.store.acquireSupervisor('new-owner')); }
      release();
      assert.equal(await starting, change === 'fence' ? 'observer' : 'stopped');
      assert.equal(actions, 0); assert.equal(launches, 0);
      assert.deepEqual(h.store.attempts(h.repair.caseId), []);
      assert.equal(h.store.getCase(h.repair.caseId)?.currentAttemptId, null);
      assert.deepEqual(errors, []);
    } finally { release(); await controller.shutdown(); h.store.close(); }
  }
});

test('a cross-host stop committed immediately before the atomic scheduled claim is cancellation rather than a thrown bootstrap failure', async () => {
  const h = fixture(); const observer = new AdminManagementStore(h.filename);
  const originalClaim = h.store.claimScheduled.bind(h.store);
  h.store.claimScheduled = (authority,verification) => { observer.setIntent('stopped', 'cross-host-stop'); return originalClaim(authority,verification); };
  const errors: string[] = [];
  const controller = createAdminController({ store: h.store, ownerId: 'host', confirmStopped: async () => true,
    onError: error => { errors.push(String(error)); }, launch: async () => { throw new Error('Must not launch'); } });
  try {
    assert.equal(await controller.start(), 'stopped');
    assert.deepEqual(h.store.attempts(h.repair.caseId), []);
    assert.deepEqual(errors, []);
  } finally { await controller.shutdown(); observer.close(); h.store.close(); }
});

test('Admin failure is resumed from the same persisted investigation with a new attempt, never human fallback', async () => {
  const h = fixture();
  let launches = 0;
  const controller = createAdminController({
    store: h.store, ownerId: 'host', confirmStopped: async () => true,
    launch: async (claim) => {
      launches += 1;
      h.store.recordEvidence(claim, 'hypothesis', 'hypothesis', { attempt: launches, investigate: 'actual service version' });
      return { completion: Promise.resolve({ outcome: 'failed', exitConfirmed: true, reason: 'Admin CLI failed' }), stop: async () => true };
    },
  });
  try {
    for (let count = 0; count < 5; count += 1) {
      assert.equal(await controller.reconcile(), 'launched');
      await controller.waitForSettlements();
    }
    assert.equal(launches, 5);
    assert.equal(h.store.getCase(h.repair.caseId)?.status, 'queued');
    assert.equal(h.store.attempts(h.repair.caseId).length, 5);
    assert.equal(h.store.evidence(h.repair.caseId).length, 5);
  } finally { await controller.shutdown(); h.store.close(); }
});

test('invalid takeover reconciliation stops the owning Admin before the capability records terminal release', async () => {
  const h = fixture();
  let invalid = false; let stops = 0; let recorded = false;
  const controller = createAdminController({ store: h.store, ownerId: 'revocation-host', confirmStopped: async () => true,
    reconcileTakeovers: async authority => {
      if (!invalid) return { attemptIds: [], revoked: 0, draining: 0 };
      const attempt = h.store.attempts(h.repair.caseId)[0];
      if (attempt && ['launching', 'running'].includes(attempt.status)) return { attemptIds: [attempt.attemptId], revoked: 0, draining: 0 };
      if (attempt && !recorded) {
        h.store.recordRepairTakeoverRevocation(authority, { caseId: h.repair.caseId, generation: attempt.generation,
          kind: 'cancelled', terminal: true, reason: 'Business source cancelled', eventKey: 'fixture-revoked',
          coveredObservationIds: [] });
        recorded = true;
      }
      return { attemptIds: [], revoked: recorded ? 1 : 0, draining: 0 };
    },
    launch: async () => ({ completion: new Promise(() => {}), stop: async () => { stops++; return true; } }),
  });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    invalid = true;
    assert.equal(await controller.reconcile(), 'idle');
    assert.equal(stops, 1);
    assert.equal(recorded, true);
    assert.equal(h.store.getCase(h.repair.caseId)?.status, 'closed');
    assert.equal(h.store.attempts(h.repair.caseId)[0].status, 'interrupted');
  } finally { await controller.shutdown(); h.store.close(); }
});

test('new Controller refuses unconfirmed old Admin exit, then resumes the same case after physical confirmation', async () => {
  let now = Date.now();
  const h = fixture(() => now);
  const old = h.store.claimNext(h.store.acquireSupervisor('old-host')!)!;
  h.store.attachProcess(old, 779, 'old-process');
  h.store.recordEvidence(old, 'original-hypothesis', 'hypothesis', { cause: 'version mismatch' });
  now += 31_000;
  let confirmed = false;
  let launches = 0;
  const controller = createAdminController({
    store: h.store, ownerId: 'new-host', confirmStopped: async () => confirmed,
    launch: async (claim) => {
      launches += 1;
      assert.equal(claim.repairCase.caseId, h.repair.caseId);
      assert.equal(claim.attempt.generation, 2);
      return { completion: Promise.resolve({ outcome: 'verification-requested', exitConfirmed: true, reason: 'request verification' }), stop: async () => true };
    },
  });
  try {
    assert.equal(await controller.reconcile(), 'idle');
    assert.equal(launches, 0);
    confirmed = true;
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    assert.equal(h.store.evidence(h.repair.caseId).length, 1);
    assert.equal(h.store.getCase(h.repair.caseId)?.status, 'verifying');
  } finally { await controller.shutdown(); h.store.close(); }
});

test('observer user stop physically cancels the owning host Admin immediately without stealing its supervisor lease', async () => {
  const h = fixture();
  const observerStore = new AdminManagementStore(h.filename);
  let child!: ReturnType<typeof spawn>;
  const owner = createAdminController({ store: h.store, ownerId: 'owning-host', confirmStopped: async () => false,
    launch: async (_claim, bind) => {
      child = spawn(process.execPath, ['-e', 'setInterval(()=>undefined,1000)'], { stdio: 'ignore' });
      const completion = new Promise<AdminExecutionCompletion>(resolve => child.once('exit', () =>
        resolve({ outcome: 'failed', reason: 'User stopped from observer', exitConfirmed: true })));
      const identity = await waitForProcessIdentity(child.pid!);
      assert.ok(identity);
      bind(child.pid!, identity.startMarker);
      return { completion, stop: async () => terminateProcessTree(child.pid!, 1000, identity.startMarker) };
    } });
  let inspected = 0;
  const observer = createAdminController({ store: observerStore, ownerId: 'observing-host',
    launch: async () => { throw new Error('Observer cannot launch'); },
    confirmStopped: async attempt => {
      inspected++;
      assert.equal(attempt.pid, child.pid);
      return terminateProcessTree(attempt.pid!, 1000, attempt.startMarker!);
    } });
  try {
    assert.equal(await owner.reconcile(), 'launched');
    assert.equal(await observer.reconcile(), 'observer');
    await observer.stop('observer-user-stop');
    await owner.waitForSettlements();
    assert.equal(inspected, 1);
    assert.throws(() => process.kill(child.pid!, 0));
    assert.equal(observerStore.control().owner_id, 'owning-host');
    assert.equal(observerStore.control().desired_intent, 'stopped');
    assert.equal(observerStore.getCase(h.repair.caseId)?.currentAttemptId, null);
  } finally { await observer.shutdown(); await owner.shutdown(); observerStore.close(); h.store.close(); }
});

test('slow Admin launch cannot starve supervision renewal and user stop immediately cancels pending launch', async () => {
  let now = Date.now();
  const h = fixture(() => now);
  let tick!: () => void;
  let signal!: AbortSignal;
  let entered!: () => void;
  let finish!: (result: AdminExecutionCompletion) => void;
  const launched = new Promise<void>((resolve) => { entered = resolve; });
  const completion = new Promise<AdminExecutionCompletion>((resolve) => { finish = resolve; });
  const controller = createAdminController({
    store: h.store, ownerId: 'host', confirmStopped: async () => true,
    scheduleInterval: (callback) => { tick = callback as () => void; return setInterval(() => undefined, 100_000); },
    launch: async (_claim, _bind, cancellation) => {
      signal = cancellation;
      entered();
      await new Promise<void>((resolve) => cancellation.addEventListener('abort', () => resolve(), { once: true }));
      return { completion, stop: async () => { finish({ outcome: 'failed', exitConfirmed: true, reason: 'stopped' }); return true; } };
    },
  });
  const starting = controller.start();
  try {
    await launched;
    for (let count = 0; count < 4; count += 1) {
      now += 10_000;
      tick();
      assert.equal(h.store.control().expires_at, now + 30_000);
    }
    const stopping = controller.stop(randomUUID());
    assert.equal(signal.aborted, true, 'cancel must not wait behind launch');
    await starting;
    await stopping;
    await controller.waitForSettlements();
    assert.equal(h.store.control().desired_intent, 'stopped');
    assert.equal(h.store.getCase(h.repair.caseId)?.currentAttemptId, null);
    assert.equal(h.store.attempts(h.repair.caseId).length, 1);
  } finally { await controller.shutdown(); h.store.close(); }
});

test('a real management CLI launches with all normal slots occupied and never consumes or changes business reservations', async () => {
  const db = await databaseConnection();
  await setAgentConcurrency(1);
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  for (let count = 0; count < 2; count += 1) {
    createTaskInDb(db, createTaskSchema.parse({ title: `Occupied business slot ${count}`, itemType: 'direct' }), `REQ-${randomUUID()}`);
  }
  const runId = await beginRun('Independent management scheduling fixture');
  const reserved = await progressDispatcher.reserveNext({ runId });
  assert.equal(reserved.kind, 'reserved');
  if (reserved.kind !== 'reserved') throw new Error('Missing ordinary slot reservation');
  assert.equal(reserved.reservations.length, 1);
  assert.equal((await progressDispatcher.reserveNext({ runId })).kind, 'wait');
  const before = {
    executions: db.prepare('SELECT * FROM execution_attempts ORDER BY execution_id').all(),
    claims: db.prepare('SELECT * FROM resource_claims ORDER BY resource_key,resource_scope').all(),
  };
  const h = fixture();
  let cliPid = 0;
  const controller = createAdminController({
    store: h.store, ownerId: 'independent-management-host', confirmStopped: async () => false,
    launch: async (_claim, bind) => {
      const child = spawn(process.execPath, ['-e', 'process.stdout.write("management ready"); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      cliPid = child.pid!;
      const completion = new Promise<AdminExecutionCompletion>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve({ outcome: 'failed', reason: 'stopped management fixture', exitConfirmed: true }));
      });
      bind(cliPid);
      const identity = await waitForProcessIdentity(cliPid);
      assert.ok(identity);
      bind(cliPid, identity.startMarker);
      return { completion, stop: () => terminateProcessTree(cliPid, 2000, identity.startMarker) };
    },
  });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    assert.ok(cliPid > 0);
    assert.doesNotThrow(() => process.kill(cliPid, 0));
    await controller.stop(randomUUID());
    await controller.waitForSettlements();
    assert.throws(() => process.kill(cliPid, 0));
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts ORDER BY execution_id').all(), before.executions);
    assert.deepEqual(db.prepare('SELECT * FROM resource_claims ORDER BY resource_key,resource_scope').all(), before.claims);
  } finally {
    await controller.shutdown();
    if (cliPid) await terminateProcessTree(cliPid, 2000);
    h.store.close();
    await endRun(runId, false, { stopRunner: false });
  }
});

test('management diagnostics and Controller continue when a business database cannot be read', async () => {
  const h = fixture();
  const damagedPath = join(process.env.LOOP_DATA_ROOT!, `damaged-business-${randomUUID()}.db`);
  writeFileSync(damagedPath, 'not a sqlite database');
  const broken = new Database(damagedPath);
  assert.throws(() => broken.pragma('schema_version'), /not a database/);
  let launches = 0;
  const controller = createAdminController({
    store: h.store, ownerId: 'management-without-business-db', confirmStopped: async () => false,
    launch: async () => {
      launches += 1;
      return { completion: Promise.resolve({ outcome: 'failed', reason: 'independent diagnostic captured', exitConfirmed: true }), stop: async () => true };
    },
  });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    assert.equal(launches, 1);
    assert.equal(h.store.observations(h.repair.caseId).length, 1);
    assert.equal(h.store.getCase(h.repair.caseId)?.lastError, 'independent diagnostic captured');
  } finally { await controller.shutdown(); broken.close(); h.store.close(); }
});

test('uncertain completion keeps the physical cleanup handle until exit is confirmed and retains the original error', async () => {
  const h = fixture();
  let launches = 0;
  let stopCalls = 0;
  const controller = createAdminController({
    store: h.store, ownerId: 'host', confirmStopped: async () => false,
    launch: async () => {
      launches += 1;
      return {
        completion: Promise.resolve({ outcome: launches === 1 ? 'failed' : 'verification-requested', reason: 'original CLI transport error', exitConfirmed: launches > 1 }),
        stop: async () => { stopCalls += 1; return stopCalls > 1; },
      };
    },
  });
  try {
    await controller.reconcile();
    await controller.waitForSettlements();
    assert.equal(await controller.reconcile(), 'running');
    assert.equal(launches, 1);
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    assert.equal(launches, 2);
    assert.match(h.store.attempts(h.repair.caseId)[0].lastError || '', /original CLI transport error/);
    assert.equal(h.store.getCase(h.repair.caseId)?.status, 'verifying');
  } finally { await controller.shutdown(); h.store.close(); }
});
