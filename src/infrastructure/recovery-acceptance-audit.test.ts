import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import { auditRecoveryAcceptance } from './recovery-acceptance-audit';

function fixture() {
  const admin = new Database(':memory:');
  admin.exec(`
    CREATE TABLE repair_cases(case_id TEXT PRIMARY KEY,scope TEXT,status TEXT,current_attempt_id TEXT,generation INTEGER,created_at INTEGER);
    CREATE TABLE repair_attempts(attempt_id TEXT PRIMARY KEY,case_id TEXT,role TEXT,status TEXT,pid INTEGER,start_marker TEXT,process_group_id INTEGER,generation INTEGER,started_at INTEGER);
    CREATE TABLE repair_verifications(attempt_id TEXT,receipt_json TEXT);
    CREATE TABLE repair_verification_purposes(attempt_id TEXT,purpose TEXT);
    CREATE TABLE repair_followups(case_id TEXT,verification_attempt_id TEXT,kind TEXT);
    CREATE TABLE repair_runtime_business_closures(case_id TEXT);
    CREATE TABLE repair_runtime_original_operations(case_id TEXT);
  `);
  const business = new Database(':memory:');
  business.exec(`
    CREATE TABLE tasks(task_id TEXT,agile_status TEXT);
    CREATE TABLE execution_attempts(execution_id TEXT,status TEXT);
    CREATE TABLE interventions(intervention_id TEXT,source_kind TEXT,status TEXT);
    CREATE TABLE execution_processes(allocation_id TEXT,execution_id TEXT,status TEXT,pid INTEGER);
    CREATE TABLE loop_managed_processes(process_id TEXT,status TEXT,pid INTEGER);
  `);
  return { admin, business };
}

function receipt() {
  const plan = { sourceRepairAttemptId: 'repair', expectedVersion: 'v1', originalObservationIds: ['original'], versionCommand: 'version',
    reproduction: { targetRef: 'failure', command: 'reproduce' }, acceptanceChecks: [{ targetRef: 'acceptance', command: 'accept' }] };
  const checks = [
    { kind: 'version-before', targetRef: 'runtime-version', command: 'version', result: { exitCode: 0, stdout: 'v1', stderr: '', exitConfirmed: true } },
    { kind: 'reproduction', targetRef: 'failure', command: 'reproduce', result: { exitCode: 0, stdout: '', stderr: '', exitConfirmed: true } },
    { kind: 'acceptance', targetRef: 'acceptance', command: 'accept', result: { exitCode: 0, stdout: '', stderr: '', exitConfirmed: true } },
    { kind: 'version-after', targetRef: 'runtime-version', command: 'version', result: { exitCode: 0, stdout: 'v1', stderr: '', exitConfirmed: true } },
  ];
  return JSON.stringify({ plan, checks, passed: true, exitConfirmed: true, reason: 'verified' });
}

test('audit accepts only a closed business Case with independent verification, handoff and progress', () => {
  const { admin, business } = fixture();
  admin.prepare("INSERT INTO repair_cases VALUES('case','work-item','closed',NULL,2,1)").run();
  admin.prepare("INSERT INTO repair_attempts VALUES('verify','case','verification','completed',NULL,NULL,NULL,2,1)").run();
  admin.prepare('INSERT INTO repair_verifications VALUES(?,?)').run('verify', receipt());
  admin.prepare("INSERT INTO repair_verification_purposes VALUES('verify','repair-verification')").run();
  admin.prepare("INSERT INTO repair_followups VALUES('case','verify','handoff'),('case','verify','business-progress')").run();
  const result = auditRecoveryAcceptance(admin, business, { now: 1 });
  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
  admin.close(); business.close();
});

test('audit reports human fallback, false closure, duplicate ownership and stopped residuals together', () => {
  const { admin, business } = fixture();
  admin.prepare("INSERT INTO repair_cases VALUES('case','work-item','closed',NULL,2,1)").run();
  admin.prepare("INSERT INTO repair_attempts VALUES('a','case','investigation','running',1,'m',1,1,1),('b','case','investigation','launching',NULL,NULL,NULL,2,2)").run();
  business.prepare("INSERT INTO interventions VALUES('human','agent-fault','awaiting_human')").run();
  business.prepare("INSERT INTO execution_processes VALUES('p1','execution','running',10),('p2','execution','terminating',11)").run();
  const result = auditRecoveryAcceptance(admin, business, { expectStopped: true, now: 1 });
  assert.equal(result.passed, false);
  assert.deepEqual(new Set(result.violations.map(row => row.code)), new Set([
    'duplicate-active-admin', 'unowned-active-admin', 'closed-without-independent-verification',
    'agent-fault-awaiting-human', 'duplicate-active-execution', 'residual-process-barrier-after-stop',
  ]));
  admin.close(); business.close();
});

test('audit cannot pass a requested scenario when its RepairCase never existed', () => {
  const { admin, business } = fixture();
  const result = auditRecoveryAcceptance(admin, business, { requiredCaseIds: ['expected-case'], now: 1 });
  assert.equal(result.passed, false);
  assert.deepEqual(result.violations, [{
    code: 'required-repair-case-missing', detail: 'Acceptance scenario did not create every required RepairCase', ids: ['expected-case'],
  }]);
  admin.close(); business.close();
});
