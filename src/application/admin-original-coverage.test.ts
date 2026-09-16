import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { executeIndependentRepairVerification } from './independent-repair-verification';
import { createAdminHandoffs } from './admin-handoff';
import { authorizePreparedVerification, originalVerificationTargets } from '../domain/independent-verification-preparation';

function fixture(count = 2) {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'coverage.db'));
  const observation = (id: string) => ({ observationId: id, scope: 'work-item' as const, scopeKey: 'task:work', fingerprint: 'original-missing',
    sourceVersion: 'v1', origin: 'business' as const, summary: 'Original implementation missing',
    evidence: { taskId: 'task', item: { item_id: 'item', revision: 1, dispatch_epoch: 1 }, originalContract: {
      requirement: { description: 'Original actual acceptance' }, acceptances: [{ acceptance_key: 'original', oracle: 'Actual expected result' }] } } });
  const ids = Array.from({ length: count }, (_, index) => `original-${index}`);
  const repairCase = store.observe(observation(ids[0]));
  for (const id of ids.slice(1)) store.observe(observation(id));
  store.setIntent('running', 'start');
  const authority = store.acquireSupervisor('coverage-host')!;
  const repair = store.claimNext(authority)!;
  const credential = store.issueCommandCredential(repair);
  store.commandStatus(credential);
  store.commandRequestAction(credential, 'owned', { kind: 'workspace-takeover', itemId: 'item', itemRevision: 1, reason: 'Actual repair' });
  const workspaceRoot = join(process.env.LOOP_DATA_ROOT!, 'controlled-coverage-workspace');
  store.recordCommandActionResult(repair, 'owned', 'completed', { phase: 'owned', workspaceRoot,
    anchor: { taskId: 'task', itemId: 'item', itemRevision: 1, itemEpoch: 1, workspaceRoot } });
  store.commandRecordEvidence(credential, 'change', 'change', { actualFixtureChange: true });
  const verification = { reproductionCommand: 'suggestion-not-authority', versionCheckCommand: 'suggestion-not-authority',
    acceptanceChecks: [{ targetRef: 'original', command: 'suggestion-not-authority', expected: 'Original observable result' }] };
  const submission = { outcome: 'verification-requested' as const, summary: 'Repair original failure', repairVersion: 'v2',
    originalObservationIds: ids, repairEvidenceKeys: ['change'], verification };
  const start = () => {
    store.commandSubmit(credential, submission);
    store.finishAttempt(repair, { outcome: 'verification-requested', reason: submission.summary, exitConfirmed: true });
    const claim = store.claimVerification(authority)!;
    const input = store.independentVerificationInput(claim);
    const plan = authorizePreparedVerification(input, { reproduction: { targetRef: 'original-failures', command: 'actual-original-check' },
      acceptanceChecks: originalVerificationTargets(input).map(target => ({ targetRef: target.targetRef, command: 'actual-acceptance-check' })) }, 'actual-version-check');
    store.recordVerificationPlan(claim, plan);
    return { claim, plan };
  };
  const legacyInsert = (id: string) => {
    const value = observation(id); const json = JSON.stringify(value);
    const connection = new Database(store.filename);
    try { connection.prepare(`INSERT INTO repair_observations
      (observation_id,case_id,origin,source_version,summary,evidence_json,observation_hash,observation_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, repairCase.caseId, value.origin, value.sourceVersion, value.summary,
        JSON.stringify(value.evidence), createHash('sha256').update(json).digest('hex'), json, Date.now()); }
    finally { connection.close(); }
  };
  return { store, observation, ids, repairCase, repair, credential, authority, submission, verification, start, legacyInsert };
}

async function save(h: ReturnType<typeof fixture>, started: ReturnType<ReturnType<typeof fixture>['start']>) {
  const receipt = await executeIndependentRepairVerification(started.plan, { signal: new AbortController().signal,
    run: async command => ({ exitCode: 0, stdout: command === 'actual-version-check' ? 'v2' : '', stderr: '', exitConfirmed: true }),
    persist: async (key, payload) => { h.store.recordEvidence(started.claim, key, key === 'verification-plan' ? 'verification-plan' : 'verification-check', payload); } });
  h.store.recordVerificationReceipt(started.claim, receipt);
  return receipt;
}

test('repair verification cannot cherry-pick originals or duplicate IDs, and more than one hundred originals remain complete', () => {
  const h = fixture(101);
  try {
    const coverage = h.store.commandStatus(h.credential).requiredOriginalCoverage;
    assert.equal(coverage.count, 101); assert.equal(coverage.observationIds.length, 16); assert.equal(coverage.hasMore, true);
    assert.throws(() => h.store.commandSubmit(h.credential, { ...h.submission, originalObservationIds: h.ids.slice(0, -1) }), /遗漏 1 条.*original-100/);
    assert.throws(() => h.store.commandSubmit(h.credential, { ...h.submission, originalObservationIds: [h.ids[0], h.ids[0]] }), /引用不能重复/);
    const { plan } = h.start();
    assert.equal(plan.originalObservationIds.length, 101); assert.equal(plan.acceptanceChecks.length, 202);
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
  } finally { h.store.close(); }
});

test('focused diagnosis may select a subset but its passed checks never grant repair verification or handback', async () => {
  const h = fixture(2);
  try {
    h.store.commandSubmit(h.credential, { outcome: 'diagnosis-requested', summary: 'Focus on one original cause', baselineVersion: 'v2',
      originalObservationIds: [h.ids[0]], verification: h.verification });
    h.store.finishAttempt(h.repair, { outcome: 'diagnosis-requested', reason: 'Focused diagnosis', exitConfirmed: true });
    const claim = h.store.claimVerification(h.authority)!; const input = h.store.independentVerificationInput(claim);
    const plan = authorizePreparedVerification(input, { reproduction: { targetRef: 'original-failures', command: 'actual-focused-check' },
      acceptanceChecks: originalVerificationTargets(input).map(target => ({ targetRef: target.targetRef, command: 'actual-focused-check' })) }, 'actual-version-check');
    h.store.recordVerificationPlan(claim, plan); await save(h, { claim, plan });
    h.store.finishVerification(claim, true);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.throws(() => h.store.verifiedContext(h.authority, h.repairCase.caseId));
    assert.equal(h.store.observations(h.repairCase.caseId).length, 2);
  } finally { h.store.close(); }
});

test('a newly observed original after immutable repair submission rejects settlement only after actual exit', () => {
  const h = fixture(1);
  try {
    h.store.commandSubmit(h.credential, h.submission);
    h.store.observe(h.observation('original-arrived-late'));
    assert.equal(h.store.finishAttempt(h.repair, { outcome: 'verification-requested', reason: 'Old immutable submission', exitConfirmed: false }), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, h.repair.attempt.attemptId);
    h.store.finishAttempt(h.repair, { outcome: 'verification-requested', reason: 'Old immutable submission', exitConfirmed: true });
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal(h.store.attempts(h.repairCase.caseId)[0].status, 'failed');
    assert.match(h.store.getCase(h.repairCase.caseId)?.lastError || '', /original-arrived-late/);
    assert.throws(() => h.store.readCommandSubmission(h.repair), /代次或执行来源已失效/);
    const connection = new Database(h.store.filename, { readonly: true });
    try {
      const saved = connection.prepare('SELECT submission_json FROM admin_command_sessions WHERE attempt_id=?')
        .get(h.repair.attempt.attemptId) as { submission_json: string };
      assert.deepEqual(JSON.parse(saved.submission_json), h.submission, 'immutable old submission is preserved');
    } finally { connection.close(); }
  } finally { h.store.close(); }
});

test('legacy saved partial verification is retained but rejected after physical exit instead of recovered as pass', async () => {
  const h = fixture(1);
  try {
    const started = h.start(); const receipt = await save(h, started); h.legacyInsert('original-legacy-omitted');
    assert.equal(h.store.finishVerification(started.claim, false), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, started.claim.attempt.attemptId);
    assert.equal(h.store.finishVerification(started.claim, true), true);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal(h.store.attempts(h.repairCase.caseId)[1].status, 'failed');
    assert.deepEqual(h.store.verificationReceipt(started.claim.attempt.attemptId), receipt, 'old receipt is not rewritten');
    assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
  } finally { h.store.close(); }
});

test('legacy observing partial pass is re-opened before any business handoff, with an excluded derived invalidation fact', async () => {
  const h = fixture(1);
  try {
    const started = h.start(); await save(h, started); h.store.finishVerification(started.claim, true);
    h.legacyInsert('original-legacy-omitted');
    let handoffs = 0;
    await createAdminHandoffs({ store: h.store, handoff: async () => { handoffs++; throw new Error('Partial pass cannot hand back'); } })(h.authority);
    assert.equal(handoffs, 0); assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal(h.store.observations(h.repairCase.caseId).length, 3);
    const repair = h.store.claimNext(h.authority)!; const credential = h.store.issueCommandCredential(repair);
    assert.equal(h.store.commandStatus(credential).requiredOriginalCoverage.count, 2, 'derived invalidation does not invent a third acceptance');
    assert.equal(h.store.verificationReceipt(started.claim.attempt.attemptId)?.passed, true);
  } finally { h.store.close(); }
});

test('derived runtime invalidation and Admin failures are not substitute targets, but business originals cannot hide in that namespace', () => {
  const h = fixture(2);
  try {
    h.store.observe({ ...h.observation('runtime-derived'), origin: 'runtime', evidence: { kind: 'repair-version-changed' } });
    h.store.observe({ ...h.observation('admin-own-failure'), origin: 'admin', repairCaseId: h.repairCase.caseId, evidence: {} });
    assert.equal(h.store.commandStatus(h.credential).requiredOriginalCoverage.count, 2);
    h.store.observe({ ...h.observation('business-original'), evidence: { ...h.observation('business-original').evidence, kind: 'repair-version-changed' } });
    assert.equal(h.store.commandStatus(h.credential).requiredOriginalCoverage.count, 3);
    assert.throws(() => h.store.commandSubmit(h.credential, h.submission), /遗漏 1 条.*business-original/);
    h.store.commandSubmit(h.credential, { ...h.submission, originalObservationIds: [...h.ids, 'business-original'] });
  } finally { h.store.close(); }
});

test('legacy saved preparation missing an original cannot recover as authorized checks after physical settlement', () => {
  const h = fixture(1);
  try {
    const started = h.start();
    h.store.recordVerificationPreparation(started.claim, h.store.independentVerificationInput(started.claim), started.plan,
      { directory: 'trusted-host-fixture-only', entries: [] });
    h.legacyInsert('original-legacy-preparation-omitted');
    assert.equal(h.store.finishVerificationPreparation(started.claim, false), false);
    assert.equal(h.store.finishVerificationPreparation(started.claim, true), true);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal(h.store.attempts(h.repairCase.caseId)[1].status, 'failed');
    assert.equal(h.store.verificationReceipt(started.claim.attempt.attemptId), null);
  } finally { h.store.close(); }
});

test('host loss recovery rejects a late original omitted by the saved immutable repair submission', () => {
  const h = fixture(1);
  try {
    h.store.commandSubmit(h.credential, h.submission);
    h.store.observe(h.observation('original-after-save-before-host-loss'));
    assert.equal(h.store.recoverStoppedSubmission(h.authority, h.repair.attempt.attemptId, false), false);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, h.repair.attempt.attemptId);
    assert.equal(h.store.recoverStoppedSubmission(h.authority, h.repair.attempt.attemptId, true), true);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
    assert.equal(h.store.attempts(h.repairCase.caseId)[0].status, 'failed');
  } finally { h.store.close(); }
});
