import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,chmodSync,readFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { loadExternalAgent,externalAgentOptions } from './external-agents';
import { getAgentExecutor } from './agent-executor';
import { buildAgentProcessLaunch } from './delegation-execution';
mkdirSync(process.env.LOOP_DATA_ROOT!,{recursive:true});
test('native RPC adapter preserves events, saves isolated sessions and closes after native completion',async()=>{
 const root=mkdtempSync(join(process.env.LOOP_DATA_ROOT!,'rpc-'));const binary=join(root,'omp');
 writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');fs.writeFileSync(process.env.ARGS_FILE,JSON.stringify(process.argv.slice(2)));
const emit=e=>console.log(JSON.stringify(e));emit({type:'ready'});
rl.createInterface({input:process.stdin}).on('line',s=>{const q=JSON.parse(s);if(q.type==='get_state')emit({type:'response',id:q.id,success:true,data:{sessionId:'native-id',isStreaming:false}});if(q.type==='prompt'){emit({type:'response',id:q.id,success:true});emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'RPC_OK'}]}});emit({type:'agent_end',messages:[]});}}).on('close',()=>process.exit(0));
`);chmodSync(binary,0o700);
 const bridge=join(process.cwd(),'scripts','omp-rpc.mjs');
 const stdout=await new Promise<string>((resolve,reject)=>{
   const child=execFile(process.execPath,[bridge,binary,'--print','--mode','json','--no-session','--no-tools'],{timeout:8000,env:{...process.env,ARGS_FILE:join(root,'args.json'),LOOP_OMP_SESSION_DIR:join(root,'session')}},(error,stdout)=>error?reject(error):resolve(stdout));
   child.stdin?.end('Test task packet');
 });
 const frames=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.ok(frames.some(f=>f.type==='session'&&f.id==='native-id'));assert.ok(frames.some(f=>f.type==='message_end'));
 const args=JSON.parse(readFileSync(join(root,'args.json'),'utf8'));assert.ok(args.includes('rpc'));assert.ok(args.includes('--session-dir'));assert.ok(args.includes('--extension'));assert.ok(!args.includes('--no-session'));assert.ok(!args.includes('--print'));
});
test('Agent native settings control model, thinking and tools, and the system body is a frozen file snapshot',()=>{
 const agent=loadExternalAgent(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,'dev-agent');
 agent.metadata={model:'provider/model',tools:[],thinking:'high',skills:['delivery']};
 const options=externalAgentOptions(agent);const launch=buildAgentProcessLaunch(getAgentExecutor('omp'),'task',process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,options);
 assert.equal(launch.command,process.execPath);assert.ok(launch.args.includes('--no-tools'));assert.ok(launch.args.includes('provider/model'));assert.ok(launch.args.includes('high'));assert.ok(launch.args.includes('delivery'));
 const promptFile=launch.args[launch.args.indexOf('--append-system-prompt')+1];assert.equal(readFileSync(promptFile,'utf8'),agent.prompt);assert.ok(!readFileSync(promptFile,'utf8').startsWith('---'));
});

test('native RPC adapter fails on a rejected prompt or an early provider exit', async () => {
 const root=mkdtempSync(join(process.env.LOOP_DATA_ROOT!,'rpc-failure-'));
 for(const mode of ['rejected','early']) {
  const binary=join(root,mode);
  writeFileSync(binary,`#!/usr/bin/env node
const rl=require('node:readline');
console.log(JSON.stringify({type:'ready'}));
rl.createInterface({input:process.stdin}).on('line',s=>{const q=JSON.parse(s);if(q.type==='prompt')${mode==='early'?"process.exit(0)":"console.log(JSON.stringify({type:'response',id:q.id,success:false,error:'provider rejected'}))"};}).on('close',()=>process.exit(0));
`);chmodSync(binary,0o700);
  const outcome=await new Promise<{error: Error|null;stdout:string}>(resolve=>{
   const child=execFile(process.execPath,[join(process.cwd(),'scripts','omp-rpc.mjs'),binary],{timeout:8000},(error,stdout)=>resolve({error,stdout}));child.stdin?.end('Task');
  });
  assert.ok(outcome.error);assert.match(outcome.stdout,mode==='early'?/exited before completing/:/provider rejected/);
 }
});
