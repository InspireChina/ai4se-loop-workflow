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
