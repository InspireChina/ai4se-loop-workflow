import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {AdminManagementStore} from './admin-management-store';
import {createNativeAdminBusinessWorker} from './native-admin-business-worker';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {stageRuntimeArtifact} from './runtime-staging';
import {RuntimeCapabilityFailure,originalRuntimeArtifact} from '../domain/runtime-original-artifact';
import {createNativeAdminManagement} from './native-admin-management';
import {runAdminCommand} from '../application/admin-command';
import {prepareAdminHarnessWorkspaces} from './admin-harness-workspaces';

const protocol=`const raw=process.argv.slice(2);const allocationId=raw[raw.indexOf('--allocation-id')+1];
process.send({kind:'ready',allocationId,pid:process.pid});
process.on('message',message=>{process.send({kind:'result',allocationId,pid:process.pid,ok:true,
value:{operation:message.request.operation,pid:process.pid,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>/^LOOP_/i.test(key)))} });});`;
const hungProtocol=protocol.replace("process.send({kind:'result'", "return;process.send({kind:'result'");

async function fixture(program=protocol,timeoutMs=5000){
  const sourceRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(sourceRoot,{recursive:true});
  for(const dir of ['app','src','scripts','desktop','command-chains','migrations','app-migrations','desktop-runners','.next'])await mkdir(join(sourceRoot,dir));
  for(const file of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(sourceRoot,file),file==='package.json'?JSON.stringify({version:'controlled-capability'}):'{}');
  await writeFile(join(sourceRoot,'scripts','fixture.cjs'),program);await writeFile(join(sourceRoot,'desktop-runners','admin-business-worker.cjs'),program);
  const source=await captureHarnessSource(sourceRoot);await writeFile(join(sourceRoot,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'capability-fixture'}));
  await writeFile(join(sourceRoot,'.next','BUILD_ID'),'capability-fixture');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const artifact=await stageRuntimeArtifact(await writeHarnessArtifact(sourceRoot),dataRoot,new AbortController().signal,()=>{});
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));store.setIntent('running','start');
  const rootAuthority=store.acquireRuntimeHost('root')!;const managementAuthority=store.acquireSupervisor('root:management')!;
  store.initializeRuntimeInstallation(artifact);
  store.bindRuntimeHostArtifact(rootAuthority,artifact);
  const worker=createNativeAdminBusinessWorker({store,rootOwnerId:'root',appRoot:artifact.root,dataRoot,executable:process.execPath,timeoutMs});
  return {store,worker,artifact,rootAuthority,managementAuthority};
}
async function bound(h:Awaited<ReturnType<typeof fixture>>){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){const record=h.store.adminBusinessWorkers(true)[0];if(record?.marker)return record;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error('Actual capability identity was not persisted');
}

test('cold worker startup over five seconds has its own budget before the capability call',async()=>{
  const delayed=protocol.replace("process.send({kind:'ready',allocationId,pid:process.pid});","setTimeout(()=>process.send({kind:'ready',allocationId,pid:process.pid}),5500);");
  const h=await fixture(delayed,1000);
  try {
    const result=await h.worker.run({operation:'host-audit'}) as {operation:string};
    assert.equal(result.operation,'host-audit');assert.equal(h.store.adminBusinessWorkers(true).length,0);
  } finally {await h.worker.stopOwned();h.store.close();}
});

test('PID is durable before admission and failed admission cleans the captured child',async()=>{
  const h=await fixture(hungProtocol);let pid:number|undefined;
  const worker=createNativeAdminBusinessWorker({store:h.store,rootOwnerId:'root',appRoot:h.artifact.root,
    dataRoot:dirname(h.store.filename),executable:process.execPath,attachContainment:async input=>{
      pid=input.pid;const record=h.store.adminBusinessWorker(input.allocationId)!;
      assert.equal(record.pid,pid);assert.equal(record.status,'launching');
      return false;
    }});
  try {
    await assert.rejects(worker.run({operation:'host-audit'}),/无法进入 Windows Job/);
    assert.ok(pid);assert.throws(()=>process.kill(pid!,0),/ESRCH/);
    assert.equal(h.store.adminBusinessWorkers(true).length,0);
  } finally {await worker.stopOwned();await h.worker.stopOwned();h.store.close();}
});

test('Windows successor drains a receiptless legacy reservation and can execute host audit',
  {skip:process.platform!=='win32',timeout:60_000},async()=>{
    const h=await fixture();
    const parent=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});
    await once(parent,'close');assert.ok(parent.pid);
    const record=h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'host-audit'});
    const db=new Database(h.store.filename);
    try{db.prepare('UPDATE admin_business_worker_processes SET parent_pid=? WHERE allocation_id=?').run(parent.pid,record.allocationId);}finally{db.close();}
    h.store.releaseRuntimeHost(h.rootAuthority);h.store.releaseSupervisor(h.managementAuthority);
    const root=h.store.acquireRuntimeHost('successor',120_000)!;h.store.acquireSupervisor('successor:management',120_000);
    h.store.bindRuntimeHostArtifact(root,h.artifact);
    const worker=createNativeAdminBusinessWorker({store:h.store,rootOwnerId:'successor',appRoot:h.artifact.root,
      dataRoot:dirname(h.store.filename),executable:process.execPath});
    try {
      await worker.drainPrevious();
      assert.equal(h.store.adminBusinessWorker(record.allocationId)?.status,'exited');
      assert.equal((await worker.run({operation:'host-audit'}) as {operation:string}).operation,'host-audit');
      assert.equal(h.store.adminBusinessWorkers(true).length,0);
    }finally{await worker.stopOwned();h.store.close();}
  });

test('startup timeout and manual stop reap a worker that never announces readiness',{skip:process.platform==='win32'},async()=>{
  for(const stop of [false,true]) {
    const h=await fixture("setInterval(()=>{},1000);");
    const worker=createNativeAdminBusinessWorker({store:h.store,rootOwnerId:'root',appRoot:h.artifact.root,
      dataRoot:dirname(h.store.filename),executable:process.execPath,startupTimeoutMs:stop?30_000:1500});
    try {
      const pending=worker.run({operation:'host-audit'});void pending.catch(()=>undefined);
      const record=await bound(h);
      if(stop)await worker.stopOwned();
      await assert.rejects(pending,stop?/管理停止/:/启动超时/);
      assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);
      assert.equal(h.store.adminBusinessWorkers(true).length,0);
    } finally {await worker.stopOwned();await h.worker.stopOwned();h.store.close();}
  }
});

test('stopped-state suspension preserves the external root host audit until explicit shutdown',async()=>{
  const h=await fixture(hungProtocol);const pending=h.worker.run({operation:'host-audit'});void pending.catch(()=>undefined);
  try{
    const record=await bound(h);h.store.setIntent('stopped','persisted-stopped-state');
    await h.worker.suspendManagedOwned();process.kill(record.pid!,0);
    assert.equal(h.store.adminBusinessWorkers(true).length,1,'root audit remains available to finish startup fencing');
    await h.worker.stopOwned();await assert.rejects(pending,/管理停止或外部 root 失效/);
    assertGone(record.pid);assert.equal(h.store.adminBusinessWorkers(true).length,0);
  }finally{await h.worker.stopOwned();h.store.close();}
});

test('native write suspension preserves the actual update read-capability process; user STOP kills its physical group',
  {skip:process.platform==='win32'},async()=>{
  const h=await fixture(hungProtocol);
  const management=createNativeAdminManagement({store:h.store,rootOwnerId:'root',appRoot:h.artifact.root,
    dataRoot:dirname(h.store.filename),executable:process.execPath});
  const update=h.store.beginRuntimeUpdate({updateId:randomUUID(),caseId:'controlled-read-suspension',before:h.artifact,
    candidate:{...h.artifact,root:join(dirname(h.artifact.root),'controlled-unused-candidate'),artifactId:'d'.repeat(64)}});
  const authority=h.store.acquireRuntimeUpdate(update.request.updateId,'root')!;
  // This fixture program hangs instead of reading SQL. It proves native lane
  // lifetime and physical cancellation, not snapshot/verification success.
  const pending=management.freezeRuntimeBusinessBaseline(update,new AbortController().signal,()=>h.store.assertRuntimeUpdate(authority));
  void pending.catch(()=>{});
  try{
    const record=await bound(h);assert.equal(record.operation,'runtime-business-baseline');assert.equal(record.artifact.artifactId,h.artifact.artifactId);
    await management.suspendCapabilities!();process.kill(record.pid!,0);
    assert.equal(h.store.adminBusinessWorkers(true).length,1);
    h.store.setIntent('stopped','user-stop');await management.stopCapabilities!();await assert.rejects(pending);
    assertGone(record.pid);assert.equal(h.store.adminBusinessWorkers(true).length,0);
    assert.equal(h.store.getCase('controlled-read-suspension'),null);assert.equal(h.store.runtimeUpdateProcesses(update.request.updateId).length,0);
  }finally{await management.stopCapabilities!();await h.worker.stopOwned();h.store.close();}
});
function assertGone(pid:number|null){assert.ok(pid);assert.throws(()=>process.kill(pid,0),/ESRCH/);}

test('capability ledger fences both owners, keeps unknown allocations, and accepts immutable late cleanup identity',async()=>{
  const h=await fixture();
  try{
    const record=h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'discover'});
    assert.equal(record.pid,null);assert.equal(record.parentPid,process.pid);
    assert.throws(()=>h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'actions'}),/退出未确认/);
    h.store.setIntent('stopped','stop');
    h.store.bindAdminBusinessWorker(record,12345,'captured-start',12345);
    const attached=h.store.adminBusinessWorker(record.allocationId)!;
    assert.throws(()=>h.store.assertAdminBusinessWorker(attached),/运行意图/);
    assert.throws(()=>h.store.bindAdminBusinessWorker(record,12346,'other',12346),/不能覆盖/);
    assert.throws(()=>h.store.confirmAdminBusinessWorkerExit(record),/不匹配/);
    h.store.confirmAdminBusinessWorkerExit(attached);assert.equal(h.store.adminBusinessWorkers(true).length,0);
  }finally{await h.worker.stopOwned();h.store.close();}
});

test('actual private capability calls serialize and confirm physical exit before returning; authority env is stripped',{skip:process.platform==='win32'},async()=>{
  const h=await fixture();const original=process.env.LOOP_ADMIN_TOKEN;process.env.LOOP_ADMIN_TOKEN='must-not-inherit';
  try{
    const results=await Promise.all([h.worker.run({operation:'configuration'}),h.worker.run({operation:'discover'})]) as Array<{operation:string;pid:number;env:Record<string,string>}>;
    assert.deepEqual(results.map(result=>result.operation),['configuration','discover']);
    assert.notEqual(results[0].pid,results[1].pid);
    for(const result of results){assertGone(result.pid);assert.equal(result.env.LOOP_ADMIN_TOKEN,undefined);assert.equal(result.env.LOOP_TEST_MODE,undefined);}
    assert.equal(h.store.adminBusinessWorkers().length,2);assert.equal(h.store.adminBusinessWorkers(true).length,0);
  }finally{if(original===undefined)delete process.env.LOOP_ADMIN_TOKEN;else process.env.LOOP_ADMIN_TOKEN=original;await h.worker.stopOwned();h.store.close();}
});

test('a bound isolated build can run beside short diagnostics, but stop drains both physical lanes',{skip:process.platform==='win32'},async()=>{
  const h=await fixture(hungProtocol),builds=createNativeAdminBusinessWorker({store:h.store,rootOwnerId:'root',appRoot:h.artifact.root,
    dataRoot:dirname(h.store.filename),executable:process.execPath,lane:'harness-build'});
  const pending=builds.run({operation:'harness-build'});void pending.catch(()=>{});
  try{
    const build=await bound(h);assert.equal(build.operation,'harness-build');
    assert.throws(()=>h.worker.run({operation:'harness-build'}),/不能跨越/);
    await h.worker.drainPrevious();process.kill(build.pid!,0);
    // Same controlled program hangs in both lanes; this proves simultaneous
    // allocations without claiming that a compiler or model succeeded.
    const audit=h.worker.run({operation:'host-audit'});void audit.catch(()=>{});
    const deadline=Date.now()+3000;
    while((h.store.adminBusinessWorkers(true).length<2||h.store.adminBusinessWorkers(true).some(row=>!row.marker))&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));
    assert.equal(h.store.adminBusinessWorkers(true).length,2);assert.ok(h.store.adminBusinessWorkers(true).every(row=>!!row.marker));process.kill(build.pid!,0);
    const reader=new AdminManagementStore(h.store.filename);try{assert.equal(reader.adminBusinessWorkers(true).length,2);}finally{reader.close();}
    h.store.setIntent('stopped','stop-both');await Promise.all([h.worker.stopOwned(),builds.stopOwned()]);
    await assert.rejects(pending);await assert.rejects(audit);
    for(const row of h.store.adminBusinessWorkers()){assert.equal(row.status,'exited');assertGone(row.pid);}
    assert.equal(h.store.adminBusinessWorkers(true).length,0);
  }finally{await Promise.all([h.worker.stopOwned(),builds.stopOwned()]);h.store.close();}
});

test('an unknown build allocation blocks the diagnostic lane and survives until actual no-spawn cleanup is supplied',async()=>{
  const h=await fixture(),record=h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'harness-build'});
  try{
    await assert.rejects(h.worker.run({operation:'host-audit'}),/退出未确认/);
    assert.equal(h.store.adminBusinessWorkers().length,1);assert.equal(h.store.adminBusinessWorker(record.allocationId)!.pid,null);
  }finally{h.store.confirmAdminBusinessWorkerExit(record);await h.worker.stopOwned();h.store.close();}
});

test('unknown predecessor allocation blocks private spawn and explicit ordinary-admission drain',async()=>{
  const h=await fixture();
  const record=h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'discover'});
  try{
    await assert.rejects(h.worker.run({operation:'configuration'}),/退出未确认/);
    await assert.rejects(h.worker.drainPrevious(),/退出未确认/);
    assert.equal(h.store.adminBusinessWorkers().length,1);assert.equal(h.store.adminBusinessWorker(record.allocationId)?.pid,null);
  }finally{h.store.confirmAdminBusinessWorkerExit(record);await h.worker.stopOwned();h.store.close();}
});

test('stop aborts an actual hung capability and queued calls without additional spawn',{skip:process.platform==='win32'},async()=>{
  const h=await fixture(hungProtocol);
  const first=h.worker.run({operation:'discover'});void first.catch(()=>{});
  const second=h.worker.run({operation:'actions'});void second.catch(()=>{});
  try{
    const record=await bound(h);h.store.setIntent('stopped','user-stop');await h.worker.stopOwned();
    await assert.rejects(first);await assert.rejects(second);assertGone(record.pid);
    assert.equal(h.store.adminBusinessWorkers().length,1);assert.equal(h.store.adminBusinessWorkers(true).length,0);
  }finally{await h.worker.stopOwned();h.store.close();}
});

test('management read failure cannot suppress physical worker termination, and durable cleanup can retry',{skip:process.platform==='win32'},async()=>{
  const h=await fixture(hungProtocol);
  const pending=h.worker.run({operation:'discover'});void pending.catch(()=>{});const lookup=h.store.adminBusinessWorker;
  try{
    const record=await bound(h);
    h.store.adminBusinessWorker=()=>{throw new Error('management read unavailable');};
    await assert.rejects(h.worker.stopOwned(),/退出未确认/);await assert.rejects(pending);assertGone(record.pid);
    h.store.adminBusinessWorker=lookup;
    assert.equal(h.store.adminBusinessWorker(record.allocationId)?.status,'bound','uncertain persisted exit keeps the barrier');
    await h.worker.stopOwned();assert.equal(h.store.adminBusinessWorkers(true).length,0);
  }finally{h.store.adminBusinessWorker=lookup;await h.worker.stopOwned();h.store.close();}
});

test('a capability failure after manual stop/restart retains its old intent and cannot create a new recovery fault',{skip:process.platform==='win32'},async()=>{
  const h=await fixture(hungProtocol),pending=h.worker.run({operation:'discover'});void pending.catch(()=>{});
  try{
    const record=await bound(h);h.store.setIntent('stopped','stop');await h.worker.stopOwned();h.store.setIntent('running','restart');
    await assert.rejects(pending,error=>{
      assert.ok(error instanceof RuntimeCapabilityFailure);assert.equal(error.intentRevision,1);assert.equal(h.store.control().intent_revision,3);
      assert.equal(h.store.observeExternalRuntimeFailure(h.rootAuthority,error.intentRevision,error.selectionRevision,{observationId:randomUUID(),
        origin:'runtime',scope:'runtime',scopeKey:'old-call',fingerprint:'interrupted',sourceVersion:error.artifact.version,summary:error.message,evidence:{artifact:error.artifact}}),null);
      return true;
    });
    assertGone(record.pid);assert.equal(h.store.adminBusinessWorkers().length,1);
    const db=new Database(h.store.filename,{readonly:true});try{assert.equal(db.prepare('SELECT COUNT(*) FROM repair_cases').pluck().get(),0);}finally{db.close();}
  }finally{await h.worker.stopOwned();h.store.close();}
});

test('capability timeout terminates the actual hung process instead of merely rejecting lookup',{skip:process.platform==='win32'},async()=>{
  const h=await fixture(hungProtocol,1500);
  try{
    await assert.rejects(h.worker.run({operation:'discover'}),error=>{
      assert.ok(error instanceof RuntimeCapabilityFailure);assert.match(error.message,/调用超时/);
      assert.deepEqual(error.artifact,h.artifact);assert.equal(error.selectionRevision,1);assert.equal(error.operation,'discover');assert.equal(error.intentRevision,1);return true;
    });
    const record=h.store.adminBusinessWorkers()[0];assertGone(record.pid);assert.equal(record.status,'exited');
  }finally{await h.worker.stopOwned();h.store.close();}
});

test('native capability failure records its actual image and original source remains available through the management command',{skip:process.platform==='win32'},async()=>{
  const failure=protocol.replace('ok:true,','ok:false,error:"controlled business loader failure",');
  const h=await fixture(failure),dataRoot=dirname(h.store.filename);
  const management=createNativeAdminManagement({store:h.store,rootOwnerId:'root',appRoot:h.artifact.root,dataRoot,executable:process.execPath});
  try{
    assert.equal(await management.discover!(),0);
    const db=new Database(h.store.filename,{readonly:true,fileMustExist:true});let rows:{case_id:string}[];
    try{rows=db.prepare('SELECT case_id FROM repair_cases').all() as {case_id:string}[];}finally{db.close();}
    assert.equal(rows.length,2);
    for(const repairCase of rows){
      const observation=h.store.observations(repairCase.case_id)[0] as {evidence_json:string;observation_id:string;source_version:string};
      const evidence=JSON.parse(observation.evidence_json);assert.deepEqual(originalRuntimeArtifact(evidence),h.artifact);
      assert.equal(evidence.selectionRevision,1);assert.match(observation.source_version,new RegExp(h.artifact.artifactId));
    }
    const claim=h.store.claimNext(h.managementAuthority)!,credential=h.store.issueCommandCredential(claim);
    const original=h.store.observations(claim.repairCase.caseId)[0] as {observation_id:string};
    runAdminCommand(h.store,credential,['status']);runAdminCommand(h.store,credential,['harness','workspace','--key','source','--observation-id',original.observation_id,'--reason','Restore original capability source']);
    assert.deepEqual(await prepareAdminHarnessWorkspaces({store:h.store,authority:h.managementAuthority,dataRoot,assertCurrent:()=>{}}),{prepared:1});
    assert.equal(h.store.commandStatus(credential).actions[0].result!.sourceId,h.artifact.sourceId);
    assert.equal(h.store.adminBusinessWorkers().length,2);for(const record of h.store.adminBusinessWorkers()){assert.equal(record.status,'exited');assertGone(record.pid);}
  }finally{await management.stopCapabilities?.();await h.worker.stopOwned();h.store.close();}
});

test('ordinary startup predecessor drain does not kill its own in-flight capability or another broker in the same root',{skip:process.platform==='win32'},async()=>{
  const h=await fixture(hungProtocol);const pending=h.worker.run({operation:'discover'});void pending.catch(()=>{});
  const other=createNativeAdminBusinessWorker({store:h.store,rootOwnerId:'root',appRoot:h.artifact.root,dataRoot:h.store.filename.replace(/\/admin-management\.db$/,''),executable:process.execPath});
  try{
    const record=await bound(h);await h.worker.drainPrevious();process.kill(record.pid!,0);
    await assert.rejects(other.run({operation:'configuration'}),/退出未确认/);process.kill(record.pid!,0);
    await assert.rejects(other.drainPrevious(),/退出未确认/);process.kill(record.pid!,0);
    await h.worker.stopOwned();await assert.rejects(pending);assertGone(record.pid);
  }finally{await h.worker.stopOwned();await other.stopOwned();h.store.close();}
});

test('read-only host audit can be reserved during stopped/update intent without enabling mutating capabilities',async()=>{
  const h=await fixture();
  try{
    h.store.setIntent('stopped','stop');
    const record=h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'host-audit'});
    h.store.assertAdminBusinessWorker(record);h.store.confirmAdminBusinessWorkerExit(record);
    assert.throws(()=>h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'discover'}),/运行意图/);
    h.store.setUpdateSilence(true,'update');
    const audit=h.store.reserveAdminBusinessWorker(h.rootAuthority,h.managementAuthority,h.artifact,{operation:'host-audit'});
    h.store.assertAdminBusinessWorker(audit);h.store.confirmAdminBusinessWorkerExit(audit);
  }finally{await h.worker.stopOwned();h.store.close();}
});

test('immutable root diagnostics keep their code when a different business artifact is selected',{skip:process.platform==='win32'},async()=>{
  const rootFixture=await fixture(protocol.replace('value:{','value:{buildTag:"stable-root",'));
  const businessFixture=await fixture(protocol.replace('value:{','value:{buildTag:"selected-business",'));
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const rootArtifact=await stageRuntimeArtifact(rootFixture.artifact,dataRoot,new AbortController().signal,()=>{});
  const businessArtifact=await stageRuntimeArtifact(businessFixture.artifact,dataRoot,new AbortController().signal,()=>{});
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
  const root=store.acquireRuntimeHost('stable')!;store.setIntent('running','start');store.acquireSupervisor('stable:management');
  store.initializeRuntimeInstallation(businessArtifact);
  const worker=createNativeAdminBusinessWorker({store,rootOwnerId:'stable',appRoot:rootArtifact.root,dataRoot,executable:process.execPath});
  try{
    await assert.rejects(worker.run({operation:'host-audit'}),/缺少当前 root/);
    assert.equal(store.adminBusinessWorkers().length,0,'missing root identity fails strictly before allocation');
    store.bindRuntimeHostArtifact(root,rootArtifact);store.bindRuntimeHostArtifact(root,rootArtifact);
    assert.throws(()=>store.bindRuntimeHostArtifact(root,businessArtifact),/不能替换/);
    const business=await worker.run({operation:'configuration'}) as {buildTag:string};assert.equal(business.buildTag,'selected-business');
    store.setIntent('stopped','stop');store.setUpdateSilence(true,'silence');
    const audit=await worker.run({operation:'host-audit'}) as {buildTag:string};assert.equal(audit.buildTag,'stable-root');
    const records=store.adminBusinessWorkers();assert.equal(records[0].artifact.artifactId,businessArtifact.artifactId);assert.equal(records[1].artifact.artifactId,rootArtifact.artifactId);
    records.forEach(record=>assertGone(record.pid));
    store.releaseRuntimeHost(root);assert.throws(()=>store.runtimeHostArtifact(root),/所有权|监督/);
  }finally{await worker.stopOwned();store.close();await rootFixture.worker.stopOwned();rootFixture.store.close();await businessFixture.worker.stopOwned();businessFixture.store.close();}
});
