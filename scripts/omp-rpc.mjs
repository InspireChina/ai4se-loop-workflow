#!/usr/bin/env node
// Process adapter only: OMP owns the session, tools, model loop and compaction.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [binary, ...forward] = process.argv.slice(2);
if (!binary) throw new Error('Missing OMP executable');
let input=''; for await (const chunk of process.stdin) input+=chunk;
const args=[];
for(let i=0;i<forward.length;i++) {
  if(forward[i]==='--mode'){i++;continue;}
  if(['--print','-p','--no-session'].includes(forward[i]))continue;
  args.push(forward[i]);
}
const sessions=process.env.LOOP_OMP_SESSION_DIR || join(resolve(process.env.LOOP_DATA_ROOT||'data/dji'),'omp-sessions',process.env.LOOP_EXECUTION_ID||randomUUID());
mkdirSync(sessions,{recursive:true,mode:0o700});
const extension=join(process.env.LOOP_APP_ROOT || resolve(dirname(fileURLToPath(import.meta.url)),'..'),'scripts','omp-extension.mjs');
const child=spawn(binary,['--mode','rpc','--session-dir',sessions,'--extension',extension,...args],{stdio:['pipe','pipe','inherit'],windowsHide:true});
const id=randomUUID();let sent=false,finishing=false,failed=false;
const write=(frame)=>{if(!child.stdin.destroyed)child.stdin.write(JSON.stringify(frame)+'\n');};
const emit=(frame)=>process.stdout.write(JSON.stringify(frame)+'\n');
function fail(message){failed=true;emit({type:'error',message});finish();}
function finish(){if(finishing)return;finishing=true;child.stdin.end();timer=setTimeout(()=>child.kill('SIGTERM'),1000);}
let timer;
child.stdin.on('error',()=>{});
child.on('error',(error)=>{emit({type:'error',message:error.message});process.exitCode=1;});
child.on('close',(code,signal)=>{clearTimeout(timer);if(!finishing&&!failed)emit({type:'error',message:'OMP RPC exited before completing its prompt'});process.exitCode=failed||!finishing?1:code||0;});
createInterface({input:child.stdout}).on('line',(line)=>{
  let event;try{event=JSON.parse(line);}catch{process.stderr.write(line+'\n');return;}
  if (!['response','extension_ui_request','available_commands_update'].includes(event.type)) emit(event);
  if(event.type==='ready'&&!sent){sent=true;write({id:'session-state',type:'get_state'});write({id,type:'prompt',message:input});}
  if(event.type==='extension_ui_request')write({type:'extension_ui_response',id:event.id,cancelled:true});
  if(event.type==='response'&&event.id==='session-state'&&event.success&&event.data?.sessionId)emit({type:'session',id:event.data.sessionId});
  if(event.type==='response'&&event.id===id){if(event.success===false)fail(typeof event.error==='string'?event.error:JSON.stringify(event.error));else if(event.data?.agentInvoked===false)finish();}
  if(event.type==='prompt_result'&&event.id===id){if(event.status==='error')fail(event.error?.message||'OMP prompt failed');else finish();}
  // Older OMP versions finish via agent_end. Confirm the native session is idle.
  if(event.type==='agent_end'&&event.yielded!==false)write({id:'settled',type:'get_state'});
  if(event.type==='response'&&event.id==='settled'&&event.success){const state=event.data||{};if(state.isSettled===true || state.isSettled===undefined&&!state.isStreaming&&!state.isCompacting&&!state.queuedMessageCount)finish();else if(!finishing)setTimeout(()=>write({id:'settled',type:'get_state'}),250);}
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{write({type:'abort'});child.kill(signal);});
