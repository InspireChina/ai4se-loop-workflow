import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type {RuntimeCliProcess} from '../domain/runtime-cli';
import type {RuntimeRepairHandoff} from '../domain/runtime-repair-followup';
import {runtimeBusinessBaselineSchema} from '../domain/runtime-business-progress';
import {captureRuntimeBusinessBaselineInDb,findRuntimeBusinessProgressCandidatesInDb,findRuntimeBusinessCohortChangesInDb} from './runtime-business-progress';

// Controlled SQL fixtures exercise read-only evidence gates. They are not
// real model, physical host, runtime-update or end-to-end recovery proofs.
function fixture(){
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());mkdirSync(root,{recursive:true});
  const filename=join(root,'business.db');const writer=new Database(filename);
  writer.exec(`CREATE TABLE projects(project_id TEXT PRIMARY KEY,deleted_at TEXT);
    CREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT,workflow_engine TEXT,is_paused INTEGER);
    CREATE TABLE workflow_items(item_id TEXT PRIMARY KEY,task_id TEXT,revision INTEGER,dispatch_epoch INTEGER,
      origin TEXT,status TEXT,completion_authority TEXT,created_at TEXT,completed_at TEXT,updated_at TEXT NOT NULL DEFAULT '2026-09-01 00:00:00');
    CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY,task_id TEXT,work_item_id TEXT,status TEXT,input_json TEXT);
    CREATE TABLE agent_results(result_id TEXT PRIMARY KEY,execution_id TEXT,task_id TEXT,application_status TEXT,effect_outcome TEXT,applied_at TEXT);
    CREATE TABLE workflow_item_events(event_id TEXT PRIMARY KEY,item_id TEXT,execution_id TEXT,event_key TEXT,event_type TEXT,authority TEXT);
    CREATE TABLE execution_processes(allocation_id TEXT PRIMARY KEY,execution_id TEXT,status TEXT);
    CREATE TABLE interventions(intervention_id TEXT PRIMARY KEY,task_id TEXT,item_id TEXT,status TEXT);
    INSERT INTO projects VALUES('project',NULL);
    INSERT INTO tasks VALUES('original-a','project','native',0),('original-b','project','native',0),('new-task','project','native',0);
    INSERT INTO workflow_items(item_id,task_id,revision,dispatch_epoch,origin,status,completion_authority,created_at,completed_at) VALUES
      ('a','original-a',1,2,'native','ready',NULL,'2026-09-01 00:00:00',NULL),
      ('b','original-b',1,3,'native','waiting',NULL,'2026-09-01 00:00:00',NULL),
      ('old','original-a',1,1,'native','completed','agent','2026-09-01 00:00:00','2026-09-01 00:10:00'),
      ('new','new-task',1,1,'native','ready',NULL,'2026-09-03 00:00:00',NULL);
    INSERT INTO execution_attempts VALUES('old-execution','original-a','a','retryable_failed','{"delegation":{"workItemEpoch":2}}');`);
  const reader=new Database(filename,{readonly:true,fileMustExist:true});
  const candidateArtifact={artifactId:'a'.repeat(64),sourceId:'b'.repeat(64),version:'0.1.20',root:'/private/candidate'};
  const binding={caseId:'case',verificationAttemptId:'verification',updateId:'update',candidateArtifact,
    originalBoundaryMs:Date.parse('2026-09-02T00:00:00Z'),assertQuiescent:()=>{}};
  const capture=()=>captureRuntimeBusinessBaselineInDb(reader,binding);
  const handoff:RuntimeRepairHandoff={caseId:'case',verificationAttemptId:'verification',updateId:'update',
    artifact:candidateArtifact,
    installationRevision:2,hostAllocationId:'new-host',hostSequence:2,rootOwnerId:'root',rootToken:2,
    pid:102,marker:'actual-host-marker',groupId:102,parentPid:101,businessSupervisionToken:7};
  const cli=(executionId:string,hostAllocationId='new-host'):RuntimeCliProcess=>({allocationId:`cli:${executionId}`,hostAllocationId,
    executionId,ownerPid:103,pid:104,marker:'actual-cli-marker',groupId:104,status:'exited'});
  const apply=(itemId:string,executionId:string)=>{
    const item=writer.prepare('SELECT task_id,dispatch_epoch FROM workflow_items WHERE item_id=?').get(itemId) as {task_id:string;dispatch_epoch:number};
    writer.prepare('INSERT OR REPLACE INTO execution_attempts VALUES(?,?,?,?,?)').run(executionId,item.task_id,itemId,'applied',JSON.stringify({delegation:{workItemEpoch:item.dispatch_epoch}}));
    writer.prepare('UPDATE workflow_items SET status=\'completed\',completion_authority=\'agent\',completed_at=\'2026-09-04 00:00:00\' WHERE item_id=?').run(itemId);
    writer.prepare('INSERT OR REPLACE INTO agent_results VALUES(?,?,?,?,?,?)').run(`result:${executionId}`,executionId,item.task_id,'applied','advanced','2026-09-04 00:00:00');
    writer.prepare('INSERT OR REPLACE INTO workflow_item_events VALUES(?,?,?,?,?,?)').run(`event:${executionId}`,itemId,executionId,`result:result:${executionId}`,'complete','agent');
  };
  const baseline=capture();
  const observe=(clis:RuntimeCliProcess[],handoffs=[handoff])=>findRuntimeBusinessProgressCandidatesInDb(reader,{baseline,handoffs,clis,assertCurrent:()=>{}});
  return {writer,reader,baseline,binding,capture,handoff,cli,apply,observe,close:()=>{reader.close();writer.close();}};
}

test('runtime baseline freezes original obligations and old executions without business writes',()=>{
  const f=fixture();try{
    assert.deepEqual(f.baseline.tasks.map(task=>[task.taskId,task.items.map(item=>item.itemId)]),[['original-a',['a']],['original-b',['b']]]);
    assert.deepEqual(f.baseline.tasks[0].items[0].previousExecutionIds,['old-execution']);
    assert.deepEqual(f.observe([]),[]);
    assert.throws(()=>captureRuntimeBusinessBaselineInDb(f.writer,f.binding),/只读/);
    let checks=0;
    assert.throws(()=>captureRuntimeBusinessBaselineInDb(f.reader,{...f.binding,assertQuiescent:()=>{if(++checks===3)throw new Error('fenced');}}),/fenced/);
    assert.equal((f.writer.prepare('SELECT COUNT(*) AS count FROM execution_attempts').get() as {count:number}).count,1);
    f.writer.prepare('UPDATE workflow_items SET created_at=\'not-a-date\' WHERE item_id=\'b\'').run();
    assert.throws(f.capture,/时间无效/);
  }finally{f.close();}
});

test('recurring runtime faults freeze the whole original time interval without dropping later affected demands',()=>{
  const f=fixture();try{
    f.writer.prepare("UPDATE workflow_items SET status='completed',completed_at='2026-09-02 12:00:00' WHERE item_id='a'").run();
    const binding={...f.binding,originalStartBoundaryMs:Date.parse('2026-09-02T00:00:00Z'),
      originalBoundaryMs:Date.parse('2026-09-03T12:00:00Z')};
    const baseline=captureRuntimeBusinessBaselineInDb(f.reader,binding);
    assert.deepEqual(baseline.tasks.map(task=>task.taskId),['new-task','original-a','original-b']);
    assert.equal(baseline.originalStartBoundaryMs,binding.originalStartBoundaryMs);
    assert.equal(baseline.tasks.some(task=>task.items.some(item=>item.itemId==='old')),false,'pre-first-fault completion remains historical');
    assert.throws(()=>captureRuntimeBusinessBaselineInDb(f.reader,{...binding,originalStartBoundaryMs:binding.originalBoundaryMs+1}),/时间范围不能倒置/);
    f.writer.prepare("UPDATE workflow_items SET created_at='2026-09-04' WHERE item_id='new'").run();
    assert.equal(captureRuntimeBusinessBaselineInDb(f.reader,binding).tasks.some(task=>task.taskId==='new-task'),false);
  }finally{f.close();}
});

test('frozen original work follows only actual same-contract supersession links and preserves every old execution',()=>{
  const f=fixture();try{
    f.writer.exec(`ALTER TABLE workflow_items ADD COLUMN work_key TEXT;
      ALTER TABLE workflow_items ADD COLUMN kind TEXT;
      ALTER TABLE workflow_items ADD COLUMN story_index INTEGER;
      ALTER TABLE workflow_items ADD COLUMN superseded_by_item_id TEXT;
      UPDATE workflow_items SET work_key=item_id,kind='agent';
      UPDATE workflow_items SET status='superseded',updated_at='2026-09-03',superseded_by_item_id='a2' WHERE item_id='a';
      INSERT INTO workflow_items(item_id,task_id,revision,dispatch_epoch,origin,status,completion_authority,created_at,completed_at,updated_at,
        work_key,kind,story_index,superseded_by_item_id) VALUES
        ('a2','original-a',2,1,'native','superseded',NULL,'2026-09-03',NULL,'2026-09-03','a','agent',NULL,'a3'),
        ('a3','original-a',3,1,'native','ready',NULL,'2026-09-03',NULL,'2026-09-03','a','agent',NULL,NULL);
      INSERT INTO execution_attempts VALUES('middle-execution','original-a','a2','retryable_failed','{"delegation":{"workItemEpoch":1}}');`);
    const baseline=f.capture(),item=baseline.tasks.find(task=>task.taskId==='original-a')!.items.find(item=>item.itemId==='a3')!;
    assert.equal(item.revision,3);assert.equal(item.workKey,'a');
    assert.deepEqual(item.predecessors,[{itemId:'a',revision:1},{itemId:'a2',revision:2}]);
    assert.deepEqual(item.previousExecutionIds,['middle-execution','old-execution']);
    f.apply('a3','fresh-successor');
    const found=findRuntimeBusinessProgressCandidatesInDb(f.reader,{baseline,handoffs:[f.handoff],clis:[f.cli('fresh-successor')],assertCurrent:()=>{}});
    assert.equal(found.length,1);assert.equal(found[0].itemId,'a3');
    f.writer.prepare("UPDATE workflow_items SET story_index=99 WHERE item_id='a3'").run();
    assert.deepEqual(findRuntimeBusinessProgressCandidatesInDb(f.reader,{baseline,handoffs:[f.handoff],
      clis:[f.cli('fresh-successor')],assertCurrent:()=>{}}),[],'changed contract identity cannot reuse frozen original evidence');
    f.writer.prepare("UPDATE workflow_items SET story_index=NULL WHERE item_id='a3'").run();
    // A new unrelated high revision must not be substituted for a link.
    f.writer.prepare("UPDATE workflow_items SET superseded_by_item_id='missing' WHERE item_id='a2'").run();
    assert.throws(f.capture,/回退链缺失/);
    f.writer.prepare("UPDATE workflow_items SET superseded_by_item_id='a' WHERE item_id='a2'").run();
    assert.throws(f.capture,/回退链缺失/);
    f.writer.prepare("UPDATE workflow_items SET superseded_by_item_id='a3' WHERE item_id='a2'").run();
    for(const field of ['work_key','kind','story_index','task_id','revision']){
      const original=f.writer.prepare(`SELECT ${field} AS value FROM workflow_items WHERE item_id='a3'`).get() as {value:unknown};
      f.writer.prepare(`UPDATE workflow_items SET ${field}=? WHERE item_id='a3'`).run(field==='revision'?1:field==='story_index'?9:'other');
      assert.throws(f.capture,/回退链缺失/);
      f.writer.prepare(`UPDATE workflow_items SET ${field}=? WHERE item_id='a3'`).run(original.value as string|number|null);
    }
  }finally{f.close();}
});

test('supersession deduplication retains the longest original chain even when the current head is read first',()=>{
  const f=fixture();try{
    f.writer.exec(`ALTER TABLE workflow_items ADD COLUMN work_key TEXT;
      ALTER TABLE workflow_items ADD COLUMN kind TEXT;
      ALTER TABLE workflow_items ADD COLUMN story_index INTEGER;
      ALTER TABLE workflow_items ADD COLUMN superseded_by_item_id TEXT;
      UPDATE workflow_items SET work_key=item_id,kind='agent';
      INSERT INTO workflow_items(item_id,task_id,revision,dispatch_epoch,origin,status,created_at,updated_at,
        work_key,kind,superseded_by_item_id) VALUES
        ('zz-original','original-a',1,2,'native','superseded','2026-09-01','2026-09-03','chain','agent','mm-middle'),
        ('mm-middle','original-a',2,1,'native','superseded','2026-09-03','2026-09-03','chain','agent','aa-head'),
        ('aa-head','original-a',3,1,'native','ready','2026-09-03','2026-09-03','chain','agent',NULL);
      INSERT INTO execution_attempts VALUES('chain-original','original-a','zz-original','failed','{}'),
        ('chain-middle','original-a','mm-middle','failed','{}'),('chain-head','original-a','aa-head','failed','{}');`);
    const baseline=captureRuntimeBusinessBaselineInDb(f.reader,{...f.binding,
      originalStartBoundaryMs:Date.parse('2026-09-02T00:00:00Z'),originalBoundaryMs:Date.parse('2026-09-04T00:00:00Z')});
    const items=baseline.tasks.find(task=>task.taskId==='original-a')!.items.filter(item=>item.workKey==='chain');
    assert.equal(items.length,1);assert.equal(items[0].itemId,'aa-head');
    assert.deepEqual(items[0].predecessors,[{itemId:'zz-original',revision:1},{itemId:'mm-middle',revision:2}]);
    assert.deepEqual(items[0].previousExecutionIds,['chain-head','chain-middle','chain-original']);
  }finally{f.close();}
});

test('later source changes are fresh derived facts, never automatic authority for another revision',()=>{
  const f=fixture();try{
    const read=(progressTaskIds:string[]=[])=>findRuntimeBusinessCohortChangesInDb(f.reader,{baseline:f.baseline,progressTaskIds,assertCurrent:()=>{}});
    assert.deepEqual(read(),[]);
    f.writer.prepare("UPDATE workflow_items SET dispatch_epoch=3 WHERE item_id='a'").run();assert.deepEqual(read(),[],'ordinary retry cycle remains original work');
    f.writer.prepare("UPDATE workflow_items SET status='superseded' WHERE item_id='a'").run();
    const changed=read();assert.equal(changed.length,1);assert.equal(changed[0].originalItemId,'a');assert.equal(changed[0].originalRevision,1);
    assert.equal(changed[0].current!.status,'superseded');assert.deepEqual(read(['original-a']),[],'actual proven demand progress is not lost to a different obsolete item');
    f.writer.prepare("UPDATE workflow_items SET revision=2,status='ready' WHERE item_id='a'").run();assert.equal(read()[0].current!.revision,2);
    f.writer.prepare("DELETE FROM workflow_items WHERE item_id='a'").run();assert.equal(read()[0].current,null);
    assert.throws(()=>findRuntimeBusinessCohortChangesInDb(f.writer,{baseline:f.baseline,progressTaskIds:[],assertCurrent:()=>{}}),/只读/);
    assert.throws(()=>findRuntimeBusinessCohortChangesInDb(f.reader,{baseline:f.baseline,progressTaskIds:[],assertCurrent:()=>{throw new Error('STOP');}}),/STOP/);
  }finally{f.close();}
});

test('paused, deleted and explicitly cancelled demands are user control, not cohort repair failures',()=>{
  const f=fixture();try{
    f.writer.prepare("UPDATE workflow_items SET status='superseded' WHERE item_id='a'").run();
    const read=()=>findRuntimeBusinessCohortChangesInDb(f.reader,{baseline:f.baseline,progressTaskIds:[],assertCurrent:()=>{}});
    assert.equal(read().length,1);
    f.writer.prepare("UPDATE tasks SET is_paused=1 WHERE task_id='original-a'").run();assert.deepEqual(read(),[]);
    f.writer.prepare("UPDATE tasks SET is_paused=0 WHERE task_id='original-a'").run();
    f.writer.prepare("UPDATE projects SET deleted_at='2026-09-16' WHERE project_id='project'").run();assert.deepEqual(read(),[]);
    f.writer.prepare("UPDATE projects SET deleted_at=NULL WHERE project_id='project'").run();
    f.writer.prepare('INSERT INTO workflow_item_events VALUES(?,?,?,?,?,?)').run('cancel','a',null,'task:cancelled','cancel','human');
    assert.deepEqual(read(),[]);
  }finally{f.close();}
});

test('old saved results, new unrelated demands and unbound CLI completions are not runtime recovery',()=>{
  const f=fixture();try{
    f.apply('a','old-execution');f.apply('new','new-execution');
    assert.deepEqual(f.observe([f.cli('old-execution'),f.cli('new-execution')]),[]);
    f.apply('a','fresh-a');
    assert.deepEqual(f.observe([]),[]);
    assert.deepEqual(f.observe([f.cli('fresh-a','old-host')]),[]);
    assert.deepEqual(f.observe([{...f.cli('fresh-a'),status:'running'}]),[]);
    assert.deepEqual(f.observe([{...f.cli('fresh-a'),marker:null}]),[]);
    assert.deepEqual(f.observe([{...f.cli('fresh-a'),groupId:null}]),[]);
    assert.equal(f.observe([f.cli('fresh-a')]).length,1);
    assert.equal(f.observe([f.cli('fresh-a')])[0].cli.ownerPid,103); // Runner is a contained descendant, not the host itself.
    f.apply('b','fresh-b');
    assert.deepEqual(f.observe([f.cli('fresh-a'),f.cli('fresh-b')]).map(row=>row.taskId),['original-a','original-b']);
    assert.deepEqual(f.baseline.tasks[0].items[0].previousExecutionIds,['old-execution']);
  }finally{f.close();}
});

test('actual ordinary application, exact result event and epoch are all required',()=>{
  const f=fixture();try{
    f.apply('a','fresh-a');const clis=[f.cli('fresh-a')];
    const mutations=[
      ["UPDATE execution_attempts SET status='saved' WHERE execution_id='fresh-a'","UPDATE execution_attempts SET status='applied' WHERE execution_id='fresh-a'"],
      ["UPDATE agent_results SET effect_outcome='noop'","UPDATE agent_results SET effect_outcome='advanced'"],
      ["UPDATE agent_results SET application_status='saved'","UPDATE agent_results SET application_status='applied'"],
      ["UPDATE workflow_item_events SET authority='arbitration'","UPDATE workflow_item_events SET authority='agent'"],
      ["UPDATE workflow_items SET completion_authority='human' WHERE item_id='a'","UPDATE workflow_items SET completion_authority='agent' WHERE item_id='a'"],
      ["UPDATE workflow_item_events SET event_key='unrelated'","UPDATE workflow_item_events SET event_key='result:result:fresh-a'"],
      ["UPDATE execution_attempts SET input_json='{}' WHERE execution_id='fresh-a'",`UPDATE execution_attempts SET input_json='{"delegation":{"workItemEpoch":2}}' WHERE execution_id='fresh-a'`],
      ["UPDATE workflow_items SET revision=2 WHERE item_id='a'","UPDATE workflow_items SET revision=1 WHERE item_id='a'"],
      ["UPDATE workflow_items SET dispatch_epoch=1 WHERE item_id='a'","UPDATE workflow_items SET dispatch_epoch=2 WHERE item_id='a'"],
    ];
    for(const [reject,restore] of mutations){f.writer.exec(reject);assert.deepEqual(f.observe(clis),[],reject);f.writer.exec(restore);assert.equal(f.observe(clis).length,1,restore);}
    f.writer.exec("INSERT INTO execution_processes VALUES('process','fresh-a','running')");
    assert.deepEqual(f.observe(clis),[]);
    f.writer.exec("UPDATE execution_processes SET status='exited'");assert.equal(f.observe(clis).length,1);
  }finally{f.close();}
});

test('pause, deletion, unresolved holds and cancellation never count as business recovery',()=>{
  const f=fixture();try{
    f.apply('a','fresh-a');const clis=[f.cli('fresh-a')];
    f.writer.exec("UPDATE tasks SET is_paused=1 WHERE task_id='original-a'");assert.deepEqual(f.observe(clis),[]);
    f.writer.exec("UPDATE tasks SET is_paused=0");assert.equal(f.observe(clis).length,1);
    f.writer.exec("UPDATE projects SET deleted_at='now'");assert.deepEqual(f.observe(clis),[]);
    f.writer.exec("UPDATE projects SET deleted_at=NULL; INSERT INTO interventions VALUES('hold','original-a',NULL,'awaiting_human')");
    assert.deepEqual(f.observe(clis),[]);
    f.writer.exec("UPDATE interventions SET status='resolved'");assert.equal(f.observe(clis).length,1);
    f.writer.exec("INSERT INTO workflow_item_events VALUES('cancel','a',NULL,'task:cancelled','cancel','human')");
    assert.deepEqual(f.observe(clis),[]);
  }finally{f.close();}
});

test('runtime business candidates preserve exact case and host generation provenance',()=>{
  const f=fixture();try{
    f.apply('a','fresh-a');f.apply('b','fresh-b');
    assert.throws(()=>f.observe([f.cli('fresh-a')],[{...f.handoff,caseId:'other-case'}]),/不一致/);
    assert.throws(()=>f.observe([f.cli('fresh-a')],[{...f.handoff,artifact:{...f.handoff.artifact,sourceId:'c'.repeat(64)}}]),/不一致/);
    assert.deepEqual(f.observe([{...f.cli('fresh-a'),pid:f.handoff.pid}]),[]);
    assert.throws(()=>f.observe([f.cli('fresh-a')],[f.handoff,f.handoff]),/重复/);
    const second={...f.handoff,hostAllocationId:'replacement-host',hostSequence:3,pid:202,groupId:202};
    const result=f.observe([f.cli('fresh-a'),f.cli('fresh-b','replacement-host')],[f.handoff,second]);
    assert.deepEqual(result.map(row=>row.handoff.hostAllocationId),['new-host','replacement-host']);
    assert.deepEqual(result.map(row=>row.handoff.artifact),[f.handoff.artifact,f.handoff.artifact]);
    assert.equal(runtimeBusinessBaselineSchema.safeParse({...f.baseline,tasks:[...f.baseline.tasks,f.baseline.tasks[0]]}).success,false);
    assert.throws(()=>findRuntimeBusinessProgressCandidatesInDb(f.reader,{baseline:f.baseline,handoffs:[f.handoff],clis:[f.cli('fresh-a')],assertCurrent:()=>{throw new Error('stopped');}}),/stopped/);
    assert.deepEqual(f.observe([],[]),[]);
  }finally{f.close();}
});

test('unavailable schema is an error, not a fabricated empty recovery workload',()=>{
  const f=fixture();try{
    f.writer.exec('DROP TABLE execution_attempts');assert.throws(f.capture,/no such table/);
  }finally{f.close();}
});

test('cancelling an original demand after the fault cannot erase it from frozen recovery coverage',()=>{
  const f=fixture();try{
    f.writer.exec("UPDATE workflow_items SET status='cancelled',updated_at='2026-09-03 00:00:00' WHERE item_id='b'");
    const afterFault=f.capture();assert.ok(afterFault.tasks.some(task=>task.taskId==='original-b'));
    assert.deepEqual(f.observe([f.cli('fresh-b')]),[]);
    f.writer.exec("UPDATE workflow_items SET updated_at='2026-09-01 00:00:00' WHERE item_id='b'");
    assert.equal(f.capture().tasks.some(task=>task.taskId==='original-b'),false);
  }finally{f.close();}
});

test('runtime progress reader accepts actual migrated business command application, never a saved submission alone',async()=>{
  const {databaseConnection}=await import('../infrastructure/database');
  const {createProject}=await import('./projects');
  const {createTaskInDb,createTaskSchema}=await import('./tasks');
  const {beginTestExecutionAttempt}=await import('../test/execution-fixtures');
  const {inspectTaskDispatchEnvelope}=await import('../test/dispatch-inspection-fixtures');
  const {issueAgentCommandToken,runAgentCommand,readAgentCommandSubmission}=await import('./agent-command-drafts');
  const {applyAgentResult}=await import('./agent-results');
  const {completeExecution}=await import('./executions');
  const db=await databaseConnection();
  const workspace=join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,randomUUID());mkdirSync(workspace,{recursive:true});
  const projectId=await createProject({name:'Runtime business progress reader',workspaceRoot:workspace});
  const taskId=`REQ-${randomUUID()}`;
  createTaskInDb(db,createTaskSchema.parse({title:'Original demand',description:'Produce the original result',itemType:'direct',projectId}),taskId);
  const controlled=fixture();const reader=new Database(db.name,{readonly:true,fileMustExist:true});
  try{
    const baseline=captureRuntimeBusinessBaselineInDb(reader,{...controlled.binding,originalBoundaryMs:Date.now()});
    assert.ok(baseline.tasks.some(task=>task.taskId===taskId));
    const delegation=(await inspectTaskDispatchEnvelope(taskId))[0];assert.ok(delegation);
    const runId=`RUN-${randomUUID()}`;
    const started=await beginTestExecutionAttempt({runId,delegation,prompt:'Ordinary command application under controlled runtime provenance'});
    const executionId=started.attempt.execution_id;
    const token=(await issueAgentCommandToken(executionId))!;
    await runAgentCommand({executionId,token,args:['direct','run']});
    await runAgentCommand({executionId,token,args:['direct','submit','--summary','Original demand completed','--result','# Original result\n\nActual command application.']});
    const read=()=>findRuntimeBusinessProgressCandidatesInDb(reader,{baseline,handoffs:[controlled.handoff],clis:[controlled.cli(executionId)],assertCurrent:()=>{}});
    assert.deepEqual(read(),[]);
    const submission=(await readAgentCommandSubmission(executionId))!;
    assert.equal(await applyAgentResult(runId,delegation,submission,{executionId}),'advanced');
    await completeExecution(executionId);
    const progress=read();assert.equal(progress.length,1);assert.equal(progress[0].executionId,executionId);
    assert.equal(progress[0].taskId,taskId);assert.equal(progress[0].itemId,started.attempt.work_item_id);
    assert.deepEqual(read(),progress); // Read-only replays, no extra application or closure.
  }finally{reader.close();controlled.close();}
});
