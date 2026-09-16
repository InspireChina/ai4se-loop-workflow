import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {AdminManagementStore} from './admin-management-store';
import {drainRuntimeCliRegistry} from './runtime-cli-registry';
import {inspectProcessIdentity,terminateProcessGroup} from './process-tree';
import {executeDelegation} from './delegation-execution';
import {createLangfuseTelemetry} from './langfuse';

async function fixture(rootOverride?:string,groupId=process.pid,certified=true) {
  const root=rootOverride||join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(root,{recursive:true});
  const filename=join(root,'admin-management.db');
  const store=new AdminManagementStore(filename);store.setIntent('running','controlled-start');
  const authority=store.acquireRuntimeHost('root')!;
  const artifact={root:join(root,'artifact'),sourceId:'a'.repeat(64),artifactId:'b'.repeat(64),version:'fixture'};
  store.initializeRuntimeInstallation(artifact);const record=store.reserveRuntimeHostProcess(authority,artifact);
  store.bindRuntimeHostProcess(record,process.pid,(await inspectProcessIdentity(process.pid))!.startMarker,groupId);
  if(certified)store.certifyRuntimeCliHost(record);store.readyRuntimeHostProcess(authority,record.allocationId);
  return {root,filename,store,record,authority};
}

test('independent CLI admission is durable, source/intent fenced and cannot reopen after drain',async()=>{
  const f=await fixture();
  try {
    f.store.reserveRuntimeCli(f.record.allocationId,'cli-1','execution-1',process.pid);
    f.store.attachRuntimeCli('cli-1',999901,undefined,999901);
    assert.equal(f.store.runtimeCliProcesses(f.record.allocationId)[0].status,'launching');
    f.store.attachRuntimeCli('cli-1',999901,'actual-start');
    assert.equal(f.store.runtimeCliProcesses(f.record.allocationId)[0].status,'running');
    assert.throws(()=>f.store.attachRuntimeCli('cli-1',999901,'reused-start'),/身份变化/);
    assert.throws(()=>f.store.attachRuntimeCli('cli-1',999902,'actual-start'),/身份变化/);
    f.store.beginRuntimeCliDrain(f.record.allocationId);f.store.finishRuntimeCli('cli-1',false);
    f.store.attachRuntimeCli('cli-1',999901,'actual-start');
    assert.equal(f.store.runtimeCliProcesses(f.record.allocationId)[0].status,'terminating');
    assert.throws(()=>f.store.certifyRuntimeCliHost(f.record),/不能重新开放/);
    assert.throws(()=>f.store.reserveRuntimeCli(f.record.allocationId,'cli-2','execution-2',process.pid),/排空/);
    f.store.close();const reopened=new AdminManagementStore(f.filename);
    try{assert.throws(()=>reopened.reserveRuntimeCli(f.record.allocationId,'cli-2','execution-2',process.pid),/排空/);}
    finally{reopened.close();}
  }finally{try{f.store.close();}catch{}}
});

test('unknown CLI reservation retains the barrier even with corrupt business data; another group still gets cleanup',async()=>{
  const f=await fixture();const business=join(f.root,'loop-ui.db');const original=Buffer.from('not a sqlite database');await writeFile(business,original);
  const attempted:number[]=[];
  try {
    f.store.reserveRuntimeCli(f.record.allocationId,'unknown','execution-unknown',process.pid);
    f.store.reserveRuntimeCli(f.record.allocationId,'known','execution-known',process.pid);
    f.store.attachRuntimeCli('known',999903,'known-start',999903);
    assert.equal(await drainRuntimeCliRegistry(f.store,f.record.allocationId,async group=>{attempted.push(group);return true;}),false);
    assert.deepEqual(attempted,[999903]);
    assert.deepEqual(f.store.runtimeCliProcesses(f.record.allocationId).map(row=>row.status),['terminating','exited']);
    assert.deepEqual(await readFile(business),original);
  }finally{f.store.close();}
});

test('one cleanup throw cannot suppress other registered group termination',async()=>{
  const f=await fixture();const attempted:number[]=[];
  try {
    for(const [id,pid] of [['bad',999904],['good',999905]] as const) {
      f.store.reserveRuntimeCli(f.record.allocationId,id,`execution-${id}`,process.pid);f.store.attachRuntimeCli(id,pid,'start',pid);
    }
    assert.equal(await drainRuntimeCliRegistry(f.store,f.record.allocationId,async group=>{attempted.push(group);if(group===999904)throw Error('diagnostic');return true;}),false);
    assert.deepEqual(attempted,[999904,999905]);
    assert.deepEqual(f.store.runtimeCliProcesses(f.record.allocationId).map(row=>row.status),['terminating','exited']);
  }finally{f.store.close();}
});

test('stopped intent and lost external lease reject independent pre-spawn registration',async()=>{
  const f=await fixture();
  try {
    f.store.setIntent('stopped','user-stop');
    assert.throws(()=>f.store.reserveRuntimeCli(f.record.allocationId,'cli','execution',process.pid),/意图/);
    f.store.setIntent('running','user-start');f.store.releaseRuntimeHost(f.authority);f.store.acquireRuntimeHost('successor');
    assert.throws(()=>f.store.reserveRuntimeCli(f.record.allocationId,'cli','execution',process.pid),/失效/);
    assert.equal(f.store.runtimeCliProcesses(f.record.allocationId).length,0);
  }finally{f.store.close();}
});

test('an empty uncertified registry cannot prove a legacy host had no detached CLIs',async()=>{
  const f=await fixture(undefined,process.pid,false);
  try {
    assert.equal(await drainRuntimeCliRegistry(f.store,f.record.allocationId),false);
    assert.throws(()=>f.store.certifyRuntimeCliHost(f.record),/不能重新开放/);
    assert.throws(()=>f.store.reserveRuntimeCli(f.record.allocationId,'cli','execution',process.pid),/未就绪|排空/);
  }finally{f.store.close();}
});

test('actual orphaned detached CLI descendant stops via management registry despite corrupt business DB',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();const target=join(f.root,'writer.log'),pidFile=join(f.root,'writer.pid');
  const business=join(f.root,'loop-ui.db');await writeFile(business,'corrupt-business-sentinel');
  const writer=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(target)},'write\\n'),20);`;
  const program=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  f.store.reserveRuntimeCli(f.record.allocationId,'actual','execution',process.pid);
  const child=spawn(process.execPath,['-e',program],{detached:true,stdio:'ignore'});
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));let marker:string|undefined;let writerPid=0;
  try {
    marker=(await inspectProcessIdentity(child.pid!))!.startMarker;f.store.attachRuntimeCli('actual',child.pid!,marker,child.pid!);
    const deadline=Date.now()+5000;
    while(Date.now()<deadline) {try{writerPid=Number(await readFile(pidFile,'utf8'));if((await readFile(target)).length)break;}catch{}await new Promise<void>(resolve=>setTimeout(resolve,20));}
    assert.ok(writerPid>0);process.kill(writerPid,0);
    child.kill('SIGKILL');await closed;assert.throws(()=>process.kill(child.pid!,0));process.kill(writerPid,0);
    assert.equal(await drainRuntimeCliRegistry(f.store,f.record.allocationId),true);
    assert.throws(()=>process.kill(writerPid,0));
    assert.equal(f.store.runtimeCliProcesses(f.record.allocationId)[0].status,'exited');
    const stable=await readFile(target);await new Promise<void>(resolve=>setTimeout(resolve,80));assert.deepEqual(await readFile(target),stable);
    assert.equal(await readFile(business,'utf8'),'corrupt-business-sentinel');
  }finally{if(child.pid)await terminateProcessGroup(child.pid,5000,marker);await closed;f.store.close();}
});

test('business composition records and physically settles host-owned helper invocations without execution IDs',{skip:process.platform==='win32'},async()=>{
  const group=Number(spawnSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).stdout.trim());assert.ok(group>0);
  const f=await fixture(process.env.LOOP_DATA_ROOT!,group);const previous=process.env.LOOP_RUNTIME_HOST_ALLOCATION;
  const releaseFile=join(f.root,`helper-release-${randomUUID()}`);
  process.env.LOOP_RUNTIME_HOST_ALLOCATION=f.record.allocationId;
  let descendant=0;
  try {
    const result=await executeDelegation({
      runId:'helper-fixture',workspaceRoot:f.root,prompt:'controlled invocation',executor:{
        id:'claude',label:'Controlled',command:process.execPath,promptMode:'argument',
        buildArgs:()=>['-e',`const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log('writer='+child.pid);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)}))clearInterval(timer)},10)`],formatCommand:()=> 'controlled-node',
        parseStdout:line=>{if(line.startsWith('writer='))descendant=Number(line.slice(7));return line;},parseStderr:line=>line,
      },executionOptions:{},context:{agent:'dev-agent',taskId:'fixture',storyIndex:null,pipeline:'feature'},description:'controlled helper',
      telemetry:createLangfuseTelemetry({env:{LANGFUSE_ENABLED:'false'}}),appendLog:async()=>undefined,
      maxRuntimeMs:5000,startupTimeoutMs:2000,idleTimeoutMs:2000,
      processes:{register:async(_run,pid)=>{const identity=await inspectProcessIdentity(pid);assert.ok(identity);await writeFile(releaseFile,'release');return identity.startMarker;},
        terminate:async()=>true,confirmExit:async()=>true,markExited:async()=>undefined},
    });
    assert.equal(result.exitCode,0,JSON.stringify(result));
    const rows=f.store.runtimeCliProcesses(f.record.allocationId);assert.equal(rows.length,1);
    assert.equal(rows[0].status,'exited');assert.equal(rows[0].groupId,rows[0].pid);assert.ok(rows[0].marker);
    assert.throws(()=>process.kill(rows[0].pid!,0));
    assert.ok(descendant>0);assert.throws(()=>process.kill(descendant,0));
  }finally{for(const row of f.store.runtimeCliProcesses(f.record.allocationId))if(row.groupId)await terminateProcessGroup(row.groupId,5000,row.marker||undefined);
    if(previous===undefined)delete process.env.LOOP_RUNTIME_HOST_ALLOCATION;else process.env.LOOP_RUNTIME_HOST_ALLOCATION=previous;f.store.close();}
});
