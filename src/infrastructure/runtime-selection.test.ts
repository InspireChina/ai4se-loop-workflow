import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';
import {selectInstalledRuntime} from './runtime-selection';
import {AdminManagementStore} from './admin-management-store';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {stageRuntimeArtifact} from './runtime-staging';

async function artifact(program:string,version:string) {
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(root,{recursive:true});
  for(const dir of ['app','src','scripts','desktop','command-chains','migrations','app-migrations','desktop-runners','.next'])await mkdir(join(root,dir));
  for(const file of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(root,file),file==='package.json'?JSON.stringify({version}):'{}');
  await writeFile(join(root,'scripts','fixture.cjs'),program);await writeFile(join(root,'desktop-runners','host-service.cjs'),program);
  const source=await captureHarnessSource(root);await writeFile(join(root,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-selection-build'}));await writeFile(join(root,'.next','BUILD_ID'),'controlled-selection-build');
  return writeHarnessArtifact(root);
}

test('actual standalone bootstrap delegates to selected artifact code, not just different root environment, while preserving private IPC and saved stop',async()=>{
  const compiled=await build({entryPoints:['scripts/loop/host-service-entry.ts'],bundle:true,platform:'node',format:'cjs',external:['better-sqlite3','next/cache'],write:false,logLevel:'silent'});
  const before=await artifact(compiled.outputFiles![0].text,'old-bootstrap');
  const candidate=await artifact(`const args=process.argv.slice(2);const root=args[args.indexOf('--app-root')+1];
    process.send({kind:'selected-fixture-ready',pid:process.pid,root,parent:process.ppid});setInterval(()=>{},1000);
    process.on('message',message=>{if(message.kind==='shutdown-host')process.exit(0)});process.on('disconnect',()=>process.exit(0));`,'selected-candidate');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
  store.setIntent('stopped','saved-stop');const request={updateId:randomUUID(),caseId:'controlled-case',before,candidate};store.beginRuntimeUpdate(request);
  const authority=store.acquireRuntimeUpdate(request.updateId,'controller')!;
  for(const [from,to] of [['stopping','candidate-starting'],['candidate-starting','candidate-activating'],['candidate-activating','candidate-observing'],['candidate-observing','succeeded']] as const)
    store.advanceRuntimeUpdate(authority,from,to,to==='candidate-observing'?{selected:candidate}:{});
  const env:NodeJS.ProcessEnv={...process.env,NODE_PATH:join(process.cwd(),'node_modules')};for(const key of Object.keys(env))if(key.startsWith('LOOP_TEST')||key==='NODE_TEST_CONTEXT')delete env[key];
  const child=spawn(process.execPath,[join(before.root,'desktop-runners','host-service.cjs'),'--app-root',before.root,'--data-root',dataRoot],{env,stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stdout!.on('data',()=>undefined);child.stderr!.on('data',bytes=>{stderr+=bytes.toString();});
  const closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(stderr)));});void closed.catch(()=>undefined);
  let selectedPid:number|undefined;
  try {
    const message=await new Promise<{pid:number;root:string;parent:number}>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Selected bootstrap timed out: ${stderr}`)),10000);
      child.on('message',message=>{if(message&&typeof message==='object'&&'kind'in message&&message.kind==='selected-fixture-ready'){clearTimeout(timer);resolve(message as unknown as {pid:number;root:string;parent:number});}});
      child.once('close',()=>{clearTimeout(timer);reject(new Error(stderr||'Bootstrap exited'));});
    });selectedPid=message.pid;assert.equal(message.root,candidate.root);assert.equal(message.parent,child.pid);assert.notEqual(message.pid,child.pid);
    assert.equal(store.control().desired_intent,'stopped');assert.equal(store.attempts().length,0);
    child.send({kind:'shutdown-host'});await closed;assert.throws(()=>process.kill(message.pid,0));assert.throws(()=>process.kill(child.pid!,0));
  }finally {
    if(child.connected)child.send({kind:'shutdown-host'});await closed.catch(()=>undefined);store.close();
    if(selectedPid)assert.throws(()=>process.kill(selectedPid!,0));
  }
});

test('ordinary bootstrap refuses changed bytes without pinning a mutable installer directory or writing into installed roots',async()=>{
  const before=await artifact('approved bytes','approved');const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  await assert.rejects(selectInstalledRuntime(before.root,join(before.root,'data')),/不可变安装目录/);
  const selected=await selectInstalledRuntime(before.root,dataRoot);assert.equal(selected.root,before.root);
  await writeFile(join(before.root,'desktop-runners','host-service.cjs'),'tampered');
  await assert.rejects(selectInstalledRuntime(before.root,dataRoot),/installed bytes changed/);
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));try{assert.equal(store.runtimeInstallation(),null);}finally{store.close();}
});

test('content-addressed staging preserves actual approved bytes independently of later build cache changes and reuses a verified snapshot',async()=>{
  const source=await artifact('approved installed bytes','staged');const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const staged=await stageRuntimeArtifact(source,dataRoot,new AbortController().signal,()=>undefined);
  assert.notEqual(staged.root,source.root);assert.equal(staged.artifactId,source.artifactId);
  assert.deepEqual(await stageRuntimeArtifact(source,dataRoot,new AbortController().signal,()=>undefined),staged);
  await writeFile(join(source.root,'desktop-runners','host-service.cjs'),'later build cache mutation');
  assert.equal(await readFile(join(staged.root,'desktop-runners','host-service.cjs'),'utf8'),'approved installed bytes');
  await assert.rejects(stageRuntimeArtifact(source,dataRoot,new AbortController().signal,()=>undefined),/installed bytes changed/);
});

test('staging never overwrites a corrupt published snapshot or accepts startup cancellation as a complete artifact',async()=>{
  const source=await artifact('approved installed bytes','staged');const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const staged=await stageRuntimeArtifact(source,dataRoot,new AbortController().signal,()=>undefined);
  await writeFile(join(staged.root,'desktop-runners','host-service.cjs'),'corrupt snapshot');
  await assert.rejects(stageRuntimeArtifact(source,dataRoot,new AbortController().signal,()=>undefined),/installed bytes changed/);
  assert.equal(await readFile(join(staged.root,'desktop-runners','host-service.cjs'),'utf8'),'corrupt snapshot');
  const abort=new AbortController();abort.abort();await assert.rejects(stageRuntimeArtifact(source,dataRoot,abort.signal,()=>undefined),/已取消/);
});

test('Desktop starts independent management before selected Web and leaves immutable selection/version validation to the native service',async()=>{
  const main=await readFile(join(process.cwd(),'desktop/main.mjs'),'utf8');
  assert.ok(main.indexOf('const initializing=createLifecycle(bootstrap);')<main.indexOf('await createWindow();'));
  assert.ok(main.indexOf('const host=await pending;')<main.indexOf('selectedRuntimeRoot=host.service.store.runtimeInstallation()'));
  assert.match(main,/createNativeExternalService/);assert.match(main,/lifecycle\.ui\.start/);
  assert.doesNotMatch(main,/createManagedLoopRunLifecycle|registerHostProcess|selectInstalledRuntime/);
});
