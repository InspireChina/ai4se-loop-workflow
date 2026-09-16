import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createServer} from 'node:http';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {AdminManagementStore} from './admin-management-store';
import {createNativeRuntimeUi} from './native-runtime-ui';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {build} from 'esbuild';
import {stageRuntimeArtifact} from './runtime-staging';
import {createNativeExternalService} from './native-external-service';

async function fixture(program=`require('node:http').createServer((req,res)=>res.end('owned UI')).listen(Number(process.env.PORT),'127.0.0.1')`){
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(root,{recursive:true});
  for(const dir of ['app','src','scripts','desktop','command-chains','migrations','app-migrations','.next','desktop-runners'])await mkdir(join(root,dir));
  for(const file of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(root,file),file==='package.json'?JSON.stringify({version:'ui-fixture'}):'{}');
  await writeFile(join(root,'scripts','fixture.cjs'),program);await writeFile(join(root,'server.js'),program);
  await build({entryPoints:[join(process.cwd(),'scripts/loop/ui-server-entry.ts')],outfile:join(root,'desktop-runners/ui-server.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['better-sqlite3']});
  await build({entryPoints:[join(process.cwd(),'src/infrastructure/external-ui-lifecycle-client.ts')],outfile:join(root,'desktop-runners/ui-client.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24'});
  // Resolve only the actual fixture Node ABI library, not a fake DB/host.
  await mkdir(join(root,'node_modules'),{recursive:true});
  for(const name of ['better-sqlite3','bindings','file-uri-to-path'])await cp(join(process.cwd(),'node_modules',name),join(root,'node_modules',name),{recursive:true,mode:constants.COPYFILE_FICLONE});
  const source=await captureHarnessSource(root);await writeFile(join(root,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-ui'}));
  await writeFile(join(root,'.next','BUILD_ID'),'controlled-ui');await writeFile(join(root,'external-ui-protocol.json'),JSON.stringify({version:1,sourceId:source.sourceId}));
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const artifact=await stageRuntimeArtifact(await writeHarnessArtifact(root),dataRoot,new AbortController().signal,()=>{});
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
  store.initializeRuntimeInstallation(artifact);const authority=store.acquireRuntimeHost('ui-root')!;
  store.bindRuntimeHostArtifact(authority,artifact);
  const native=createNativeRuntimeUi({store,dataRoot,toolRoot:artifact.root,executable:process.execPath,startupTimeoutMs:5000});
  return {artifact,store,authority,native};
}
async function listen(server:ReturnType<typeof createServer>){
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return (server.address() as {port:number}).port;
}
async function freePort(){const server=createServer();const port=await listen(server);await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

test('actual UI listener is independently owned before ready and its group exits before allocation release',{skip:process.platform!=='darwin'},async()=>{
  const f=await fixture();const signal=new AbortController();
  try{
    const {url}=await f.native.start(f.artifact,f.authority,await freePort(),signal.signal,()=>f.store.assertRuntimeHost(f.authority));
    const record=f.store.runtimeUiProcesses()[0];assert.equal(record.status,'ready');assert.equal(record.parentPid,process.pid);
    assert.equal(record.groupId,record.pid);assert.ok(record.marker);process.kill(record.pid!,0);
    assert.equal((await fetch(url)).status,200);
    assert.equal((await f.native.start(f.artifact,f.authority,await freePort(),signal.signal,()=>{})).url,url);
    assert.equal(f.store.runtimeUiProcesses().length,1);assert.equal(f.store.runtimeHostProcesses().length,0);
    assert.equal(await f.native.drainAll(),true);f.native.assertStopped();assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);
    assert.throws(()=>process.kill(-record.groupId!,0),/ESRCH/);assert.equal(f.store.control().desired_intent,'stopped');
  }finally{await f.native.drainAll();f.store.close();}
});

test('HTTP success from a different process cannot certify a new UI startup',{skip:process.platform!=='darwin'},async()=>{
  const f=await fixture('setInterval(()=>{},1000)');
  const old=createServer((req,res)=>res.end('old server'));const port=await listen(old);
  const native=createNativeRuntimeUi({store:f.store,dataRoot:dirname(f.store.filename),toolRoot:f.artifact.root,executable:process.execPath,startupTimeoutMs:500});
  try{
    await assert.rejects(native.start(f.artifact,f.authority,port,new AbortController().signal,()=>{}),/启动确认超时/);
    const record=f.store.runtimeUiProcesses()[0];assert.equal(record.status,'exited');assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'old server');
  }finally{await native.drainAll();await new Promise<void>(resolve=>old.close(()=>resolve()));f.store.close();}
});

test('unknown UI reservation survives takeover and cannot be waived or assigned to a new root',async()=>{
  const f=await fixture();
  try{
    const record=f.store.reserveRuntimeUiProcess(f.authority,f.artifact);
    assert.equal(await f.native.drainAll(),false);assert.throws(()=>f.native.assertStopped(),/屏障/);
    f.store.releaseRuntimeHost(f.authority);const next=f.store.acquireRuntimeHost('next')!;
    assert.throws(()=>f.store.reserveRuntimeUiProcess(next,f.artifact),/退出未确认/);
    f.store.bindRuntimeUiProcess(record,999999,'captured',999999);
    assert.throws(()=>f.store.bindRuntimeUiProcess(record,999998,'foreign',999998),/迟到/);
    assert.throws(()=>f.store.confirmRuntimeUiProcessExit(record),/不匹配/);
    assert.throws(()=>f.store.readyRuntimeUiProcess(record),/所有权/);
    assert.equal(f.store.runtimeUiProcesses()[0].authority.ownerId,'ui-root');
  }finally{f.store.close();}
});

test('update silence bars UI admission without overriding stopped business intent',async()=>{
  const f=await fixture();
  try{
    f.store.setUpdateSilence(true,'publisher-update');
    assert.throws(()=>f.store.reserveRuntimeUiProcess(f.authority,f.artifact),/门禁/);
    assert.equal(f.store.runtimeUiProcesses().length,0);assert.equal(f.store.control().desired_intent,'stopped');
  }finally{f.store.close();}
});

test('first UI identity persistence failure still terminates the captured live group despite logging failure',{skip:process.platform!=='darwin'},async()=>{
  const f=await fixture();const bind=f.store.bindRuntimeUiProcess.bind(f.store);let first=true;
  f.store.bindRuntimeUiProcess=(...args)=>{if(first){first=false;throw new Error('first UI attachment failed');}return bind(...args);};
  const native=createNativeRuntimeUi({store:f.store,dataRoot:dirname(f.store.filename),toolRoot:f.artifact.root,executable:process.execPath,
    onError:()=>{throw new Error('logger unavailable');}});
  try{
    await assert.rejects(native.start(f.artifact,f.authority,await freePort(),new AbortController().signal,()=>{}),/first UI attachment failed/);
    const record=f.store.runtimeUiProcesses()[0];assert.equal(record.status,'exited');assert.ok(record.pid&&record.marker);
    assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);assert.throws(()=>process.kill(-record.groupId!,0),/ESRCH/);
  }finally{f.store.bindRuntimeUiProcess=bind;await native.drainAll();f.store.close();}
});

test('late shutdown of an old root cannot terminate the successor actual UI',{skip:process.platform!=='darwin'},async()=>{
  const f=await fixture();
  try{
    f.store.releaseRuntimeHost(f.authority);const next=f.store.acquireRuntimeHost('successor')!;
    f.store.bindRuntimeHostArtifact(next,f.artifact);
    await f.native.start(f.artifact,next,await freePort(),new AbortController().signal,()=>f.store.assertRuntimeHost(next));
    const record=f.store.runtimeUiProcesses()[0];
    assert.equal(await f.native.cancelOwned(f.authority),true);assert.equal(f.store.runtimeUiProcesses()[0].status,'ready');
    process.kill(record.pid!,0);assert.equal(record.authority.ownerId,'successor');
    assert.equal(await f.native.cancelOwned(next),true);assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);
  }finally{await f.native.drainAll();f.store.close();}
});

test('actual guarded UI uses its private lifecycle channel and cannot promote itself into local supervision',{skip:process.platform!=='darwin'},async()=>{
  const f=await fixture(`const client=require('./desktop-runners/ui-client.cjs').createExternalUiLifecycleClient();
    require('node:http').createServer(async(req,res)=>{if(req.url==='/'){res.end('ready');return;}
      try{const value=await client.status();res.end(JSON.stringify(value));}catch(error){res.statusCode=500;res.end(String(error));}}).listen(Number(process.env.PORT),'127.0.0.1')`);
  let requests=0;
  const native=createNativeRuntimeUi({store:f.store,dataRoot:dirname(f.store.filename),toolRoot:f.artifact.root,executable:process.execPath,
    onLifecycleRequest:async request=>{assert.equal(request.operation,'status');requests++;return {intent:{desired:f.store.control().desired_intent}};}});
  try{
    const {url}=await native.start(f.artifact,f.authority,await freePort(),new AbortController().signal,()=>f.store.assertRuntimeHost(f.authority));
    const value=await (await fetch(url+'/state')).json();assert.deepEqual(value,{intent:{desired:'stopped'}});assert.equal(requests,1);
    assert.equal(f.store.runtimeHostProcesses().length,0);assert.equal(f.store.attempts().length,0);
    assert.equal(await native.cancelOwned(f.authority),true);
  }finally{await native.drainAll();f.store.close();}
});

test('user stop during actual native service construction persists before staging and cannot start a runner or repair attempt',async()=>{
  const f=await fixture();const cancellation=new AbortController();
  try{
    f.store.setIntent('running','previous-running');
    await assert.rejects(createNativeExternalService({appRoot:f.artifact.root,dataRoot:dirname(f.store.filename),executable:process.execPath,
      signal:cancellation.signal,onStoreReady:store=>{assert.equal(store.control().desired_intent,'running');
        store.setIntent('stopped','user-stop-during-construction');cancellation.abort(new Error('user-stop'));}}),/user-stop/);
    assert.equal(f.store.control().desired_intent,'stopped');assert.equal(f.store.runtimeHostProcesses().length,0);
    assert.equal(f.store.attempts().length,0);assert.equal(f.store.isRuntimeHostCurrent(f.authority),true);
  }finally{f.store.close();}
});
