import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AdminManagementStore } from './admin-management-store';
import { createManagementToolLaunch } from './management-tool-launch';
import { captureHarnessSource, encodeHarnessSource } from '../../scripts/harness-source.mjs';
import { writeHarnessArtifact } from '../../scripts/harness-artifact.mjs';
import { stageRuntimeArtifact } from './runtime-staging';

async function fixture() {
  const sourceRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(sourceRoot,{recursive:true});
  for(const dir of ['app','src','scripts','desktop','command-chains','migrations','app-migrations','desktop-runners','.next'])await mkdir(join(sourceRoot,dir));
  for(const file of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(sourceRoot,file),file==='package.json'?JSON.stringify({version:'controlled-management-tools'}):'{}');
  await writeFile(join(sourceRoot,'scripts','fixture.cjs'),'// controlled tool source');
  await writeFile(join(sourceRoot,'desktop-runners','loop-admin.cjs'),'console.log("controlled stable tools")');
  const source=await captureHarnessSource(sourceRoot);await writeFile(join(sourceRoot,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-management-build'}));
  await writeFile(join(sourceRoot,'.next','BUILD_ID'),'controlled-management-build');
  const dataRoot=join(process.env.LOOP_DATA_ROOT!,randomUUID());
  const artifact=await stageRuntimeArtifact(await writeHarnessArtifact(sourceRoot),dataRoot,new AbortController().signal,()=>{});
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));store.setIntent('running','start');
  const rootAuthority=store.acquireRuntimeHost('root')!;const managementAuthority=store.acquireSupervisor('root:management')!;
  store.bindRuntimeHostArtifact(rootAuthority,artifact);
  store.observe({observationId:randomUUID(),scope:'runtime',scopeKey:'controlled-tools',sourceVersion:artifact.version,
    fingerprint:'controlled-fault',origin:'runtime',summary:'Original failure remains unresolved',evidence:{}});
  const claim=store.claimNext(managementAuthority)!;
  return {store,artifact,claim};
}

test('root-bound tools are resolved without querying the damaged selected installation',async()=>{
  const h=await fixture();let delegated=0;
  try{
    h.store.runtimeInstallation=()=>{throw new Error('Damaged selected business metadata must not own management tools');};
    const launch=createManagementToolLaunch({store:h.store,rootOwnerId:'root',launch:toolRoot=>async(claim)=>{
      assert.equal(toolRoot,h.artifact.root);assert.equal(claim,h.claim);delegated++;
      return {completion:Promise.resolve({outcome:'failed',exitConfirmed:true,reason:'Controlled invocation only'}),stop:async()=>true};
    }});
    const handle=await launch(h.claim,()=>{},new AbortController().signal);await handle.completion;assert.equal(delegated,1);
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)?.status,'running');
  }finally{h.store.close();}
});

test('changed root-owned tool bytes fail before delegation with positive no-spawn proof',async()=>{
  const h=await fixture();let delegated=0;
  try{
    await writeFile(join(h.artifact.root,'desktop-runners','loop-admin.cjs'),'throw new Error("corrupt stable tools")');
    const launch=createManagementToolLaunch({store:h.store,rootOwnerId:'root',launch:()=>async()=>{delegated++;throw Error('Must not launch');}});
    const result=await(await launch(h.claim,()=>{},new AbortController().signal)).completion;
    assert.equal(delegated,0);assert.equal(result.outcome,'failed');assert.equal(result.exitConfirmed,true);assert.match(result.reason!,/bytes changed/);
  }finally{h.store.close();}
});

test('user stop revokes management tool admission before any delegated launch',async()=>{
  const h=await fixture();let delegated=0;
  try{
    h.store.setIntent('stopped','user-stop');
    const launch=createManagementToolLaunch({store:h.store,rootOwnerId:'root',launch:()=>async()=>{delegated++;throw Error('Must not launch');}});
    const result=await(await launch(h.claim,()=>{},new AbortController().signal)).completion;
    assert.equal(delegated,0);assert.equal(result.outcome,'failed');assert.equal(result.exitConfirmed,true);
  }finally{h.store.close();}
});

test('a delegated launch rejection is not falsely converted into no-spawn settlement',async()=>{
  const h=await fixture();
  try{
    const failure=new Error('Delegated adapter might already own a child');
    const launch=createManagementToolLaunch({store:h.store,rootOwnerId:'root',launch:()=>async()=>{throw failure;}});
    await assert.rejects(launch(h.claim,()=>{},new AbortController().signal),error=>error===failure);
  }finally{h.store.close();}
});
