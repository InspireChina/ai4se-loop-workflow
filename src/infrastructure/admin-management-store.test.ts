import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { AdminManagementStore } from './admin-management-store';
import type { RepairObservation } from '../domain/repair-case';

function observation(input: Partial<RepairObservation> = {}): RepairObservation {
  return { observationId: randomUUID(), scope: 'runtime', scopeKey: 'installed-runtime', fingerprint: 'startup-failed',
    sourceVersion: 'v1', summary: 'Business database cannot load', evidence: { error: 'no such table' }, origin: 'runtime', ...input };
}

test('management records need no task/run and deduplicate faults across versions while retaining original evidence', () => {
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db');
  const first = new AdminManagementStore(filename);
  const original = observation();
  const repair = first.observe(original);
  assert.equal(first.observe(original).caseId, repair.caseId);
  assert.equal(first.observe(observation({ sourceVersion: 'v2', summary: 'Same fault after restart' })).caseId, repair.caseId);
  assert.equal(first.observations(repair.caseId).length, 2);
  assert.equal(first.getCase(repair.caseId)?.originalVersion, 'v1');
  first.close();
  const reopened = new AdminManagementStore(filename);
  try {
    assert.equal(reopened.getCase(repair.caseId)?.originalSummary, original.summary);
    assert.equal(reopened.observations(repair.caseId).length, 2);
    assert.throws(() => reopened.observe({ ...original, summary: 'Overwrite original fault' }), /已绑定其他故障/);
  } finally { reopened.close(); }
});

test('new work-item observations resolve a retired alias to its final owner and restore a schedulable queue entry', () => {
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'case-alias.db');
  const store = new AdminManagementStore(filename);
  const scopeKey = `REQ-${randomUUID()}:delivery:dev:1`;
  const firstObservation = observation({ scope: 'work-item', scopeKey, fingerprint: 'legacy-a', origin: 'business',
    evidence: { interventionId: 'INT-A' } });
  const secondObservation = observation({ scope: 'work-item', scopeKey, fingerprint: 'legacy-b', origin: 'business',
    evidence: { interventionId: 'INT-B' } });
  const firstCase = store.observe(firstObservation);
  store.observe(secondObservation);
  const laterCaseId = `REPAIR-${randomUUID()}`;
  const raw = new Database(filename);
  try {
    raw.pragma('foreign_keys = ON');
    raw.transaction(() => {
      raw.prepare(`INSERT INTO repair_cases(case_id,dedupe_key,scope,scope_key,fingerprint,original_version,original_summary,
        status,generation,current_attempt_id,created_at,updated_at)
        SELECT ?,?,scope,scope_key,?,original_version,?,'queued',0,NULL,created_at+1,updated_at+1
        FROM repair_cases WHERE case_id=?`).run(laterCaseId, randomUUID(), 'legacy-b', 'Later resource owner', firstCase.caseId);
      raw.prepare('UPDATE repair_observations SET case_id=? WHERE observation_id=?').run(laterCaseId, secondObservation.observationId);
      raw.prepare('INSERT INTO repair_schedule_queue(case_id) VALUES(?)').run(laterCaseId);
    }).immediate();
  } finally { raw.close(); }
  store.setIntent('running', 'start-alias-reconciliation');
  const authority = store.acquireSupervisor('alias-owner')!;
  try {
    store.mergeWorkItemCaseCohort(authority, { scopeKey, canonicalCaseId: laterCaseId, aliasCaseIds: [firstCase.caseId] });
    const closed = new Database(filename);
    try { closed.prepare("UPDATE repair_cases SET status='closed' WHERE case_id=?").run(laterCaseId); }
    finally { closed.close(); }
    const newObservation = observation({ scope: 'work-item', scopeKey, fingerprint: 'successor-fault', origin: 'business',
      evidence: { interventionId: 'INT-C' } });
    const reopened = store.observe(newObservation);
    assert.equal(reopened.caseId, laterCaseId);
    assert.equal(store.getCase(firstCase.caseId)?.status, 'closed');
    assert.equal(store.getCase(laterCaseId)?.status, 'queued');
    assert.equal(store.claimNext(authority)?.repairCase.caseId, laterCaseId);
  } finally { store.close(); }
});

test('failed cases rotate fairly at identical timestamps, survive reopen, and new observations cannot steal a turn',()=>{
  const filename=join(process.env.LOOP_DATA_ROOT!,randomUUID(),'fair-queue.db');
  let store=new AdminManagementStore(filename,()=>100_000);
  try{
    store.setIntent('running','start');
    const a=store.observe(observation({fingerprint:'a'}));
    const b=store.observe(observation({fingerprint:'b'}));
    const authority=store.acquireSupervisor('fair-owner')!;
    const first=store.claimScheduled(authority,true)!;assert.equal(first.repairCase.caseId,a.caseId);
    store.finishAttempt(first,{outcome:'failed',exitConfirmed:true,reason:'controlled no-spawn failed turn'});
    store.observe(observation({fingerprint:'a',summary:'new evidence must not requeue at the front'}));
    const c=store.observe(observation({fingerprint:'c'}));
    store.close();store=new AdminManagementStore(filename,()=>100_000);
    for(const caseId of [b.caseId,a.caseId,c.caseId,b.caseId,a.caseId,c.caseId]){
      const claim=store.claimScheduled(authority,true)!;
      assert.equal(claim.repairCase.caseId,caseId);
      store.finishAttempt(claim,{outcome:'failed',exitConfirmed:true,reason:'controlled no-spawn failed turn'});
    }
    assert.equal(store.observations(a.caseId).length,2);
    assert.equal(store.attempts(a.caseId).length,3);
  }finally{store.close();}
});

test('fair scheduler preserves cooldown and physical barriers and rolls back a fenced allocation',()=>{
  let now=100_000;
  const store=new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!,randomUUID(),'fair-cooldown.db'),()=>now);
  try{
    store.setIntent('running','start');
    const a=store.observe(observation({fingerprint:'a'}));const b=store.observe(observation({fingerprint:'b'}));
    const authority=store.acquireSupervisor('owner')!;
    const first=store.claimScheduled(authority,true)!;
    store.finishAttempt(first,{outcome:'failed',exitConfirmed:true,reason:'probe later',retryAt:now+1000});
    const second=store.claimScheduled(authority,true)!;assert.equal(second.repairCase.caseId,b.caseId);
    assert.equal(store.claimScheduled(authority,true),null,'cooldown and unknown process are not eligible');
    store.retireStoppedAttempt(authority,second.attempt.attemptId,true,'known no-spawn fixture');
    const before=store.attempts().length;
    store.setIntent('stopped','stop');
    assert.throws(()=>store.claimScheduled(authority,true),/运行意图/);assert.equal(store.attempts().length,before);
    store.setIntent('running','restart');now+=1000;
    assert.equal(store.claimScheduled(authority,true)!.repairCase.caseId,a.caseId,'denied allocation cannot move queue order');
  }finally{store.close();}
});

test('legacy management queue backfill retains last service order without modifying original attempts',()=>{
  const filename=join(process.env.LOOP_DATA_ROOT!,randomUUID(),'legacy-fair-queue.db');
  let now=100_000;let store=new AdminManagementStore(filename,()=>now);
  let a:string,b:string,original:unknown;
  try{
    store.setIntent('running','start');a=store.observe(observation({fingerprint:'a'})).caseId;
    now++;b=store.observe(observation({fingerprint:'b'})).caseId;
    now++;const claim=store.claimNext(store.acquireSupervisor('owner')!)!;
    store.finishAttempt(claim,{outcome:'failed',exitConfirmed:true,reason:'controlled legacy no-spawn failure'});
    original=store.attempts();
  }finally{store.close();}
  const legacy=new Database(filename);
  try{legacy.exec('DROP TABLE repair_schedule_queue');}finally{legacy.close();}
  store=new AdminManagementStore(filename,()=>now);
  try{
    assert.deepEqual(store.attempts(),original);
    assert.equal(store.claimScheduled(store.acquireSupervisor('owner')!,true)!.repairCase.caseId,b!);
    assert.equal(store.getCase(a!)!.status,'queued');
  }finally{store.close();}
});

test('lease takeover cannot release a physical Admin allocation and stale owners cannot change evidence or results', () => {
  let now = 100_000;
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db');
  const a = new AdminManagementStore(filename, () => now);
  const b = new AdminManagementStore(filename, () => now);
  try {
    a.setIntent('running', randomUUID());
    const repair = a.observe(observation());
    const owner = a.acquireSupervisor('host-a')!;
    const claim = a.claimNext(owner)!;
    a.attachProcess(claim, 777, 'generation-a');
    assert.equal(b.acquireSupervisor('host-b'), null);
    now += 31_000;
    const nextOwner = b.acquireSupervisor('host-b')!;
    assert.equal(nextOwner.token, owner.token + 1);
    assert.equal(a.renewSupervisor(owner), false);
    assert.equal(b.claimNext(nextOwner), null, 'lease expiration is not proof of physical exit');
    assert.throws(() => a.recordEvidence(claim, 'late', 'hypothesis', {}), /监督权/);
    assert.throws(() => a.finishAttempt(claim, { outcome: 'failed', exitConfirmed: true, reason: 'late' }), /监督权/);
    assert.equal(b.retireStoppedAttempt(nextOwner, claim.attempt.attemptId, false, 'unknown process'), false);
    assert.equal(b.getCase(repair.caseId)?.currentAttemptId, claim.attempt.attemptId);
    assert.equal(b.retireStoppedAttempt(nextOwner, claim.attempt.attemptId, true, 'confirmed exit'), true);
    const next = b.claimNext(nextOwner)!;
    assert.equal(next.attempt.generation, 2);
    assert.equal(next.repairCase.caseId, repair.caseId);
    assert.equal(b.attempts(repair.caseId)[0].status, 'interrupted');
  } finally { a.close(); b.close(); }
});

test('user stop invalidates an in-flight claim; replaying an old start cannot undo the stop', () => {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db'));
  try {
    const requestId = randomUUID();
    const revision = store.setIntent('running', requestId);
    store.observe(observation());
    const authority = store.acquireSupervisor('host')!;
    const claim = store.claimNext(authority)!;
    store.setIntent('stopped', randomUUID());
    assert.equal(store.setIntent('running', requestId), revision);
    assert.equal(store.control().desired_intent, 'stopped');
    assert.throws(() => store.claimNext(authority), /运行意图/);
    assert.throws(() => store.attachProcess(claim, 778), /运行意图/);
    assert.equal(store.retireStoppedAttempt(authority, claim.attempt.attemptId, true, 'no child spawned'), true);
    assert.throws(() => store.setIntent('stopped', requestId), /同一请求/);
  } finally { store.close(); }
});

test('Admin PID attachment remains launching until actual start identity is persisted, without losing its cleanup barrier',()=>{
  const store=new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!,randomUUID(),'admin.db'));
  try {
    store.setIntent('running',randomUUID());const repair=store.observe(observation());
    const owner=store.acquireSupervisor('host')!;const claim=store.claimNext(owner)!;
    store.attachProcess(claim,777);
    assert.equal(store.attempts(repair.caseId)[0].status,'launching');assert.equal(store.attempts(repair.caseId)[0].pid,777);
    assert.equal(store.claimNext(owner),null,'unknown launch still blocks a second allocation');
    store.attachProcess(claim,777,undefined,777);assert.equal(store.attempts(repair.caseId)[0].status,'launching');
    assert.throws(()=>store.attachProcess(claim,777,'  '),/进程身份/);
    store.attachProcess(claim,777,'actual-start',777);assert.equal(store.attempts(repair.caseId)[0].status,'running');
    store.attachProcess(claim,777);assert.equal(store.attempts(repair.caseId)[0].status,'running');
    assert.equal(store.attempts(repair.caseId)[0].startMarker,'actual-start');
    assert.throws(()=>store.attachProcess(claim,777,'different-start'),/进程代次/);
  }finally{store.close();}
});

test('repair evidence is immutable and Admin failures stay in the original case rather than spawning an Admin of Admin', () => {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'admin.db'));
  try {
    store.setIntent('running', randomUUID());
    const repair = store.observe(observation());
    const claim = store.claimNext(store.acquireSupervisor('host')!)!;
    assert.equal(store.recordEvidence(claim, 'hypothesis-1', 'hypothesis', { command: 'check actual version' }), true);
    assert.equal(store.recordEvidence(claim, 'hypothesis-1', 'hypothesis', { command: 'check actual version' }), false);
    assert.throws(() => store.recordEvidence(claim, 'hypothesis-1', 'hypothesis', { command: 'different' }), /不能改写/);
    const failure = observation({ origin: 'admin', fingerprint: 'admin-cli-exit', repairCaseId: repair.caseId });
    assert.equal(store.observe(failure).caseId, repair.caseId);
    assert.equal(store.observe(failure).caseId, repair.caseId);
    const persisted = store.observations(repair.caseId)[1] as { observation_json: string };
    assert.deepEqual(JSON.parse(persisted.observation_json), failure, 'Admin failure keeps its own full fingerprint and scope evidence');
    assert.throws(() => store.observe(observation({ origin: 'admin' })), /禁止递归/);
    assert.equal(store.evidence(repair.caseId).length, 1);
    assert.equal(store.finishAttempt(claim, { outcome: 'verification-requested', exitConfirmed: false, reason: 'root exited; descendants unknown' }), false);
    assert.equal(store.getCase(repair.caseId)?.status, 'running');
    assert.equal(store.finishAttempt(claim, { outcome: 'verification-requested', exitConfirmed: true, reason: 'repair ready for independent verification' }), true);
    assert.equal(store.getCase(repair.caseId)?.status, 'verifying', 'an Admin summary cannot close the repair case');
  } finally { store.close(); }
});

test('host recovery decisions retain exact failed generations and do not count repeated logs as progress', () => {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'decisions.db'));
  try {
    store.setIntent('running', randomUUID());
    const repair = store.observe(observation());
    const authority = store.acquireSupervisor('decision-host')!;
    let claim = store.claimNext(authority)!;
    const originalDecision = store.recoveryDecision(claim.attempt.attemptId);
    const originalAttemptId = claim.attempt.attemptId;
    const failures: string[] = [];
    for (let index = 0; index < 10; index++) {
      store.recordEvidence(claim, 'repeated-log', 'finding', { summary: 'Everything is almost fixed', counter: index });
      store.finishAttempt(claim, { outcome: 'failed', exitConfirmed: true, reason: 'still not independently verified' });
      failures.push(claim.attempt.attemptId);
      claim = store.claimNext(authority)!;
      assert.deepEqual(store.recoveryDecision(claim.attempt.attemptId)?.failedAttemptIds, failures);
    }
    assert.equal(store.recoveryDecision(claim.attempt.attemptId)?.method, 'alternate-runtime');
    assert.deepEqual(store.recoveryDecision(originalAttemptId), originalDecision, 'later failures never rewrite an earlier decision');
    assert.equal(store.getCase(repair.caseId)?.status, 'running', 'exhaustion is not awaiting_human');
    assert.equal(store.observations(repair.caseId).length, 1);
  } finally { store.close(); }
});

test('confirmed host loss contributes one recovery failure while user stop and update do not', () => {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'interruptions.db'));
  try {
    store.setIntent('running', randomUUID());
    store.observe(observation());
    const authority = store.acquireSupervisor('host')!;
    const original = store.claimNext(authority)!;
    assert.equal(store.retireStoppedAttempt(authority, original.attempt.attemptId, false, 'unknown exit'), false);
    assert.equal(store.retireStoppedAttempt(authority, original.attempt.attemptId, true, 'host crashed'), true);
    assert.equal(store.retireStoppedAttempt(authority, original.attempt.attemptId, true, 'duplicate proof'), false);
    const resumed = store.claimNext(authority)!;
    assert.deepEqual(store.recoveryDecision(resumed.attempt.attemptId)?.failedAttemptIds, [original.attempt.attemptId]);
    store.setIntent('stopped', randomUUID());
    store.retireStoppedAttempt(authority, resumed.attempt.attemptId, true, 'user stop');
    store.setIntent('running', randomUUID());
    const afterStop = store.claimNext(authority)!;
    assert.deepEqual(store.recoveryDecision(afterStop.attempt.attemptId)?.failedAttemptIds, [original.attempt.attemptId]);
    store.setUpdateSilence(true, randomUUID());
    store.retireStoppedAttempt(authority, afterStop.attempt.attemptId, true, 'update suspension');
    store.setUpdateSilence(false, randomUUID());
    const afterUpdate = store.claimNext(authority)!;
    assert.deepEqual(store.recoveryDecision(afterUpdate.attempt.attemptId)?.failedAttemptIds, [original.attempt.attemptId]);
  } finally { store.close(); }
});

test('activity novelty survives management restart and remains separate from repair completion authority', () => {
  const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'activity.db'));
  try {
    store.setIntent('running', randomUUID());
    const repair = store.observe(observation());
    const authority = store.acquireSupervisor('host')!;
    const claim = store.claimNext(authority)!;
    const operation = JSON.stringify({ tool: 'read', input: { file_path: 'original.ts' } });
    assert.equal(store.recordActivityCheckpoint(claim, operation), true);
    assert.equal(store.recordActivityCheckpoint(claim, operation), false);
    assert.equal(store.getCase(repair.caseId)?.status, 'running');
    store.finishAttempt(claim, { outcome: 'failed', exitConfirmed: true, reason: 'Original acceptance still failed' });
    const reopened = new AdminManagementStore(store.filename);
    try {
      const next = reopened.claimNext(authority)!;
      assert.equal(reopened.knownActivityCheckpoint(next, operation), true);
      assert.equal(reopened.recordActivityCheckpoint(next, operation), false);
      assert.equal(reopened.getCase(repair.caseId)?.status, 'running', 'activity is not a verification receipt or Case closure');
      assert.throws(() => store.recordActivityCheckpoint(claim, 'late-operation'), /已失效/);
    } finally { reopened.close(); }
  } finally { store.close(); }
});

test('management storage cannot accidentally open the application or business database', () => {
  assert.throws(() => new AdminManagementStore('/tmp/loop-ui.db'), /独立/);
  assert.throws(() => new AdminManagementStore('/tmp/loopwork.db'), /独立/);
  assert.throws(() => new AdminManagementStore('admin.db'), /独立/);
});

test('management schema never mutates an existing business database or a newer unsupported management version', () => {
  const filename = join(process.env.LOOP_DATA_ROOT!, `foreign-database-${randomUUID()}.db`);
  const business = new Database(filename);
  business.exec('CREATE TABLE tasks(task_id TEXT PRIMARY KEY)');
  business.close();
  assert.throws(() => new AdminManagementStore(filename), /已有业务/);
  const unchanged = new Database(filename, { readonly: true });
  try {
    assert.equal(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'admin_control'").get(), undefined);
    assert.equal(unchanged.pragma('journal_mode', { simple: true }), 'delete');
  } finally { unchanged.close(); }
  const futureFile = join(process.env.LOOP_DATA_ROOT!, `future-admin-${randomUUID()}.db`);
  const future = new Database(futureFile);
  future.exec('PRAGMA user_version = 100');
  future.close();
  assert.throws(() => new AdminManagementStore(futureFile), /拒绝降级写入/);
  const version = new Database(futureFile, { readonly: true });
  try { assert.equal(version.pragma('user_version', { simple: true }), 100); } finally { version.close(); }
});

test('compiled Admin management code has no business/Web dependency and records diagnostics in a separate database', async () => {
  const result = await build({
    entryPoints: {
      'admin-management': 'src/infrastructure/admin-management-store.ts',
      'admin-controller': 'src/application/admin-controller.ts',
    },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['better-sqlite3'],
    write: false, metafile: true, outdir: join(process.env.LOOP_DATA_ROOT!, 'admin-boundary-build'),
  });
  const inputs = Object.keys(result.metafile!.inputs);
  assert.equal(inputs.some(path => /src\/(?:application\/(?:tasks|progress-dispatch|interventions)|infrastructure\/database)\.ts$/.test(path)), false);
  assert.equal(inputs.some(path => /node_modules\/(?:next|electron)\//.test(path)), false);
  const bundle = result.outputFiles!.find(file => file.path.endsWith('admin-management.js'))!;
  const filename = join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'compiled-admin.db');
  const child = spawnSync(process.execPath, ['-e', `
    eval(require('node:fs').readFileSync(0, 'utf8'));
    const store = new module.exports.AdminManagementStore(${JSON.stringify(filename)});
    const repair = store.observe(${JSON.stringify(observation())});
    console.log(JSON.stringify({ version: repair.originalVersion, count: store.observations(repair.caseId).length }));
    store.close();
  `], { cwd: process.cwd(), input: bundle.text, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, LOOP_GLOBAL_DB_PATH: join(process.env.LOOP_DATA_ROOT!, 'missing-business-parent', 'unavailable.db') } });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { version: 'v1', count: 1 });
});
