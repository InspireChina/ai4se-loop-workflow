import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { runAdminCommand } from './admin-command';
import { createAdminController } from './admin-controller';

function fixture(now: () => number = Date.now) {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db'), now);
  store.setIntent('running', randomUUID());
  const observationId = randomUUID();
  store.observe({ observationId, scope: 'runtime', scopeKey: 'server', fingerprint: 'old-version', origin: 'runtime',
    sourceVersion: 'v1', summary: 'Test reached an old server', evidence: { actualVersion: 'v0' } });
  const claim = store.claimNext(store.acquireSupervisor('host')!)!;
  const credential = store.issueCommandCredential(claim);
  const submission = {
    outcome: 'verification-requested', summary: 'Service corrected; request original verification', repairVersion: 'v1',
    originalObservationIds: [observationId], repairEvidenceKeys: ['service-restart'],
    verification: {
      reproductionCommand: 'curl http://localhost:1234/original-failing-route', versionCheckCommand: 'curl http://localhost:1234/version',
      acceptanceChecks: [{ targetRef: 'original-route', command: 'node original-test.mjs', expected: 'original assertion passes' }],
    },
  };
  const status = () => runAdminCommand(store, credential, ['status']);
  const record = () => runAdminCommand(store, credential, ['evidence', 'record', '--key', 'service-restart', '--kind', 'action', '--payload', JSON.stringify({ command: 'restart correct service', actualVersion: 'v1' })]);
  const submit = (value: unknown = submission) => runAdminCommand(store, credential, ['submit', '--result', JSON.stringify(value)]);
  return { store, claim, credential, submission, status, record, submit };
}

test('Admin command requires current scoped credentials, status first, and immutable evidence before a verification request', () => {
  const h = fixture();
  try {
    assert.throws(h.record, /先读取 status/);
    assert.throws(h.submit, /先读取 status/);
    assert.throws(() => runAdminCommand(h.store, { ...h.credential, token: '0'.repeat(64) }, ['status']), /凭证无效/);
    assert.throws(() => runAdminCommand(h.store, { ...h.credential, caseId: 'foreign-case' }, ['status']), /凭证无效/);
    const status = h.status();
    assert.equal(status.includes(h.credential.token), false);
    assert.match(status, /Test reached an old server/);
    assert.throws(h.submit, /修复动作或变更证据/);
    assert.match(h.record(), /Outcome: recorded/);
    assert.match(h.submit(), /Outcome: submitted/);
    assert.match(h.submit(), /Outcome: already-submitted/);
    assert.throws(h.record, /已终止提交/);
    assert.throws(() => h.submit({ ...h.submission, summary: 'Overwrite submitted result' }), /不能改写/);
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)?.status, 'running', 'submission alone cannot settle a still-running process');
    assert.deepEqual(h.store.readCommandSubmission(h.claim), h.submission);
  } finally { h.store.close(); }
});

test('Admin cannot fabricate original fault references, use another attempt evidence, or issue completion commands', () => {
  const h = fixture();
  try {
    h.status();
    h.record();
    assert.throws(() => h.submit({ ...h.submission, originalObservationIds: ['fake-fault'] }), /原始故障不存在/);
    assert.throws(() => h.submit({ ...h.submission, repairEvidenceKeys: ['historical-action'] }), /本轮/);
    assert.throws(() => runAdminCommand(h.store, h.credential, ['complete', 'dev']), /不能直接完成/);
    assert.throws(() => h.submit({ outcome: 'completed', summary: 'Dev and Test are done' }), /Invalid discriminator/);
    assert.throws(() => h.store.issueCommandCredential(h.claim), /不能重复签发/);
  } finally { h.store.close(); }
});

test('stop and ownership expiry invalidate all existing Admin commands and prevent late submission', () => {
  let now = Date.now();
  const h = fixture(() => now);
  try {
    h.status();
    h.record();
    now += 31_000;
    assert.throws(h.submit, /监督权/);
    h.store.acquireSupervisor('new-host');
    assert.throws(h.status, /监督权/);
    h.store.setIntent('stopped', randomUUID());
    assert.throws(h.record, /监督权|运行意图/);
  } finally { h.store.close(); }
});

test('Controller recovers a submitted Admin result after a host crash only once physical exit is confirmed', async () => {
  let now = Date.now();
  const h = fixture(() => now);
  h.status(); h.record(); h.submit();
  now += 31_000;
  let confirmed = false;
  let launches = 0;
  const controller = createAdminController({
    store: h.store, ownerId: 'new-host', confirmStopped: async () => confirmed,
    launch: async () => { launches += 1; throw new Error('Saved result recovery must not restart Admin'); },
  });
  try {
    await controller.reconcile();
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)?.status, 'running');
    confirmed = true;
    await controller.reconcile();
    assert.equal(launches, 0);
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)?.status, 'verifying');
    assert.equal(h.store.attempts(h.claim.repairCase.caseId).length, 1);
    await controller.reconcile();
    assert.equal(launches, 0);
  } finally { await controller.shutdown(); h.store.close(); }
});
