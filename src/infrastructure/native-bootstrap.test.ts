import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {cp,mkdir,readFile,realpath,writeFile,symlink,rename} from 'node:fs/promises';
import Database from 'better-sqlite3';
import test from 'node:test';
import {AdminManagementStore} from './admin-management-store';
import {resolveNativeBootstrap} from './native-bootstrap';
import {artifactFixture} from '../test/harness-artifact-fixture';
import {stageRuntimeArtifact} from './runtime-staging';
import {externalLifecycleView} from '../application/external-lifecycle-adapter';
import {originalRuntimeArtifact} from '../domain/runtime-original-artifact';
import {prepareAdminHarnessWorkspaces} from './admin-harness-workspaces';
import {runAdminCommand} from '../application/admin-command';
import {captureHarnessSource} from '../../scripts/harness-source.mjs';

async function fixture(){
 const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(dataRoot,{recursive:true});
 const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
 const source=await artifactFixture();const signal=new AbortController().signal;
 const cached=await stageRuntimeArtifact(source.descriptor,dataRoot,signal,()=>{});
 const authority=store.acquireRuntimeHost('old-root')!;store.bindRuntimeHostArtifact(authority,cached);store.releaseRuntimeHost(authority);
 const cases=()=>{const db=new Database(store.filename,{readonly:true,fileMustExist:true});
  try{return db.prepare('SELECT status FROM repair_cases').all() as {status:string}[];}finally{db.close();}};
 return {dataRoot,store,source,cached,signal,cases};
}

test('bootstrap prefers the actual verified install and does not manufacture a fault for an available current artifact',async()=>{
 const f=await fixture();try{
  const value=await resolveNativeBootstrap({...f,appRoot:f.source.root});assert.deepEqual(value,{bootstrap:f.cached});
  assert.equal(f.cases().length,0);assert.equal(f.store.attempts().length,0);
 }finally{f.store.close();}
});

test('damaged mutable installation recovers management from reverified prior root and retains the original failure across retries',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source.root,'desktop-runners/host-service.cjs'),'damaged bytes');let reports=0;
  const options={...f,appRoot:f.source.root,onError:()=>{reports++;throw new Error('logger unavailable');}};
  const value=await resolveNativeBootstrap(options);assert.deepEqual(value.bootstrap,f.cached);assert.match(value.installationError!,/installed bytes changed/);
  const view=externalLifecycleView({control:f.store.control(),installationError:value.installationError});
  assert.equal(view.lastError,'BOOTSTRAP_UNAVAILABLE');assert.equal(view.bootstrapWarning,value.installationError);assert.equal(view.run.healthy,false);
  assert.equal(f.cases().length,1);assert.equal(f.cases()[0]!.status,'queued');assert.equal(f.store.attempts().length,0);
  assert.deepEqual(await resolveNativeBootstrap(options),value);assert.equal(f.cases().length,1);assert.ok(reports>=2);
 }finally{f.store.close();}
});

test('a damaged cached artifact is not trusted based on its saved hash and absence of a verified fallback persists a fault',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source.root,'desktop-runners/host-service.cjs'),'damaged install');
  await writeFile(join(f.cached.root,'desktop-runners/host-service.cjs'),'damaged cache');
  await assert.rejects(resolveNativeBootstrap({...f,appRoot:f.source.root}),/均不可用/);
  assert.equal(f.cases().length,1);assert.equal(f.cases()[0]!.status,'queued');
  assert.equal(f.store.runtimeHostProcesses().length,0);assert.equal(f.store.attempts().length,0);
 }finally{f.store.close();}
});

test('cache outside the bound content-addressed root, even with matching bytes, cannot become management bootstrap',async()=>{
 const f=await fixture();try{
  const outside=join(f.dataRoot,'outside');await cp(f.cached.root,outside,{recursive:true});
  await writeFile(join(f.source.root,'desktop-runners/host-service.cjs'),'damaged install');
  await assert.rejects(resolveNativeBootstrap({...f,appRoot:f.source.root,store:{observe:input=>f.store.observe(input),
   runtimeBootstrapCandidates:()=>[{...f.cached,root:outside}]}}),/均不可用/);
 }finally{f.store.close();}
});

test('cache root symlink escape is rejected and an aborted startup never falls back or records an Agent fault',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source.root,'desktop-runners/host-service.cjs'),'damaged install');
  const moved=f.cached.root+'-moved';await rename(f.cached.root,moved);await symlink(moved,f.cached.root);
  await assert.rejects(resolveNativeBootstrap({...f,appRoot:f.source.root}),/均不可用/);assert.equal(f.cases().length,1);
  const stopped=new Error('user-stop');const signal=AbortSignal.abort(stopped);
  await assert.rejects(resolveNativeBootstrap({...f,signal,appRoot:f.source.root}),error=>error===stopped);
  assert.equal(f.cases().length,1);assert.equal(f.store.attempts().length,0);
 }finally{f.store.close();}
});

test('one malformed historical binding and a failing logger cannot hide a valid earlier bootstrap',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.source.root,'desktop-runners/host-service.cjs'),'damaged install');
  const db=new Database(f.store.filename);try{db.prepare('INSERT INTO admin_runtime_root_artifacts(owner_id,token,artifact_json) VALUES(?,?,?)').run('malformed',1,'not-json');}finally{db.close();}
  const value=await resolveNativeBootstrap({...f,appRoot:f.source.root,onError:()=>{throw Error('logger failed');}});
  assert.deepEqual(value.bootstrap,f.cached);assert.equal(f.cases().length,1);
 }finally{f.store.close();}
});

test('repeated bindings of a damaged recent artifact do not evict the earlier valid candidate from the bounded search',async()=>{
 const f=await fixture();try{
  const newer=await artifactFixture('newer-root');const bad=await stageRuntimeArtifact(newer.descriptor,f.dataRoot,f.signal,()=>{});
  for(let i=0;i<12;i++){const authority=f.store.acquireRuntimeHost('repeat-'+i)!;f.store.bindRuntimeHostArtifact(authority,bad);f.store.releaseRuntimeHost(authority);}
  await writeFile(join(bad.root,'desktop-runners/host-service.cjs'),'damaged cache');
  await writeFile(join(f.source.root,'desktop-runners/host-service.cjs'),'damaged install');
  assert.deepEqual((await resolveNativeBootstrap({...f,appRoot:f.source.root})).bootstrap,f.cached);
  assert.equal(f.store.runtimeBootstrapCandidates().length,2);
 }finally{f.store.close();}
});

test('independently packaged management image starts diagnosis before a damaged first install and exposes only exact equivalent source',async()=>{
 const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(dataRoot,{recursive:true});
 const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
 const installed=await artifactFixture('same packaged source'),management=await artifactFixture('same packaged source');
 try{
  await writeFile(join(installed.root,'desktop-runners/host-service.cjs'),'damaged before first capability');
  const result=await resolveNativeBootstrap({appRoot:installed.root,managementRoot:management.root,dataRoot,
    signal:new AbortController().signal,store});
  assert.match(result.installationError!,/installed bytes changed/);
  assert.equal(result.bootstrap.root,join(dataRoot,'runtime-artifacts',result.bootstrap.artifactId));
  assert.equal(result.bootstrap.sourceId,installed.descriptor.sourceId);
  const database=new Database(store.filename,{readonly:true,fileMustExist:true});let evidence:Record<string,unknown>,observationId:string;
  try{const row=database.prepare('SELECT observation_id,evidence_json FROM repair_observations').get() as {observation_id:string;evidence_json:string};
    observationId=row.observation_id;evidence=JSON.parse(row.evidence_json);}
  finally{database.close();}
  assert.deepEqual(originalRuntimeArtifact(evidence),result.bootstrap);
  assert.equal((evidence.sourceEquivalence as {installedRoot:string}).installedRoot,await realpath(installed.root));
  store.setIntent('running','start-external-diagnosis');const authority=store.acquireSupervisor('root:management')!;
  const claim=store.claimNext(authority)!,credential=store.issueCommandCredential(claim);store.commandStatus(credential);
  runAdminCommand(store,credential,['harness','workspace','--key','source','--observation-id',observationId,'--reason','Restore exact damaged install source']);
  assert.deepEqual(await prepareAdminHarnessWorkspaces({store,authority,dataRoot,assertCurrent:()=>{}}),{prepared:1});
  const action=store.commandStatus(credential).actions[0]!;assert.equal(action.result!.phase,'prepared');
  assert.equal((await captureHarnessSource(action.result!.workspaceRoot as string)).sourceId,installed.descriptor.sourceId);
  assert.equal(await readFile(join(installed.root,'desktop-runners/host-service.cjs'),'utf8'),'damaged before first capability');
 }finally{store.close();}
});

test('different management source may keep diagnosis alive but cannot masquerade as the damaged install source',async()=>{
 const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(dataRoot,{recursive:true});
 const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));
 const installed=await artifactFixture('installed source'),management=await artifactFixture('different management source');
 try{
  await writeFile(join(installed.root,'desktop-runners/host-service.cjs'),'damaged before first capability');
  await resolveNativeBootstrap({appRoot:installed.root,managementRoot:management.root,dataRoot,signal:new AbortController().signal,store});
  const database=new Database(store.filename,{readonly:true,fileMustExist:true});let evidence:Record<string,unknown>;
  try{evidence=JSON.parse((database.prepare('SELECT evidence_json FROM repair_observations').get() as {evidence_json:string}).evidence_json);}
  finally{database.close();}
  assert.equal(evidence.sourceArtifact,undefined);assert.throws(()=>originalRuntimeArtifact(evidence),/缺少准确/);
 }finally{store.close();}
});
