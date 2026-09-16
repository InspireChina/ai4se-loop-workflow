import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import test from 'node:test';
import { createAdminController } from '../application/admin-controller';
import { authorizePreparedVerification, independentPreparationPrompt, originalVerificationTargets } from '../domain/independent-verification-preparation';
import { AdminManagementStore } from './admin-management-store';
import { confirmAdminAttemptStopped } from './admin-execution';
import { createIndependentVerificationPreparation } from './independent-verification-preparation';
import { createDefaultRepairVerification } from './default-repair-verification';
import { readRepairWorkspaceVersion, workspaceVersionCommand } from './repair-workspace-version';
import type { AgentExecutor } from './agent-executor';

async function fixture(feature = 'fixed', mode: 'normal' | 'omit' | 'mutate' | 'stall' | 'self-mutate' = 'normal') {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const file = join(workspace, 'feature.txt');
  writeFileSync(file, feature);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Actual original source'], { cwd: workspace });
  let now = Date.now();
  const store = new AdminManagementStore(join(root, 'management.db'), () => now);
  store.setIntent('running', 'start');
  const repairCase = store.observe({ observationId: 'original', scope: 'work-item', scopeKey: 'task:work', fingerprint: 'missing-feature',
    sourceVersion: 'broken-v1', origin: 'business', summary: 'Actual feature must equal fixed', evidence: { taskId: 'task',
      item: { item_id: 'item', revision: 1, dispatch_epoch: 0 }, originalContract: {
        requirement: { authoritativeExecutionRequirement: { description: 'Actual feature must equal fixed' } },
        acceptances: [{ acceptance_key: 'feature-value', oracle: 'Actual feature must equal fixed', statement: 'Feature works' }],
        featureFile: file,
      } } });
  const authority = store.acquireSupervisor('preparation-host')!;
  const repair = store.claimNext(authority)!;
  const credential = store.issueCommandCredential(repair);
  store.commandStatus(credential);
  store.commandRequestAction(credential, 'owned', { kind: 'workspace-takeover', itemId: 'item', itemRevision: 1, reason: 'Repair actual feature' });
  store.recordCommandActionResult(repair, 'owned', 'completed', { phase: 'owned', workspaceRoot: workspace,
    anchor: { taskId: 'task', itemId: 'item', itemRevision: 1, itemEpoch: 0, workspaceRoot: workspace } });
  store.commandRecordEvidence(credential, 'change', 'change', { file });
  const expectedVersion = await readRepairWorkspaceVersion(workspace);
  store.commandSubmit(credential, { outcome: 'verification-requested', summary: 'Repairer claims fixed', repairVersion: expectedVersion,
    originalObservationIds: ['original'], repairEvidenceKeys: ['change'], verification: {
      reproductionCommand: 'echo REPAIRER_FAKE_ORACLE', versionCheckCommand: 'echo REPAIRER_FAKE_VERSION',
      acceptanceChecks: [{ targetRef: 'fake', command: 'echo REPAIRER_FAKE_ORACLE', expected: 'pass' }],
    } });
  store.finishAttempt(repair, { outcome: 'verification-requested', reason: 'Actual repair request', exitConfirmed: true });
  let preparations = 0;
  const executor: AgentExecutor = { id: 'claude', command: process.execPath, label: 'Actual independent preparation fixture', promptMode: 'argument',
    env: { LOOP_ADMIN_COMMAND_TOKEN: 'must-not-leak', LOOP_EXECUTION_TOKEN: 'must-not-leak' },
    buildArgs: prompt => {
      assert.equal(prompt.includes('REPAIRER_FAKE_ORACLE'), false);
      preparations++;
      return ['-e', `
        const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
        assert.equal(process.env.LOOP_ADMIN_COMMAND_TOKEN,undefined);assert.equal(process.env.LOOP_EXECUTION_TOKEN,undefined);
        const input=JSON.parse(fs.readFileSync(path.join(process.env.LOOP_AGENT_TMP_DIR,'original-facts.json'),'utf8'));
        const script=path.join(process.env.LOOP_AGENT_TMP_DIR,'check.cjs');
        fs.writeFileSync(script,${JSON.stringify(`require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(file)},'utf8'),'fixed')`)});
        if(${JSON.stringify(mode)}==='self-mutate')fs.appendFileSync(script,${JSON.stringify(';require("node:fs").appendFileSync(__filename,"\\n// Changed oracle after execution");')});
        const command=JSON.stringify(process.execPath)+' '+JSON.stringify(script);
        const plan={reproduction:{targetRef:'original-failures',command},
          acceptanceChecks:input.targets.map(target=>({targetRef:target.targetRef,command}))};
        if(${JSON.stringify(mode)}==='omit')plan.acceptanceChecks=plan.acceptanceChecks.slice(1);
        if(${JSON.stringify(mode)}==='mutate')fs.writeFileSync(${JSON.stringify(file)},'Verifier must not change source');
        fs.writeFileSync(path.join(process.env.LOOP_AGENT_TMP_DIR,'verification-plan.json'),JSON.stringify(plan));
        console.log('Actual independent preparation completed');
        if(${JSON.stringify(mode)}==='stall')setInterval(()=>{},1000);else setTimeout(()=>{},300);
      `];
    }, formatCommand: () => 'node independent preparation', parseStdout: line => line, parseStderr: line => line };
  const prepare = createIndependentVerificationPreparation({ store, appRoot: process.cwd(), dataRoot: root, executor, executionOptions: {},
    limits: { maxRuntimeMs: 10000, startupTimeoutMs: 5000, idleTimeoutMs: 5000 } });
  const launch = createDefaultRepairVerification({ store, appRoot: process.cwd(), prepare });
  return { root, workspace, store, repairCase, authority, repair, prepare, launch, preparations: () => preparations,
    advanceClock: () => { now += 60001; } };
}

test('host binds all frozen targets and actual version, never the repairer proposed oracle or version command', async () => {
  const h = await fixture();
  try {
    const claim = h.store.claimVerification(h.authority)!;
    const input = h.store.independentVerificationInput(claim);
    const targets = originalVerificationTargets(input);
    const proposed = { reproduction: { targetRef: 'original-failures', command: 'independent-original-repro' },
      acceptanceChecks: targets.map(target => ({ targetRef: target.targetRef, command: 'independent-check' })) };
    const plan = authorizePreparedVerification(input, proposed, workspaceVersionCommand(process.cwd(), h.workspace));
    assert.equal(plan.sourceRepairAttemptId, h.repair.attempt.attemptId);
    assert.deepEqual(plan.originalObservationIds, ['original']);
    assert.equal(plan.versionCommand.includes('REPAIRER_FAKE_VERSION'), false);
    assert.throws(() => authorizePreparedVerification(input, { ...proposed, acceptanceChecks: proposed.acceptanceChecks.slice(1) }, plan.versionCommand), /完整覆盖/);
    assert.throws(() => authorizePreparedVerification(input, { ...proposed, expectedVersion: 'fake' }, plan.versionCommand), /版本和来源/);
    assert.equal(independentPreparationPrompt(input, 'original.json', 'plan.json').includes('REPAIRER_FAKE_ORACLE'), false);
    assert.throws(() => h.store.issueCommandCredential(claim), /不能签发/);
  } finally { h.store.close(); }
});

test('original target coverage above one hundred remains complete rather than silently dropping contract checks', async () => {
  const h = await fixture();
  try {
    const claim = h.store.claimVerification(h.authority)!;
    const input = h.store.independentVerificationInput(claim);
    const original = input.originalObservations[0];
    const expanded = { ...input, originalObservations: [{ ...original, evidence: { ...original.evidence,
      originalContract: { requirement: { description: 'Every original target must be asserted' },
        acceptances: Array.from({ length: 101 }, (_, index) => ({ acceptance_key: `target-${index}`, oracle: `Actual oracle ${index}` })) } } }] };
    const checks = originalVerificationTargets(expanded).map(target => ({ targetRef: target.targetRef, command: 'actual-independent-check' }));
    const proposed = { reproduction: { targetRef: 'original-failures', command: 'actual-original-repro' }, acceptanceChecks: checks };
    assert.equal(authorizePreparedVerification(expanded, proposed, 'host-version-command').acceptanceChecks.length, 102);
    assert.throws(() => authorizePreparedVerification(expanded, { ...proposed, acceptanceChecks: checks.slice(0, 100) }, 'host-version-command'), /完整覆盖/);
  } finally { h.store.close(); }
});

test('streamed input fencing checks current authority without reparsing large original contracts', async () => {
  const h = await fixture();
  try {
    const claim = h.store.claimVerification(h.authority)!;
    h.store.independentVerificationInput = () => { throw new Error('Full contract read is forbidden during stream fencing'); };
    for (let index = 0; index < 100; index++) h.store.assertIndependentVerificationClaim(claim);
    h.store.setIntent('stopped', 'stream-user-stop');
    assert.throws(() => h.store.assertIndependentVerificationClaim(claim));
  } finally { h.store.close(); }
});

test('production default stage selector physically prepares, independently runs all checks, and remains observing until ordinary business progresses',
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture();
    const controller = createAdminController({ store: h.store, ownerId: 'preparation-host', confirmStopped: confirmAdminAttemptStopped,
      launchVerification: h.launch, launch: async () => { throw new Error('Unexpected business/investigation invocation'); } });
    try {
      const deadline = Date.now() + 15000;
      while (h.store.getCase(h.repairCase.caseId)?.status === 'verifying' && Date.now() < deadline) {
        await controller.reconcile(); await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
      assert.equal(h.preparations(), 1);
      const attempts = h.store.attempts(h.repairCase.caseId);
      assert.deepEqual(attempts.map(attempt => [attempt.role, attempt.status]), [['investigation', 'completed'], ['verification', 'completed'], ['verification', 'completed']]);
      assert.equal(h.store.verificationReceipt(attempts[1].attemptId), null, 'A prepared plan is not verification success');
      assert.equal(h.store.verificationReceipt(attempts[2].attemptId)?.passed, true);
      assert.ok(attempts.slice(1).every(attempt => attempt.pid && attempt.startMarker && attempt.processGroupId));
      assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0, 'No fake handoff or Dev/Test completion');
    } finally { await controller.shutdown(); h.store.close(); }
  });

test('saved preparation cannot release an unknown physical process and recovers without another model call after confirmed host loss',
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture();
    try {
      const claim = h.store.claimVerification(h.authority)!;
      const handle = await h.launch(claim, (pid, marker, group) => h.store.attachProcess(claim, pid, marker, group), new AbortController().signal);
      const result = await handle.completion;
      assert.equal(result.outcome, 'verification-prepared');
      assert.equal(h.store.finishVerificationPreparation(claim, false), false);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, claim.attempt.attemptId);
      h.advanceClock();
      const authority = h.store.acquireSupervisor('restarted-host')!;
      assert.ok(authority);
      assert.equal(h.store.recoverStoppedSubmission(authority, claim.attempt.attemptId, true), true);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'verifying');
      const next = h.store.claimVerification(authority)!;
      const native = await h.launch(next, (pid, marker, group) => h.store.attachProcess(next, pid, marker, group), new AbortController().signal);
      const verified = await native.completion;
      assert.equal(verified.outcome, 'verified');
      h.store.finishVerification(next, verified.exitConfirmed);
      assert.equal(h.preparations(), 1);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
    } finally { h.store.close(); }
  });

test('independent actual checks reject a missing feature despite a repairer claiming success',
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture('still missing');
    try {
      const prepared = h.store.claimVerification(h.authority)!;
      const planning = await h.launch(prepared, (pid, marker, group) => h.store.attachProcess(prepared, pid, marker, group), new AbortController().signal);
      const result = await planning.completion;
      assert.equal(result.outcome, 'verification-prepared');
      h.store.finishAttempt(prepared, result);
      const claim = h.store.claimVerification(h.authority)!;
      const handle = await h.launch(claim, (pid, marker, group) => h.store.attachProcess(claim, pid, marker, group), new AbortController().signal);
      const failed = await handle.completion;
      assert.equal(failed.outcome, 'failed');
      assert.equal(failed.exitConfirmed, true);
      assert.equal(h.store.verificationReceipt(claim.attempt.attemptId)?.passed, false);
      h.store.finishVerification(claim, true);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
      assert.equal(h.store.observations(h.repairCase.caseId).length, 1);
    } finally { h.store.close(); }
  });

for (const mode of ['omit', 'mutate'] as const) test(`independent preparation rejects ${mode} instead of saving a usable plan`,
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture('fixed', mode);
    try {
      const claim = h.store.claimVerification(h.authority)!;
      const handle = await h.launch(claim, (pid, marker, group) => h.store.attachProcess(claim, pid, marker, group), new AbortController().signal);
      const result = await handle.completion;
      assert.equal(result.outcome, 'failed');
      assert.equal(result.exitConfirmed, true);
      assert.match(result.reason, mode === 'omit' ? /完整覆盖/ : /修改了源码版本/);
      h.store.finishAttempt(claim, result);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
      assert.equal(h.store.verificationReceipt(claim.attempt.attemptId), null);
      assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    } finally { h.store.close(); }
  });

test('manual stop cancels the actual independent planner and remains a neutral interruption, not acceptance or a failure budget charge',
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture('fixed', 'stall');
    try {
      const claim = h.store.claimVerification(h.authority)!;
      const signal = new AbortController();
      const handle = await h.launch(claim, (pid, marker, group) => h.store.attachProcess(claim, pid, marker, group), signal.signal);
      const deadline = Date.now() + 5000;
      while (!h.store.attempts(h.repairCase.caseId).find(attempt => attempt.attemptId === claim.attempt.attemptId)?.startMarker && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(h.store.attempts(h.repairCase.caseId).find(attempt => attempt.attemptId === claim.attempt.attemptId)?.startMarker);
      h.store.setIntent('stopped', 'manual-stop'); signal.abort();
      assert.equal(await handle.stop(), true);
      const result = await handle.completion;
      assert.equal(result.exitConfirmed, true);
      assert.equal(result.outcome, 'failed');
      h.store.retireStoppedAttempt(h.authority, claim.attempt.attemptId, true, 'User stopped independent preparation');
      assert.equal(h.store.attempts(h.repairCase.caseId).at(-1)?.status, 'interrupted');
      assert.equal(h.store.verificationReceipt(claim.attempt.attemptId), null);
      assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    } finally { h.store.close(); }
  });

test('a source ownership rejection prevents any planner spawn, including when an apparently completed takeover is cached', async () => {
  const h = await fixture();
  try {
    const claim = h.store.claimVerification(h.authority)!;
    const launch = createDefaultRepairVerification({ store: h.store, appRoot: process.cwd(), prepare: h.prepare,
      assertWorkspace: async () => { throw new Error('Actual workspace no longer owned'); } });
    let binds = 0;
    const handle = await launch(claim, () => { binds++; }, new AbortController().signal);
    const result = await handle.completion;
    assert.equal(result.outcome, 'failed'); assert.equal(result.exitConfirmed, true);
    assert.equal(binds, 0); assert.equal(h.preparations(), 0);
    assert.match(result.reason, /no longer owned/);
  } finally { h.store.close(); }
});

test('a preexisting scratch alias outside the owned root is rejected before creating files or spawning a CLI',
  { skip: process.platform === 'win32' ? 'Creating symbolic links requires local Windows privileges' : false }, async () => {
    const h = await fixture();
    const outside = join(h.root, 'not-owned'); mkdirSync(outside);
    symlinkSync(outside, join(h.workspace, '.tmp'), 'dir');
    try {
      const claim = h.store.claimVerification(h.authority)!;
      const handle = await h.launch(claim, () => { throw new Error('Must not spawn'); }, new AbortController().signal);
      const result = await handle.completion;
      assert.equal(result.outcome, 'failed'); assert.equal(result.exitConfirmed, true);
      assert.match(result.reason, /越过/); assert.deepEqual(readdirSync(outside), []);
      assert.equal(h.preparations(), 0);
    } finally { h.store.close(); }
  });

test('a live workspace ownership loss cancels the actual planner, saves the reason and keeps the original Case for recovery',
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture('fixed', 'stall');
    try {
      let checks = 0;
      const launch = createDefaultRepairVerification({ store: h.store, appRoot: process.cwd(), prepare: h.prepare,
        assertWorkspace: async () => { if (++checks > 1) throw new Error('Actual ownership lost during invocation'); } });
      const claim = h.store.claimVerification(h.authority)!;
      const handle = await launch(claim, (pid, marker, group) => h.store.attachProcess(claim, pid, marker, group), new AbortController().signal);
      const result = await handle.completion;
      assert.equal(result.outcome, 'failed'); assert.equal(result.exitConfirmed, true);
      assert.match(result.reason, /ownership lost/);
      h.store.finishAttempt(claim, result);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
      assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, null);
      assert.ok(h.store.evidence(h.repairCase.caseId).some(raw => (raw as { receipt_key: string }).receipt_key === 'independent-source-lost'));
      assert.equal(h.store.observations(h.repairCase.caseId).length, 1);
    } finally { h.store.close(); }
  });

test('source loss after saving a passed native receipt invalidates handoff and settles the actual attempt without rewriting that receipt',
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture();
    let controller: ReturnType<typeof createAdminController> | undefined;
    try {
      const preparation = h.store.claimVerification(h.authority)!;
      const first = await h.launch(preparation, (pid, marker, group) => h.store.attachProcess(preparation, pid, marker, group), new AbortController().signal);
      h.store.finishAttempt(preparation, await first.completion);
      const launch = createDefaultRepairVerification({ store: h.store, appRoot: process.cwd(), prepare: h.prepare,
        assertWorkspace: async () => {
          const current = h.store.getCase(h.repairCase.caseId)?.currentAttemptId;
          if (current && h.store.verificationReceipt(current)?.passed) throw new Error('Measured workspace ownership lost after check completion');
        } });
      controller = createAdminController({ store: h.store, ownerId: 'preparation-host', launchVerification: launch,
        confirmStopped: confirmAdminAttemptStopped, launch: async () => { throw new Error('Unexpected repair invocation'); } });
      await controller.reconcile();
      const deadline = Date.now() + 10000;
      while (h.store.getCase(h.repairCase.caseId)?.currentAttemptId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, null);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
      const attempt = h.store.attempts(h.repairCase.caseId).at(-1)!;
      assert.equal(attempt.status, 'failed');
      assert.equal(h.store.verificationReceipt(attempt.attemptId)?.passed, true, 'Retain the actual old receipt as evidence, not current authority');
      assert.throws(() => h.store.verifiedContext(h.authority, h.repairCase.caseId), /当前代次独立验证/);
      assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    } finally { await controller?.shutdown(); h.store.close(); }
  });

const electron = join(process.cwd(), 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
for (const mutation of ['script', 'new-input', 'directory-link', 'legacy-manifest', 'missing-anchor'] as const) test(`frozen verification rejects ${mutation} before spawning a worker and returns to investigation`,
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture();
    try {
      const preparation = h.store.claimVerification(h.authority)!;
      const planning = await h.launch(preparation, (pid, marker, group) => h.store.attachProcess(preparation, pid, marker, group), new AbortController().signal);
      const result = await planning.completion;
      assert.equal(result.outcome, 'verification-prepared', result.reason);
      h.store.finishAttempt(preparation, result);
      const claim = h.store.claimVerification(h.authority)!;
      const prepared = h.store.preparedVerificationPlan(claim)!;
      const original = JSON.stringify(h.store.observations(h.repairCase.caseId));
      if (mutation === 'script') writeFileSync(join(prepared.artifacts.directory, 'check.cjs'), 'process.exit(0)');
      if (mutation === 'new-input') writeFileSync(join(prepared.artifacts.directory, 'replacement-data.json'), '{"passed":true}');
      if (mutation === 'directory-link') {
        renameSync(prepared.artifacts.directory, `${prepared.artifacts.directory}-moved`);
        symlinkSync(`${prepared.artifacts.directory}-moved`, prepared.artifacts.directory, 'dir');
      }
      if (mutation === 'legacy-manifest') {
        const connection = new Database(join(h.root, 'management.db'));
        try { connection.prepare('DELETE FROM repair_verification_artifacts WHERE attempt_id = ?').run(preparation.attempt.attemptId); }
        finally { connection.close(); }
      }
      if (mutation === 'missing-anchor') {
        const connection = new Database(join(h.root, 'management.db'));
        try { connection.prepare("UPDATE admin_command_actions SET result_json=json_remove(result_json,'$.anchor') WHERE attempt_id=?")
          .run(h.repair.attempt.attemptId); }
        finally { connection.close(); }
      }
      let bound = 0;
      const handle = await h.launch(claim, () => { bound++; }, new AbortController().signal);
      const failure = await handle.completion;
      assert.equal(failure.outcome, 'failed');
      assert.equal(failure.exitConfirmed, true);
      assert.equal(bound, 0);
      assert.equal(h.store.verificationReceipt(claim.attempt.attemptId), null);
      h.store.finishAttempt(claim, failure);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
      assert.equal(h.store.getCase(h.repairCase.caseId)?.currentAttemptId, null);
      assert.equal(h.preparations(), 1);
      assert.equal(JSON.stringify(h.store.observations(h.repairCase.caseId)), original);
      assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    } finally { h.store.close(); }
  });

test('a check changing its own frozen script cannot produce a passed receipt or handoff',
  { skip: process.platform === 'win32' ? 'Windows physical descendant proof requires the pending guardian adapter' : false }, async () => {
    const h = await fixture('fixed', 'self-mutate');
    try {
      const claim = h.store.claimVerification(h.authority)!;
      const planning = await h.launch(claim, (pid, marker, group) => h.store.attachProcess(claim, pid, marker, group), new AbortController().signal);
      const planned = await planning.completion;
      assert.equal(planned.outcome, 'verification-prepared', planned.reason);
      h.store.finishAttempt(claim, planned);
      const next = h.store.claimVerification(h.authority)!;
      const handle = await h.launch(next, (pid, marker, group) => h.store.attachProcess(next, pid, marker, group), new AbortController().signal);
      const failure = await handle.completion;
      assert.equal(failure.outcome, 'failed', failure.reason);
      assert.match(failure.reason || '', /冻结.*修改/);
      assert.equal(failure.exitConfirmed, true);
      assert.equal(h.store.verificationReceipt(next.attempt.attemptId), null);
      h.store.finishAttempt(next, failure);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'queued');
      assert.equal(h.store.followupEvidence(h.repairCase.caseId).length, 0);
    } finally { h.store.close(); }
  });

test('an actual Electron Node worker verifies the prepared plan when the desktop main host had no inherited Node-mode flag',
  { skip: process.platform !== 'darwin' || !existsSync(electron) ? 'Local macOS Electron binary is required' : false }, async () => {
    const h = await fixture();
    const previousNode = process.env.LOOP_DESKTOP_NODE;
    const previousMode = process.env.ELECTRON_RUN_AS_NODE;
    try {
      process.env.LOOP_DESKTOP_NODE = electron;
      delete process.env.ELECTRON_RUN_AS_NODE;
      const claim = h.store.claimVerification(h.authority)!;
      const planning = await h.launch(claim, (pid, marker, group) => h.store.attachProcess(claim, pid, marker, group), new AbortController().signal);
      const planned = await planning.completion;
      assert.equal(planned.outcome, 'verification-prepared');
      h.store.finishAttempt(claim, planned);
      const native = h.store.claimVerification(h.authority)!;
      const handle = await h.launch(native, (pid, marker, group) => h.store.attachProcess(native, pid, marker, group), new AbortController().signal);
      const result = await handle.completion;
      assert.equal(result.outcome, 'verified', result.reason);
      assert.equal(result.exitConfirmed, true);
      h.store.finishVerification(native, true);
      assert.equal(h.store.getCase(h.repairCase.caseId)?.status, 'observing');
      assert.equal(h.preparations(), 1);
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined, 'Do not change the GUI main host environment globally');
    } finally {
      if (previousNode === undefined) delete process.env.LOOP_DESKTOP_NODE; else process.env.LOOP_DESKTOP_NODE = previousNode;
      if (previousMode === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previousMode;
      h.store.close();
    }
  });
