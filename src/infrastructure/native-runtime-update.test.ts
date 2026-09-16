import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {AdminManagementStore} from './admin-management-store';
import {createRuntimeUpdateController} from '../application/runtime-update-controller';
import {createNativeRuntimeUpdate} from './native-runtime-update';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';

async function nativeArtifact(fail=false,version=fail?'bad':'known-good',brokenHealth=false,healthProtocol:string|null='private-health-v1') {
  const root=join(process.env.LOOP_DATA_ROOT!,`native-artifact-${randomUUID()}`);await mkdir(root,{recursive:true});
  for(const dir of ['app','src','scripts','desktop','command-chains','migrations','app-migrations'])await mkdir(join(root,dir));
  for(const file of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(root,file),file==='package.json'?JSON.stringify({version}):'{}');
  const program=fail?`console.error('controlled candidate startup failure');process.exit(1);`:
    `const args=process.argv.slice(2);const allocation=args[args.indexOf('--allocation-id')+1];
     const fs=require('node:fs');const path=require('node:path');const root=args[args.indexOf('--app-root')+1];
     const artifact=JSON.parse(fs.readFileSync(path.join(root,'harness-artifact.json'),'utf8')).artifactId;
     let activated=false;setInterval(()=>{},1000);process.send({kind:'update-host-ready',allocationId:allocation,pid:process.pid,artifactId:artifact,healthProtocol:${healthProtocol===null?'undefined':JSON.stringify(healthProtocol)}});
     process.on('message',message=>{if(message.kind==='shutdown-host')process.exit(0);
       if(message.kind==='probe-update-host'&&${healthProtocol===null})process.exit(99);
       if(message.kind==='activate-update-host'){activated=true;process.send({kind:'update-host-activated',requestId:message.requestId,allocationId:allocation,pid:process.pid,artifactId:artifact,outcome:'resumed'});}
       if(message.kind==='probe-update-host')process.send({kind:'update-host-health',requestId:message.requestId,allocationId:allocation,pid:process.pid,artifactId:artifact,
         health:{version:${brokenHealth?"'wrong-version'":"JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version"},owner:true,token:1,leaseExpiresAt:new Date(Date.now()+30000).toISOString(),
           managementMode:'update-silence',businessMode:'normal',updatePending:true,runId:null,runPhase:'stopped',lastError:null}});});
     process.on('disconnect',()=>process.exit(0));`;
  await writeFile(join(root,'scripts','fixture.cjs'),program);const source=await captureHarnessSource(root);
  await mkdir(join(root,'.next'));await writeFile(join(root,'.next','BUILD_ID'),'controlled-native-build');
  await writeFile(join(root,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-native-build'}));
  await mkdir(join(root,'desktop-runners'));await writeFile(join(root,'desktop-runners','host-service.cjs'),program);
  return writeHarnessArtifact(root);
}

test('default native startup verification performs fresh private health RPC before and after activation',{skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  const request={updateId:randomUUID(),caseId:'controlled-health',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,validateCompatibility:async()=>{},confirmOldHostsStopped:async()=>true,startupTimeoutMs:5000});
  const check=()=>store.assertRuntimeUpdate(authority);const signal=new AbortController().signal;
  try{
    await native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,signal,check);
    assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].status,'ready');
    store.advanceRuntimeUpdate(authority,'candidate-starting','candidate-activating');
    await native.activate(candidate,store.runtimeUpdate(request.updateId)!,signal,check);
    assert.equal(await native.observeStartup(candidate,store.runtimeUpdate(request.updateId)!,signal,check),'healthy');
    const pid=store.runtimeUpdateProcesses(request.updateId)[0].pid!;await native.cancelOwned(authority);assert.throws(()=>process.kill(pid,0),/ESRCH/);
  }finally{await native.cancelOwned(authority);store.close();}
});

test('default health rejects a live ready child claiming the wrong version, then physically cleans it',{skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate',true);
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  const request={updateId:randomUUID(),caseId:'controlled-wrong-health',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,validateCompatibility:async()=>{},confirmOldHostsStopped:async()=>true,startupTimeoutMs:5000});
  try{
    await assert.rejects(native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,new AbortController().signal,()=>store.assertRuntimeUpdate(authority)),/不健康/);
    const record=store.runtimeUpdateProcesses(request.updateId)[0];assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);
    await native.cancelOwned(authority);assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].status,'exited');
  }finally{await native.cancelOwned(authority);store.close();}
});

test('legacy readiness uses an explicit checked reader, never sends unsupported probe, and cleans both allocations',{skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'legacy',false,null);
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
  const request={updateId:randomUUID(),caseId:'controlled-legacy',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  let reads=0,stops=0;
  const readLegacyStartupHealth=Object.assign(async(record:Parameters<NonNullable<Parameters<typeof createNativeRuntimeUpdate>[0]['readLegacyStartupHealth']>>[0],signal:AbortSignal,check:()=>void)=>{
    check();signal.throwIfAborted();assert.ok(record.pid&&record.marker);process.kill(record.pid,0);reads++;
    return {version:record.artifact.version,owner:true,token:7,leaseExpiresAt:new Date(Date.now()+30000).toISOString(),managementMode:'update-silence',businessMode:'normal',updatePending:true,runId:null,runPhase:'stopped',lastError:null};
  },{stopOwned:async()=>{stops++;return true;}});
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,validateCompatibility:async()=>{},confirmOldHostsStopped:async()=>true,readLegacyStartupHealth,startupTimeoutMs:5000});
  const signal=new AbortController().signal;const check=()=>store.assertRuntimeUpdate(authority);
  try{
    await native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,signal,check);
    store.advanceRuntimeUpdate(authority,'candidate-starting','candidate-activating');
    await native.activate(candidate,store.runtimeUpdate(request.updateId)!,signal,check);
    assert.equal(await native.observeStartup(candidate,store.runtimeUpdate(request.updateId)!,signal,check),'healthy');assert.equal(reads,2);
    const pid=store.runtimeUpdateProcesses(request.updateId)[0].pid!;await native.cancelOwned(authority);assert.ok(stops);assert.throws(()=>process.kill(pid,0),/ESRCH/);
  }finally{await native.cancelOwned(authority);store.close();}
});

test('legacy reader cleanup failure still kills the held host and retains the cancellation barrier',{skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  const request={updateId:randomUUID(),caseId:'controlled-legacy-cleanup',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  let readerExited=false;
  const readLegacyStartupHealth=Object.assign(async()=>({}),{stopOwned:()=>{
    if(!readerExited)throw new Error('legacy reader cleanup failed synchronously');return Promise.resolve(true);
  }});
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,validateCompatibility:async()=>{},
    confirmOldHostsStopped:async()=>true,readLegacyStartupHealth,startupTimeoutMs:5000});
  try{
    await native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,new AbortController().signal,()=>store.assertRuntimeUpdate(authority));
    const record=store.runtimeUpdateProcesses(request.updateId)[0];process.kill(record.pid!,0);
    await assert.rejects(native.cancelOwned(authority),/退出未确认/);
    assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].status,'exited');
    assert.equal(store.control().management_mode,'update-silence');
    readerExited=true;await native.cancelOwned(authority);
  }finally{readerExited=true;await native.cancelOwned(authority);store.close();}
});

test('an unknown future health protocol cannot silently downgrade through the legacy reader',{skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'future',false,'private-health-v999');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
  const request={updateId:randomUUID(),caseId:'controlled-future',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');let calls=0;
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,validateCompatibility:async()=>{},confirmOldHostsStopped:async()=>true,readLegacyStartupHealth:async()=>{calls++;return {};},startupTimeoutMs:5000});
  try{
    await assert.rejects(native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,new AbortController().signal,()=>store.assertRuntimeUpdate(authority)),/健康协议未知/);
    assert.equal(calls,0);assert.throws(()=>process.kill(store.runtimeUpdateProcesses(request.updateId)[0].pid!,0),/ESRCH/);
  }finally{await native.cancelOwned(authority);store.close();}
});

test('damaged original installation and failed candidate recover through an actual historical startup, retaining both failures', {skip:process.platform==='win32'},async()=>{
  const initial=await nativeArtifact(false,'initial');const historical=await nativeArtifact(false,'historical');
  const damaged=await nativeArtifact(false,'later-installation');const failed=await nativeArtifact(true,'failed-candidate');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  store.setIntent('running','start');
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,
    validateCompatibility:async(artifact,update)=>{
      if(update.rollback)assert.equal(update.rollback.artifact.root,historical.root);
      assert.notEqual(artifact.root,update.rollback?damaged.root:'no-damaged-target');
    },confirmOldHostsStopped:async()=>true,startupTimeoutMs:5000});
  const controllers:ReturnType<typeof createRuntimeUpdateController>[]=[];
  async function successful(before:typeof initial,candidate:typeof initial) {
    const request={updateId:randomUUID(),caseId:'actual-startup-history',before,candidate};store.beginRuntimeUpdate(request);
    const controller=createRuntimeUpdateController({store,ownerId:'native-controller',...native});controllers.push(controller);
    for(const phase of ['candidate-starting','candidate-activating','candidate-observing','succeeded'])assert.equal((await controller.reconcile(request.updateId))!.phase,phase);
    await controller.shutdown();assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].status,'exited');
    return request;
  }
  try {
    const historicalRequest=await successful(initial,historical);await successful(historical,damaged);
    await writeFile(join(damaged.root,'desktop-runners','host-service.cjs'),'throw new Error("actual damaged installed bytes");');
    const original=store.observe({observationId:'damaged-original',scope:'runtime',scopeKey:'installation',sourceVersion:damaged.version,
      fingerprint:'damaged-installation',origin:'runtime',summary:'Original installation bytes damaged',evidence:{original:true}});
    const request={updateId:randomUUID(),caseId:original.caseId,before:damaged,candidate:failed};store.beginRuntimeUpdate(request);
    const controller=createRuntimeUpdateController({store,ownerId:'native-controller',...native});controllers.push(controller);
    for(const phase of ['candidate-starting','rolling-back','known-good-starting','known-good-activating','known-good-observing','rolled-back'])assert.equal((await controller.reconcile(request.updateId))!.phase,phase);
    const result=store.runtimeUpdate(request.updateId)!;
    assert.deepEqual(result.request,request,'original damaged installation is not replaced by a guessed healthy version');
    assert.deepEqual(result.rollback,{artifact:historical,sourceUpdateId:historicalRequest.updateId});
    assert.deepEqual(store.runtimeInstallation()!.artifact,historical);
    assert.match(result.failure!,/controlled candidate startup failure/);
    assert.ok(store.runtimeUpdateEvents(request.updateId).some(event=>event.detail?.includes('Original installation unavailable')));
    assert.notEqual(store.getCase(original.caseId)!.status,'resolved','startup rollback is not independent repair/business verification');
    const records=store.runtimeUpdateProcesses(request.updateId);assert.equal(records[0].status,'exited');assert.equal(records[1].status,'activated');
    assert.equal(records[1].artifact.root,historical.root);
    const reopened=new AdminManagementStore(join(dataRoot,'management.db'));
    try {assert.deepEqual(reopened.runtimeUpdate(request.updateId)!.rollback,result.rollback);}finally{reopened.close();}
    await controller.shutdown();for(const record of records)assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);
  } finally {
    for(const controller of controllers)await controller.shutdown();
    for(const record of store.liveRuntimeUpdateProcesses())await native.cancelOwned(record.authority);
    store.close();
  }
});

test('damaged original without historical startup evidence keeps update guard and never guesses a rollback artifact',async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate');
  await writeFile(join(before.root,'desktop-runners','host-service.cjs'),'damaged');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  const request={updateId:randomUUID(),caseId:'no-startup-history',before,candidate};store.beginRuntimeUpdate(request);
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,validateCompatibility:async()=>{},confirmOldHostsStopped:async()=>true});
  const controller=createRuntimeUpdateController({store,ownerId:'controller',...native});
  try {
    assert.equal((await controller.reconcile(request.updateId))!.phase,'rolling-back');
    await assert.rejects(controller.reconcile(request.updateId),/无可验证的历史回滚版本/);
    assert.equal(store.control().management_mode,'update-silence');assert.equal(store.runtimeUpdate(request.updateId)!.rollback,undefined);
    assert.deepEqual(store.runtimeUpdate(request.updateId)!.request,request);assert.equal(store.runtimeUpdateProcesses(request.updateId).length,0);
  }finally{await controller.shutdown();store.close();}
});

test('native private IPC candidate failure actually exits, drains its process group and starts known-good; no original Case is closed', {skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(true);
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  store.setIntent('running','start');const original=store.observe({observationId:'original',scope:'runtime',scopeKey:'runtime',sourceVersion:'known-good',fingerprint:'controlled-fault',origin:'runtime',summary:'Original controlled fault',evidence:{original:true}});
  const request={updateId:randomUUID(),caseId:original.caseId,before,candidate};store.beginRuntimeUpdate(request);
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,
    validateCompatibility:async()=>undefined,confirmOldHostsStopped:async()=>true,
    verifyStartup:async(_artifact,processRecord)=>{assert.ok(processRecord.pid);process.kill(processRecord.pid!,0);},startupTimeoutMs:5000});
  const controller=createRuntimeUpdateController({store,ownerId:'native-external-controller',...native});
  try {
    for(const phase of ['candidate-starting','rolling-back','known-good-starting','known-good-activating','known-good-observing','rolled-back']) {
      assert.equal((await controller.reconcile(request.updateId))!.phase,phase);
    }
    const records=store.runtimeUpdateProcesses(request.updateId);assert.equal(records.length,2);
    assert.equal(records[0].status,'exited');assert.ok(records[0].pid);assert.throws(()=>process.kill(records[0].pid!,0));
    assert.equal(records[1].status,'activated');process.kill(records[1].pid!,0);
    assert.equal(store.control().desired_intent,'running');assert.equal(store.control().management_mode,'normal');
    assert.equal(store.getCase(original.caseId)!.originalSummary,'Original controlled fault');assert.notEqual(store.getCase(original.caseId)!.status,'resolved');
    assert.match(store.runtimeUpdate(request.updateId)!.failure!,/controlled candidate startup failure/);
    await controller.shutdown();assert.throws(()=>process.kill(records[1].pid!,0));
    assert.equal(store.runtimeUpdateProcesses(request.updateId)[1].status,'exited');
  }finally {
    for(const record of store.runtimeUpdateProcesses(request.updateId))await native.cancelOwned(record.authority);
    await controller.shutdown();store.close();
  }
});

test('native replay recovers its current private connection without duplicate spawn; shutdown proves exit but leaves unfinished update held',{skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate');const store=new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!,randomUUID(),'management.db'));
  store.setIntent('running','start');const request={updateId:randomUUID(),caseId:'controlled-case',before,candidate};store.beginRuntimeUpdate(request);
  const native=createNativeRuntimeUpdate({store,dataRoot:join(process.env.LOOP_DATA_ROOT!,randomUUID()),executable:process.execPath,
    validateCompatibility:async()=>undefined,confirmOldHostsStopped:async()=>true,verifyStartup:async()=>undefined,startupTimeoutMs:5000});
  const authority=store.acquireRuntimeUpdate(request.updateId,'native-controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  const check=()=>store.assertRuntimeUpdate(authority);const update=store.runtimeUpdate(request.updateId)!;
  try {
    await native.startHeld(candidate,update,new AbortController().signal,check);
    const first=store.runtimeUpdateProcesses(request.updateId)[0];
    await native.startHeld(candidate,update,new AbortController().signal,check);
    assert.equal(store.runtimeUpdateProcesses(request.updateId).length,1);assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].pid,first.pid);
    await native.cancelOwned(authority);assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].status,'exited');assert.throws(()=>process.kill(first.pid!,0));
    assert.equal(store.control().management_mode,'update-silence');
  }finally {await native.cancelOwned(authority);store.close();}
});

test('durable reservation rejects connectionless replay and stale late binding cannot release or overwrite a different captured PID',async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate');const store=new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!,randomUUID(),'management.db'));
  store.setIntent('running','start');const request={updateId:randomUUID(),caseId:'controlled-case',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  const record=store.reserveRuntimeUpdateProcess(authority,candidate);
  const native=createNativeRuntimeUpdate({store,dataRoot:join(process.env.LOOP_DATA_ROOT!,randomUUID()),executable:process.execPath,
    validateCompatibility:async()=>undefined,confirmOldHostsStopped:async()=>true,verifyStartup:async()=>undefined});
  try {
    await assert.rejects(native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,new AbortController().signal,()=>store.assertRuntimeUpdate(authority)),/私有连接丢失/);
    assert.equal(store.runtimeUpdateProcesses(request.updateId).length,1);assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].pid,null);
    assert.equal(await native.stopOwned(store.runtimeUpdate(request.updateId)!,authority,()=>store.assertRuntimeUpdate(authority)),false);
    await assert.rejects(native.cancelOwned(authority),/退出未确认/);
    store.bindRuntimeUpdateProcess(record,999999,'controlled-marker');
    assert.throws(()=>store.bindRuntimeUpdateProcess(record,999999,'different-marker'),/迟到登记/);
    assert.throws(()=>store.advanceRuntimeUpdateProcess(authority,record.allocationId,'bound','activated'),/门禁/);
    assert.throws(()=>store.bindRuntimeUpdateProcess(record,888888,'other'),/迟到登记/);
    assert.throws(()=>store.confirmRuntimeUpdateProcessExit(record),/不匹配/);
  }finally {store.close();}
});

test('a live failed spawn proves no process was created and can clear its reservation without releasing the update guard',async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  store.setIntent('running','start');const request={updateId:randomUUID(),caseId:'controlled-case',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:join(dataRoot,'nonexistent-executable'),
    validateCompatibility:async()=>undefined,confirmOldHostsStopped:async()=>true,verifyStartup:async()=>undefined});
  const check=()=>store.assertRuntimeUpdate(authority);
  try {
    await assert.rejects(native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,new AbortController().signal,check),/ENOENT/);
    assert.equal(await native.stopOwned(store.runtimeUpdate(request.updateId)!,authority,check),true);
    const record=store.runtimeUpdateProcesses(request.updateId)[0];assert.equal(record.pid,null);assert.equal(record.status,'exited');
    assert.equal(store.control().management_mode,'update-silence');
  }finally {await native.cancelOwned(authority);store.close();}
});

test('a synchronous reader cleanup failure cannot suppress physical held-host termination or be reported as successful cancellation',{skip:process.platform==='win32'},async()=>{
  const before=await nativeArtifact();const candidate=await nativeArtifact(false,'candidate');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'management.db'));
  store.setIntent('running','start');const request={updateId:randomUUID(),caseId:'controlled-case',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;store.advanceRuntimeUpdate(authority,'stopping','candidate-starting');
  let readerExited=false;
  const compatibility=Object.assign(async()=>undefined,{stopOwned:()=>{
    if(!readerExited)throw new Error('reader cleanup failed synchronously');return Promise.resolve(true);
  }});
  const native=createNativeRuntimeUpdate({store,dataRoot,executable:process.execPath,validateCompatibility:compatibility,
    confirmOldHostsStopped:async()=>true,verifyStartup:async()=>undefined,startupTimeoutMs:5000});
  try {
    await native.startHeld(candidate,store.runtimeUpdate(request.updateId)!,new AbortController().signal,()=>store.assertRuntimeUpdate(authority));
    const record=store.runtimeUpdateProcesses(request.updateId)[0];process.kill(record.pid!,0);
    await assert.rejects(native.cancelOwned(authority),/退出未确认/);
    assert.throws(()=>process.kill(record.pid!,0));
    assert.equal(store.runtimeUpdateProcesses(request.updateId)[0].status,'exited');
    assert.equal(store.control().management_mode,'update-silence');
    readerExited=true;await native.cancelOwned(authority);
  }finally{readerExited=true;await native.cancelOwned(authority);store.close();}
});
