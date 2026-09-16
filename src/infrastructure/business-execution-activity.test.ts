import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {databaseConnection} from './database';
import {createTaskInDb,createTaskSchema} from '../application/tasks';
import {inspectTaskDispatchEnvelope} from '../test/dispatch-inspection-fixtures';
import {beginTestExecutionAttempt} from '../test/execution-fixtures';
import {acquireResourceClaimInDb,releaseTaskResourceClaimsInDb} from '../application/resource-claims';
import {executeDelegation} from './delegation-execution';
import {createLangfuseTelemetry} from './langfuse';
import type {AgentExecutor} from './agent-executor';

async function source(){
  const db=await databaseConnection(),taskId=`REQ-${randomUUID()}`,runId=`RUN-${randomUUID()}`;
  // Each case owns a separate requirement in this test process's private DB.
  // Earlier protocol fixtures intentionally never claim business completion;
  // pause them so global admission does not select them again.
  db.prepare('UPDATE tasks SET is_paused=1').run();
  createTaskInDb(db,createTaskSchema.parse({title:'Controlled business activity CLI',itemType:'direct'}),taskId);
  const work=(await inspectTaskDispatchEnvelope(taskId))[0];
  const {attempt}=await beginTestExecutionAttempt({runId,delegation:work,prompt:'Activity protocol fixture, not a model repair'});
  db.prepare('UPDATE execution_attempts SET started_at=? WHERE execution_id=?').run(new Date().toISOString(),attempt.execution_id);
  acquireResourceClaimInDb(db,{resourceKey:'code:workspace',taskId,lane:'control',executionId:attempt.execution_id});
  return {db,runId,executionId:attempt.execution_id,context:{agent:work.agent,taskId,storyIndex:work.storyIndex,pipeline:work.pipeline}};
}
function executor(id:AgentExecutor['id'],program:string):AgentExecutor{return {id,label:'Controlled Node telemetry fixture',command:process.execPath,
  promptMode:'argument',buildArgs:()=>['-e',program],formatCommand:()=> 'controlled Node activity',parseStdout:line=>line,parseStderr:line=>line};}

for(const id of ['claude','codex','cursor'] as const)test(`ordinary ${id} continuous output/repeated successful tool IDs is physically stopped by the default business adapter`,async()=>{
  const f=await source();let n=0;const reports=[];
  const program=id==='claude'?`let n=0;setInterval(()=>{const id='c'+n++;console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Read',input:{file_path:'fixture.ts'}}]}}));console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:'same protocol fixture, not executed acceptance'}]}}));},10);`:
    id==='codex'?`let n=0;setInterval(()=>console.log(JSON.stringify({type:'item.completed',item:{id:'c'+n++,type:'command_execution',command:'echo same fixture',exit_code:0,aggregated_output:'same fixture'}})),10);`:
    `let n=0;setInterval(()=>{const call_id='c'+n++;console.log(JSON.stringify({type:'tool_call',subtype:'started',call_id,tool_call:{ShellToolCall:{args:{command:'echo same fixture'}}}}));console.log(JSON.stringify({type:'tool_call',subtype:'completed',call_id,tool_call:{ShellToolCall:{result:{success:{exitCode:0,stdout:'same fixture'}}}}}));},10);`;
  const result=await executeDelegation({...f,workspaceRoot:process.cwd(),prompt:'fixture',executor:executor(id,program),executionOptions:{},
    description:'Real Node lifecycle with controlled runtime protocol, not a real model repair',
    telemetry:createLangfuseTelemetry({env:{LANGFUSE_ENABLED:'false'}}),activityTimeoutMs:500,activityPollIntervalMs:10,
    appendLog:async()=>{n++;},recordTelemetryEvent:async event=>{reports.push(event);},
    maxRuntimeMs:4000,startupTimeoutMs:1500,idleTimeoutMs:3000});
  assert.equal(result.terminationKind,'activity-stalled');assert.match(result.terminationReason!,/Business execution stalled/);
  assert.equal(result.cancelled,undefined);assert.ok(n>2);assert.ok(reports.length>2);
  assert.equal(f.db.prepare("SELECT count(*) FROM execution_receipts WHERE execution_id=? AND kind='activity_checkpoint'").pluck().get(f.executionId),1);
  const processes=f.db.prepare('SELECT pid,status FROM execution_processes WHERE execution_id=?').all(f.executionId) as {pid:number;status:string}[];
  assert.equal(processes.length,1);assert.equal(processes[0].status,'exited');assert.throws(()=>process.kill(processes[0].pid,0),error=>(error as NodeJS.ErrnoException).code==='ESRCH');
  releaseTaskResourceClaimsInDb(f.db,f.context.taskId);
});

test('business stall termination is not blocked by a permanently hung log sink',async()=>{
  const f=await source();
  const result=await executeDelegation({...f,workspaceRoot:process.cwd(),prompt:'fixture',executor:executor('claude',"console.log('startup');setInterval(()=>console.log('same heartbeat text'),10)"),executionOptions:{},
    description:'Hung sink controlled fixture',telemetry:createLangfuseTelemetry({env:{LANGFUSE_ENABLED:'false'}}),
    appendLog:()=>new Promise(()=>{}),persistenceTimeoutMs:10,activityTimeoutMs:500,activityPollIntervalMs:10,
    maxRuntimeMs:4000,startupTimeoutMs:1500,idleTimeoutMs:3000});
  assert.equal(result.terminationKind,'activity-stalled');assert.match(result.logPersistenceError!,/timeout/);
  const record=f.db.prepare('SELECT pid,status FROM execution_processes WHERE execution_id=?').get(f.executionId) as {pid:number;status:string};
  assert.equal(record.status,'exited');assert.throws(()=>process.kill(record.pid,0));
  releaseTaskResourceClaimsInDb(f.db,f.context.taskId);
});
