import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createRuntimeUpdateController } from './runtime-update-controller';
import type { RuntimeUpdateRequest } from '../domain/runtime-update';
import {RuntimeCompatibilityResample} from '../domain/runtime-update';

function fixture() {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  let time = Date.now();
  const store = new AdminManagementStore(join(root,'management.db'), () => time);
  store.setIntent('running','original-user-start');
  const request: RuntimeUpdateRequest = { updateId: randomUUID(), caseId: 'original-case',
    before: { root: join(root,'known-good'), sourceId: 'a'.repeat(64), artifactId: 'b'.repeat(64), version: 'before' },
    candidate: { root: join(root,'candidate'), sourceId: 'c'.repeat(64), artifactId: 'd'.repeat(64), version: 'candidate' } };
  store.beginRuntimeUpdate(request);
  const actions: string[] = [];
  const base = {
    store, ownerId: 'external-controller',
    stopOwned: async () => { actions.push('physical-stop'); return true; },
    validateArtifactAndCompatibility: async (artifact: { version: string }) => { actions.push(`validate:${artifact.version}`); },
    startHeld: async (artifact: { version: string }) => { actions.push(`held:${artifact.version}`); },
    activate: async (artifact: { version: string }) => { actions.push(`activate:${artifact.version}`); },
    observeStartup: async (artifact: { version: string }) => { actions.push(`health:${artifact.version}`); return 'healthy' as const; },
    cancelOwned: async () => { actions.push('cancel-owned'); },
  };
  return { root, store, request, actions, base, advanceTime: (delta: number) => { time += delta; } };
}

function legacyFixture() {
  const f = fixture();
  // Controlled old-version persisted request, not a new API admission or
  // manufacturing a business completion. No physical allocations yet.
  const db = new Database(join(f.root, 'management.db'));
  const originalId = `publisher:${randomUUID()}`;
  const original = { ...f.request, updateId: originalId };
  try {
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      db.prepare('UPDATE admin_runtime_update_events SET update_id=? WHERE update_id=?').run(originalId, f.request.updateId);
      db.prepare('UPDATE admin_runtime_updates SET update_id=?,request_json=?,failure=? WHERE update_id=?')
        .run(originalId, JSON.stringify(original), 'original rejected CLI error', f.request.updateId);
    })();
  } finally { db.close(); }
  return { ...f, request: original };
}

test('original business baseline is frozen only after physical stop and before candidate launch',async()=>{
  const f=fixture();
  const controller=createRuntimeUpdateController({...f.base,freezeBusinessBaseline:async(update,signal,check)=>{
    check();signal.throwIfAborted();assert.equal(update.phase,'stopping');
    assert.equal(f.store.control().management_mode,'update-silence');f.actions.push('freeze-original-business');
  }});
  try{
    assert.equal((await controller.reconcile(f.request.updateId))!.phase,'candidate-starting');
    assert.deepEqual(f.actions,['validate:candidate','physical-stop','freeze-original-business']);
    await controller.reconcile(f.request.updateId);assert.equal(f.actions.at(-1),'held:candidate');
  }finally{await controller.shutdown();f.store.close();}
});

test('unconfirmed physical exit cannot enter baseline capture or candidate startup',async()=>{
  const f=fixture();let snapshots=0;
  const controller=createRuntimeUpdateController({...f.base,stopOwned:async()=>false,freezeBusinessBaseline:async()=>{snapshots++;}});
  try{assert.equal((await controller.reconcile(f.request.updateId))!.phase,'stopping');assert.equal(snapshots,0);assert.deepEqual(f.actions,['validate:candidate']);}
  finally{await controller.shutdown();f.store.close();}
});

test('baseline capture failure cannot launch a candidate and retains failure for guarded rollback',async()=>{
  const f=fixture();const controller=createRuntimeUpdateController({...f.base,freezeBusinessBaseline:async()=>{throw new Error('original business schema unreadable');}});
  try{
    const result=(await controller.reconcile(f.request.updateId))!;assert.equal(result.phase,'rolling-back');
    assert.match(result.failure!,/original business schema unreadable/);assert.deepEqual(f.actions,['validate:candidate','physical-stop']);
  }finally{await controller.shutdown();f.store.close();}
});

test('user STOP during baseline read fences the snapshot and prevents candidate admission',async()=>{
  const f=fixture();const controller=createRuntimeUpdateController({...f.base,freezeBusinessBaseline:async(_update,_signal,check)=>{
    f.store.setIntent('stopped','user-stop-during-snapshot');check();
  }});
  try{
    await assert.rejects(controller.reconcile(f.request.updateId));
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.phase,'stopping');assert.equal(f.store.control().desired_intent,'stopped');
    assert.equal(f.actions.some(action=>action.startsWith('held:')),false);
  }finally{await controller.shutdown();f.store.close();}
});

test('old host-incompatible requests drain and validate live data before an atomic legal replacement, retaining history and intent', async () => {
  const f = legacyFixture();
  const controller = createRuntimeUpdateController(f.base);
  try {
    const replacement = (await controller.reconcile(f.request.updateId))!;
    assert.match(replacement.request.updateId, /^recovery-[a-f0-9]{64}$/);
    assert.equal(replacement.phase, 'stopping');
    assert.deepEqual(replacement.request, { ...f.request, updateId: replacement.request.updateId });
    assert.deepEqual(f.actions, ['physical-stop','validate:before','physical-stop']);
    assert.equal(f.store.control().management_mode, 'update-silence');
    assert.equal(f.store.control().desired_intent, 'running');
    const retained = f.store.runtimeUpdate(f.request.updateId)!;
    assert.deepEqual(retained.request, f.request);
    assert.equal(retained.phase, 'aborted');
    assert.match(retained.failure!, /original rejected CLI error/);
    assert.ok(f.store.runtimeUpdateEvents(f.request.updateId).some(row => row.detail?.includes('reissued')));
    assert.equal(f.store.activeRuntimeUpdate()!.request.updateId, replacement.request.updateId);
    assert.equal((await controller.reconcile(f.request.updateId))!.phase, 'aborted', 'replay cannot create another replacement');
    for (const phase of ['candidate-starting','candidate-activating','candidate-observing','succeeded']) {
      assert.equal((await controller.reconcile(replacement.request.updateId))!.phase, phase);
    }
    assert.equal(f.store.control().management_mode, 'normal');
  } finally { await controller.shutdown(); f.store.close(); }
});

test('old request recovery retains its guard when physical exit or live-data readability is unproven', async () => {
  for (const failure of ['physical','compatibility','barrier']) {
    const f = legacyFixture();
    if (failure === 'barrier') {
      const authority = f.store.acquireRuntimeUpdate(f.request.updateId, 'external-controller')!;
      f.store.advanceRuntimeUpdate(authority, 'stopping', 'candidate-starting');
      f.store.reserveRuntimeUpdateProcess(authority, f.request.candidate);
    }
    const controller = createRuntimeUpdateController({ ...f.base,
      stopOwned: async () => failure !== 'physical',
      validateArtifactAndCompatibility: async () => { if (failure === 'compatibility') throw new Error('live data unreadable'); },
    });
    try {
      if (failure === 'physical') assert.equal((await controller.reconcile(f.request.updateId))!.phase, 'stopping');
      else await assert.rejects(controller.reconcile(f.request.updateId), /unreadable|进程屏障/);
      assert.equal(f.store.activeRuntimeUpdate()!.request.updateId, f.request.updateId);
      assert.equal(f.store.control().management_mode, 'update-silence');
      assert.deepEqual(f.store.runtimeUpdate(f.request.updateId)!.request, f.request);
      assert.ok(!f.actions.some(action => action.startsWith('held:')));
    } finally { await controller.shutdown(); f.store.close(); }
  }
});

test('user stop wins over legacy protocol recovery without replacement or model restart', async () => {
  const f = legacyFixture();
  const controller = createRuntimeUpdateController({ ...f.base,
    validateArtifactAndCompatibility: async () => { f.store.setIntent('stopped','user-stop-during-recovery'); },
  });
  try {
    await assert.rejects(controller.reconcile(f.request.updateId), /意图/);
    assert.equal(f.store.activeRuntimeUpdate()!.request.updateId, f.request.updateId);
    assert.equal((await controller.reconcile(f.request.updateId))!.phase, 'aborted');
    assert.equal(f.store.activeRuntimeUpdate(), null);
    assert.equal(f.store.control().desired_intent, 'stopped');
  } finally { await controller.shutdown(); f.store.close(); }
});

test('replacement persistence failure rolls back legacy retirement, installation and silence in the same transaction', async () => {
  const f = legacyFixture();
  const db = new Database(join(f.root, 'management.db'));
  db.exec("CREATE TRIGGER fail_replacement BEFORE INSERT ON admin_runtime_updates WHEN NEW.update_id LIKE 'recovery-%' BEGIN SELECT RAISE(ABORT, 'controlled replacement persistence failure'); END");
  db.close();
  const before = f.store.runtimeInstallation();
  const revision = f.store.control().intent_revision;
  const controller = createRuntimeUpdateController(f.base);
  try {
    await assert.rejects(controller.reconcile(f.request.updateId), /replacement persistence failure/);
    assert.equal(f.store.activeRuntimeUpdate()!.request.updateId, f.request.updateId);
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.phase, 'stopping');
    assert.deepEqual(f.store.runtimeInstallation(), before);
    assert.equal(f.store.control().intent_revision, revision);
    assert.equal(f.store.control().management_mode, 'update-silence');
    assert.ok(!f.store.runtimeUpdateEvents(f.request.updateId).some(row => row.phase === 'aborted'));
  } finally { await controller.shutdown(); f.store.close(); }
});

test('stale live snapshots retain each guarded phase and request fresh compatibility instead of rolling back a healthy candidate', async () => {
  const route = ['candidate-starting','candidate-activating','candidate-observing','rolling-back','known-good-starting','known-good-activating','known-good-observing'] as const;
  for (const phase of ['stopping', ...route]) {
    const f = fixture();
    const authority = f.store.acquireRuntimeUpdate(f.request.updateId, 'external-controller')!;
    let previous: 'stopping' | typeof route[number] = 'stopping';
    if (phase !== 'stopping') for (const next of route) {
      f.store.advanceRuntimeUpdate(authority, previous, next, next === 'candidate-observing' ? {selected:f.request.candidate}
        : next === 'known-good-starting' ? {selected:f.request.before} : undefined);
      previous = next;
      if (next === phase) break;
    }
    let stale = true;
    const controller = createRuntimeUpdateController({...f.base,validateArtifactAndCompatibility:async()=>{
      if(stale)throw new RuntimeCompatibilityResample('controlled live data changed');
    }});
    try {
      assert.equal((await controller.reconcile(f.request.updateId))!.phase,phase);
      assert.equal(f.store.control().management_mode,'update-silence');
      assert.equal(f.store.runtimeUpdate(f.request.updateId)!.failure,null);
      assert.ok(f.store.runtimeUpdateEvents(f.request.updateId).at(-1)!.detail?.includes('resample required'));
      assert.ok(!f.actions.some(action=>action.startsWith('held:')||action.startsWith('activate:')));
      stale = false;
      assert.notEqual((await controller.reconcile(f.request.updateId))!.phase,phase);
    } finally { await controller.shutdown(); f.store.close(); }
  }
});

test('stop while invalidating a legacy snapshot cancels physical activity rather than preserving a live held generation', async () => {
  const f=legacyFixture();
  const controller=createRuntimeUpdateController({...f.base,validateArtifactAndCompatibility:async()=>{
    f.store.setIntent('stopped','user-stop-stale-snapshot');throw new RuntimeCompatibilityResample('stale while stopped');
  }});
  try{
    await assert.rejects(controller.reconcile(f.request.updateId),/意图/);
    assert.ok(f.actions.includes('cancel-owned'));
    assert.equal(f.store.activeRuntimeUpdate()!.request.updateId,f.request.updateId);
  }finally{await controller.shutdown();f.store.close();}
});

test('external update holds ordinary startup, uses independent lease, and resumes only after actual startup health', async () => {
  const f=fixture();
  try {
    assert.equal(f.store.control().management_mode,'update-silence');
    assert.throws(()=>f.store.setUpdateSilence(false,'ordinary-restart'),/普通宿主不能解除/);
    const ordinary=f.store.acquireSupervisor('business-host')!;
    assert.ok(ordinary);
    const controller=createRuntimeUpdateController(f.base);
    for(const phase of ['candidate-starting','candidate-activating','candidate-observing','succeeded']) {
      const result=await controller.reconcile(f.request.updateId);assert.equal(result!.phase,phase);
      assert.equal(f.store.control().management_mode,phase==='succeeded'?'normal':'update-silence');
    }
    assert.deepEqual(f.actions,['validate:candidate','physical-stop','validate:candidate','held:candidate','validate:candidate','activate:candidate','validate:candidate','health:candidate']);
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.selected.artifactId,f.request.candidate.artifactId);
    assert.equal(f.store.control().desired_intent,'running');
    assert.equal(f.store.control().owner_id,'business-host');
    assert.equal(f.store.activeRuntimeUpdate(),null);
    assert.equal((await controller.reconcile(f.request.updateId))!.phase,'succeeded');
    await controller.shutdown();
  } finally {f.store.close();}
});

test('unconfirmed old physical exit never starts candidate or relinquishes the update guard', async () => {
  const f=fixture();
  try {
    const controller=createRuntimeUpdateController({...f.base,stopOwned:async()=>false});
    for(let index=0;index<4;index++)assert.equal((await controller.reconcile(f.request.updateId))!.phase,'stopping');
    assert.deepEqual(f.actions,['validate:candidate','validate:candidate','validate:candidate','validate:candidate']);
    assert.equal(f.store.control().management_mode,'update-silence');
    await controller.shutdown();
  }finally{f.store.close();}
});

test('candidate start failure rolls back to immutable known-good after drain and fresh live-data compatibility validation', async () => {
  const f=fixture();
  try {
    const controller=createRuntimeUpdateController({...f.base,startHeld:async artifact=>{
      f.actions.push(`held:${artifact.version}`);if(artifact.version==='candidate')throw new Error('candidate bootstrap failed');
    }});
    for(const phase of ['candidate-starting','rolling-back','known-good-starting','known-good-activating','known-good-observing','rolled-back']) {
      assert.equal((await controller.reconcile(f.request.updateId))!.phase,phase);
    }
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.selected.artifactId,f.request.before.artifactId);
    assert.match(f.store.runtimeUpdate(f.request.updateId)!.failure!,/bootstrap failed/);
    assert.deepEqual(f.actions,['validate:candidate','physical-stop','validate:candidate','held:candidate','physical-stop','validate:before','validate:before','held:before','validate:before','activate:before','validate:before','health:before']);
    assert.equal(f.store.control().management_mode,'normal');
    const events=f.store.runtimeUpdateEvents(f.request.updateId);
    assert.ok(events.some(event=>event.phase==='rolling-back'&&event.detail?.includes('bootstrap failed')));
    assert.equal(events.at(-1)!.phase,'rolled-back');
    await controller.shutdown();
  }finally{f.store.close();}
});

test('candidate health failure, rather than merely process spawn, drives rollback', async () => {
  const f=fixture();
  try {
    let checks=0;
    const controller=createRuntimeUpdateController({...f.base,observeStartup:async artifact=>{
      if(artifact.version==='before')return 'healthy';return ++checks===1?'waiting':'failed';
    }});
    for(let index=0;index<3;index++)await controller.reconcile(f.request.updateId);
    assert.equal((await controller.reconcile(f.request.updateId))!.phase,'candidate-observing');
    assert.equal(f.store.control().management_mode,'update-silence');
    assert.equal((await controller.reconcile(f.request.updateId))!.phase,'rolling-back');
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.request.caseId,'original-case');
    await controller.shutdown();
  }finally{f.store.close();}
});

test('user stop during update cancels owned activity and never restores the pre-update running intent', async () => {
  const f=fixture();
  try {
    const controller=createRuntimeUpdateController(f.base);
    await controller.reconcile(f.request.updateId);
    f.store.setIntent('stopped','real-user-stop');
    assert.equal((await controller.reconcile(f.request.updateId))!.phase,'aborted');
    assert.equal(f.store.control().desired_intent,'stopped');
    assert.equal(f.store.control().management_mode,'normal');
    assert.deepEqual(f.actions,['validate:candidate','physical-stop','physical-stop']);
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.selected.artifactId,f.request.before.artifactId);
    await controller.shutdown();
  }finally{f.store.close();}
});

test('lease renewal and user-stop detection remain live while an independent probe hangs', async () => {
  const f=fixture();
  try {
    let tick:(()=>void)|undefined;let release:(()=>void)|undefined;let started:(()=>void)|undefined;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const controller=createRuntimeUpdateController({...f.base,
      scheduleInterval: callback=>{tick=callback as ()=>void;return {unref:()=>undefined} as unknown as NodeJS.Timeout;},cancelInterval:()=>undefined,
      validateArtifactAndCompatibility:async(_artifact,_update,signal)=>{
        started!();await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});
      },
    });
    const running=controller.reconcile(f.request.updateId);await ready;
    f.advanceTime(10000);tick!();assert.ok(f.store.runtimeUpdate(f.request.updateId)!.expiresAt>Date.now()+20000);
    f.store.setIntent('stopped','stop-during-probe');tick!();
    await assert.rejects(running,/取消|意图/);assert.ok(f.actions.includes('cancel-owned'));
    release!();
    assert.equal((await controller.reconcile(f.request.updateId))!.phase,'aborted');
    await controller.shutdown();
  }finally{f.store.close();}
});

test('two external controllers cannot update concurrently and expired owners cannot advance a successor transaction', () => {
  const f=fixture();const peer=new AdminManagementStore(join(f.root,'management.db'),()=>Date.now()+40000);
  try {
    const first=f.store.acquireRuntimeUpdate(f.request.updateId,'first')!;
    assert.equal(f.store.acquireRuntimeUpdate(f.request.updateId,'second'),null);
    const successor=peer.acquireRuntimeUpdate(f.request.updateId,'second')!;assert.ok(successor.token>first.token);
    assert.throws(()=>f.store.advanceRuntimeUpdate(first,'stopping','candidate-starting'),/所有权/);
    assert.equal(f.store.renewRuntimeUpdate(first),false);
  }finally{peer.close();f.store.close();}
});

test('persisted update restart retains source identities, selected version, original case and phase; request replay is immutable', async () => {
  const f=fixture();
  try {
    const controller=createRuntimeUpdateController(f.base);await controller.reconcile(f.request.updateId);await controller.shutdown();
    const peer=new AdminManagementStore(join(f.root,'management.db'));
    try {
      const record=peer.runtimeUpdate(f.request.updateId)!;assert.equal(record.phase,'candidate-starting');
      assert.deepEqual(record.request,f.request);assert.deepEqual(record.selected,f.request.before);
      assert.equal(peer.beginRuntimeUpdate(f.request).phase,'candidate-starting');
      assert.throws(()=>peer.beginRuntimeUpdate({...f.request,candidate:{...f.request.candidate,sourceId:'e'.repeat(64)}}),/不能复用/);
      assert.throws(()=>peer.beginRuntimeUpdate({...f.request,updateId:'another'}),/仍在进行/);
    }finally{peer.close();}
  }finally{f.store.close();}
});

test('rollback compatibility refusal retains guarded automatic recovery without starting unreadable old code or losing original records', async () => {
  const f=fixture();
  try {
    let compatible=false;
    const controller=createRuntimeUpdateController({...f.base,
      startHeld:async artifact=>{if(artifact.version==='candidate')throw new Error('candidate failed');f.actions.push('known-good-start');},
      validateArtifactAndCompatibility:async artifact=>{if(artifact.version==='before'&&!compatible)throw new Error('new live schema not readable by old code');},
    });
    await controller.reconcile(f.request.updateId);await controller.reconcile(f.request.updateId);
    await assert.rejects(controller.reconcile(f.request.updateId),/not readable/);
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.phase,'rolling-back');
    assert.equal(f.store.control().management_mode,'update-silence');assert.ok(!f.actions.includes('known-good-start'));
    compatible=true;assert.equal((await controller.reconcile(f.request.updateId))!.phase,'known-good-starting');
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.request.before.sourceId,f.request.before.sourceId);
    await controller.shutdown();
  }finally{f.store.close();}
});

test('update transition gate rejects terminal shortcuts, foreign artifacts and stale revision bypass', () => {
  const f=fixture();
  try {
    const authority=f.store.acquireRuntimeUpdate(f.request.updateId,'owner')!;
    assert.throws(()=>f.store.advanceRuntimeUpdate(authority,'stopping','succeeded'),/阶段迁移/);
    assert.throws(()=>f.store.advanceRuntimeUpdate(authority,'stopping','candidate-starting',{selected:{...f.request.candidate,artifactId:'e'.repeat(64)}}),/请求以外/);
    f.store.setIntent('stopped','stop');
    assert.throws(()=>f.store.advanceRuntimeUpdate(authority,'stopping','candidate-starting'),/意图/);
    assert.throws(()=>f.store.advanceRuntimeUpdate(authority,'stopping','candidate-starting',{permitChangedIntent:true}),/阶段迁移/);
    assert.equal(f.store.activeRuntimeUpdate()!.phase,'stopping');
  }finally{f.store.close();}
});

test('external controller shutdown cancels a held generation between reconciliations without declaring physical exit or releasing its guard', async () => {
  const f=fixture();
  try {
    const controller=createRuntimeUpdateController(f.base);
    await controller.reconcile(f.request.updateId);await controller.reconcile(f.request.updateId);
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.phase,'candidate-activating');
    await controller.shutdown();assert.ok(f.actions.includes('cancel-owned'));
    assert.equal(f.store.control().management_mode,'update-silence');
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.phase,'candidate-activating');
    assert.equal((await controller.reconcile(f.request.updateId))!.phase,'candidate-activating');
  }finally{f.store.close();}
});

test('terminal update shutdown cancels its captured host and propagates an unconfirmed physical exit', async () => {
  const f=fixture();let exited=false;let cancellations=0;
  const controller=createRuntimeUpdateController({...f.base,cancelOwned:async()=>{
    cancellations++;if(!exited)throw new Error('physical exit unconfirmed');
  }});
  try {
    for(let phase=0;phase<4;phase++)await controller.reconcile(f.request.updateId);
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.phase,'succeeded');
    await assert.rejects(controller.shutdown(),/physical exit unconfirmed/);
    assert.equal(cancellations,1);
    exited=true;await controller.shutdown();assert.equal(cancellations,2);
    assert.equal(f.store.runtimeUpdate(f.request.updateId)!.phase,'succeeded');
  }finally{exited=true;await controller.shutdown();f.store.close();}
});

test('shutdown waits for the cancelled in-flight operation even when physical cleanup throws synchronously',async()=>{
  const f=fixture();let started!:()=>void;let release!:()=>void;let settled=false;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let cleanupFails=true;
  const controller=createRuntimeUpdateController({...f.base,
    validateArtifactAndCompatibility:async()=>{started();await gate;},
    cancelOwned:()=>{if(cleanupFails)throw new Error('physical cleanup unavailable');return Promise.resolve();},
  });
  const running=controller.reconcile(f.request.updateId);void running.catch(()=>undefined);
  try {
    await ready;
    const shutdown=controller.shutdown();
    void shutdown.then(()=>{settled=true;},()=>{settled=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
    release();await assert.rejects(shutdown,/physical cleanup unavailable/);
    await assert.rejects(running,/取消/);
    assert.equal(f.store.control().management_mode,'update-silence');
    cleanupFails=false;await controller.shutdown();
  }finally{release();cleanupFails=false;await controller.shutdown();f.store.close();}
});
