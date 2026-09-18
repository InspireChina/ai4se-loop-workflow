import assert from 'node:assert/strict';
import test from 'node:test';
import {createExternalLifecycleAdapter,externalLifecycleView} from './external-lifecycle-adapter';
import {runtimeFallbackDocument} from '../../desktop/runtime-fallback.mjs';
import {uiLifecycleRequestSchema} from '../domain/ui-lifecycle-protocol';
import {randomUUID} from 'node:crypto';
import {createDesktopRuntimeHost,prepareDesktopRuntimeInstall,startDesktopRuntimeUi} from '../../desktop/runtime-host.mjs';

const control={desired_intent:'stopped' as const,intent_revision:4,management_mode:'update-silence' as const,owner_id:'actual-manager',fencing_token:7,expires_at:123};
test('desktop view uses independent intent, preserves unknown business state and never invents liveness or ownership',()=>{
  const view=externalLifecycleView({control,businessError:'BUSINESS_DIAGNOSTIC_UNAVAILABLE'});
  assert.equal(view.intent.desired,'stopped');assert.equal(view.intent.revision,4);assert.equal(view.mode.kind,'update-silence');
  assert.equal(view.run.phase,'unknown');assert.equal(view.run.healthy,false);assert.equal(view.run.health,'unverified');
  assert.equal(view.supervision.owner,false);assert.equal(view.management.ownerId,'actual-manager');assert.equal(view.lastError,'BUSINESS_DIAGNOSTIC_UNAVAILABLE');
});

test('accepted control receipt is not mislabeled started/applied; cleanup refusal and actual latest intent are retained',async()=>{
  const adapter=createExternalLifecycleAdapter({status:async()=>({control}),command:async(requestId)=>({requestId,revision:3,outcome:'cleanup-pending',
    intent:'stopped',mode:'update-silence',failures:['actual UI group exit not confirmed']})});
  const receipt=await adapter.command({requestId:'original-request',action:{kind:'stop'}});
  assert.equal(receipt.outcome,'cleanup-pending');assert.equal(receipt.revision,3);assert.equal(receipt.snapshot.intent.revision,4);
  assert.equal(receipt.error,'actual UI group exit not confirmed');
});

test('private UI protocol cannot prepare updates, change actor authority, or smuggle unknown command fields',()=>{
  const request={kind:'ui-lifecycle-request',allocationId:randomUUID(),requestId:randomUUID(),operation:'command',command:{requestId:randomUUID(),action:{kind:'stop',reason:'user-stop'}}};
  assert.ok(uiLifecycleRequestSchema.safeParse(request).success);
  for(const action of [{kind:'prepare-update'},{kind:'stop',reason:'application-exit'},{kind:'start',actor:'host'}]){
    assert.equal(uiLifecycleRequestSchema.safeParse({...request,command:{...request.command,action}}).success,false);
  }
});

test('native failure document renders error as text and carries only preload-based controls',()=>{
  const document=runtimeFallbackDocument('</script><script>throw new Error("injected")</script>');
  assert.equal(document.includes('</script><script>throw'),false);assert.ok(document.includes('\\u003c/script>'));
  assert.ok(document.includes('textContent='));assert.ok(document.includes('bridge.retryUI()'));
  assert.equal(document.includes('http://localhost'),false);
});

test('desktop publishes the actual service before startup wait so shutdown can cancel an in-flight startup',async()=>{
  let resolveStart!:()=>void;const started=new Promise<void>(resolve=>{resolveStart=resolve;});let published:{shutdown:()=>Promise<void>}|undefined;let stops=0;let quitting=false;
  const service={start:()=>started,shutdown:async()=>{stops++;resolveStart();},store:{control:()=>({desired_intent:'stopped'})},
    lifecycle:{status:async()=>({}),command:async()=>({snapshot:{intent:{desired:'stopped'}}})},ui:{},reconcile:async()=>{}};
  const pending=createDesktopRuntimeHost({createService:async()=>service,onCreated:(host:{shutdown:()=>Promise<void>})=>{published=host;},isQuitting:()=>quitting});
  await Promise.resolve();assert.ok(published);quitting=true;await published.shutdown();await pending;assert.equal(stops,1);
});

test('quit requested during service construction skips business startup entirely',async()=>{
  let starts=0;let stops=0;
  await createDesktopRuntimeHost({createService:async()=>({start:async()=>{starts++;},shutdown:async()=>{stops++;},store:{control:()=>({desired_intent:'stopped'})},
    lifecycle:{status:async()=>({}),command:async()=>({})},ui:{},reconcile:async()=>{}}),onCreated:()=>{},isQuitting:()=>true});
  assert.equal(starts,0);assert.equal(stops,1);
});

test('desktop does not retry old-runtime handoff states before exposing startup result',async()=>{
  let reconciles=0;
  const service={start:async()=> 'observer',shutdown:async()=>undefined,store:{control:()=>({desired_intent:'stopped'})},
    lifecycle:{status:async()=>({}),command:async()=>({})},ui:{},reconcile:async()=>{reconciles++;return 'hosting';}};
  const host=await createDesktopRuntimeHost({createService:async()=>service,onCreated:()=>{},isQuitting:()=>false});
  assert.equal(await host.ready,'observer');assert.equal(reconciles,0);
});

test('desktop may publish immediately while deferred startup work continues in the background',async()=>{
  let resolveStart!:(state:string)=>void;const started=new Promise<string>(resolve=>{resolveStart=resolve;});const errors:unknown[]=[];
  const service={start:()=>started,shutdown:async()=>undefined,store:{control:()=>({desired_intent:'stopped'})},
    lifecycle:{status:async()=>({}),command:async()=>({snapshot:{intent:{desired:'stopped'}}})},ui:{},reconcile:async()=> 'hosting'};
  const host=await createDesktopRuntimeHost({createService:async()=>service,onCreated:()=>{},isQuitting:()=>false,deferStartup:true,
    onError:(error:unknown)=>errors.push(error),startupHandoffTimeoutMs:0});
  assert.equal(host.service,service);
  let ready=false;void host.ready.then(()=>{ready=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(ready,false);
  resolveStart('observer');await host.ready;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ready,true);
  assert.deepEqual(errors,[]);
});

test('desktop exposes its control UI for every settled lifecycle state',async()=>{
  for(const state of ['hosting','observer','updating','degraded']){
    const ports:number[]=[];
    const host={ready:Promise.resolve(state),ui:{start:async(port:number)=>{ports.push(port);return {url:`http://127.0.0.1:${port}`};}}};
    const result=await startDesktopRuntimeUi(host,async()=>4816);
    assert.deepEqual(result,{url:'http://127.0.0.1:4816'});
    assert.deepEqual(ports,[4816]);
  }
});

test('desktop update preparation no longer waits for cross-runtime readiness receipts',async()=>{
  const order:string[]=[];
  const lifecycle={service:{assertUpdateReady:async()=>{order.push('ready');}},shutdown:async()=>{order.push('shutdown');}};
  await prepareDesktopRuntimeInstall({lifecycle,stopUi:async()=>{order.push('ui');}});
  assert.deepEqual(order,['ui','shutdown']);
});
