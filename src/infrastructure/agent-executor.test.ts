import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentFinalTextAccumulator, createAgentRunMetricsAccumulator, extractAgentFailureDetail, getAgentExecutor, parseAgentTelemetryStdout, parseAgentTelemetryStderr } from './agent-executor';
import { assertSupportedAgentExecutor } from '../domain/agent-executor';
const context={agent:'dev-agent',taskId:'REQ-OMP',storyIndex:1,pipeline:'development'};

test('launches only native OMP with explicit model, thinking and tool settings',()=>{
 const executor=getAgentExecutor('omp');
 assert.equal(executor.transport,'omp-rpc');assert.equal(executor.promptMode,'stdin');
 assert.deepEqual(executor.buildArgs('task','/workspace',{model:'provider/model',reasoningEffort:'off',tools:[]}),['--approval-mode','yolo','--model','provider/model','--thinking','off','--no-tools']);
 assert.match(executor.formatCommand('/workspace'),/^omp --mode rpc/);
 assert.throws(()=>assertSupportedAgentExecutor('unsupported'),/仅支持 OMP/);
});
test('normalizes native OMP tool starts, successes and failures',()=>{
 const start=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_start',toolCallId:'t1',toolName:'bash',args:{command:'npm test'}}));
 assert.equal(start?.phase,'started');assert.equal(start?.toolClass,'shell');assert.equal(start?.toolCallId,'t1');
 const end=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_end',toolCallId:'t1',toolName:'bash',result:{exitCode:0,stdout:'passed'},isError:false}));
 assert.equal(end?.success,true);assert.equal(end?.exitCode,0);
 const failed=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_end',toolName:'bash',result:{exitCode:7},isError:true}));
 assert.equal(failed?.success,false);assert.equal(failed?.exitCode,7);
});
test('retains the final native assistant text without duplicating aggregate events',()=>{
 const accumulator=createAgentFinalTextAccumulator('omp');
 accumulator.ingest(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'final answer'}]}}));
 accumulator.ingest(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'aggregate answer'}]}]}));
 assert.equal(accumulator.value(),'final answer');
 accumulator.ingest(JSON.stringify({type:'message_end',message:{role:'user',content:[{type:'text',text:'must not become output'}]}}));
 assert.equal(accumulator.value(),'final answer');
});
test('records OMP model and usage and captures exact provider failures',()=>{
 const metrics=createAgentRunMetricsAccumulator('omp');metrics.ingest(JSON.stringify({type:'message_end',message:{model:'provider/model',usage:{input:12,output:6}}}));
 assert.equal(metrics.value().model,'provider/model');assert.deepEqual(metrics.value().usage,{input:12,output:6});
 assert.match(extractAgentFailureDetail('omp',JSON.stringify({type:'agent_end',error:{code:'AUTH_FAILED',message:'provider unavailable'}}))||'',/AUTH_FAILED/);
 assert.equal(parseAgentTelemetryStderr('omp','ERROR: provider unavailable')?.level,'ERROR');
});
test('keeps domain command labels for the existing Workflow stages',()=>{
 for(const command of ['direct run','artifact put','decision resolve','phase complete','runtime-input put','delivery-spec current']) {
  const log=getAgentExecutor('omp').parseStdout(JSON.stringify({type:'tool_execution_start',toolName:'bash',args:{command:`node /workspace/scripts/loop/loop-agent.mjs ${command}`}}),context);
  assert.match(log||'',/tool=agent-command/);
 }
});
test('projects native assistant output and handles malformed diagnostic lines',()=>{
 assert.match(getAgentExecutor('omp').parseStdout(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}),context)||'',/executor=omp.*done/);
 assert.equal(parseAgentTelemetryStdout('omp','native diagnostic')?.name,'loop.agent.diagnostic');
});

test('native loopwork arguments retain a domain command identity without granting a Shell receipt', () => {
 const event=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_start',toolName:'loopwork',toolCallId:'native-run',args:{args:['direct','run']}}));
 assert.equal(event?.toolClass,'other');
 assert.equal(event?.summary,'loopwork direct run');
 assert.equal((event?.input as {command:string}).command,'loopwork direct run');
});

test('native browser runs retain exact validation input without becoming Shell commands', () => {
 const args={action:'run',name:'main',code:'if (await page.title() !== "文本工具") throw new Error("wrong title");'};
 const event=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_start',toolName:'browser',toolCallId:'browser-check',args}));
 assert.equal(event?.toolClass,'other');
 assert.equal((event?.input as {command:string}).command,`browser run ${JSON.stringify(args)}`);
 for(const args of [{action:'open',url:'http://localhost/'},{action:'run',code:''}]) {
  const navigation=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_start',toolName:'browser',args}));
  assert.equal((navigation?.input as {command?:string}).command,undefined);
 }
 const failed=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_end',toolName:'browser',toolCallId:'browser-check',isError:true,result:{error:'wrong title'}}));
 assert.equal(failed?.success,false);
});

test('native xd device dispatch retains Workflow identity without treating an ordinary file write as a command', () => {
 const event=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_start',toolName:'write',toolCallId:'device-call',args:{path:'xd://loopwork',content:JSON.stringify({args:['phase','complete']})}}));
 assert.equal(event?.tool,'write');
 assert.equal(event?.toolClass,'other');
 assert.equal((event?.input as {command:string}).command,'loopwork phase complete');
 const ordinary=parseAgentTelemetryStdout('omp',JSON.stringify({type:'tool_execution_start',toolName:'write',args:{path:'/tmp/loopwork.json',content:JSON.stringify({args:['phase','complete']})}}));
 assert.equal((ordinary?.input as {command?:string}).command,undefined);
});

test('recoverable tool errors and aggregate assistant messages never become fatal execution diagnostics', () => {
 const transcript={role:'assistant',content:[{type:'thinking',thinking:'private model reasoning'},{type:'text',text:'Interim work'}]};
 assert.equal(extractAgentFailureDetail('omp',JSON.stringify({type:'tool_execution_end',isError:true,result:{content:[{type:'text',text:'Outcome: rejected'}]}})),null);
 assert.equal(extractAgentFailureDetail('omp',JSON.stringify({type:'agent_end',message:transcript})),null);
 const error=extractAgentFailureDetail('omp',JSON.stringify({type:'error',error:{code:'PROVIDER_UNAVAILABLE',message:'Connection closed',transcript}}));
 assert.match(error||'',/PROVIDER_UNAVAILABLE/);assert.ok(!error?.includes('private model reasoning'));
});
