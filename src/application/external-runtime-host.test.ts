import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {AdminManagementStore} from '../infrastructure/admin-management-store';
import {createExternalRuntimeHost} from './external-runtime-host';
import {createRuntimeUpdateController} from './runtime-update-controller';
import {createExternalRuntimeFailureReporter} from './external-runtime-failure';

function fixture() {
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());const filename=join(root,'management.db');let now=Date.now();
  const store=new AdminManagementStore(filename,()=>now);
  const before={root:join(root,'before'),sourceId:'a'.repeat(64),artifactId:'b'.repeat(64),version:'known-good'};
  const candidate={root:join(root,'candidate'),sourceId:'c'.repeat(64),artifactId:'d'.repeat(64),version:'candidate'};
  const request={updateId:randomUUID(),caseId:'original-case',before,candidate};
  const actions:string[]=[];let tick:()=>void=()=>undefined;
  const ports={store,bootstrap:before,ownerId:'external-root',
    validateInstalled:async(artifact:typeof before)=>{actions.push(`validate:${artifact.version}`);},
    ensureSelected:async(artifact:typeof before)=>{actions.push(`ensure:${artifact.version}`);},
    drainNormal:async()=>{actions.push('drain');return true;},
    updates:{reconcile:async(id:string)=>{actions.push(`update:${id}`);},shutdown:async()=>{actions.push('update-shutdown');}},
    cancelOwned:async()=>{actions.push('cancel');return true;},
    scheduleInterval:(callback:()=>void)=>{tick=callback;return {unref(){}} as NodeJS.Timeout;},cancelInterval:()=>undefined};
  return {root,filename,store,before,candidate,request,actions,ports,tick:()=>tick(),advance:(delta:number)=>{now+=delta;}};
}

test('publisher silence without an automatic update never recreates an ordinary host on periodic reconciliation',async()=>{
  const f=fixture();f.store.setIntent('running','start');const host=createExternalRuntimeHost(f.ports);
  try{await host.reconcile();f.actions.length=0;f.store.setUpdateSilence(true,'publisher-prepare');
    assert.equal(await host.reconcile(),'updating');assert.equal(await host.reconcile(),'updating');assert.deepEqual(f.actions,['drain','drain']);
    f.store.setUpdateSilence(false,'publisher-resume');assert.equal(await host.reconcile(),'hosting');assert.ok(f.actions.includes('ensure:known-good'));
  }finally{await host.shutdown();f.store.close();}
});

test('installed selection commits atomically with update completion and restart cannot restore a stale bootstrap artifact',async()=>{
  const f=fixture();f.store.setIntent('running','start');f.store.beginRuntimeUpdate(f.request);
  const controller=createRuntimeUpdateController({store:f.store,ownerId:'update-controller',stopOwned:async()=>true,validateArtifactAndCompatibility:async()=>undefined,
    startHeld:async()=>undefined,activate:async()=>undefined,observeStartup:async()=> 'healthy',cancelOwned:async()=>undefined});
  try {
    for(const phase of ['candidate-starting','candidate-activating','candidate-observing','succeeded']) {
      assert.equal((await controller.reconcile(f.request.updateId))!.phase,phase);
      assert.deepEqual(f.store.runtimeInstallation()!.artifact,phase==='succeeded'?f.candidate:f.before);
    }
    assert.equal(f.store.runtimeInstallation()!.revision,2);assert.throws(()=>f.store.initializeRuntimeInstallation(f.before),/不能覆盖/);
    assert.throws(()=>f.store.beginRuntimeUpdate({...f.request,updateId:randomUUID()}),/不匹配/);
    await controller.shutdown();f.store.close();
    const reopened=new AdminManagementStore(f.filename);const host=createExternalRuntimeHost({...f.ports,store:reopened});
    try{assert.equal(await host.reconcile(),'hosting');assert.deepEqual(f.actions,['validate:candidate','ensure:candidate']);await host.shutdown();}
    finally{reopened.close();}
  }catch(error){try{f.store.close();}catch{}throw error;}
});

test('a legacy active update backfills its known-good selection; completed history backfills its actual selected version',()=>{
  for(const completed of [false,true]) {
    const f=fixture();f.store.beginRuntimeUpdate(f.request);
    if(completed) {
      const authority=f.store.acquireRuntimeUpdate(f.request.updateId,'controller')!;
      for(const [from,to] of [['stopping','candidate-starting'],['candidate-starting','candidate-activating'],['candidate-activating','candidate-observing'],['candidate-observing','succeeded']] as const)
        f.store.advanceRuntimeUpdate(authority,from,to,to==='candidate-observing'?{selected:f.candidate}:{});
    }
    f.store.close();const raw=new Database(f.filename);raw.exec('DROP TABLE admin_runtime_installation');raw.close();
    const reopened=new AdminManagementStore(f.filename);try{assert.deepEqual(reopened.runtimeInstallation()!.artifact,completed?f.candidate:f.before);}finally{reopened.close();}
  }
});

test('external root lease is independent of Admin and update leases, excludes competitors and fences old renewals',()=>{
  const f=fixture();try {
    f.store.beginRuntimeUpdate(f.request);const first=f.store.acquireRuntimeHost('root-one')!;
    assert.ok(f.store.acquireSupervisor('admin-owner'));assert.ok(f.store.acquireRuntimeUpdate(f.request.updateId,'update-owner'));
    assert.equal(f.store.acquireRuntimeHost('root-two'),null);f.advance(31000);const second=f.store.acquireRuntimeHost('root-two')!;
    assert.ok(second.token>first.token);assert.equal(f.store.renewRuntimeHost(first),false);assert.equal(f.store.releaseRuntimeHost(first),false);
    assert.throws(()=>f.store.assertRuntimeHost(first),/失效/);f.store.assertRuntimeHost(second);
  }finally{f.store.close();}
});

test('root management starts before selected business and remains supervised after ordinary startup failure',async()=>{
  const f=fixture();f.store.setIntent('running','start');let stops=0;
  const host=createExternalRuntimeHost({...f.ports,
    management:{start:async authority=>{f.store.assertRuntimeHost(authority);f.actions.push('management-start');},shutdown:async()=>{stops++;}},
    ensureSelected:async()=>{f.actions.push('business-failed');throw new Error('original business bootstrap failure');}});
  try{
    await assert.rejects(host.reconcile(),/original business bootstrap failure/);
    assert.equal(f.actions[0],'management-start');assert.equal(f.actions.at(-2),'business-failed');
    assert.equal(stops,0,'business failure is not management shutdown');
    assert.equal(f.store.acquireRuntimeHost('competitor'),null);
    await host.shutdown();assert.equal(stops,1);assert.ok(f.store.acquireRuntimeHost('competitor'));
  }finally{await host.shutdown();f.store.close();}
});

test('management background work is released only after the business admission attempt settles',async()=>{
  const f=fixture();f.store.setIntent('running','start');
  const host=createExternalRuntimeHost({...f.ports,management:{
    start:async()=>{f.actions.push('management-admitted');},
    settled:state=>{f.actions.push(`management-background:${state}`);},shutdown:async()=>undefined,
  }});
  try{
    assert.equal(await host.reconcile(),'hosting');
    assert.deepEqual(f.actions,['management-admitted','validate:known-good','ensure:known-good','management-background:hosting']);
  }finally{await host.shutdown();f.store.close();}
});

test('observing a foreign management lease blocks ordinary business startup but does not deadlock an authorized external update',async()=>{
  const f=fixture();const host=createExternalRuntimeHost({...f.ports,management:{start:async()=> 'observer',shutdown:async()=>undefined}});
  try{
    assert.equal(await host.reconcile(),'observer');assert.deepEqual(f.actions,[]);
    f.store.beginRuntimeUpdate(f.request);assert.equal(await host.reconcile(),'updating');
    assert.deepEqual(f.actions,['drain',`update:${f.request.updateId}`]);
  }finally{await host.shutdown();f.store.close();}
});

test('management cleanup failure cannot suppress normal physical cancellation or release the root, and shutdown can retry',async()=>{
  const f=fixture();let allowExit=false;let normalStops=0;
  const host=createExternalRuntimeHost({...f.ports,cancelOwned:async()=>{normalStops++;return true;},
    management:{start:async()=>undefined,shutdown:async()=>{if(!allowExit)throw new Error('Admin child exit uncertain');}}});
  try{
    await host.reconcile();await assert.rejects(host.shutdown(),/退出未确认/);
    assert.equal(normalStops,1);assert.equal(f.store.acquireRuntimeHost('competitor'),null);
    allowExit=true;await host.shutdown();assert.equal(normalStops,2);assert.ok(f.store.acquireRuntimeHost('competitor'));
  }finally{allowExit=true;await host.shutdown();f.store.close();}
});

test('root fencing shuts down only its captured management service and cannot release a successor root',async()=>{
  const f=fixture();let stops=0;
  const host=createExternalRuntimeHost({...f.ports,management:{start:async()=>undefined,shutdown:async()=>{stops++;}}});
  try{
    await host.reconcile();f.advance(31000);const successor=f.store.acquireRuntimeHost('successor')!;assert.ok(successor);
    f.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(stops,1);
    await assert.rejects(host.reconcile(),/已关闭/);await host.shutdown();f.store.assertRuntimeHost(successor);
  }finally{await host.shutdown();f.store.close();}
});

test('an unfinished update drains ordinary hosts, never starts an ordinary bootstrap and preserves its restart guard',async()=>{
  const f=fixture();f.store.beginRuntimeUpdate(f.request);const host=createExternalRuntimeHost({...f.ports,drainNormal:async()=>false});
  try{assert.equal(await host.reconcile(),'updating');assert.deepEqual(f.actions,[]);assert.equal(f.store.control().management_mode,'update-silence');await host.shutdown();}
  finally{f.store.close();}
});

test('selection changing during a long startup cancels the original owner instead of accepting stale success',async()=>{
  const f=fixture();f.store.initializeRuntimeInstallation(f.before);const host=createExternalRuntimeHost({...f.ports,ensureSelected:async()=>{f.store.beginRuntimeUpdate(f.request);}});
  try{await assert.rejects(host.reconcile(),/门禁已变化/);assert.ok(f.actions.includes('cancel'));assert.equal(f.store.control().management_mode,'update-silence');await host.shutdown();}
  finally{f.store.close();}
});

test('fencing cancels a blocked startup; failed update shutdown cannot prevent physical normal-host cancellation',async()=>{
  const f=fixture();let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  const host=createExternalRuntimeHost({...f.ports,ensureSelected:async(_artifact,_authority,signal)=>{
    ready();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  },updates:{...f.ports.updates,shutdown:async()=>{throw new Error('update diagnostic failed');}}});
  const running=host.reconcile();void running.catch(()=>undefined);await started;f.advance(31000);assert.ok(f.store.acquireRuntimeHost('successor'));f.tick();
  try{await assert.rejects(running,/停止|取消|失效/);await assert.rejects(host.shutdown(),/退出未确认/);assert.ok(f.actions.includes('cancel'));}
  finally{f.store.close();}
});

test('ordinary operation failure can retry under the same live external lease; neutral stopped intent still hosts diagnostics',async()=>{
  const f=fixture();let attempt=0;const host=createExternalRuntimeHost({...f.ports,ensureSelected:async()=>{if(++attempt===1)throw new Error('transient startup failure');}});
  try{await assert.rejects(host.reconcile(),/transient/);f.tick();assert.equal(await host.reconcile(),'hosting');assert.equal(f.store.control().desired_intent,'stopped');await host.shutdown();}
  finally{f.store.close();}
});

test('failed shutdown preserves ownership and can retry cleanup without reopening business dispatch',async()=>{
  const f=fixture();let exited=false;let cancellations=0;
  const host=createExternalRuntimeHost({...f.ports,cancelOwned:async()=>{cancellations++;return exited;}});
  try {
    await host.reconcile();
    const first=host.shutdown();assert.equal(host.shutdown(),first);
    await assert.rejects(first,/退出未确认/);
    assert.equal(f.store.acquireRuntimeHost('competitor'),null);
    await assert.rejects(host.reconcile(),/不能启动/);
    exited=true;await host.shutdown();assert.equal(cancellations,2);
    assert.ok(f.store.acquireRuntimeHost('competitor'));
    await host.shutdown();assert.equal(cancellations,2);
  }finally{f.store.close();}
});

test('synchronous update cleanup failure still attempts physical ordinary-host cancellation',async()=>{
  const f=fixture();let fail=true;let cancellations=0;
  const host=createExternalRuntimeHost({...f.ports,
    updates:{...f.ports.updates,shutdown:()=>{if(fail)throw new Error('synchronous cleanup failure');return Promise.resolve();}},
    cancelOwned:async()=>{cancellations++;return true;},
  });
  try {
    await host.reconcile();await assert.rejects(host.shutdown(),/退出未确认/);
    assert.equal(cancellations,1);assert.equal(f.store.acquireRuntimeHost('competitor'),null);
    fail=false;await host.shutdown();assert.equal(cancellations,2);
    assert.ok(f.store.acquireRuntimeHost('competitor'));
  }finally{f.store.close();}
});

test('synchronous physical cleanup failure cannot replace the original startup diagnostic',async()=>{
  const f=fixture();const diagnostics:unknown[]=[];let fail=true;
  const host=createExternalRuntimeHost({...f.ports,
    ensureSelected:async()=>{throw new Error('original startup failure');},
    cancelOwned:()=>{if(fail)throw new Error('secondary cleanup failure');return Promise.resolve(true);},
    onError:error=>{diagnostics.push(error);},
  });
  try {
    await assert.rejects(host.reconcile(),/original startup failure/);
    assert.ok(diagnostics.some(error=>String(error).includes('secondary cleanup failure')));
    fail=false;await host.shutdown();
  }finally{f.store.close();}
});

test('startup failure records the actual selected artifact, keeps all root causes across retries and does not trust bootstrap provenance',async()=>{
  const f=fixture();f.store.setIntent('running','start');f.store.initializeRuntimeInstallation(f.candidate);
  const record=createExternalRuntimeFailureReporter(f.store,f.ports.ownerId);const cases:string[]=[];
  const host=createExternalRuntimeHost({...f.ports,
    ensureSelected:async()=>{throw new Error('selected startup failed token=must-not-persist',{cause:new Error('specific loader error')});},
    onFailure:failure=>{const result=record(failure);assert.ok(result);cases.push(result.caseId);},
  });
  try {
    await assert.rejects(host.reconcile(),/selected startup failed/);await assert.rejects(host.reconcile(),/selected startup failed/);
    assert.equal(cases.length,2);assert.equal(cases[0],cases[1]);
    const observations=f.store.observations(cases[0]) as {source_version:string;evidence_json:string}[];
    assert.equal(observations.length,2);assert.match(observations[0].source_version,new RegExp(f.candidate.sourceId));
    const evidence=JSON.parse(observations[0].evidence_json);
    assert.deepEqual(evidence.artifact,f.candidate);assert.deepEqual(evidence.attemptedArtifact,f.candidate);assert.equal(evidence.selectionRevision,1);assert.equal(evidence.stage,'startup');
    assert.match(evidence.error.cause.message,/specific loader/);assert.ok(!JSON.stringify(evidence).includes('must-not-persist'));
    assert.equal(f.actions.filter(action=>action==='cancel').length,2);
  }finally{await host.shutdown();f.store.close();}
});

for(const change of ['stop','stop-and-restart','fence','update'] as const) {
  test(`a ${change} during startup is cancellation, not a new repair fault`,async()=>{
    const f=fixture();f.store.setIntent('running','start');f.store.initializeRuntimeInstallation(f.before);let recorded=0;
    const host=createExternalRuntimeHost({...f.ports,onFailure:()=>{recorded++;},ensureSelected:async()=>{
      if(change==='stop'||change==='stop-and-restart'){f.store.setIntent('stopped','stop');if(change==='stop-and-restart')f.store.setIntent('running','restart');}
      if(change==='fence'){f.advance(31000);f.store.acquireRuntimeHost('successor');}
      if(change==='update')f.store.beginRuntimeUpdate(f.request);
      throw new Error('startup interrupted');
    }});
    try{await assert.rejects(host.reconcile(),/startup interrupted/);assert.equal(recorded,0);assert.ok(f.actions.includes('cancel'));}
    finally{await host.shutdown();f.store.close();}
  });
}

test('failed management observation preserves primary startup error and still physically cancels',async()=>{
  const f=fixture();f.store.setIntent('running','start');const diagnostics:unknown[]=[];
  const host=createExternalRuntimeHost({...f.ports,onError:error=>{diagnostics.push(error);},
    onFailure:()=>{throw Error('observation database failure');},ensureSelected:async()=>{throw Error('original startup failed');}});
  try {
    await assert.rejects(host.reconcile(),/original startup failed/);
    assert.ok(diagnostics.some(error=>String(error).includes('observation database failure')));assert.ok(f.actions.includes('cancel'));
  }finally{await host.shutdown();f.store.close();}
});

test('a stop immediately before observation persistence wins atomically and adds no fault',async()=>{
  const f=fixture();f.store.setIntent('running','start');const record=createExternalRuntimeFailureReporter(f.store,f.ports.ownerId);
  const host=createExternalRuntimeHost({...f.ports,ensureSelected:async()=>{throw Error('startup failure');},
    onFailure:failure=>{f.store.setIntent('stopped','racing-stop');assert.equal(record(failure),null);},
  });
  try {
    await assert.rejects(host.reconcile(),/startup failure/);
    const read=new Database(f.filename,{readonly:true});try{assert.equal(read.prepare('SELECT count(*) FROM repair_cases').pluck().get(),0);}finally{read.close();}
    assert.ok(f.actions.includes('cancel'));
  }finally{await host.shutdown();f.store.close();}
});

test('validation failure preserves bounded aggregate causes and labels advertised source identity unverified',async()=>{
  const f=fixture();f.store.setIntent('running','start');const record=createExternalRuntimeFailureReporter(f.store,f.ports.ownerId);let caseId='';
  const cycle=new Error('cause repeated');cycle.cause=cycle;
  const aggregate=new AggregateError([cycle,...Array.from({length:8},(_,index)=>new Error(`cause-${index} token=secret-${index}`))],'manifest identity failed');
  const host=createExternalRuntimeHost({...f.ports,validateInstalled:async()=>{throw aggregate;},
    onFailure:failure=>{caseId=record(failure)!.caseId;},
  });
  try {
    await assert.rejects(host.reconcile(),/manifest identity/);
    const observation=f.store.observations(caseId)[0] as {source_version:string;evidence_json:string};const evidence=JSON.parse(observation.evidence_json);
    assert.match(observation.source_version,/^unverified-attempt:/);assert.equal(evidence.artifactIdentityVerified,false);
    assert.equal(evidence.error.errorsTotal,9);assert.equal(evidence.error.errorsTruncated,true);assert.equal(evidence.error.errors.length,4);
    assert.equal(evidence.error.errors[0].cause.truncated,true);assert.ok(!observation.evidence_json.includes('secret-'));
  }finally{await host.shutdown();f.store.close();}
});
