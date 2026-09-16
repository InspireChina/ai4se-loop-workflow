import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createConfiguredAdminExecution } from './admin-configured-execution';
import type { AdminRuntimeConfiguration } from '../domain/admin-runtime-configuration';

const configuration: AdminRuntimeConfiguration = { configurationId: 'configured-system', sourceVersion: 'v15',
  executorId: 'claude', executionOptions: { model: 'configured-model' } };
function fixture() {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db'));
  store.setIntent('running', 'start');
  store.observe({ observationId: 'runtime-failure', scope: 'runtime', scopeKey: 'runtime', fingerprint: 'broken-business-store',
    sourceVersion: 'v15', origin: 'runtime', summary: 'Configuration DB unavailable', evidence: {} });
  const authority = store.acquireSupervisor('host')!;
  return { store, authority, claim: store.claimNext(authority)! };
}

test('Admin retains exact configured executor/model after management restart and business configuration failure', async () => {
  const original = fixture();
  const selected: AdminRuntimeConfiguration[] = [];
  const launch = async (runtime: AdminRuntimeConfiguration) => {
    selected.push(runtime);
    return { completion: Promise.resolve({ outcome: 'failed' as const, exitConfirmed: true, reason: 'diagnostic round' }), stop: async () => true };
  };
  const first = createConfiguredAdminExecution({ store: original.store, refreshRuntime: async () => configuration, launch });
  const result = await first(original.claim, () => undefined, new AbortController().signal);
  original.store.finishAttempt(original.claim, await result.completion);
  assert.deepEqual(original.store.runtimeConfiguration()?.configuration, configuration);
  const filename = original.store.filename;
  original.store.close();
  const store = new AdminManagementStore(filename);
  try {
    const claim = store.claimNext(store.acquireSupervisor('host')!)!;
    const second = createConfiguredAdminExecution({ store, refreshRuntime: async () => { throw new Error('SQLITE_CANTOPEN'); }, launch });
    const handle = await second(claim, () => undefined, new AbortController().signal);
    assert.equal((await handle.completion).exitConfirmed, true);
    assert.deepEqual(selected, [configuration, configuration]);
    const receipt = store.evidence(claim.repairCase.caseId).find(raw => {
      const row = raw as { attempt_id: string; receipt_key: string };
      return row.attempt_id === claim.attempt.attemptId && row.receipt_key === 'invocation-runtime';
    }) as { payload_json: string };
    assert.equal(JSON.parse(receipt.payload_json).source, 'durable-cache');
    assert.equal(store.runtimeConfiguration()?.revision, 1);
  } finally { store.close(); }
});

test('missing or invalid runtime never silently invokes a default, and known pre-launch failure supplies exit proof', async () => {
  const h = fixture();
  let launches = 0;
  const execute = createConfiguredAdminExecution({ store: h.store,
    refreshRuntime: async () => { throw new Error('Configuration DB unavailable'); },
    launch: async () => { launches++; throw new Error('Must not launch'); } });
  try {
    const handle = await execute(h.claim, () => undefined, new AbortController().signal);
    const result = await handle.completion;
    assert.equal(launches, 0);
    assert.equal(result.exitConfirmed, true);
    assert.match(result.reason, /没有可用的已配置/);
    assert.equal(h.store.finishAttempt(h.claim, result), true);
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)?.status, 'queued');
    assert.throws(() => h.store.cacheRuntimeConfiguration(h.authority, { ...configuration, apiKey: 'must-not-persist' }, 0));
    assert.throws(() => h.store.cacheRuntimeConfiguration(h.authority,
      { ...configuration, executionOptions: { model: 'model', env: { TOKEN: 'must-not-persist' } } }, 0));
    assert.equal(h.store.runtimeConfiguration(), null);
  } finally { h.store.close(); }
});

test('configuration updates reject stale refresh overwrites and stopped/stale owners', () => {
  const h = fixture();
  try {
    const first = h.store.cacheRuntimeConfiguration(h.authority, configuration, 0);
    assert.equal(first.revision, 1);
    assert.equal(h.store.cacheRuntimeConfiguration(h.authority, configuration, 1).revision, 1);
    const changed = { ...configuration, executionOptions: { model: 'new-model' } };
    assert.equal(h.store.cacheRuntimeConfiguration(h.authority, changed, 1).revision, 2);
    assert.throws(() => h.store.cacheRuntimeConfiguration(h.authority, configuration, 1), /迟到配置覆盖/);
    assert.equal(h.store.runtimeConfiguration()?.configuration.executionOptions.model, 'new-model');
    h.store.setIntent('stopped', 'stop');
    assert.throws(() => h.store.cacheRuntimeConfiguration(h.authority, configuration, 2), /运行意图/);
  } finally { h.store.close(); }
});

test('stop during an asynchronous configuration read fences child invocation; launch rejection itself remains uncertain', async () => {
  const h = fixture();
  let returned!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { returned = resolve; });
  let launches = 0;
  const execute = createConfiguredAdminExecution({ store: h.store,
    refreshRuntime: async () => { entered(); await release; return configuration; },
    launch: async () => { launches++; throw new Error('Unknown physical launch failure'); } });
  try {
    const pending = execute(h.claim, () => undefined, new AbortController().signal);
    await ready;
    h.store.setIntent('stopped', 'stop');
    returned();
    assert.equal((await (await pending).completion).exitConfirmed, true);
    assert.equal(launches, 0);
    h.store.retireStoppedAttempt(h.authority, h.claim.attempt.attemptId, true, 'never spawned');
    h.store.setIntent('running', 'restart');
    const next = h.store.claimNext(h.authority)!;
    const uncertain = createConfiguredAdminExecution({ store: h.store, refreshRuntime: async () => configuration,
      launch: async () => { throw new Error('Unknown physical launch failure'); } });
    await assert.rejects(uncertain(next, () => undefined, new AbortController().signal), /Unknown physical/);
    assert.equal(h.store.getCase(next.repairCase.caseId)?.currentAttemptId, next.attempt.attemptId);
  } finally { returned(); h.store.close(); }
});

test('repeated host failures actually select a configured alternative and preserve choices across restart', async () => {
  const h = fixture();
  let claim = h.claim;
  for (let index = 0; index < 8; index++) {
    h.store.finishAttempt(claim, { outcome: 'failed', exitConfirmed: true, reason: 'same original failure' });
    claim = h.store.claimNext(h.authority)!;
  }
  const alternative: AdminRuntimeConfiguration = { ...configuration, configurationId: 'configured-alternative',
    executorId: 'codex', executionOptions: { model: 'another-configured-model' } };
  const selected: AdminRuntimeConfiguration[] = [];
  const launch = async (runtime: AdminRuntimeConfiguration) => {
    selected.push(runtime);
    return { completion: Promise.resolve({ outcome: 'failed' as const, exitConfirmed: true, reason: 'continue independent diagnosis' }), stop: async () => true };
  };
  try {
    const execute = createConfiguredAdminExecution({ store: h.store, refreshRuntime: async () => configuration,
      refreshAlternatives: async () => [configuration, alternative], launch });
    const handle = await execute(claim, () => undefined, new AbortController().signal);
    assert.deepEqual(selected[0], alternative);
    assert.equal(h.store.recoveryDecision(claim.attempt.attemptId)?.method, 'alternate-runtime');
    assert.equal(h.store.runtimeConfiguration()?.configuration.configurationId, configuration.configurationId, 'recovery does not globally activate another Runtime');
    h.store.finishAttempt(claim, await handle.completion);
    const reopened = new AdminManagementStore(h.store.filename);
    try {
      const next = reopened.claimNext(h.authority)!;
      const resumed = createConfiguredAdminExecution({ store: reopened, refreshRuntime: async () => { throw new Error('business DB unavailable'); },
        refreshAlternatives: async () => { throw new Error('configuration catalog unavailable'); }, launch });
      await resumed(next, () => undefined, new AbortController().signal);
      assert.deepEqual(selected, [alternative, alternative]);
      assert.equal(reopened.recoveryDecision(next.attempt.attemptId)?.failedAttemptIds.length, 9);
      assert.equal(reopened.getCase(h.claim.repairCase.caseId)?.status, 'running');
    } finally { reopened.close(); }
  } finally { h.store.close(); }
});

test('user stop is preserved in history but does not consume failure-based strategy escalation', () => {
  const h = fixture();
  try {
    h.store.setIntent('stopped', 'user-stop');
    h.store.retireStoppedAttempt(h.authority, h.claim.attempt.attemptId, true, 'user requested stop');
    h.store.setIntent('running', 'user-restart');
    const next = h.store.claimNext(h.authority)!;
    assert.equal(next.attempt.generation, 2);
    assert.deepEqual(h.store.recoveryDecision(next.attempt.attemptId)?.failedAttemptIds, []);
    assert.equal(h.store.attempts(next.repairCase.caseId)[0].status, 'interrupted');
  } finally { h.store.close(); }
});

test('stop while resolving alternate configured choices prevents actual child launch', async () => {
  const h = fixture();
  let claim = h.claim;
  for (let index = 0; index < 8; index++) {
    h.store.finishAttempt(claim, { outcome: 'failed', exitConfirmed: true, reason: 'same failure' });
    claim = h.store.claimNext(h.authority)!;
  }
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let launches = 0;
  const execute = createConfiguredAdminExecution({ store: h.store, refreshRuntime: async () => configuration,
    refreshAlternatives: async () => { entered(); await pending; return [{ ...configuration, configurationId: 'alternate', executorId: 'codex' }]; },
    launch: async () => { launches++; throw new Error('Must not launch after stop'); } });
  try {
    const started = execute(claim, () => undefined, new AbortController().signal);
    await ready;
    h.store.setIntent('stopped', randomUUID());
    release();
    const result = await (await started).completion;
    assert.equal(result.exitConfirmed, true);
    assert.equal(launches, 0);
    assert.equal(h.store.runtimeAlternatives(), null, 'late catalog resolution cannot persist after user stop');
    assert.equal(h.store.control().desired_intent, 'stopped');
  } finally { release(); h.store.close(); }
});

test('a hung business configuration read uses durable configuration without waiting for late refresh', async () => {
  const h = fixture();
  let release!: (configuration: AdminRuntimeConfiguration) => void;
  const hung = new Promise<AdminRuntimeConfiguration>(resolve => { release = resolve; });
  h.store.cacheRuntimeConfiguration(h.authority, configuration, 0);
  let selected: AdminRuntimeConfiguration | undefined;
  const execute = createConfiguredAdminExecution({ store: h.store, refreshRuntime: () => hung, configurationLookupTimeoutMs: 20,
    launch: async runtime => {
      selected = runtime;
      return { completion: Promise.resolve({ outcome: 'failed' as const, reason: 'independent cached invocation', exitConfirmed: true }), stop: async () => true };
    } });
  try {
    await execute(h.claim, () => undefined, new AbortController().signal);
    assert.deepEqual(selected, configuration);
    release({ ...configuration, executionOptions: { model: 'late-overwrite' } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(h.store.runtimeConfiguration()?.configuration, configuration);
  } finally { release(configuration); h.store.close(); }
});

test('aborting a permanently hung configuration lookup supplies pre-launch exit proof promptly', async () => {
  const h = fixture();
  const cancellation = new AbortController();
  let launches = 0;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const execute = createConfiguredAdminExecution({ store: h.store, refreshRuntime: async () => {
    entered(); return new Promise<AdminRuntimeConfiguration>(() => undefined);
  }, launch: async () => { launches++; throw new Error('Cannot launch'); } });
  try {
    const pending = execute(h.claim, () => undefined, cancellation.signal);
    await ready;
    cancellation.abort();
    assert.equal((await (await pending).completion).exitConfirmed, true);
    assert.equal(launches, 0);
  } finally { h.store.close(); }
});
