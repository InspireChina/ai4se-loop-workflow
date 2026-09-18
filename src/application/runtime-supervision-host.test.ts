import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createAdminController } from './admin-controller';
import { createRuntimeSupervisionHost } from './runtime-supervision-host';

const storeFixture = () => new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db'));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('failed idle sleep release cannot report host shutdown before independent physical cleanup settles', async () => {
  const store = storeFixture(); const management = deferred(); const business = deferred();
  let managementCleaning = false; let businessCleaning = false; let finished = false;
  const host = createRuntimeSupervisionHost({ store,
    management: { start: async () => 'idle', stop: async () => 'stopped', reconcile: async () => 'idle',
      shutdown: async () => { managementCleaning = true; await management.promise; } },
    business: { initialize: async () => undefined, applyIntent: async () => undefined,
      shutdown: async () => { businessCleaning = true; await business.promise; } },
    idleSleep: { start: async () => undefined, reconcile: async () => undefined, shutdown: async () => { throw new Error('OS assertion still owned'); } },
    reportBusinessFailure: () => undefined,
  });
  try {
    await host.initialize();
    const stopped = host.shutdown(); void stopped.finally(() => { finished = true; }).catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(managementCleaning, true); assert.equal(businessCleaning, true); assert.equal(finished, false);
    management.resolve(); business.resolve();
    await assert.rejects(stopped, error => error instanceof AggregateError && error.errors.some(reason => String(reason).includes('OS assertion still owned')));
  } finally { management.resolve(); business.resolve(); await host.shutdown().catch(() => undefined); store.close(); }
});

test('shared host starts real independent management despite unavailable business storage, then recovers without a second Controller', async () => {
  const store = storeFixture();
  store.setIntent('running', 'start');
  const repair = store.observe({ observationId: 'runtime-fault', scope: 'runtime', scopeKey: 'business-store',
    fingerprint: 'cannot-open', sourceVersion: 'v1', origin: 'runtime', summary: 'Business DB unavailable', evidence: {} });
  let launches = 0;
  let healthTick!: () => void;
  let databaseAvailable = false;
  const failures: string[] = [];
  const applied: string[] = [];
  const management = createAdminController({ store, ownerId: 'host', confirmStopped: async () => true,
    launch: async () => {
      launches++;
      return { completion: Promise.resolve({ outcome: 'failed', reason: 'diagnostic round', exitConfirmed: true }), stop: async () => true };
    } });
  const host = createRuntimeSupervisionHost({ store, management,
    scheduleInterval: callback => { healthTick = callback; return setInterval(() => undefined, 100_000); },
    business: {
      initialize: async () => {
        assert.ok(store.control().owner_id, 'management supervision must already exist');
        if (!databaseAvailable) throw new Error('SQLITE_CANTOPEN');
      },
      applyIntent: async current => { applied.push(`${current.desired}:${current.revision}`); },
      shutdown: async () => undefined,
    }, reportBusinessFailure: (error, phase) => { failures.push(`${phase}:${String(error)}`); } });
  try {
    await host.initialize();
    await management.waitForSettlements();
    assert.equal(launches, 1);
    assert.match(failures[0]!, /initialize:Error: SQLITE_CANTOPEN/);
    assert.equal(store.getCase(repair.caseId)?.status, 'queued');
    databaseAvailable = true;
    healthTick();
    await host.reconcileBusiness();
    assert.ok(applied.length > 0);
    assert.ok(applied.every(value => value === 'running:1'));
    assert.equal(launches, 1);
  } finally { await host.shutdown(); store.close(); }
});

test('user stop persists and cancels management immediately while business initialization is blocked; old start replay cannot undo it', async () => {
  const store = storeFixture();
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];
  const applied: string[] = [];
  const host = createRuntimeSupervisionHost({ store,
    management: {
      start: async () => { order.push('management-start'); return 'idle'; },
      reconcile: async () => 'idle',
      stop: async () => { assert.equal(store.control().desired_intent, 'stopped'); order.push('management-stop'); return 'stopped'; },
      shutdown: async () => undefined,
    },
    business: {
      initialize: async current => { order.push(`business-init:${current.desired}`); entered.resolve(); await release.promise; },
      applyIntent: async current => { applied.push(`${current.desired}:${current.revision}`); },
      shutdown: async () => undefined,
    }, reportBusinessFailure: () => undefined,
  });
  store.setIntent('running', 'old-start');
  try {
    const initializing = host.initialize();
    await entered.promise;
    const stopping = host.setIntent('stopped', 'user-stop');
    assert.equal(store.control().desired_intent, 'stopped');
    assert.deepEqual(order, ['management-start', 'business-init:running', 'management-stop']);
    assert.equal(await host.setIntent('running', 'old-start'), 1);
    assert.equal(store.control().desired_intent, 'stopped');
    release.resolve();
    await Promise.all([initializing, stopping]);
    assert.ok(applied.every(value => value === 'stopped:2'));
    await host.shutdown();
    assert.equal(store.control().desired_intent, 'stopped');
  } finally { release.resolve(); await host.shutdown(); store.close(); }
});

test('management launch and management cleanup cannot hold up unrelated business supervision or stop', async () => {
  const store = storeFixture();
  const launch = deferred();
  const cleanup = deferred();
  const businessStarted = deferred();
  const businessStopped = deferred();
  const host = createRuntimeSupervisionHost({ store,
    management: {
      start: async () => { await launch.promise; return 'idle'; },
      reconcile: async () => 'idle',
      stop: async () => { await cleanup.promise; return 'stopped'; },
      shutdown: async () => undefined,
    }, business: {
      initialize: async () => { businessStarted.resolve(); },
      applyIntent: async current => { if (current.desired === 'stopped') businessStopped.resolve(); },
      shutdown: async () => undefined,
    }, reportBusinessFailure: () => undefined,
  });
  store.setIntent('running', 'start');
  try {
    const initializing = host.initialize();
    await businessStarted.promise;
    const stopping = host.setIntent('stopped', 'stop');
    await businessStopped.promise;
    assert.equal(store.control().desired_intent, 'stopped');
    launch.resolve(); cleanup.resolve();
    await Promise.all([initializing, stopping]);
  } finally { launch.resolve(); cleanup.resolve(); await host.shutdown(); store.close(); }
});

test('standard supervision resolves business startup and stop without waiting for Admin',async()=>{
  const store=storeFixture();const launch=deferred();const cleanup=deferred();let applied='';
  const host=createRuntimeSupervisionHost({store,backgroundManagement:true,
    management:{start:async()=>{await launch.promise;return 'idle';},reconcile:async()=> 'idle',
      stop:async()=>{await cleanup.promise;return 'stopped';},shutdown:async()=>undefined},
    business:{initialize:async()=>undefined,applyIntent:async intent=>{applied=intent.desired;},shutdown:async()=>undefined},
    reportBusinessFailure:()=>undefined});
  store.setIntent('running','start');
  try{
    await host.initialize();assert.equal(applied,'running');
    await host.setIntent('stopped','stop');assert.equal(applied,'stopped');
  }finally{launch.resolve();cleanup.resolve();await host.shutdown();store.close();}
});

test('restart respects persisted management stop rather than stale business running intent, and failure reporting cannot kill bootstrap', async () => {
  const original = storeFixture();
  const filename = original.filename;
  original.setIntent('running', 'start'); original.setIntent('stopped', 'stop'); original.close();
  const store = new AdminManagementStore(filename);
  let businessIntent = 'running';
  let initialized = 0;
  const host = createRuntimeSupervisionHost({ store,
    management: { start: async () => 'stopped', stop: async () => 'stopped', reconcile: async () => 'stopped', shutdown: async () => undefined },
    business: {
      initialize: async current => { businessIntent = current.desired; if (!initialized++) throw new Error('temporary failure'); },
      applyIntent: async current => { businessIntent = current.desired; }, shutdown: async () => undefined,
    }, reportBusinessFailure: () => { throw new Error('diagnostic sink unavailable'); },
  });
  try {
    await host.initialize();
    await host.reconcileBusiness();
    assert.equal(initialized, 2);
    assert.equal(businessIntent, 'stopped');
    assert.equal(store.control().intent_revision, 2);
  } finally { await host.shutdown(); store.close(); }
});
