import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {AdminManagementStore} from './admin-management-store';
import {createNativeRuntimeHost} from './native-runtime-host';
import {createExternalRuntimeHost} from '../application/external-runtime-host';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';

async function fixture(programOverride?:string) {
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(root,{recursive:true});
  for(const directory of ['app','src','scripts','desktop','command-chains','migrations','app-migrations','desktop-runners','.next'])await mkdir(join(root,directory));
  for(const file of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(root,file),file==='package.json'?JSON.stringify({version:'normal-host-fixture'}):'{}');
  const program=`const args=process.argv.slice(2);const allocation=args[args.indexOf('--host-allocation')+1];
    const fs=require('node:fs'),path=require('node:path');const root=args[args.indexOf('--app-root')+1];
    const artifact=JSON.parse(fs.readFileSync(path.join(root,'harness-artifact.json'),'utf8')).artifactId;
    setInterval(()=>{},1000);process.send({kind:'normal-host-ready',allocationId:allocation,pid:process.pid,artifactId:artifact});
    process.on('message',message=>{if(message.kind==='shutdown-host')process.exit(0);});process.on('disconnect',()=>process.exit(0));`;
  await writeFile(join(root,'scripts','fixture.cjs'),programOverride||program);await writeFile(join(root,'desktop-runners','host-service.cjs'),programOverride||program);
  const source=await captureHarnessSource(root);await writeFile(join(root,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-normal-host'}));
  await writeFile(join(root,'.next','BUILD_ID'),'controlled-normal-host');
  const artifact=await writeHarnessArtifact(root);const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const store=new AdminManagementStore(join(dataRoot,'management.db'));store.initializeRuntimeInstallation(artifact);store.setIntent('stopped','saved-stop');
  return {artifact,dataRoot,store};
}

test('external native normal host records actual ownership before readiness, reuses its private handle and physically exits before releasing root lease',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();const native=createNativeRuntimeHost({...f,executable:process.execPath,drainUpdates:async()=>true,confirmDescendantsExited:async()=>true});
  const root=createExternalRuntimeHost({...f,bootstrap:f.artifact,ownerId:'external-root',...native,updates:{reconcile:async()=>undefined,shutdown:async()=>undefined}});
  try {
    assert.equal(await root.reconcile(),'hosting');const record=f.store.runtimeHostProcesses()[0];
    assert.equal(record.status,'ready');assert.equal(record.parentPid,process.pid);assert.equal(record.groupId,record.pid);assert.ok(record.marker);process.kill(record.pid!,0);
    assert.equal(await root.reconcile(),'hosting');assert.equal(f.store.runtimeHostProcesses().length,1);
    assert.equal(f.store.control().desired_intent,'stopped');assert.equal(f.store.attempts().length,0);
    await root.shutdown();assert.throws(()=>process.kill(record.pid!,0));assert.equal(f.store.runtimeHostProcesses()[0].status,'exited');
    assert.ok(f.store.acquireRuntimeHost('successor'));
  }finally{await root.shutdown();f.store.close();}
});

test('stdout-only structured host fatal survives later noisy output and is preserved in the independent root failure',{skip:process.platform==='win32'},async()=>{
  const f=await fixture(`setTimeout(()=>{
    const line=JSON.stringify({kind:'host-fatal',pid:process.pid,error:'SqliteError: file is not a database; 业务库损坏 token=secret-test-token'});
    const bytes=Buffer.from(line+'\\n');const split=bytes.indexOf(Buffer.from('业务'))+1;
    process.stdout.write(bytes.subarray(0,split));
    setTimeout(()=>{process.stdout.write(bytes.subarray(split));process.stdout.write('unrelated shutdown output\\n'.repeat(4000),()=>process.exit(1));},10);
  },150);`);
  f.store.setIntent('running','controlled-fatal-startup');
  const native=createNativeRuntimeHost({...f,executable:process.execPath,drainUpdates:async()=>true,confirmDescendantsExited:async()=>true});
  let failure:unknown;
  const root=createExternalRuntimeHost({...f,bootstrap:f.artifact,ownerId:'fatal-root',...native,
    onFailure:value=>{failure=value;},updates:{reconcile:async()=>undefined,shutdown:async()=>undefined}});
  try{
    await assert.rejects(root.reconcile(),error=>{
      assert.match(String(error),/file is not a database; 业务库损坏/);
      assert.doesNotMatch(String(error),/secret-test-token/);return true;
    });
    assert.match(String((failure as {error:unknown}).error),/file is not a database/);
    const record=f.store.runtimeHostProcesses()[0];assert.equal(record.status,'exited');
    assert.throws(()=>process.kill(record.pid!,0));
  }finally{await root.shutdown();f.store.close();}
});

test('unknown normal-host reservation survives root takeover and blocks spawning; fencing cannot replace the captured allocation',async()=>{
  const f=await fixture();const old=f.store.acquireRuntimeHost('old')!;const record=f.store.reserveRuntimeHostProcess(old,f.artifact);
  f.store.releaseRuntimeHost(old);const current=f.store.acquireRuntimeHost('new')!;
  const native=createNativeRuntimeHost({...f,executable:process.execPath,drainUpdates:async()=>true,confirmDescendantsExited:async()=>true});
  try {
    await assert.rejects(native.ensureSelected(f.artifact,current,new AbortController().signal,()=>f.store.assertRuntimeHost(current)),/退出未确认/);
    assert.equal(f.store.runtimeHostProcesses().length,1);assert.equal(f.store.runtimeHostProcesses()[0].pid,null);
    assert.equal(await native.cancelOwned(old),false);
    assert.throws(()=>f.store.reserveRuntimeHostProcess(current,f.artifact),/退出未确认/);
    f.store.bindRuntimeHostProcess(record,999999,'captured');
    assert.throws(()=>f.store.bindRuntimeHostProcess(record,999998,'foreign'),/迟到/);
    assert.throws(()=>f.store.confirmRuntimeHostProcessExit(record),/不匹配/);
    assert.throws(()=>f.store.readyRuntimeHostProcess(old,record.allocationId),/所有权/);
  }finally{f.store.close();}
});

test('standard host retires stale allocation and update cleanup errors instead of requiring manual runtime deletion',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();const old=f.store.acquireRuntimeHost('old-standard')!;
  f.store.reserveRuntimeHostProcess(old,f.artifact);f.store.releaseRuntimeHost(old);
  const current=f.store.acquireRuntimeHost('new-standard')!;let cleanupReported=0;
  const native=createNativeRuntimeHost({...f,strictContainment:false,executable:process.execPath,
    drainUpdates:async()=>{throw new Error('stale update cleanup unavailable');},confirmDescendantsExited:async()=>false,
    onError:()=>{cleanupReported++;}});
  try{
    await native.ensureSelected(f.artifact,current,new AbortController().signal,()=>f.store.assertRuntimeHost(current));
    const records=f.store.runtimeHostProcesses();assert.equal(records.length,2);assert.equal(records[0].status,'exited');
    assert.equal(records[1].status,'ready');assert.ok(cleanupReported>=1);
  }finally{await native.cancelOwned(current);f.store.close();}
});

test('descendant cleanup refusal or synchronous failure cannot suppress root termination, but neither can release its physical barrier',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();let proof:'throw'|'false'|'true'='throw';
  const authority=f.store.acquireRuntimeHost('root')!;
  const native=createNativeRuntimeHost({...f,executable:process.execPath,drainUpdates:async()=>true,confirmDescendantsExited:()=>{
    if(proof==='throw')throw new Error('independent CLI group cleanup failed');return Promise.resolve(proof==='true');
  }});
  try {
    await native.ensureSelected(f.artifact,authority,new AbortController().signal,()=>f.store.assertRuntimeHost(authority));
    const record=f.store.runtimeHostProcesses()[0];assert.equal(await native.cancelOwned(authority),false);assert.throws(()=>process.kill(record.pid!,0));
    assert.equal(f.store.runtimeHostProcesses()[0].status,'ready');proof='false';assert.equal(await native.cancelOwned(authority),false);
    proof='true';assert.equal(await native.cancelOwned(authority),true);assert.equal(f.store.runtimeHostProcesses()[0].status,'exited');
  }finally{proof='true';await native.cancelOwned(authority);f.store.close();}
});

test('unfinished captured update cannot be hidden by an empty ordinary-host registry',async()=>{
  const f=await fixture();const authority=f.store.acquireRuntimeHost('root')!;
  const native=createNativeRuntimeHost({...f,executable:process.execPath,drainUpdates:async()=>false,confirmDescendantsExited:async()=>true});
  try {
    await assert.rejects(native.ensureSelected(f.artifact,authority,new AbortController().signal,()=>f.store.assertRuntimeHost(authority)),/更新进程退出未确认/);
    assert.equal(f.store.runtimeHostProcesses().length,0);
  }finally{f.store.close();}
});

test('a live failed ordinary spawn can clear its positively empty reservation without changing user stop',async()=>{
  const f=await fixture();const authority=f.store.acquireRuntimeHost('root')!;
  const native=createNativeRuntimeHost({...f,executable:join(f.dataRoot,'missing-node'),drainUpdates:async()=>true,confirmDescendantsExited:async()=>true});
  try {
    await assert.rejects(native.ensureSelected(f.artifact,authority,new AbortController().signal,()=>f.store.assertRuntimeHost(authority)),error=>{
      assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');
      assert.equal((error as NodeJS.ErrnoException).path,join(f.dataRoot,'missing-node'));
      assert.match((error as NodeJS.ErrnoException).syscall!,/^spawn /);return true;
    });
    assert.equal(f.store.runtimeHostProcesses()[0].status,'exited');assert.equal(f.store.runtimeHostProcesses()[0].pid,null);
    assert.equal(f.store.control().desired_intent,'stopped');assert.equal(await native.cancelOwned(authority),true);
  }finally{await native.cancelOwned(authority);f.store.close();}
});

test('CLI admission storage failure cannot suppress physical root exit or authorize barrier release',{skip:process.platform==='win32'},async()=>{
  const f=await fixture();const authority=f.store.acquireRuntimeHost('root')!;
  const native=createNativeRuntimeHost({...f,executable:process.execPath,drainUpdates:async()=>true,confirmDescendantsExited:async()=>true});
  const original=f.store.beginRuntimeCliDrain.bind(f.store);
  try {
    await native.ensureSelected(f.artifact,authority,new AbortController().signal,()=>f.store.assertRuntimeHost(authority));
    const record=f.store.runtimeHostProcesses()[0];
    f.store.beginRuntimeCliDrain=()=>{throw new Error('management write failed');};
    assert.equal(await native.cancelOwned(authority),false);assert.throws(()=>process.kill(record.pid!,0));
    assert.equal(f.store.runtimeHostProcesses()[0].status,'ready');
    f.store.beginRuntimeCliDrain=original;
    assert.equal(await native.cancelOwned(authority),true);assert.equal(f.store.runtimeHostProcesses()[0].status,'exited');
  }finally{f.store.beginRuntimeCliDrain=original;await native.cancelOwned(authority);f.store.close();}
});
