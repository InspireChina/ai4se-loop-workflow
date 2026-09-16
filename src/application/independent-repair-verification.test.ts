import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { executeIndependentRepairVerification, type RepairVerificationPlan, type VerificationCommandResult } from './independent-repair-verification';

const plan: RepairVerificationPlan = {
  sourceRepairAttemptId: 'repair-attempt', expectedVersion: 'fixed-v2', originalObservationIds: ['original-failure'],
  versionCommand: 'version', reproduction: { targetRef: 'original-failure', command: 'reproduce' },
  acceptanceChecks: [{ targetRef: 'original-acceptance', command: 'acceptance' }],
};
const ok = (stdout = ''): VerificationCommandResult => ({ exitCode: 0, stdout, stderr: '', exitConfirmed: true });

test('diagnostic checks retain original failures and still inspect acceptance and final version', async () => {
  const commands: string[] = [];
  const receipt = await executeIndependentRepairVerification(plan, {
    signal: new AbortController().signal, continueOnCheckFailure: true, persist: async () => undefined,
    run: async command => {
      commands.push(command);
      return command === 'version' ? ok('fixed-v2') : { ...ok(), exitCode: 1, stderr: 'Original acceptance is still missing' };
    },
  });
  assert.deepEqual(commands, ['version', 'reproduce', 'acceptance', 'version']);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.checks.length, 4);
  assert.equal(receipt.checks.at(-1)?.kind, 'version-after');
});

test('independent verification actually runs original reproduction and acceptance in separate native processes', async () => {
  const execute = promisify(execFile);
  const commands: string[] = [];
  const evidence: string[] = [];
  const result = await executeIndependentRepairVerification(plan, {
    signal: new AbortController().signal,
    run: async (command, signal) => {
      commands.push(command);
      const code = command === 'version' ? 'process.stdout.write("fixed-v2")'
        : command === 'reproduce' ? 'require("node:assert/strict").equal([1,2].includes(2),true)'
        : 'require("node:assert/strict").deepEqual([3,1,2].sort(),[1,2,3])';
      const { stdout, stderr } = await execute(process.execPath, ['-e', code], { signal });
      return { exitCode: 0, stdout, stderr, exitConfirmed: true };
    },
    persist: async key => { evidence.push(key); },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(commands, ['version', 'reproduce', 'acceptance', 'version']);
  assert.equal(evidence.length, 5);
  assert.match(result.reason, /等待业务交还/);
});

test('old runtime, changing version, failed acceptance and unknown physical exit cannot pass', async () => {
  for (const failure of ['old-version', 'changed-version', 'acceptance-failed', 'unknown-exit']) {
    let versionReads = 0;
    const receipt = await executeIndependentRepairVerification(plan, {
      signal: new AbortController().signal,
      run: async command => {
        if (command === 'version') {
          versionReads++;
          return ok(failure === 'old-version' || (failure === 'changed-version' && versionReads === 2) ? 'old-v1' : 'fixed-v2');
        }
        if (command === 'acceptance' && failure === 'acceptance-failed') return { ...ok(), exitCode: 1, stderr: 'original UI still missing' };
        if (command === 'reproduce' && failure === 'unknown-exit') return { ...ok(), exitConfirmed: false };
        return ok();
      },
      persist: async () => undefined,
    });
    assert.equal(receipt.passed, false, failure);
    assert.equal(receipt.exitConfirmed, failure !== 'unknown-exit');
  }
});

test('missing evidence, duplicate targets and cancellation never turn into independent success', async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  let runs = 0;
  const ports = { signal: cancellation.signal, run: async () => { runs++; return ok('fixed-v2'); }, persist: async () => undefined };
  assert.equal((await executeIndependentRepairVerification(plan, ports)).passed, false);
  assert.equal(runs, 0);
  await assert.rejects(executeIndependentRepairVerification({ ...plan, acceptanceChecks: [] }, ports));
  await assert.rejects(executeIndependentRepairVerification({ ...plan, acceptanceChecks: [...plan.acceptanceChecks, ...plan.acceptanceChecks] }, ports));
  await assert.rejects(executeIndependentRepairVerification(plan, {
    ...ports, signal: new AbortController().signal, persist: async () => { throw new Error('evidence disk failed'); },
  }), /evidence disk failed/);
  assert.equal(runs, 0, 'no command launched when its durable plan cannot be saved');
});

test('verification allocation survives restart, cannot borrow repair credentials and never closes the Case', () => {
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'independent-verification.db');
  let store = new AdminManagementStore(filename);
  try {
    store.setIntent('running', randomUUID());
    const repairCase = store.observe({ observationId: 'original-failure', scope: 'runtime', scopeKey: 'test-runtime',
      fingerprint: 'original-failure', sourceVersion: 'broken-v1', summary: 'original acceptance failed', evidence: {}, origin: 'runtime' });
    const authority = store.acquireSupervisor('host')!;
    const repair = store.claimNext(authority)!;
    assert.equal(repair.attempt.role, 'investigation');
    assert.equal(store.finishAttempt(repair, { outcome: 'verification-requested', exitConfirmed: false, reason: 'descendants unknown' }), false);
    assert.equal(store.claimVerification(authority), null);
    store.finishAttempt(repair, { outcome: 'verification-requested', exitConfirmed: true, reason: 'repair submitted' });
    const verification = store.claimVerification(authority)!;
    assert.equal(verification.attempt.role, 'verification');
    assert.notEqual(verification.attempt.attemptId, repair.attempt.attemptId);
    assert.equal(verification.attempt.generation, 2);
    assert.throws(() => store.issueCommandCredential(verification), /不能签发修复命令/);
    assert.throws(() => store.finishAttempt(verification, { outcome: 'verification-requested', exitConfirmed: true, reason: 'self declared pass' }), /不能使用修复者提交/);
    store.close();
    store = new AdminManagementStore(filename);
    assert.equal(store.claimVerification(authority), null, 'restart does not erase physical ownership');
    assert.equal(store.retireStoppedAttempt(authority, verification.attempt.attemptId, false, 'unknown'), false);
    assert.equal(store.getCase(repairCase.caseId)?.currentAttemptId, verification.attempt.attemptId);
    assert.equal(store.retireStoppedAttempt(authority, verification.attempt.attemptId, true, 'confirmed'), true);
    assert.equal(store.getCase(repairCase.caseId)?.status, 'verifying', 'interrupted verifier resumes verification rather than repeating repair');
    assert.equal(store.claimVerification(authority)?.attempt.role, 'verification');
    assert.equal(store.observations(repairCase.caseId).length, 1);
  } finally { store.close(); }
});
