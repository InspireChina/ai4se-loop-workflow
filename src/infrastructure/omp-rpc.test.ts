import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,chmodSync,readFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadExternalCommandPrompt,externalCommandOptions } from './external-command-prompts';
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
test('native RPC adapter preserves a prompt split across individual UTF-8 bytes',async()=>{
 const root=mkdtempSync(join(process.env.LOOP_DATA_ROOT!,'rpc-utf8-'));const binary=join(root,'omp');const received=join(root,'prompt.json');
 writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');const emit=e=>console.log(JSON.stringify(e));emit({type:'ready'});
rl.createInterface({input:process.stdin}).on('line',s=>{const q=JSON.parse(s);if(q.type==='get_state')emit({type:'response',id:q.id,success:true,data:{sessionId:'utf8',isStreaming:false}});if(q.type==='prompt'){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(q));emit({type:'response',id:q.id,success:true,data:{agentInvoked:false}});}}).on('close',()=>process.exit(0));`);chmodSync(binary,0o700);
 const prompt='开始传输：'+ '汉字🙂🚁完整正文'.repeat(12);
 await new Promise<void>((resolve,reject)=>{
   const child=execFile(process.execPath,[join(process.cwd(),'scripts','omp-rpc.mjs'),binary],{timeout:8000},error=>error?reject(error):resolve());
   const bytes=Buffer.from(prompt);let index=0;const timer=setInterval(()=>{if(index<bytes.length){child.stdin?.write(bytes.subarray(index,index+1));index++;}else{clearInterval(timer);child.stdin?.end();}},3);child.once('exit',()=>clearInterval(timer));
 });
 assert.equal(JSON.parse(readFileSync(received,'utf8')).message,prompt);
});
test('Agent native settings control model, thinking and tools, and native commands receive an intact work packet with an audit snapshot',()=>{
 const agent=loadExternalCommandPrompt(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,'dev-agent');
 agent.metadata={model:'provider/model',tools:[],thinking:'high',skills:['delivery']};
 const packet = `# Work packet\n{"title":"DJI's task", "template":"{{task.id}}", "path":"a\\b"}\n  indent\tend`;
 const options=externalCommandOptions(agent);const launch=buildAgentProcessLaunch(getAgentExecutor('omp'),packet,process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,options);
 assert.equal(launch.command,process.execPath);assert.ok(launch.args.includes('--no-tools'));assert.ok(launch.args.includes('provider/model'));assert.ok(launch.args.includes('high'));assert.ok(launch.args.includes('delivery'));
 const promptFile=launch.args[launch.args.indexOf('--append-system-prompt')+1];assert.match(readFileSync(promptFile,'utf8'),/Harness boundary/);assert.ok(!readFileSync(promptFile,'utf8').includes(agent.prompt));
 assert.equal(launch.input, `/dev-agent '${packet.replaceAll("'", "'\"'\"'")}'`);
 assert.equal(launch.env.LOOP_OMP_COMMAND,'dev-agent');
 assert.equal(readFileSync(join(launch.env.LOOP_OMP_SESSION_DIR!,`command-dev-agent-${agent.sourceHash}.md`),'utf8'),readFileSync(agent.path,'utf8'));
 const auxiliary=buildAgentProcessLaunch(getAgentExecutor('omp'),'helper',process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!,{},launch.env);
 assert.equal(auxiliary.input,'helper');assert.equal(auxiliary.env.LOOP_OMP_COMMAND,undefined);
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

// These cases guard the boundary before any provider prompt is sent.
test('native command preflight rejects missing commands and source changes before model dispatch', async () => {
 const root=mkdtempSync(join(process.env.LOOP_DATA_ROOT!,'rpc-command-'));
 const source=join(root,'dev-agent.md');const original='Native role instructions';
 const expected=createHash('sha256').update(original).digest('hex');
 for(const mode of ['valid','missing','changed']) {
  writeFileSync(source,mode==='changed'?'Changed after launch preparation':original);
  const binary=join(root,mode);const received=join(root,`${mode}.json`);
  writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');const emit=e=>console.log(JSON.stringify(e));emit({type:'ready'});
rl.createInterface({input:process.stdin}).on('line',s=>{const q=JSON.parse(s);
if(q.type==='get_available_commands')emit({type:'response',id:q.id,success:true,data:{commands:${mode==='missing'?'[]':"[{name:'dev-agent',source:'file'}]"}}});
if(q.type==='get_state')emit({type:'response',id:q.id,success:true,data:{sessionId:'command-id',isStreaming:false}});
if(q.type==='prompt'){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(q));emit({type:'response',id:q.id,success:true,data:{agentInvoked:false}});}
}).on('close',()=>process.exit(0));`);
  chmodSync(binary,0o700);
  const outcome=await new Promise<{error:Error|null;stdout:string}>(resolve=>{
   const child=execFile(process.execPath,[join(process.cwd(),'scripts','omp-rpc.mjs'),binary],{timeout:8000,env:{...process.env,LOOP_OMP_COMMAND:'dev-agent',LOOP_OMP_COMMAND_PATH:source,LOOP_OMP_COMMAND_HASH:expected}},(error,stdout)=>resolve({error,stdout}));
   child.stdin?.end("/dev-agent 'literal packet'");
  });
  if(mode==='valid'){assert.equal(outcome.error,null);assert.equal(JSON.parse(readFileSync(received,'utf8')).message,"/dev-agent 'literal packet'");}
  else {assert.ok(outcome.error);assert.match(outcome.stdout,mode==='missing'?/未发现原生文件命令/:/发生变化/);assert.throws(()=>readFileSync(received,'utf8'),/ENOENT/);}
 }
});
