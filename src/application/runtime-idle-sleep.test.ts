import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeIdleSleep, IdleSleepAcquisitionFailure, type IdleSleepHandle } from './runtime-idle-sleep';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let key: string | null = 'intent-1:lease-1';
  let tick!: () => void;
  let acquired = 0;
  let released = 0;
  let active = true;
  const failures: string[] = [];
  const ports = {
    readKey: () => key,
    acquire: async () => { acquired++; active = true; return { isActive: () => active, release: async () => { released++; } }; },
    onError: (error: unknown) => { failures.push(String(error)); },
    scheduleInterval: (callback: () => void) => { tick = callback; return setInterval(() => undefined, 100_000); },
  };
  return { ports, setKey: (value: string | null) => { key = value; }, tick: () => tick(),
    setActive: (value: boolean) => { active = value; }, acquired: () => acquired, released: () => released, failures };
}

test('idle sleep capability is shared by intent and lease, idempotent, and released on stop or fencing', async () => {
  const h = fixture(); const power = createRuntimeIdleSleep(h.ports);
  try {
    await power.start(); await power.start(); await power.reconcile();
    assert.equal(h.acquired(), 1);
    h.setKey('intent-1:lease-2'); await power.reconcile();
    assert.equal(h.released(), 1); assert.equal(h.acquired(), 2);
    h.setKey(null); await power.reconcile();
    assert.equal(h.released(), 2);
    h.setKey('intent-2:lease-2'); await power.reconcile();
    assert.equal(h.acquired(), 3);
    await power.shutdown(); await power.shutdown();
    assert.equal(h.released(), 3);
    await assert.rejects(power.start(), /不能重新启动/);
  } finally { await power.shutdown(); }
});

test('stop aborts startup immediately and a late OS assertion is released instead of resurrecting running state', async () => {
  const h = fixture(); const acquired = deferred<IdleSleepHandle>(); let signal!: AbortSignal;
  const power = createRuntimeIdleSleep({ ...h.ports, acquire: async value => { signal = value; return acquired.promise; } });
  try {
    const starting = power.start();
    assert.equal(signal.aborted, false);
    h.setKey(null); const stopping = power.reconcile();
    assert.equal(signal.aborted, true);
    acquired.resolve(await h.ports.acquire());
    await Promise.all([starting, stopping]);
    assert.equal(h.released(), 1); assert.equal(h.acquired(), 1);
    assert.deepEqual(h.failures, [], 'normal cancellation is not an OS failure');
  } finally { await power.shutdown(); }
});

test('failed release and failed acquisition cleanup retain their handle and never create a conflicting duplicate', async () => {
  const h = fixture(); let fail = true; let acquires = 0; let releases = 0;
  const handle = { isActive: () => true, release: async () => { releases++; if (fail) throw new Error('exit not confirmed'); } };
  const power = createRuntimeIdleSleep({ ...h.ports, acquire: async () => { acquires++; throw new IdleSleepAcquisitionFailure('startup cleanup failed', handle); } });
  try {
    await power.start(); await power.reconcile();
    assert.equal(acquires, 1); assert.equal(releases, 1, 'failed startup cleanup is retired even while running intent is unchanged');
    h.setKey(null); await power.reconcile(); await power.reconcile();
    assert.equal(acquires, 1); assert.equal(releases, 3);
    assert.ok(h.failures.some(value => value.includes('startup cleanup failed')));
    fail = false; await power.reconcile();
    assert.equal(releases, 4); assert.equal(acquires, 1);
  } finally { fail = false; await power.shutdown(); }
});

test('independent power polling detects assertion loss and survives broken capability and diagnostic sinks', async () => {
  const h = fixture(); let badRead = false;
  const power = createRuntimeIdleSleep({ ...h.ports, readKey: () => { if (badRead) throw new Error('management read unavailable'); return h.ports.readKey(); },
    onError: error => { h.ports.onError(error); throw new Error('sink failed'); } });
  try {
    await power.start(); h.setActive(false); h.tick(); await power.reconcile();
    assert.equal(h.released(), 1); assert.equal(h.acquired(), 2);
    assert.ok(h.failures.some(value => value.includes('断言已失效')));
    badRead = true; await power.reconcile();
    assert.equal(h.released(), 2);
    badRead = false; h.setActive(true); await power.reconcile();
    assert.equal(h.acquired(), 3);
  } finally { await power.shutdown(); }
});

test('many power ticks coalesce while OS startup is pending instead of accumulating independent acquisitions', async () => {
  const h = fixture(); const pending = deferred<IdleSleepHandle>();
  const power = createRuntimeIdleSleep({ ...h.ports, acquire: async () => pending.promise });
  try {
    const started = power.start();
    for (let index = 0; index < 1_000; index++) h.tick();
    pending.resolve(await h.ports.acquire()); await started; await power.reconcile();
    assert.equal(h.acquired(), 1); assert.equal(h.released(), 0);
  } finally { await power.shutdown(); }
});

test('host shutdown does not falsely report release when the OS handle still cannot be retired', async () => {
  const h = fixture(); let fail = true;
  const power = createRuntimeIdleSleep({ ...h.ports, acquire: async () => ({ isActive: () => true,
    release: async () => { if (fail) throw new Error('OS release failed'); } }) });
  try {
    await power.start(); await assert.rejects(power.shutdown(), /尚未确认释放/);
    fail = false; await power.shutdown();
  } finally { fail = false; await power.shutdown(); }
});

test('cross-host stop during old assertion release cannot start a helper from a stale running snapshot', async () => {
  const h = fixture(); const releasing = deferred<void>(); let acquires = 0;
  const power = createRuntimeIdleSleep({ ...h.ports, acquire: async () => { acquires++; return {
    isActive: () => true, release: async () => { await releasing.promise; },
  }; } });
  try {
    await power.start(); h.setKey('intent-1:lease-2'); const changingOwner = power.reconcile();
    h.setKey(null); releasing.resolve(); await changingOwner;
    assert.equal(acquires, 1, 'the stop is observed before reacquiring, not only after OS startup');
  } finally { releasing.resolve(); await power.shutdown(); }
});
