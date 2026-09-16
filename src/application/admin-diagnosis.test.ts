import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { executeIndependentRepairVerification } from './independent-repair-verification';
import { createAdminController } from './admin-controller';
import type { RepairClaim } from '../domain/repair-case';

function fixture(now: () => number = Date.now) {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'diagnosis.db'), now);
  store.setIntent('running', randomUUID());
  const observation = { observationId: 'original', scope: 'runtime' as const, scopeKey: 'diagnosis-fixture', fingerprint: 'original-failure',
    sourceVersion: 'v1', origin: 'runtime' as const, summary: 'Original acceptance failed', evidence: {} };
  const repairCase = store.observe(observation);
  const authority = store.acquireSupervisor('host')!;
  const repair = store.claimNext(authority)!;
  const credential = store.issueCommandCredential(repair);
  store.commandStatus(credential);
  const submission = { outcome: 'diagnosis-requested', summary: 'Independently inspect before repair', baselineVersion: 'v1', originalObservationIds: ['original'],
    verification: { reproductionCommand: 'proposed', versionCheckCommand: 'proposed', acceptanceChecks: [{ targetRef: 'original-target', command: 'proposed', expected: 'original behavior' }] } };
  assert.throws(() => store.commandSubmit(credential, { ...submission, originalObservationIds: ['fabricated'] }), /原始故障不存在/);
  store.commandSubmit(credential, submission);
  store.finishAttempt(repair, { outcome: 'diagnosis-requested', exitConfirmed: true, reason: submission.summary });
  const plan = { sourceRepairAttemptId: repair.attempt.attemptId, expectedVersion: 'v1', originalObservationIds: ['original'], versionCommand: 'actual-version',
    reproduction: { targetRef: 'original', command: 'actual-reproduction' }, acceptanceChecks: [{ targetRef: 'original-target', command: 'actual-acceptance' }] };
  return { store, observation, authority, repairCase, plan };
}

async function save(h: ReturnType<typeof fixture>, claim: RepairClaim, allPassed = false) {
  h.store.recordVerificationPlan(claim, h.plan);
  const receipt = await executeIndependentRepairVerification(h.plan, { signal: new AbortController().signal, continueOnCheckFailure: true,
    persist: async (key, payload) => { h.store.recordEvidence(claim, key, key === 'verification-plan' ? 'verification-plan' : 'verification-check', payload); },
    run: async command => ({ exitCode: command === 'actual-version' || allPassed ? 0 : 1,
      stdout: command === 'actual-version' ? 'v1' : '', stderr: '', exitConfirmed: true }),
  });
  h.store.recordVerificationReceipt(claim, receipt);
  return receipt;
}

test('even all-pass diagnosis cannot authorize business handoff or Case closure', async () => {
  const h = fixture();
  const external = new Database(h.store.filename);
  try {
    const claim = h.store.claimVerification(h.authority)!;
    assert.throws(() => h.store.recordVerificationPlan(claim, { ...h.plan, expectedVersion: 'fake-v2' }), /版本或原始失败/);
    assert.equal((await save(h, claim, true)).passed, true);
    h.store.finishVerification(claim, true);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    external.prepare('DELETE FROM repair_verification_purposes WHERE attempt_id = ?').run(claim.attempt.attemptId);
    assert.equal(h.store.verificationPurpose(claim.attempt.attemptId), 'diagnosis', 'missing metadata cannot upgrade a persisted diagnostic request');
    // A stale display/state projection must not upgrade diagnostic authority.
    external.prepare("UPDATE repair_cases SET status = 'observing' WHERE case_id = ?").run(h.repairCase.caseId);
    assert.throws(() => h.store.verifiedContext(h.authority, h.repairCase.caseId), /独立验证/);
    assert.throws(() => h.store.closeObservedCase(h.authority, h.repairCase.caseId, () => { throw new Error('must not read business'); }), /独立验证/);
  } finally { external.close(); h.store.close(); }
});

test('saved diagnosis recovers after host death before a new investigation without repeating independent commands', async () => {
  let now = 100_000;
  const h = fixture(() => now);
  const claim = h.store.claimVerification(h.authority)!;
  await save(h, claim);
  const filename = h.store.filename;
  h.store.close();
  now += 31_000;
  const store = new AdminManagementStore(filename, () => now);
  let stopped = false;
  let investigations = 0;
  let diagnostics = 0;
  const controller = createAdminController({ store, ownerId: 'restored-host', confirmStopped: async () => stopped,
    launch: async () => { investigations++; return { completion: new Promise(() => undefined), stop: async () => true }; },
    launchVerification: async () => { diagnostics++; throw new Error('must use saved diagnosis'); },
  });
  try {
    await controller.reconcile();
    assert.equal(investigations, 0);
    assert.equal(store.getCase(h.repairCase.caseId)?.status, 'verifying');
    stopped = true;
    await controller.reconcile();
    assert.equal(diagnostics, 0);
    assert.equal(investigations, 1);
    assert.equal(store.attempts(h.repairCase.caseId).find(attempt => attempt.attemptId === claim.attempt.attemptId)?.status, 'completed');
    assert.equal(store.diagnosisHistory(h.repairCase.caseId).length, 1);
    assert.equal(store.diagnosisHistory(h.repairCase.caseId)[0].novel, 1);
    assert.equal(store.getCase(h.repairCase.caseId)?.status, 'running', 'new investigation, never observing/closed');
  } finally { await controller.shutdown(); store.close(); }
});

test('new original-fault facts invalidate saved diagnosis before its completion can be applied', async () => {
  const h = fixture();
  try {
    const claim = h.store.claimVerification(h.authority)!;
    await save(h, claim, true);
    h.store.observe({ ...h.observation, observationId: 'new-original-fact', summary: 'Original failure recurred' });
    assert.equal(h.store.finishVerification(claim, true), false);
    assert.equal(h.store.recoverStoppedSubmission(h.authority, claim.attempt.attemptId, true), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal(h.store.diagnosisHistory(h.repairCase.caseId)[0].novel, null);
    assert.equal(h.store.verificationReceipt(claim.attempt.attemptId)?.passed, true, 'historical receipt retained, not applied');
  } finally { h.store.close(); }
});

test('reordering the same diagnosed acceptance results cannot manufacture progress', async () => {
  const h = fixture();
  try {
    h.plan.acceptanceChecks.push({ targetRef: 'other-original-target', command: 'actual-other-acceptance' });
    const first = h.store.claimVerification(h.authority)!;
    await save(h, first);
    h.store.finishVerification(first, true);
    const repair = h.store.claimNext(h.authority)!;
    const credential = h.store.issueCommandCredential(repair);
    h.store.commandStatus(credential);
    h.store.commandSubmit(credential, { outcome: 'diagnosis-requested', summary: 'Check same original targets', baselineVersion: 'v1', originalObservationIds: ['original'],
      verification: { reproductionCommand: 'suggested', versionCheckCommand: 'suggested', acceptanceChecks: [{ targetRef: 'original-target', command: 'suggested', expected: 'original behavior' }] } });
    h.store.finishAttempt(repair, { outcome: 'diagnosis-requested', exitConfirmed: true, reason: 'Check same targets' });
    h.plan.sourceRepairAttemptId = repair.attempt.attemptId;
    h.plan.acceptanceChecks.reverse();
    const second = h.store.claimVerification(h.authority)!;
    await save(h, second);
    h.store.finishVerification(second, true);
    assert.deepEqual(h.store.diagnosisHistory(h.repairCase.caseId).map(row => row.novel), [1, 0]);
  } finally { h.store.close(); }
});

test('external waiting requires the latest failed independent diagnosis and automatically becomes eligible after cooldown', async () => {
  let now = 100_000;
  const h = fixture(() => now);
  try {
    const premature = h.store.claimVerification(h.authority)!;
    await save(h, premature);
    h.store.finishVerification(premature, true);
    const admin = h.store.claimNext(h.authority)!;
    const credential = h.store.issueCommandCredential(admin);
    h.store.commandStatus(credential);
    const request = { outcome: 'external-wait-requested', summary: 'Actual dependency probe is unavailable',
      dependency: 'fixture-provider', diagnosisAttemptId: premature.attempt.attemptId, baselineVersion: 'v1',
      originalObservationIds: ['original'], evidenceKey: 'external-finding', retryAfterMs: 30_000 } as const;
    assert.throws(() => h.store.commandSubmit(credential, request), /finding/);
    h.store.commandRecordEvidence(credential, 'external-finding', 'finding', { dependency: 'fixture-provider',
      diagnosisAttemptId: premature.attempt.attemptId, result: 'probe failed outside managed workspace' });
    assert.throws(() => h.store.commandSubmit(credential, { ...request, diagnosisAttemptId: 'invented' }), /最近完成/);
    assert.throws(() => h.store.commandSubmit(credential, { ...request, baselineVersion: 'invented' }), /实际版本/);
    h.store.commandSubmit(credential, request);
    h.store.finishAttempt(admin, { outcome: 'external-wait-requested', exitConfirmed: true, reason: request.summary });
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'external-wait');
    assert.equal(h.store.getCase(h.repairCase.caseId)?.nextProbeAt, 130_000);
    assert.equal(h.store.claimScheduled(h.authority, true), null, 'cooldown is durable scheduler state, not an in-memory timer');
    const filename = h.store.filename;
    h.store.close();
    now = 129_999;
    const reopened = new AdminManagementStore(filename, () => now);
    try {
      assert.equal(reopened.claimScheduled(h.authority, true), null);
      now = 130_000;
      const restoredAuthority = reopened.acquireSupervisor('host')!;
      const probe = reopened.claimScheduled(restoredAuthority, true)!;
      assert.equal(probe.repairCase.caseId, h.repairCase.caseId);
      assert.equal(probe.attempt.role, 'investigation');
      assert.equal(reopened.getCase(h.repairCase.caseId)?.status, 'running');
      assert.equal(reopened.getCase(h.repairCase.caseId)?.nextProbeAt, null);
    } finally { reopened.close(); }
  } finally {
    try { h.store.close(); } catch { /* fixture may already be closed for restart proof */ }
  }
});

test('an all-pass diagnosis cannot be relabeled as a hard external failure', async () => {
  const h = fixture();
  try {
    const diagnosis = h.store.claimVerification(h.authority)!;
    await save(h, diagnosis, true);
    h.store.finishVerification(diagnosis, true);
    const admin = h.store.claimNext(h.authority)!;
    const credential = h.store.issueCommandCredential(admin);
    h.store.commandStatus(credential);
    h.store.commandRecordEvidence(credential, 'external-finding', 'finding', { dependency: 'fixture-provider' });
    assert.throws(() => h.store.commandSubmit(credential, { outcome: 'external-wait-requested', summary: 'False outage claim',
      dependency: 'fixture-provider', diagnosisAttemptId: diagnosis.attempt.attemptId, baselineVersion: 'v1',
      originalObservationIds: ['original'], evidenceKey: 'external-finding', retryAfterMs: 30_000 }), /没有证明/);
  } finally { h.store.close(); }
});
