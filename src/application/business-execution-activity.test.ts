import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {createBusinessExecutionActivityInDb} from './business-execution-activity';
import type {AgentTelemetryEvent} from '../infrastructure/agent-executor';

const context={agent:'dev-agent',taskId:'task',storyIndex:1,pipeline:'delivery'};
function fixture(){
  const db=new Database(':memory:');
  // Adapter-unit schema: real SQLite constraints, not a production migration
  // or a claim of business/model recovery. Physical CLI integration is separate.
  db.exec(`CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY,run_id TEXT,task_id TEXT,agent TEXT,pipeline TEXT,status TEXT,started_at TEXT,work_item_id TEXT,dispatch_generation_key TEXT);
    CREATE TABLE execution_receipts(receipt_id TEXT PRIMARY KEY,execution_id TEXT REFERENCES execution_attempts(execution_id),kind TEXT,receipt_key TEXT,payload_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(execution_id,kind,receipt_key));
    INSERT INTO execution_attempts VALUES('first','run','task','dev-agent','delivery','running','1970-01-01 00:00:00','item','generation');`);
  let now=0;const input={executionId:'first',runId:'run',context,timeoutMs:100,pollIntervalMs:1,now:()=>now};
  return {db,input,advance:(value:number)=>{now=value;},monitor:(executionId='first')=>createBusinessExecutionActivityInDb(db,{...input,executionId})};
}
const tool=(id:string,input:unknown,phase:'started'|'completed',extra:Partial<AgentTelemetryEvent>={}):AgentTelemetryEvent&{sequence:number}=>
  ({name:'loop.agent.tool',executor:'claude',tool:'Read',toolClass:'other',toolCallId:id,input,phase,success:phase==='completed'?true:undefined,sequence:1,...extra});

test('plain business output does not renew; same execution resumes its durable start deadline, including a late shell start',()=>{
  const f=fixture();try{
    const first=f.monitor();first.begin();f.advance(90);first.observe({name:'loop.agent.output',executor:'claude',sequence:1,summary:'still working'});
    f.advance(100);assert.match(first.failure()!,/Business execution stalled/);
    const resumed=f.monitor();resumed.begin();resumed.observe(tool('late',{command:'java e2e'},'started',{tool:'Bash',toolClass:'shell'}));
    assert.match(resumed.failure()!,/stalled/,'fresh invocation or started command cannot reset an expired deadline');
  }finally{f.db.close();}
});

test('successful work is queued outside observe and survives continuation, without storing tool input secrets or claiming acceptance',async()=>{
  const f=fixture();try{
    const monitor=f.monitor();monitor.begin();f.advance(80);
    monitor.observe(tool('read',{path:'feature.ts',token:'private-tool-input'},'started'));
    monitor.observe(tool('read',undefined,'completed',{tool:'tool'}));
    assert.equal(f.db.prepare('SELECT count(*) FROM execution_receipts').pluck().get(),0);
    await monitor.persist();const receipt=f.db.prepare('SELECT * FROM execution_receipts').get() as {receipt_key:string;payload_json:string};
    assert.equal(receipt.receipt_key.length,32);assert.doesNotMatch(receipt.payload_json,/private-tool-input/);
    assert.equal(JSON.parse(receipt.payload_json).acceptanceVerified,false);
    f.advance(90);const resumed=f.monitor();resumed.begin();
    resumed.observe(tool('repeat',{token:'private-tool-input',path:'feature.ts'},'completed'));
    await resumed.persist();assert.equal(f.db.prepare('SELECT count(*) FROM execution_receipts').pluck().get(),1);
    f.advance(179);assert.equal(resumed.failure(),null);f.advance(180);assert.match(resumed.failure()!,/stalled/);
  }finally{f.db.close();}
});

test('same work-item generation retries retain novelty, while a genuinely new generation may repeat verification work',async()=>{
  const f=fixture();try{
    const first=f.monitor();first.begin();f.advance(80);first.observe(tool('read',{path:'feature.ts'},'completed'));await first.persist();
    f.db.exec(`INSERT INTO execution_attempts SELECT 'retry',run_id,task_id,agent,pipeline,status,'1970-01-01 00:00:00.100',work_item_id,dispatch_generation_key FROM execution_attempts WHERE execution_id='first';
      INSERT INTO execution_attempts SELECT 'new-generation',run_id,task_id,agent,pipeline,status,'1970-01-01 00:00:00.100',work_item_id,'new-generation' FROM execution_attempts WHERE execution_id='first';`);
    f.advance(150);const retry=f.monitor('retry');retry.begin();retry.observe(tool('again',{path:'feature.ts'},'completed'));await retry.persist();
    assert.equal(f.db.prepare("SELECT count(*) FROM execution_receipts WHERE execution_id='retry'").pluck().get(),0);
    const next=f.monitor('new-generation');next.begin();next.observe(tool('new',{path:'feature.ts'},'completed'));await next.persist();
    assert.equal(f.db.prepare("SELECT count(*) FROM execution_receipts WHERE execution_id='new-generation'").pluck().get(),1);
    f.advance(200);assert.match(retry.failure()!,/stalled/);assert.equal(next.failure(),null);
  }finally{f.db.close();}
});

test('a long shell gets a bounded window; started IDs, output and unsuccessful results cannot extend it',()=>{
  const f=fixture();try{
    const monitor=f.monitor();monitor.begin();f.advance(80);monitor.observe(tool('java',{command:'java e2e'},'started',{tool:'Bash',toolClass:'shell'}));
    f.advance(150);assert.equal(monitor.failure(),null);
    monitor.observe(tool('more',{command:'mvn test'},'started',{tool:'Bash',toolClass:'shell'}));
    monitor.observe(tool('java',undefined,'completed',{tool:'tool',success:false,exitCode:1}));
    f.advance(180);assert.match(monitor.failure()!,/stalled/);
  }finally{f.db.close();}
});

test('wrong invocation identity is rejected before spawn, and changed durable source cannot receive checkpoint writes',async()=>{
  const f=fixture();try{
    assert.throws(()=>createBusinessExecutionActivityInDb(f.db,{...f.input,runId:'foreign'}),/source/);
    const monitor=f.monitor();monitor.begin();monitor.observe(tool('read',{path:'feature.ts'},'completed'));
    f.db.prepare("UPDATE execution_attempts SET status='cancelled' WHERE execution_id='first'").run();
    await assert.rejects(monitor.persist(),/source changed/);assert.equal(f.db.prepare('SELECT count(*) FROM execution_receipts').pluck().get(),0);
  }finally{f.db.close();}
});

test('the same execution may persist terminal-command telemetry after its result becomes output_received',async()=>{
  const f=fixture();try{
    const monitor=f.monitor();monitor.begin();monitor.observe(tool('terminal',{command:'phase complete'},'completed',{tool:'shell',toolClass:'shell'}));
    f.db.prepare("UPDATE execution_attempts SET status='output_received' WHERE execution_id='first'").run();
    await monitor.persist();
    const receipt=f.db.prepare("SELECT payload_json FROM execution_receipts WHERE execution_id='first' AND kind='activity_checkpoint'").get() as {payload_json:string};
    assert.equal(JSON.parse(receipt.payload_json).acceptanceVerified,false);
  }finally{f.db.close();}
});

for(const status of ['verifying','applying','applied','retryable_failed']){
  test(`activity evidence cannot arrive after the source advances to ${status}`,async()=>{
    const f=fixture();try{
      const monitor=f.monitor();monitor.begin();monitor.observe(tool('late',{path:'feature.ts'},'completed'));
      f.db.prepare('UPDATE execution_attempts SET status=? WHERE execution_id=?').run(status,'first');
      await assert.rejects(monitor.persist(),/source changed/);
    }finally{f.db.close();}
  });
}

test('an unknown durable start or malformed checkpoint cannot silently grant a fresh continuation window',()=>{
  const f=fixture();try{
    f.db.prepare("UPDATE execution_attempts SET started_at=NULL WHERE execution_id='first'").run();
    assert.throws(()=>f.monitor(),/no durable start time/);
    f.db.prepare("UPDATE execution_attempts SET started_at='1970-01-01 00:00:00' WHERE execution_id='first'").run();
    f.db.exec(`INSERT INTO execution_receipts(receipt_id,execution_id,kind,receipt_key,payload_json) VALUES('invalid','first','activity_checkpoint','invalid','{}')`);
    assert.throws(()=>f.monitor(),/invalid time/);
  }finally{f.db.close();}
});
