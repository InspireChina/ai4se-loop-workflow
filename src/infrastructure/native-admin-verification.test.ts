import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { AdminManagementStore } from './admin-management-store';
import { createNativeAdminVerification } from './native-admin-verification';
import { adminCommandReference } from './admin-execution';
import { createAdminController } from '../application/admin-controller';
import type { RepairVerificationPlan } from '../domain/repair-verification';

const nodeCommand = (code: string) => adminCommandReference({ command: process.execPath, args: ['-e', code] });
function fixture() {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  mkdirSync(root, { recursive: true });
  const file = join(root, 'feature.txt');
  writeFileSync(file, 'fixed');
  const store = new AdminManagementStore(join(root, 'native-verification.db'));
  store.setIntent('running', randomUUID());
  const repairCase = store.observe({ observationId: 'original-failure', scope: 'runtime', scopeKey: 'fixture-runtime',
    fingerprint: 'feature-missing', sourceVersion: 'broken-v1', summary: 'original behavior missing', evidence: {}, origin: 'runtime' });
  const authority = store.acquireSupervisor('native-host')!;
  const repair = store.claimNext(authority)!;
  const credential = store.issueCommandCredential(repair);
  store.commandStatus(credential);
  store.commandRecordEvidence(credential, 'actual-change', 'change', { file });
  store.commandSubmit(credential, { outcome: 'verification-requested', summary: 'fixed feature', repairVersion: 'fixed-v2',
    originalObservationIds: ['original-failure'], repairEvidenceKeys: ['actual-change'],
    verification: { reproductionCommand: 'untrusted echo', versionCheckCommand: 'untrusted echo',
      acceptanceChecks: [{ targetRef: 'fake', command: 'echo pass', expected: 'pass' }] } });
  store.finishAttempt(repair, { outcome: 'verification-requested', reason: 'fixed feature', exitConfirmed: true });
  const check = nodeCommand(`require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(file)},'utf8'),'fixed')`);
  const plan: RepairVerificationPlan = { sourceRepairAttemptId: repair.attempt.attemptId, expectedVersion: 'fixed-v2',
    originalObservationIds: ['original-failure'], versionCommand: nodeCommand("process.stdout.write('fixed-v2')"),
    reproduction: { targetRef: 'original-failure', command: check }, acceptanceChecks: [{ targetRef: 'original-behavior', command: check }] };
  return { store, root, file, repairCase, authority, plan };
}

test('hung independent plan lookup fails before spawn and its late response cannot authorize a worker', async () => {
  const h = fixture();
  let release!: (value: { plan: RepairVerificationPlan; workspaceRoot: string }) => void;
  const pending = new Promise<{ plan: RepairVerificationPlan; workspaceRoot: string }>(resolve => { release = resolve; });
  const claim = h.store.claimVerification(h.authority)!;
  let binds = 0;
  try {
    const handle = await createNativeAdminVerification({ store: h.store, appRoot: process.cwd(), planLookupTimeoutMs: 20,
      resolvePlan: () => pending })(claim, () => { binds++; }, new AbortController().signal);
    const result = await handle.completion;
    assert.equal(result.exitConfirmed, true);
    assert.match(result.reason, /plan lookup exceeded/);
    h.store.finishAttempt(claim, result);
    release({ plan: h.plan, workspaceRoot: h.root });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(binds, 0);
    assert.equal(h.store.verificationReceipt(claim.attempt.attemptId), null);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
  } finally { release({ plan: h.plan, workspaceRoot: h.root }); h.store.close(); }
});

test('user cancellation interrupts a permanently pending independent plan read without spawning', async () => {
  const h = fixture();
  const claim = h.store.claimVerification(h.authority)!;
  const cancellation = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let binds = 0;
  try {
    const pending = createNativeAdminVerification({ store: h.store, appRoot: process.cwd(), resolvePlan: async () => {
      entered(); return new Promise(() => undefined);
    } })(claim, () => { binds++; }, cancellation.signal);
    await ready;
    cancellation.abort();
    const result = await (await pending).completion;
    assert.equal(result.exitConfirmed, true);
    assert.match(result.reason, /plan lookup cancelled/);
    assert.equal(binds, 0);
  } finally { h.store.close(); }
});

test('native verification uses one durable worker, runs repaired files and cleans the physical group before observing', { skip: process.platform === 'win32' }, async () => {
  const h = fixture();
  const controller = createAdminController({ store: h.store, ownerId: 'native-host', confirmStopped: async () => false,
    launch: async () => { throw new Error('repair should not run again'); },
    launchVerification: createNativeAdminVerification({ store: h.store, appRoot: process.cwd(), resolvePlan: async () => ({ plan: h.plan, workspaceRoot: h.root }) }),
  });
  try {
    assert.equal(await controller.reconcile(), 'launched');
    await controller.waitForSettlements();
    const attempt = h.store.attempts(h.repairCase.caseId)[1];
    assert.ok(attempt.pid);
    assert.equal(attempt.processGroupId, attempt.pid);
    assert.ok(attempt.startMarker);
    assert.equal(attempt.status, 'completed', `${attempt.lastError}\n${JSON.stringify(h.store.evidence(h.repairCase.caseId))}`);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    assert.equal(h.store.verificationReceipt(attempt.attemptId)?.checks.length, 4);
    assert.throws(() => process.kill(attempt.pid!, 0), /ESRCH/);
    assert.equal(readFileSync(h.file, 'utf8'), 'fixed');
  } finally { await controller.shutdown(); h.store.close(); }
});

test('independent diagnosis runs real original failures, records all checks and repeated facts upgrade recovery rather than declaring repair', { skip: process.platform === 'win32' }, async () => {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  mkdirSync(root, { recursive: true });
  const file = join(root, 'original-feature.txt');
  const versionFile = join(root, 'actual-version.txt');
  writeFileSync(file, 'implementation is missing');
  writeFileSync(versionFile, 'broken-v1');
  const store = new AdminManagementStore(join(root, 'diagnosis.db'));
  store.setIntent('running', randomUUID());
  const repairCase = store.observe({ observationId: 'original-diagnosis-failure', scope: 'runtime', scopeKey: 'diagnostic-fixture',
    fingerprint: 'missing-original-behavior', origin: 'runtime', sourceVersion: 'broken-v1', summary: 'Original feature must equal fixed',
    evidence: { file, versionFile, originalAcceptance: 'Original feature must equal fixed' } });
  const authority = store.acquireSupervisor('diagnostic-host')!;
  const repeatedAttempts: string[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      if (index > 0) writeFileSync(versionFile, `changed-version-${index}`);
      const baselineVersion = readFileSync(versionFile, 'utf8');
      const repair = store.claimNext(authority)!;
      const credential = store.issueCommandCredential(repair);
      store.commandStatus(credential);
      store.commandSubmit(credential, { outcome: 'diagnosis-requested', summary: 'Independently inspect original failure before modifying', baselineVersion,
        originalObservationIds: ['original-diagnosis-failure'], verification: { reproductionCommand: 'untrusted echo pass', versionCheckCommand: 'untrusted echo pass',
          acceptanceChecks: [{ targetRef: 'fake', command: 'untrusted echo pass', expected: 'fake' }] } });
      store.finishAttempt(repair, { outcome: 'diagnosis-requested', exitConfirmed: true, reason: 'Request independent diagnosis, not repair success' });
      const verification = store.claimVerification(authority)!;
      const check = nodeCommand(`console.error('diagnostic round ${index}');require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(file)},'utf8'),'fixed')`);
      const plan: RepairVerificationPlan = { sourceRepairAttemptId: repair.attempt.attemptId, expectedVersion: baselineVersion, originalObservationIds: ['original-diagnosis-failure'],
        versionCommand: nodeCommand(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(versionFile)},'utf8'))`),
        reproduction: { targetRef: 'original-failure', command: check }, acceptanceChecks: [{ targetRef: 'original-behavior', command: check }] };
      const handle = await createNativeAdminVerification({ store, appRoot: process.cwd(), resolvePlan: async () => ({ plan, workspaceRoot: root }) })(verification,
        (pid, marker, groupId) => store.attachProcess(verification, pid, marker, groupId), new AbortController().signal);
      try {
        const result = await handle.completion;
        assert.equal(result.exitConfirmed, true);
        const receipt = store.verificationReceipt(verification.attempt.attemptId)!;
        assert.equal(receipt.passed, false);
        assert.deepEqual(receipt.checks.map(item => item.result.exitCode), [0, 1, 1, 0]);
        assert.match(receipt.checks[1].result.stderr, /implementation is missing/);
        assert.equal(receipt.checks.at(-1)?.result.stdout, baselineVersion);
        assert.equal(store.verificationPurpose(verification.attempt.attemptId), 'diagnosis');
        assert.equal(store.finishVerification(verification, false), false, 'even complete diagnoses wait for actual worker exit');
        store.finishVerification(verification, true);
        assert.equal(store.attempts(repairCase.caseId).at(-1)?.status, 'completed', 'expected original failure is diagnostic evidence, not CLI execution failure');
        assert.equal(store.getCase(repairCase.caseId)?.status, 'queued');
        assert.throws(() => store.verifiedContext(authority, repairCase.caseId), /独立验证/);
        const history = store.diagnosisHistory(repairCase.caseId);
        assert.equal(history.length, index + 1);
        assert.equal(history.at(-1)?.novel, index === 0 ? 1 : 0, 'changed version, stderr and command wording do not manufacture improved acceptance facts');
        assert.throws(() => process.kill(store.attempts(repairCase.caseId).at(-1)!.pid!, 0));
        if (index > 0) repeatedAttempts.push(verification.attempt.attemptId);
      } finally { await handle.stop(); }
    }
    const next = store.claimNext(authority)!;
    const credential = store.issueCommandCredential(next);
    assert.equal(store.commandStatus(credential).diagnoses.length, 3);
    assert.deepEqual(store.recoveryDecision(next.attempt.attemptId)?.failedAttemptIds, repeatedAttempts);
    assert.equal(store.recoveryDecision(next.attempt.attemptId)?.method, 'minimal-reproduction');
    assert.equal(readFileSync(file, 'utf8'), 'implementation is missing', 'diagnosis never pretends to fix business code');
    assert.equal(store.observations(repairCase.caseId).length, 1);
  } finally { store.close(); }
});

test('compiled installed worker executes original failure and cannot pass a missing implementation', { skip: process.platform === 'win32' }, async () => {
  const h = fixture();
  writeFileSync(h.file, 'still broken');
  const installed = join(h.root, 'installed');
  const bundles = join(installed, 'desktop-runners');
  mkdirSync(bundles, { recursive: true });
  await build({ entryPoints: ['scripts/loop/verification-worker-entry.ts'], outfile: join(bundles, 'verification-worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  const claim = h.store.claimVerification(h.authority)!;
  const launch = createNativeAdminVerification({ store: h.store, appRoot: installed, resolvePlan: async () => ({ plan: h.plan, workspaceRoot: h.root }) });
  const handle = await launch(claim, (pid, marker, groupId) => h.store.attachProcess(claim, pid, marker, groupId), new AbortController().signal);
  try {
    const result = await handle.completion;
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.outcome, 'failed');
    const receipt = h.store.verificationReceipt(claim.attempt.attemptId)!;
    assert.equal(receipt.passed, false);
    assert.match(receipt.checks[1].result.stderr, /still broken/);
    h.store.finishVerification(claim, result.exitConfirmed);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
  } finally { await handle.stop(); h.store.close(); }
});

test('native command timeout terminates worker and hanging descendants without a pass receipt', { skip: process.platform === 'win32' }, async () => {
  const h = fixture();
  const pidFile = join(h.root, 'hanging-command.pid');
  h.plan.reproduction.command = nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.error('真实验证停滞前的诊断');setInterval(()=>undefined,1000)`);
  const claim = h.store.claimVerification(h.authority)!;
  const handle = await createNativeAdminVerification({ store: h.store, appRoot: process.cwd(), commandTimeoutMs: 500,
    resolvePlan: async () => ({ plan: h.plan, workspaceRoot: h.root }) })(claim,
    (pid, marker, groupId) => h.store.attachProcess(claim, pid, marker, groupId), new AbortController().signal);
  try {
    const result = await handle.completion;
    assert.equal(result.exitConfirmed, true);
    assert.match(result.reason, /timed out/);
    assert.equal(h.store.verificationReceipt(claim.attempt.attemptId), null);
    const failure = h.store.evidence(h.repairCase.caseId).find(raw => (raw as { receipt_key: string }).receipt_key === 'verification-execution-failure') as { payload_json: string };
    assert.match(JSON.parse(failure.payload_json).stderrTail, /真实验证停滞前的诊断/);
    assert.ok(existsSync(pidFile), 'hang was a real launched native command');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    h.store.finishAttempt(claim, result);
    assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
  } finally { await handle.stop(); h.store.close(); }
});

test('a detached-from-shell background child prevents pass and is physically removed', { skip: process.platform === 'win32' }, async () => {
  const h = fixture();
  const pidFile = join(h.root, 'orphan.pid');
  h.plan.reproduction.command = nodeCommand(`const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>undefined,1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref()`);
  const claim = h.store.claimVerification(h.authority)!;
  const handle = await createNativeAdminVerification({ store: h.store, appRoot: process.cwd(), resolvePlan: async () => ({ plan: h.plan, workspaceRoot: h.root }) })(claim,
    (pid, marker, groupId) => h.store.attachProcess(claim, pid, marker, groupId), new AbortController().signal);
  try {
    const result = await handle.completion;
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason, /退出未确认/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(h.store.verificationReceipt(claim.attempt.attemptId)?.passed, false);
  } finally { await handle.stop(); h.store.close(); }
});

test('cancellation during trusted plan lookup does not launch a worker or execute commands', async () => {
  const h = fixture();
  const claim = h.store.claimVerification(h.authority)!;
  const cancel = new AbortController();
  const launch = createNativeAdminVerification({ store: h.store, appRoot: process.cwd(), resolvePlan: async () => {
    cancel.abort(); return { plan: h.plan, workspaceRoot: h.root };
  } });
  try {
    const handle = await launch(claim, () => { throw new Error('must not spawn'); }, cancel.signal);
    assert.equal((await handle.completion).exitConfirmed, true);
    assert.equal(h.store.attempts(h.repairCase.caseId)[1].pid, null);
    assert.equal(h.store.verificationReceipt(claim.attempt.attemptId), null);
  } finally { h.store.close(); }
});

test('stopping an actively hanging native verification cancels and physically reaps its command', { skip: process.platform === 'win32' }, async () => {
  const h = fixture();
  const pidFile = join(h.root, 'cancelled-command.pid');
  h.plan.reproduction.command = nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>undefined,1000)`);
  const claim = h.store.claimVerification(h.authority)!;
  const cancel = new AbortController();
  const handle = await createNativeAdminVerification({ store: h.store, appRoot: process.cwd(),
    resolvePlan: async () => ({ plan: h.plan, workspaceRoot: h.root }) })(claim,
    (pid, marker, groupId) => h.store.attachProcess(claim, pid, marker, groupId), cancel.signal);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile));
    cancel.abort();
    const result = await handle.completion;
    assert.equal(result.outcome, 'failed');
    assert.equal(result.exitConfirmed, true);
    assert.match(result.reason, /stopped/);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), /ESRCH/);
    assert.notEqual(h.store.verificationReceipt(claim.attempt.attemptId)?.passed, true);
  } finally { await handle.stop(); h.store.close(); }
});

test('native verifier and its commands do not inherit business or repair mutation credentials', { skip: process.platform === 'win32' }, async () => {
  const h = fixture();
  const keys = ['LOOP_EXECUTION_ID', 'LOOP_INTERNAL_COMMAND_TOKEN', 'LOOP_ADMIN_COMMAND_TOKEN'];
  const old = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = 'fake-credential-must-not-leak'; });
  h.plan.acceptanceChecks[0].command = nodeCommand(`const assert=require('node:assert/strict');for(const key of ${JSON.stringify(keys)})assert.equal(process.env[key],undefined)`);
  const claim = h.store.claimVerification(h.authority)!;
  const handle = await createNativeAdminVerification({ store: h.store, appRoot: process.cwd(),
    resolvePlan: async () => ({ plan: h.plan, workspaceRoot: h.root }) })(claim,
    (pid, marker, groupId) => h.store.attachProcess(claim, pid, marker, groupId), new AbortController().signal);
  try {
    const result = await handle.completion;
    assert.equal(result.outcome, 'verified', result.reason);
    assert.equal(result.exitConfirmed, true);
  } finally {
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
    await handle.stop(); h.store.close();
  }
});
