import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { acceptanceTaskDescription, readRecoveryScenarioState } from './recovery-acceptance-scenario';

test('acceptance external root keeps a stable cwd outside the replaceable app image', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/recovery-acceptance-scenario.ts'), 'utf8');
  assert.match(source, /cwd:\s*options\.dataRoot/);
  assert.doesNotMatch(source, /cwd:\s*options\.appRoot/);
  assert.match(source, /codexModel:\s*'gpt-5\.6-luna'/);
});

function fixture() {
  const admin = new Database(':memory:'); const business = new Database(':memory:');
  admin.exec(`CREATE TABLE repair_cases(case_id TEXT PRIMARY KEY,status TEXT,generation INTEGER,current_attempt_id TEXT,created_at INTEGER,updated_at INTEGER);`);
  business.exec(`
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,agile_status TEXT,current_subagent TEXT,closure_status TEXT,updated_at TEXT);
    CREATE TABLE interventions(intervention_id TEXT PRIMARY KEY,task_id TEXT,item_id TEXT,source_execution_id TEXT,status TEXT,
      repair_case_id TEXT,summary TEXT,source_kind TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE workflow_items(item_id TEXT PRIMARY KEY,task_id TEXT,work_key TEXT,status TEXT,revision INTEGER,dispatch_epoch INTEGER,updated_at TEXT);
    CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY,task_id TEXT,work_item_id TEXT,agent TEXT,status TEXT,attempt INTEGER,started_at TEXT,finished_at TEXT);
    INSERT INTO tasks VALUES('task','in dev','dev-agent','none','now');
    INSERT INTO workflow_items VALUES('fault-item','task','dev','waiting',1,2,'now');
    INSERT INTO execution_attempts VALUES('execution','task','fault-item','test-agent','cancelled',1,'1','1');
  `);
  return { admin, business };
}

test('scenario state requires a linked closed Case and later ordinary business progress', () => {
  const h = fixture();
  try {
    assert.equal(readRecoveryScenarioState(h.admin, h.business, 'task').complete, false);
    h.business.prepare("INSERT INTO interventions VALUES('fault','task','fault-item','execution','pending','case','failed','agent-fault','now','now')").run();
    h.admin.prepare("INSERT INTO repair_cases VALUES('case','observing',2,NULL,1,2)").run();
    assert.equal(readRecoveryScenarioState(h.admin, h.business, 'task').complete, false);
    h.admin.prepare("UPDATE repair_cases SET status='closed'").run();
    assert.equal(readRecoveryScenarioState(h.admin, h.business, 'task').complete, false);
    h.business.prepare("INSERT INTO workflow_items VALUES('later','task','test','running',1,1,'now')").run();
    assert.equal(readRecoveryScenarioState(h.admin, h.business, 'task').complete, false,
      'a new or running Work Item is scheduling state, not a recovered business fact');
    h.business.prepare("INSERT INTO execution_attempts VALUES('later-execution','task','later','test-agent','applied',1,'2','2')").run();
    const state = readRecoveryScenarioState(h.admin, h.business, 'task');
    assert.equal(state.complete, true); assert.deepEqual(state.caseIds, ['case']);
  } finally { h.admin.close(); h.business.close(); }
});

test('scenario task text keeps each controlled fault distinct', () => {
  const devDescription = acceptanceTaskDescription('dev-missing', 'npm test');
  assert.match(devDescription, /npm test/);
  assert.match(devDescription, /两个有限 JavaScript number/);
  assert.match(devDescription, /非 number 输入明确不在本次范围/);
  assert.match(acceptanceTaskDescription('test-old-service', undefined, 'http:\/\/127.0.0.1:9'), /旧服务/);
  assert.match(acceptanceTaskDescription('test-misjudgment'), /无关的失败检查/);
});
