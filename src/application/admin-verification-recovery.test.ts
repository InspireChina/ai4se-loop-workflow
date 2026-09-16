import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createAdminController } from './admin-controller';
import { executeIndependentRepairVerification } from './independent-repair-verification';
import { repairVerificationReceiptSchema, type RepairVerificationPlan } from '../domain/repair-verification';
import type { RepairClaim } from '../domain/repair-case';

function fixture(now: () => number = Date.now) {
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'verification-recovery.db');
  const store = new AdminManagementStore(filename, now);
  store.setIntent('running', randomUUID());
  const repairCase = store.observe({ observationId: 'original-failure', scope: 'runtime', scopeKey: 'installed-runtime',
    fingerprint: 'acceptance-missing', sourceVersion: 'broken-v1', summary: 'original acceptance failed', evidence: {}, origin: 'runtime' });
  const authority = store.acquireSupervisor('host')!;
  const repair = store.claimNext(authority)!;
  const credential = store.issueCommandCredential(repair);
  store.commandStatus(credential);
  store.commandRecordEvidence(credential, 'actual-change', 'change', { changedFile: 'feature.ts' });
  store.commandSubmit(credential, { outcome: 'verification-requested', summary: 'feature implemented', repairVersion: 'fixed-v2',
    originalObservationIds: ['original-failure'], repairEvidenceKeys: ['actual-change'],
    verification: { reproductionCommand: 'untrusted proposal', versionCheckCommand: 'untrusted echo',
      acceptanceChecks: [{ targetRef: 'untrusted-target', command: 'echo success', expected: 'success' }] } });
  store.finishAttempt(repair, { outcome: 'verification-requested', reason: 'feature implemented', exitConfirmed: true });
  const plan: RepairVerificationPlan = { sourceRepairAttemptId: repair.attempt.attemptId, expectedVersion: 'fixed-v2',
    originalObservationIds: ['original-failure'], versionCommand: 'host-read-actual-version',
    reproduction: { targetRef: 'original-failure', command: 'host-original-reproduction' },
    acceptanceChecks: [{ targetRef: 'original-acceptance', command: 'host-original-acceptance' }] };
  return { store, filename, authority, repair, repairCase, plan };
}

async function saveVerification(store: AdminManagementStore, claim: RepairClaim, plan: RepairVerificationPlan, failed = false) {
  store.recordVerificationPlan(claim, plan);
  const receipt = await executeIndependentRepairVerification(plan, {
    signal: new AbortController().signal,
    run: async command => ({ exitCode: failed && command === 'host-original-acceptance' ? 1 : 0,
      stdout: command === plan.versionCommand ? plan.expectedVersion : '', stderr: failed ? 'original failure' : '', exitConfirmed: true }),
    persist: async (key, payload) => { store.recordEvidence(claim, key, key === 'verification-plan' ? 'verification-plan' : 'verification-check', payload); },
  });
  store.recordVerificationReceipt(claim, receipt);
  return receipt;
}

test('independent receipt rejects changed sources, missing check evidence and fabricated exit-zero pass', async () => {
  const h = fixture();
  try {
    assert.throws(() => h.store.recordVerificationPlan(h.repair, h.plan), /已失效/);
    const verification = h.store.claimVerification(h.authority)!;
    assert.throws(() => h.store.recordVerificationPlan(verification, { ...h.plan, sourceRepairAttemptId: 'another-repair' }), /未绑定最近/);
    assert.throws(() => h.store.recordVerificationPlan(verification, { ...h.plan, expectedVersion: 'invented-version' }), /版本或原始失败/);
    assert.throws(() => h.store.recordVerificationPlan(verification, { ...h.plan, originalObservationIds: ['invented-target'] }), /版本或原始失败/);
    h.store.recordVerificationPlan(verification, h.plan);
    assert.throws(() => h.store.recordVerificationPlan(verification, { ...h.plan, versionCommand: 'echo fake' }), /不能改写/);
    const receipt = await executeIndependentRepairVerification(h.plan, { signal: new AbortController().signal,
      run: async command => ({ exitCode: 0, stdout: command === h.plan.versionCommand ? 'fixed-v2' : '', stderr: '', exitConfirmed: true }),
      persist: async () => undefined });
    assert.throws(() => h.store.recordVerificationReceipt(verification, receipt), /缺少对应/);
    assert.equal(h.store.finishVerification(verification, true), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'verifying');
    assert.equal(repairVerificationReceiptSchema.safeParse({ ...receipt, checks: [] }).success, false);
    assert.equal(repairVerificationReceiptSchema.safeParse({ ...receipt, checks: receipt.checks.map(check => ({ ...check, command: 'echo pass' })) }).success, false);
    assert.equal(repairVerificationReceiptSchema.safeParse({ ...receipt, checks: receipt.checks.map(check => ({ ...check, result: { ...check.result, exitConfirmed: false } })) }).success, false);
    assert.equal(h.store.observations(h.repairCase.caseId).length, 1);
  } finally { h.store.close(); }
});

test('Controller starts verification outside repair launch and only enters observing after durable evidence and confirmed exit', async () => {
  const h = fixture();
  let verifierLaunches = 0;
  const controller = createAdminController({ store: h.store, ownerId: 'host', confirmStopped: async () => true,
    launch: async () => { throw new Error('must not rerun repair'); },
    launchVerification: async claim => {
      verifierLaunches++;
      assert.equal(claim.attempt.role, 'verification');
      const receipt = await saveVerification(h.store, claim, h.plan);
      return { completion: Promise.resolve({ outcome: 'verified', reason: receipt.reason, exitConfirmed: true }), stop: async () => true };
    },
  });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    assert.equal(verifierLaunches, 1);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing', 'verified is not closed or business-completed');
    assert.equal(h.store.getCase(h.repairCase.caseId)?.originalVersion, 'broken-v1');
    assert.equal(h.store.attempts(h.repairCase.caseId)[1].status, 'completed');
    assert.equal(await controller.reconcile(), 'idle');
  } finally { await controller.shutdown(); h.store.close(); }
});

test('saved verification survives host death and is recovered before any duplicate command or repair invocation', async () => {
  let now = 100_000;
  const h = fixture(() => now);
  const verification = h.store.claimVerification(h.authority)!;
  const receipt = await saveVerification(h.store, verification, h.plan);
  assert.equal(h.store.recordVerificationReceipt(verification, receipt), false, 'duplicate receipt is idempotent');
  assert.throws(() => h.store.recordVerificationReceipt(verification, { ...receipt, reason: 'overwrite original proof' }), /不能改写/);
  assert.equal(h.store.finishVerification(verification, false), false);
  h.store.close();
  now += 31_000;
  const reopened = new AdminManagementStore(h.filename, () => now);
  let confirmed = false;
  let launches = 0;
  const unexpectedLaunch = async () => { launches++; throw new Error('must recover saved receipt'); };
  const controller = createAdminController({ store: reopened, ownerId: 'next-host', confirmStopped: async () => confirmed,
    launch: unexpectedLaunch, launchVerification: unexpectedLaunch });
  try {
    assert.equal(await controller.reconcile(), 'idle');
    assert.equal(reopened.getCase(h.repairCase.caseId)?.status, 'verifying');
    assert.equal(reopened.getCase(h.repairCase.caseId)?.currentAttemptId, verification.attempt.attemptId);
    confirmed = true;
    assert.equal(await controller.reconcile(), 'idle');
    assert.equal(launches, 0);
    assert.equal(reopened.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.deepEqual(reopened.verificationReceipt(verification.attempt.attemptId), receipt);
    assert.equal(reopened.attempts(h.repairCase.caseId).length, 2);
  } finally { await controller.shutdown(); reopened.close(); }
});

test('failed verification keeps original Case and evidence and returns to automatic repair rather than human', async () => {
  const h = fixture();
  try {
    const verification = h.store.claimVerification(h.authority)!;
    const receipt = await saveVerification(h.store, verification, h.plan, true);
    assert.equal(receipt.passed, false);
    assert.equal(h.store.finishVerification(verification, true), true);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.match(h.store.getCase(h.repairCase.caseId)?.lastError || '', /验收|acceptance/);
    assert.equal(h.store.claimNext(h.authority)?.repairCase.caseId, h.repairCase.caseId);
    assert.equal(h.store.verificationReceipt(verification.attempt.attemptId)?.passed, false);
  } finally { h.store.close(); }
});

test('stopped intent fences late verification and replayed saved success cannot resume business', async () => {
  const h = fixture();
  try {
    const verification = h.store.claimVerification(h.authority)!;
    await saveVerification(h.store, verification, h.plan);
    h.store.setIntent('stopped', randomUUID());
    assert.throws(() => h.store.finishVerification(verification, true), /运行意图/);
    assert.throws(() => h.store.recoverStoppedSubmission(h.authority, verification.attempt.attemptId, true), /运行意图/);
    h.store.retireStoppedAttempt(h.authority, verification.attempt.attemptId, true, 'user stop');
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'verifying');
    assert.equal(h.store.attempts(h.repairCase.caseId)[1].status, 'interrupted');
    assert.equal(h.store.verificationReceipt(verification.attempt.attemptId)?.passed, true, 'retain historical proof, do not apply it under a newer intent');
  } finally { h.store.close(); }
});

test('a verifier summary with no durable receipt cannot advance the Case', async () => {
  const h = fixture();
  const controller = createAdminController({ store: h.store, ownerId: 'host', confirmStopped: async () => true,
    launch: async () => { throw new Error('unexpected repair launch'); },
    launchVerification: async () => ({ completion: Promise.resolve({ outcome: 'verified', reason: 'trust my summary', exitConfirmed: true }), stop: async () => true }),
  });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'verifying');
    assert.equal(h.store.attempts(h.repairCase.caseId)[1].status, 'interrupted');
    assert.equal(h.store.verificationReceipt(h.store.attempts(h.repairCase.caseId)[1].attemptId), null);
  } finally { await controller.shutdown(); h.store.close(); }
});

test('evidence property ordering does not discard real independent command receipts', async () => {
  const h = fixture();
  try {
    const claim = h.store.claimVerification(h.authority)!;
    h.store.recordVerificationPlan(claim, h.plan);
    const receipt = await executeIndependentRepairVerification(h.plan, {
      signal: new AbortController().signal,
      run: async command => ({ stdout: command === h.plan.versionCommand ? 'fixed-v2' : '', exitConfirmed: true, stderr: '', exitCode: 0 }),
      persist: async (key, payload) => { h.store.recordEvidence(claim, key, key === 'verification-plan' ? 'verification-plan' : 'verification-check', payload); },
    });
    assert.equal(h.store.recordVerificationReceipt(claim, receipt), true);
    assert.equal(h.store.finishVerification(claim, true), true);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
  } finally { h.store.close(); }
});

test('new fault facts invalidate saved verification and observing authority without losing history or physical fences', async () => {
  for (const phase of ['verifying', 'observing'] as const) {
    const h = fixture();
    try {
      const claim = h.store.claimVerification(h.authority)!;
      await saveVerification(h.store, claim, h.plan);
      if (phase === 'observing') h.store.finishVerification(claim, true);
      h.store.observe({ observationId: `new-${phase}-failure`, scope: 'runtime', scopeKey: 'installed-runtime',
        fingerprint: 'acceptance-missing', sourceVersion: 'fixed-v2', summary: 'Same original behavior failed again', evidence: {}, origin: 'runtime' });
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
      assert.throws(() => h.store.verifiedContext(h.authority, h.repairCase.caseId), /当前代次独立验证/);
      if (phase === 'verifying') {
        assert.equal(h.store.finishVerification(claim, true), false);
        assert.equal(h.store.recoverStoppedSubmission(h.authority, claim.attempt.attemptId, true), false);
        assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, claim.attempt.attemptId);
        h.store.retireStoppedAttempt(h.authority, claim.attempt.attemptId, true, 'old proof invalidated by fresh failure');
      }
      assert.equal(h.store.claimNext(h.authority)?.attempt.role, 'investigation');
      assert.equal(h.store.observations(h.repairCase.caseId).length, 2);
      assert.equal(h.store.verificationReceipt(claim.attempt.attemptId)?.passed, true, 'retain the original success as historical, not current authority');
    } finally { h.store.close(); }
  }
});
