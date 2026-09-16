import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {runtimeBusinessBaselineSchema} from '../domain/runtime-business-progress';
import type {RuntimeRepairHandoff} from '../domain/runtime-repair-followup';
import {readRuntimeOriginalOperationInDb} from './runtime-original-operation';

function fixture(){
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());mkdirSync(root,{recursive:true});
  const filename=join(root,'business.db'),writer=new Database(filename);
  writer.exec(`PRAGMA user_version=125;
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY);
    CREATE TABLE workflow_items(item_id TEXT PRIMARY KEY);
    CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY);
    CREATE TABLE loop_supervisor_lease(singleton INTEGER PRIMARY KEY,owner_id TEXT,fencing_token INTEGER,expires_at TEXT);
    CREATE TABLE loop_lifecycle_state(singleton INTEGER PRIMARY KEY,desired_intent TEXT,intent_revision INTEGER,
      mode TEXT,actual_phase TEXT,active_run_id TEXT,last_error TEXT);
    INSERT INTO loop_supervisor_lease VALUES(1,'hosted-123',41,'2099-01-01T00:00:00.000Z');
    INSERT INTO loop_lifecycle_state VALUES(1,'running',9,'normal','stopped',NULL,NULL);`);
  const artifact={root:join(root,'candidate'),sourceId:'a'.repeat(64),artifactId:'b'.repeat(64),version:'0.1.20'};
  const baseline=runtimeBusinessBaselineSchema.parse({schemaVersion:1,caseId:'case',verificationAttemptId:'verification',
    updateId:'update',candidateArtifact:artifact,businessStore:'absent',originalBoundaryMs:1,tasks:[]});
  const handoff:RuntimeRepairHandoff={caseId:'case',verificationAttemptId:'verification',updateId:'update',artifact,
    installationRevision:2,hostAllocationId:'host',hostSequence:2,rootOwnerId:'root',rootToken:3,
    pid:123,marker:'marker',groupId:123,parentPid:122,businessSupervisionToken:41};
  const reader=new Database(filename,{readonly:true,fileMustExist:true});
  const read=()=>readRuntimeOriginalOperationInDb(reader,{baseline,handoff,originalObservationIds:['fault-b','fault-a'],
    assertCurrent:()=>{},now:()=>Date.parse('2026-09-16T00:00:00.000Z')});
  return {writer,reader,baseline,handoff,read,close:()=>{reader.close();writer.close();}};
}

test('no-item runtime operation binds the actual initialized protocol, fresh host lease and every original target',()=>{
  const f=fixture();try{
    const receipt=f.read();
    assert.equal(receipt.businessStoreBefore,'absent');assert.equal(receipt.businessStoreAfter,'present');
    assert.equal(receipt.databaseUserVersion,125);assert.equal(receipt.supervision.fencingToken,f.handoff.businessSupervisionToken);
    assert.deepEqual(receipt.originalObservationIds,['fault-a','fault-b']);
    assert.deepEqual(receipt.schemaTables,['execution_attempts','loop_lifecycle_state','loop_supervisor_lease','tasks','workflow_items']);
    assert.throws(()=>readRuntimeOriginalOperationInDb(f.writer,{baseline:f.baseline,handoff:f.handoff,
      originalObservationIds:['fault-a'],assertCurrent:()=>{}}),/readonly/);
    assert.throws(()=>readRuntimeOriginalOperationInDb(f.reader,{baseline:{...f.baseline,businessStore:'present',tasks:[{taskId:'task',items:[{
      itemId:'item',revision:1,dispatchEpoch:1,previousExecutionIds:[]}]}]},handoff:f.handoff,
      originalObservationIds:['fault-a'],assertCurrent:()=>{}}),/必须观察正常业务推进/);
  }finally{f.close();}
});

test('missing protocol, stale or foreign supervision and unhealthy lifecycle never become an original-operation receipt',()=>{
  for(const mutation of [
    "UPDATE loop_supervisor_lease SET fencing_token=42",
    "UPDATE loop_supervisor_lease SET expires_at='2000-01-01T00:00:00.000Z'",
    "UPDATE loop_lifecycle_state SET actual_phase='crashed',last_error='startup failed'",
    'DROP TABLE workflow_items',
  ]){
    const f=fixture();try{f.writer.exec(mutation);assert.throws(f.read);}finally{f.close();}
  }
});
