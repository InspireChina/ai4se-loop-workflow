import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from '../infrastructure/admin-management-store';
import { createExternalRuntimeControls } from './external-runtime-controls';

function fixture(){
  const store=new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!,randomUUID(),'management.db'));
  store.setIntent('running','initial');const actions:string[]=[];
  const ports={store,stopManagement:async()=>{actions.push('management');},stopBusiness:async(check:()=>void)=>{check();actions.push('business');return true;},
    stopUpdates:async(check:()=>void)=>{check();actions.push('updates');},reconcileIdleSleep:async()=>{actions.push('sleep');},reconcile:async()=>{actions.push('reconcile');return 'hosting';},
    assertStopped:async(check:()=>void)=>{check();}};
  return {store,actions,ports};
}

test('stop commits its barrier before all physical operations, even if one cleanup fails synchronously',async()=>{
  const h=fixture();
  const command=createExternalRuntimeControls({...h.ports,stopManagement:()=>{assert.equal(h.store.control().desired_intent,'stopped');h.actions.push('management');throw Error('Controlled management cleanup failure');}});
  try{const receipt=await command('user-stop',{kind:'stop'});assert.equal(receipt.outcome,'cleanup-pending');assert.equal(receipt.intent,'stopped');
    assert.deepEqual(h.actions,['management','business','updates','sleep']);assert.match(receipt.failures[0],/Controlled management/);
  }finally{h.store.close();}
});

test('update readiness requires actual business/descendant exit proof, not a silent DB mode',async()=>{
  const h=fixture();const command=createExternalRuntimeControls({...h.ports,stopBusiness:async()=>{assert.equal(h.store.control().management_mode,'update-silence');h.actions.push('business');return false;}});
  try{const receipt=await command('publisher-prepare',{kind:'prepare-update'});assert.equal(receipt.outcome,'cleanup-pending');assert.equal(receipt.mode,'update-silence');assert.match(receipt.failures[0],/实际退出未确认/);
    assert.deepEqual(h.actions,['management','business','updates','sleep']);
  }finally{h.store.close();}
});

test('successful preparation keeps update silence and only explicit resume permits subsequent host reconciliation',async()=>{
  const h=fixture();const command=createExternalRuntimeControls(h.ports);
  try{assert.equal((await command('prepare',{kind:'prepare-update'})).outcome,'ready-for-update');assert.equal(h.store.control().management_mode,'update-silence');
    const count=h.actions.length;assert.equal((await command('start-while-silent',{kind:'start'})).outcome,'update-in-progress');assert.equal(h.actions.length,count);
    assert.equal((await command('resume',{kind:'resume-after-update'})).outcome,'accepted');assert.equal(h.store.control().management_mode,'normal');assert.equal(h.actions.includes('reconcile'),true);
  }finally{h.store.close();}
});

test('an obsolete request replay neither restarts nor repeats physical cleanup for a later intent',async()=>{
  const h=fixture();const command=createExternalRuntimeControls(h.ports);
  try{assert.equal((await command('old-stop',{kind:'stop'})).outcome,'stopped');await command('new-start',{kind:'start'});const count=h.actions.length;
    assert.equal((await command('old-stop',{kind:'stop'})).outcome,'superseded');assert.equal(h.store.control().desired_intent,'running');assert.equal(h.actions.length,count);
  }finally{h.store.close();}
});

test('unconfirmed durable allocations prevent readiness even when every cleanup callback claims completion',async()=>{
  const h=fixture();const command=createExternalRuntimeControls({...h.ports,assertStopped:async()=>{throw Error('Unknown durable Admin PID remains');}});
  try{const result=await command('prepare',{kind:'prepare-update'});assert.equal(result.outcome,'cleanup-pending');assert.match(result.failures[0],/Unknown durable Admin PID/);assert.equal(h.store.control().management_mode,'update-silence');}
  finally{h.store.close();}
});

test('a newer start before cleanup dispatch fences every obsolete physical operation',async()=>{
  const h=fixture();const command=createExternalRuntimeControls(h.ports);
  try{const stopping=command('old-stop',{kind:'stop'});const starting=command('new-start',{kind:'start'});
    assert.equal((await stopping).outcome,'superseded');assert.equal((await starting).outcome,'accepted');assert.deepEqual(h.actions,['reconcile','sleep']);
  }finally{h.store.close();}
});

test('an active automatic update cannot be resumed or replaced by a publisher preparation',async()=>{
  const h=fixture();const before={root:'/controlled/before',sourceId:'a'.repeat(64),artifactId:'b'.repeat(64),version:'controlled-v1'};
  h.store.beginRuntimeUpdate({updateId:randomUUID(),caseId:'controlled',before,candidate:{...before,root:'/controlled/candidate',sourceId:'c'.repeat(64),artifactId:'d'.repeat(64)}});
  const command=createExternalRuntimeControls(h.ports);
  try{for(const kind of ['resume-after-update','prepare-update','start'] as const)assert.equal((await command(randomUUID(),{kind})).outcome,'update-in-progress');assert.deepEqual(h.actions,[]);
    assert.equal((await command('user-stop',{kind:'stop'})).outcome,'stopped');assert.equal(h.store.control().desired_intent,'stopped');assert.ok(h.store.activeRuntimeUpdate(),'physical stop is not a fabricated terminal update transaction');
  }finally{h.store.close();}
});
