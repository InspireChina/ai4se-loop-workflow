import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {AdminManagementStore} from './admin-management-store';
import {createExternalRuntimeControls} from '../application/external-runtime-controls';
import {externalLifecycleView} from '../application/external-lifecycle-adapter';
import {runtimeUpdateIdSchema} from '../domain/runtime-update';

function fixture(){
  const filename=join(process.env.LOOP_DATA_ROOT!,randomUUID(),'management.db');
  const store=new AdminManagementStore(filename);const authority=store.acquireRuntimeHost('publisher-root')!;
  const before={root:'/controlled/old',sourceId:'a'.repeat(64),artifactId:'b'.repeat(64),version:'old'};
  const candidate={root:join(dirname(filename),'runtime-artifacts','d'.repeat(64)),sourceId:'c'.repeat(64),artifactId:'d'.repeat(64),version:'new'};
  store.bindRuntimeHostArtifact(authority,candidate);
  store.initializeRuntimeInstallation(before);
  const requestId=randomUUID(),attemptId=randomUUID();
  return {filename,store,authority,before,candidate,requestId,attemptId};
}

test('standard desktop adopts the newly installed runtime directly and retires stale handoff state',()=>{
  const f=fixture();try{
    const update=f.store.beginInstalledBootstrapTransition(f.authority,f.candidate)!;
    assert.equal(update.phase,'stopping');assert.equal(f.store.control().management_mode,'update-silence');
    const selected=f.store.adoptInstalledRuntime(f.authority,f.candidate);
    assert.deepEqual(selected.artifact,f.candidate);
    assert.equal(f.store.activeRuntimeUpdate(),null);assert.equal(f.store.runtimeUpdate(update.request.updateId)!.phase,'aborted');
    assert.equal(f.store.control().management_mode,'normal');
    assert.deepEqual(f.store.adoptInstalledRuntime(f.authority,f.candidate),selected,'restart is idempotent');
    f.store.preparePublisherUpdate(f.authority,'obsolete-publisher','obsolete-attempt','99.0.0');
    assert.equal(f.store.activePublisherUpdate()!.status,'preparing');
    assert.deepEqual(f.store.adoptInstalledRuntime(f.authority,f.candidate),selected);
    assert.equal(f.store.activePublisherUpdate(),null);
    assert.equal(f.store.publisherUpdate('obsolete-publisher')!.status,'aborted');
    assert.equal(f.store.control().management_mode,'normal');
  }finally{f.store.close();}
});

test('publisher metadata survives management restart and only the matching ready target enters external update',()=>{
  const f=fixture();
  try{
    const revision=f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new');
    assert.equal(f.store.beginPublisherInstallation(f.authority,f.candidate),null,'preparing is not physical readiness');
    f.store.markPublisherUpdateReady(f.authority,f.requestId,revision);
    const peer=new AdminManagementStore(f.filename);
    try{assert.equal(peer.activePublisherUpdate()!.targetVersion,'new');
      assert.equal(peer.beginPublisherInstallation(f.authority,f.before),null,'old installer cannot resume');
      assert.equal(peer.beginPublisherInstallation(f.authority,{...f.candidate,version:'wrong'}),null);
      const update=peer.beginPublisherInstallation(f.authority,f.candidate)!;
      assert.ok(runtimeUpdateIdSchema.safeParse(update.request.updateId).success,'publisher ID must be accepted by the actual host entry');
      assert.ok(update.request.updateId.startsWith('publisher-'));
      assert.equal(update.phase,'stopping');assert.deepEqual(update.request.before,f.before);assert.deepEqual(update.request.candidate,f.candidate);
      assert.equal(peer.publisherUpdate(f.requestId)!.status,'transitioned');assert.equal(peer.control().management_mode,'update-silence');
      assert.deepEqual(peer.runtimeInstallation()!.artifact,f.before,'candidate still needs compatibility, activation and health');
      assert.equal(peer.beginPublisherInstallation(f.authority,f.candidate),null,'restart/replay creates no second update');
      assert.throws(()=>peer.setUpdateSilence(false,'unsafe-resume'),/未完成/);
    }finally{peer.close();}
  }finally{f.store.close();}
});

test('a direct installer turns a verified version mismatch into a guarded update before old business startup',()=>{
  const f=fixture();try{
    const update=f.store.beginInstalledBootstrapTransition(f.authority,f.candidate)!;
    assert.equal(update.phase,'stopping');
    assert.deepEqual(update.request.before,f.before);assert.deepEqual(update.request.candidate,f.candidate);
    assert.match(update.request.updateId,/^installer-[a-f0-9]{64}$/);
    assert.equal(update.request.caseId,`installer:${update.request.updateId.slice('installer-'.length)}`);
    assert.equal(f.store.control().management_mode,'update-silence');
    assert.deepEqual(f.store.runtimeInstallation()!.artifact,f.before,'selection changes only after candidate health succeeds');
    assert.equal(f.store.beginInstalledBootstrapTransition(f.authority,f.candidate),null,'active update is replay-safe');
    let details=f.store.runtimeUpdateEvents(update.request.updateId,20,0).map(event=>event.detail);
    assert.ok(details.some(detail=>detail?.includes('Verified packaged bootstrap differs')));
    const updateAuthority=f.store.acquireRuntimeUpdate(update.request.updateId,'fixture-controller')!;
    f.store.advanceRuntimeUpdate(updateAuthority,'stopping','aborted',{selected:f.before});
    details=f.store.runtimeUpdateEvents(update.request.updateId,20,0).map(event=>event.detail);
    assert.equal(f.store.beginInstalledBootstrapTransition(f.authority,f.candidate),null,'identical rejected bytes are not retried on every launch');
    assert.deepEqual(f.store.runtimeUpdateEvents(update.request.updateId,20,0).map(event=>event.detail),details);
  }finally{f.store.close();}
});

test('direct installer transition cannot bypass publisher state or root-bound artifact identity',()=>{
  const f=fixture();try{
    f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new');
    assert.equal(f.store.beginInstalledBootstrapTransition(f.authority,f.candidate),null,'publisher preparation remains authoritative');
  }finally{f.store.close();}
  const mismatch=fixture();try{
    assert.throws(()=>mismatch.store.beginInstalledBootstrapTransition(mismatch.authority,{...mismatch.candidate,sourceId:'e'.repeat(64)}),/实际安装/);
    assert.equal(mismatch.store.activeRuntimeUpdate(),null);
  }finally{mismatch.store.close();}
  const filename=join(process.env.LOOP_DATA_ROOT!,randomUUID(),'selected.db');
  const store=new AdminManagementStore(filename);try{
    const candidate={root:join(dirname(filename),'runtime-artifacts','d'.repeat(64)),sourceId:'c'.repeat(64),artifactId:'d'.repeat(64),version:'new'};
    const authority=store.acquireRuntimeHost('selected-root')!;store.bindRuntimeHostArtifact(authority,candidate);
    store.initializeRuntimeInstallation(candidate);
    assert.equal(store.beginInstalledBootstrapTransition(authority,candidate),null);
  }finally{store.close();}
});

test('publisher physical readiness rejects unknown UI allocations and changed intent',()=>{
  const f=fixture();try{
    f.store.reserveRuntimeUiProcess(f.authority,f.before);
    const revision=f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new');
    assert.throws(()=>f.store.markPublisherUpdateReady(f.authority,f.requestId,revision),/进程屏障/);
    assert.equal(f.store.activePublisherUpdate()!.status,'preparing');
    f.store.setIntent('stopped','manual-stop');
    assert.throws(()=>f.store.markPublisherUpdateReady(f.authority,f.requestId,revision),/已失效/);
  }finally{f.store.close();}
});

test('user stop during installer downtime cancels pending selection without restoring running',()=>{
  const f=fixture();try{
    f.store.setIntent('running','initial-running');
    const revision=f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new');
    f.store.markPublisherUpdateReady(f.authority,f.requestId,revision);f.store.setIntent('stopped','user-stop');
    assert.equal(f.store.beginPublisherInstallation(f.authority,f.candidate),null);
    assert.equal(f.store.publisherUpdate(f.requestId)!.status,'aborted');assert.equal(f.store.control().desired_intent,'stopped');
    assert.equal(f.store.control().management_mode,'normal');assert.deepEqual(f.store.runtimeInstallation()!.artifact,f.before);
    assert.equal(f.store.activeRuntimeUpdate(),null);
  }finally{f.store.close();}
});

test('a matching version is insufficient when the candidate is not bound to the actual root artifact',()=>{
  const f=fixture();try{
    const revision=f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new');
    f.store.markPublisherUpdateReady(f.authority,f.requestId,revision);
    assert.throws(()=>f.store.beginPublisherInstallation(f.authority,{...f.candidate,sourceId:'e'.repeat(64)}),/实际安装/);
    assert.equal(f.store.activeRuntimeUpdate(),null);assert.equal(f.store.activePublisherUpdate()!.status,'ready');
  }finally{f.store.close();}
});

test('new runtime requests reject host-incompatible identifiers before persisting any update or silence',()=>{
  const f=fixture();try{
    for(const updateId of ['publisher:bad','../bad','space bad','newline\nbad','x'.repeat(201)]){
      assert.equal(runtimeUpdateIdSchema.safeParse(updateId).success,false);
      assert.throws(()=>f.store.beginRuntimeUpdate({updateId,caseId:'protocol',before:f.before,candidate:f.candidate}));
      assert.equal(f.store.activeRuntimeUpdate(),null);assert.equal(f.store.control().management_mode,'normal');
    }
    assert.ok(runtimeUpdateIdSchema.safeParse('publisher-'+ 'a'.repeat(64)).success);
  }finally{f.store.close();}
});

test('publisher preparation rejects target mutation and fenced root without replacing the active request',()=>{
  const f=fixture();try{
    const revision=f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new');
    assert.equal(f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new'),revision);
    assert.throws(()=>f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'different'),/不能变更/);
    assert.throws(()=>f.store.preparePublisherUpdate({...f.authority,token:f.authority.token+1},'other','other','new'),/失效/);
    assert.throws(()=>f.store.preparePublisherUpdate(f.authority,'other','other','new'),/仍在进行/);
    assert.throws(()=>f.store.setUpdateSilence(false,'unsafe-resume'),/不能直接/);
  }finally{f.store.close();}
});

test('real control seals publisher readiness only after successful cleanup and old resume cannot cancel a new update',async()=>{
  const f=fixture();let cleanupOk=false,cancels=0;
  const command=createExternalRuntimeControls({store:f.store,preparePublisherUpdate:(id,attempt,target)=>f.store.preparePublisherUpdate(f.authority,id,attempt,target),
    markPublisherUpdateReady:(id,revision)=>f.store.markPublisherUpdateReady(f.authority,id,revision),
    cancelPublisherUpdate:async()=>{cancels++;f.store.cancelPublisherUpdate(f.authority);},
    stopManagement:async()=>{},stopBusiness:async()=>cleanupOk,stopUpdates:async()=>{},reconcileIdleSleep:async()=>{},reconcile:async()=>{},
    assertStopped:async()=>{if(!cleanupOk)throw new Error('actual container still live');}});
  try{
    assert.equal((await command(f.requestId,{kind:'prepare-update',attemptId:f.attemptId,targetVersion:'new'})).outcome,'cleanup-pending');
    assert.equal(f.store.activePublisherUpdate()!.status,'preparing');cleanupOk=true;
    assert.equal((await command(f.requestId,{kind:'prepare-update',attemptId:f.attemptId,targetVersion:'new'})).outcome,'ready-for-update');
    assert.equal(f.store.activePublisherUpdate()!.status,'ready');
    assert.equal((await command('first-resume',{kind:'resume-after-update'})).outcome,'accepted');assert.equal(cancels,1);
    const second=randomUUID();await command(second,{kind:'prepare-update',attemptId:randomUUID(),targetVersion:'new'});
    assert.equal((await command('first-resume',{kind:'resume-after-update'})).outcome,'superseded');assert.equal(cancels,1);
    assert.equal(f.store.activePublisherUpdate()!.requestId,second);
  }finally{f.store.close();}
});

test('independent lifecycle view shows actual persisted publisher metadata, never the old business update',()=>{
  const f=fixture();try{
    f.store.preparePublisherUpdate(f.authority,f.requestId,f.attemptId,'new');
    const view=externalLifecycleView({control:f.store.control(),publisher:f.store.activePublisherUpdate()});
    assert.equal(view.mode.kind,'update-silence');if(view.mode.kind==='update-silence'){
      assert.equal(view.mode.targetVersion,'new');assert.equal(view.mode.attemptId,f.attemptId);assert.equal(view.mode.readiness,'pending');
    }
    assert.equal(view.run.phase,'unknown');assert.equal(view.run.healthy,false);
  }finally{f.store.close();}
});
