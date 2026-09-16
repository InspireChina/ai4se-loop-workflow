import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';
import {readBusinessLifecycleObservation} from './business-lifecycle-observation';
import {runtimeHostAuditSchema} from '../domain/runtime-host-audit';

function initialize(db:Database.Database){
  db.exec("CREATE TABLE loop_meta(key TEXT);CREATE TABLE project_settings(setting_key TEXT);CREATE TABLE internal_agent_drafts(work_type TEXT)");
  db.exec(`CREATE TABLE execution_attempts(execution_id TEXT,status TEXT,last_error TEXT,finished_at TEXT,heartbeat_at TEXT,
    result_json TEXT,created_at TEXT,lease_owner TEXT,lease_expires_at TEXT);
    CREATE TABLE agent_results(execution_id TEXT,application_status TEXT)`);
  db.exec(readFileSync(join(process.cwd(),'migrations/030_runner_recovery_without_execution_leases.sql'),'utf8'));
  db.exec(readFileSync(join(process.cwd(),'migrations/089_loop_run_lifecycle.sql'),'utf8'));
}

test('actual read-only lifecycle observation preserves expired leases and failure facts without claiming health',()=>{
  const path=join(process.env.LOOP_DATA_ROOT!,`${randomUUID()}.db`);
  mkdirSync(process.env.LOOP_DATA_ROOT!,{recursive:true});
  const writer=new Database(path);initialize(writer);
  writer.exec(`UPDATE loop_lifecycle_state SET desired_intent='running',intent_revision=8,actual_phase='crashed',
    active_run_id='missing-run',restart_count=4,last_error='runner exited',mode='update-silence',update_target_version='0.1.21';
    INSERT INTO loop_supervisor_lease(singleton,owner_id,fencing_token,expires_at) VALUES(1,'old-owner',7,'2000-01-01T00:00:00Z')`);
  const before=writer.prepare('SELECT * FROM loop_lifecycle_state').all();writer.close();
  const reader=new Database(path,{readonly:true,fileMustExist:true});
  try{
    const observed=readBusinessLifecycleObservation(reader)!;
    assert.equal(observed.phase,'crashed');assert.equal(observed.desired,'running');assert.equal(observed.revision,8);
    assert.equal(observed.lastError,'runner exited');assert.equal(observed.targetVersion,'0.1.21');
    assert.equal(observed.lease?.ownerId,'old-owner');assert.equal(observed.lease?.token,7);
    assert.equal(observed.run,null);assert.equal('healthy' in observed,false);
    assert.deepEqual(reader.prepare('SELECT * FROM loop_lifecycle_state').all(),before);
    assert.equal(reader.prepare('SELECT expires_at FROM loop_supervisor_lease').get() instanceof Object,true);
    assert.ok(runtimeHostAuditSchema.parse({databasePresent:true,knownProtocol:true,managed:[],executions:[],runs:[],lifecycle:observed}));
  }finally{reader.close();}
});

test('pre-lifecycle database and absent singleton are unknown, never initialized or guessed stopped',()=>{
  const db=new Database(':memory:');
  try{
    assert.equal(readBusinessLifecycleObservation(db),undefined);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[]);
    initialize(db);db.exec('DELETE FROM loop_lifecycle_state');
    assert.equal(readBusinessLifecycleObservation(db),undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM loop_lifecycle_state').get() as {n:number}).n,0);
  }finally{db.close();}
});

test('actual run timestamps are read, while incompatible schema fails explicitly rather than producing healthy defaults',()=>{
  const db=new Database(':memory:');
  try{
    initialize(db);db.prepare("INSERT INTO loop_runs(run_id,owner,status,started_at,heartbeat_at) VALUES('observed','fixture','running','2026-09-16','2026-09-16')").run();
    db.exec("UPDATE loop_lifecycle_state SET active_run_id='observed',actual_phase='running'");
    assert.deepEqual(readBusinessLifecycleObservation(db)?.run,{status:'running',startedAt:'2026-09-16',heartbeatAt:'2026-09-16'});
    db.exec('ALTER TABLE loop_lifecycle_state DROP COLUMN retry_at');
    assert.throws(()=>readBusinessLifecycleObservation(db),/retry_at/);
  }finally{db.close();}
});
