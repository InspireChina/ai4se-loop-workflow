import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,realpath,symlink,unlink,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {build} from 'esbuild';
import {artifactFixture} from '../test/harness-artifact-fixture';
import {AdminManagementStore} from './admin-management-store';
import {stageRuntimeArtifact} from './runtime-staging';
import {prepareAdminHarnessWorkspaces} from './admin-harness-workspaces';
import {runAdminCommand} from '../application/admin-command';
import {captureHarnessSource,extractHarnessSource} from '../../scripts/harness-source.mjs';
import {readHarnessArtifact,writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {createNativeAdminBusinessWorker} from './native-admin-business-worker';
import {createExternalRuntimeFailureReporter} from '../application/external-runtime-failure';
import {originalRuntimeArtifact} from '../domain/runtime-original-artifact';
import {buildAdminHarnessCandidates} from './admin-harness-build';

async function fixture(native=false,selectedDifferent=false,format:'canonical'|'legacy'|'reporter'='canonical'){
  const source=await artifactFixture('preserved original Harness source');
  if(native){
    await mkdir(join(source.root,'node_modules'));
    for(const name of ['better-sqlite3','bindings','file-uri-to-path'])await cp(join(process.cwd(),'node_modules',name),join(source.root,'node_modules',name),{recursive:true});
    await build({entryPoints:[join(process.cwd(),'scripts/loop/admin-business-worker-entry.ts')],outfile:join(source.root,'desktop-runners/admin-business-worker.cjs'),
      bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
    await unlink(join(source.root,'harness-artifact.json'));source.descriptor=await writeHarnessArtifact(source.root);
  }
  const data=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(data,{recursive:true});const dataRoot=await realpath(data);
  const artifact=await stageRuntimeArtifact(source.descriptor,dataRoot,new AbortController().signal,()=>{});
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));store.setIntent('running','start');
  let originalArtifact=artifact;
  if(selectedDifferent){const original=await artifactFixture('different original failing Harness source');originalArtifact=await stageRuntimeArtifact(original.descriptor,dataRoot,new AbortController().signal,()=>{});}
  const root=store.acquireRuntimeHost('root')!;store.bindRuntimeHostArtifact(root,artifact);store.initializeRuntimeInstallation(originalArtifact);
  const authority=store.acquireSupervisor('root:management')!;let observationId:string=randomUUID();
  const fault=format==='reporter'?createExternalRuntimeFailureReporter(store,'root')({error:new Error('Original Harness cannot start'),
    stage:'validation',artifact:originalArtifact,authority:root,intentRevision:store.control().intent_revision,
    selectionRevision:store.runtimeInstallation()!.revision})!:store.observe({observationId,scope:'runtime',scopeKey:'harness-startup',origin:'runtime',fingerprint:'broken-harness',
    sourceVersion:originalArtifact.version,summary:'Original Harness cannot start',evidence:format==='legacy'?{attemptedArtifact:originalArtifact}:{artifact:originalArtifact}});
  if(format==='reporter')observationId=(store.observations(fault.caseId)[0] as {observation_id:string}).observation_id;
  const claim=store.claimNext(authority)!,credential=store.issueCommandCredential(claim);
  const command=(args:string[])=>runAdminCommand(store,credential,args);
  const request=()=>command(['harness','workspace','--key','source','--observation-id',observationId,'--reason','Reproduce and repair original Harness']);
  const status=()=>store.commandStatus(credential);
  const destination=join(dataRoot,'admin/harness-workspaces',createHash('sha256').update(fault.caseId).digest('hex'),claim.attempt.attemptId,'source');
  return {dataRoot,store,artifact,originalArtifact,authority,root,observationId,claim,credential,command,request,status,destination};
}

test('Harness action requires current scoped credentials/status, preserves request identity and does not grant business ownership',async()=>{
  const h=await fixture();try{
    assert.throws(h.request,/先读取 status/);h.status();h.request();h.request();
    assert.equal(h.status().actions.length,1);
    assert.throws(()=>h.command(['harness','workspace','--key','source','--observation-id','foreign','--reason','wrong source']),/原始 runtime/);
    assert.throws(()=>h.command(['harness','workspace','--key','new','--observation-id',h.observationId,'--reason','reason','--workspace','/untrusted']),/必须提供/);
    assert.throws(()=>h.store.repairWorkspaceAnchor(h.claim.attempt.attemptId),/工作区接管/);
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)!.status,'running');
  }finally{h.store.close();}
});

test('candidate request uses a completed source key, rejects arbitrary commands and records actual dependency failure with its log',async()=>{
  const h=await fixture();try{
    h.status();
    const build=()=>h.command(['harness','build','--key','candidate','--workspace-key','source','--reason','Build isolated source']);
    assert.throws(build,/已完成的源码/);h.request();assert.throws(build,/已完成的源码/);
    await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}});build();build();
    assert.throws(()=>h.command(['harness','build','--key','foreign','--workspace-key','source','--reason','reason','--command','echo fake']),/必须提供/);
    // The archive fixture deliberately has no valid npm lock/dependencies.
    // An actual native Node/npm failure must not become candidate-built.
    assert.deepEqual(await buildAdminHarnessCandidates({...h,assertCurrent:()=>{}}),{built:0});
    const result=h.status().actions.find(row=>row.key==='candidate')!;assert.equal(result.status,'failed');
    assert.equal(typeof result.result!.logFile,'string');assert.match(await readFile(result.result!.logFile as string,'utf8'),/Harness build stage/);
    assert.equal(result.result!.candidate,undefined);assert.equal(h.store.runtimeInstallation()!.artifact.artifactId,h.artifact.artifactId);
    assert.deepEqual(await buildAdminHarnessCandidates({...h,assertCurrent:()=>{}}),{built:0});
    assert.equal(existsSync(join(h.dataRoot,'loop-ui.db')),false);
  }finally{h.store.close();}
});

test('identical repaired source reuses only an earlier physical five-stage candidate and a damaged candidate falls back to a real rebuild',async()=>{
  const h=await fixture();try{
    const stages=['dependencies','tests','typescript','next-build','desktop-build'];
    const receipts=stages.map(stage=>({stage,exitCode:0}));
    const toolchain={node:process.execPath,npm:join(process.execPath,'npm-cli.js'),version:process.version,platform:process.platform,arch:process.arch};
    const finishRound=(claim:typeof h.claim,credential:typeof h.credential,ids:string[],buildKey:string)=>{
      const submission={outcome:'verification-requested' as const,summary:'Controlled host-written build provenance fixture',repairVersion:h.artifact.artifactId,
        originalObservationIds:ids,repairEvidenceKeys:[buildKey],verification:{reproductionCommand:'node controlled-reproduction.cjs',
          versionCheckCommand:'node controlled-version.cjs',acceptanceChecks:[{targetRef:'controlled',command:'node controlled-check.cjs',expected:'pass'}]}};
      h.store.commandSubmit(credential,submission);h.store.finishAttempt(claim,{outcome:'verification-requested',reason:submission.summary,exitConfirmed:true});
    };
    h.status();h.request();await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}});
    h.command(['harness','build','--key','candidate','--workspace-key','source','--reason','Controlled prior physical build record']);
    const firstParent=join(h.destination,'..'),frozen=join(firstParent,'build-prior','source');await mkdir(join(firstParent,'build-prior'));
    await extractHarnessSource(await readFile(join(h.artifact.root,'harness-source.json.gz')),frozen);
    const priorLog=join(firstParent,'build-prior','build.log');await writeFile(priorLog,'controlled host record; no compiler claim in this test');
    h.store.recordCommandActionResult(h.claim,'candidate','completed',{phase:'candidate-built',candidate:h.artifact,sourceArtifact:h.artifact,
      sourceId:h.artifact.sourceId,workspaceRoot:h.destination,frozenWorkspaceRoot:frozen,toolchain,receipts,logFile:priorLog,
      independentVerificationRequired:true,liveWorkspacePermission:false});
    finishRound(h.claim,h.credential,[h.observationId],'candidate');

    const secondId=randomUUID();h.store.observe({observationId:secondId,scope:'runtime',scopeKey:'harness-startup',origin:'runtime',
      fingerprint:'broken-harness',sourceVersion:h.artifact.version,summary:'Same failure recurred',evidence:{artifact:h.artifact}});
    const second=h.store.claimNext(h.authority)!;const secondCredential=h.store.issueCommandCredential(second);
    const secondCommand=(args:string[])=>runAdminCommand(h.store,secondCredential,args);h.store.commandStatus(secondCredential);
    secondCommand(['harness','workspace','--key','source-2','--observation-id',secondId,'--reason','Restore current exact source']);
    await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}});
    secondCommand(['harness','build','--key','candidate-2','--workspace-key','source-2','--reason','Reuse identical immutable candidate']);
    assert.deepEqual(await buildAdminHarnessCandidates({...h,assertCurrent:()=>{}}),{built:1});
    const reused=h.store.commandStatus(secondCredential).actions.find(row=>row.key==='candidate-2')!;
    assert.equal(reused.status,'completed');assert.equal(reused.result!.phase,'candidate-built');
    assert.deepEqual(reused.result!.reusedFrom,{attemptId:h.claim.attempt.attemptId,buildKey:'candidate',candidateArtifactId:h.artifact.artifactId,sourceId:h.artifact.sourceId});
    assert.equal((reused.result!.candidate as {artifactId:string}).artifactId,h.artifact.artifactId);
    assert.equal(h.store.harnessCandidateAnchor(second.attempt.attemptId,h.artifact.artifactId).buildKey,'candidate-2');
    finishRound(second,secondCredential,[h.observationId,secondId],'candidate-2');

    await writeFile(join(h.artifact.root,'desktop-runners','host-service.cjs'),'damaged reusable candidate');
    const thirdId=randomUUID();h.store.observe({observationId:thirdId,scope:'runtime',scopeKey:'harness-startup',origin:'runtime',
      fingerprint:'broken-harness',sourceVersion:h.artifact.version,summary:'Failure recurred after candidate damage',evidence:{artifact:h.artifact}});
    const third=h.store.claimNext(h.authority)!;const thirdCredential=h.store.issueCommandCredential(third);
    const thirdCommand=(args:string[])=>runAdminCommand(h.store,thirdCredential,args);h.store.commandStatus(thirdCredential);
    thirdCommand(['harness','workspace','--key','source-3','--observation-id',thirdId,'--reason','Restore exact source after candidate damage']);
    await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}});
    thirdCommand(['harness','build','--key','candidate-3','--workspace-key','source-3','--reason','Reject damaged reusable candidate']);
    assert.deepEqual(await buildAdminHarnessCandidates({...h,assertCurrent:()=>{}}),{built:0});
    const rejected=h.store.commandStatus(thirdCredential).actions.find(row=>row.key==='candidate-3')!;
    assert.equal(rejected.status,'failed');assert.equal(rejected.result!.candidate,undefined);
    assert.match(String(rejected.result!.logFile),/build\.log$/);
  }finally{h.store.close();}
});

for(const format of ['legacy','reporter'] as const)test(`source action consumes ${format} original startup evidence without changing historical facts`,async()=>{
  const h=await fixture(false,true,format);try{
    const before=h.store.observations(h.claim.repairCase.caseId);
    if(format==='reporter')assert.equal(JSON.parse((before[0] as {evidence_json:string}).evidence_json).artifactIdentityVerified,false);
    h.status();h.request();await writeFile(join(h.originalArtifact.root,'desktop-runners/host-service.cjs'),'original startup failure');
    assert.deepEqual(await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}}),{prepared:1});
    assert.equal((await captureHarnessSource(h.destination)).sourceId,h.originalArtifact.sourceId);
    assert.notEqual(h.originalArtifact.sourceId,h.artifact.sourceId);
    assert.deepEqual(h.store.observations(h.claim.repairCase.caseId),before);
  }finally{h.store.close();}
});

test('original runtime artifact rejects conflicting or malformed aliases and never substitutes management bootstrap',async()=>{
  const h=await fixture(false,true);try{
    assert.throws(()=>originalRuntimeArtifact({artifact:h.artifact,attemptedArtifact:h.originalArtifact}),/来源冲突/);
    assert.throws(()=>originalRuntimeArtifact({artifact:{},attemptedArtifact:h.originalArtifact}));
    assert.throws(()=>originalRuntimeArtifact({managementBootstrap:h.artifact}),/缺少准确/);
    assert.deepEqual(originalRuntimeArtifact({artifact:h.originalArtifact,attemptedArtifact:h.originalArtifact}),h.originalArtifact);
  }finally{h.store.close();}
});

test('original source can be restored even with damaged executable bytes and no task/business database',async()=>{
  const h=await fixture();try{
    h.status();h.request();await writeFile(join(h.artifact.root,'desktop-runners/host-service.cjs'),'damaged executable');
    await assert.rejects(readHarnessArtifact(h.artifact.root),/installed bytes changed/);
    assert.deepEqual(await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}}),{prepared:1});
    const action=h.status().actions[0];assert.equal(action.status,'completed');assert.equal(action.result!.phase,'prepared');
    assert.equal(action.result!.liveWorkspacePermission,false);assert.equal(action.result!.sourceId,h.artifact.sourceId);
    assert.equal((await captureHarnessSource(h.destination)).sourceId,h.artifact.sourceId);
    assert.equal(await readFile(join(h.destination,'scripts/fixture.cjs'),'utf8'),'preserved original Harness source');
    assert.equal(existsSync(join(h.dataRoot,'loop-ui.db')),false);assert.equal(existsSync(join(h.dataRoot,'loopwork.db')),false);
    assert.deepEqual(await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}}),{prepared:0},'completed action is never extracted twice');
    assert.equal(await readFile(join(h.artifact.root,'desktop-runners/host-service.cjs'),'utf8'),'damaged executable','preparation is not installation repair');
    assert.throws(()=>h.store.repairWorkspaceAnchor(h.claim.attempt.attemptId),/工作区接管/);
  }finally{h.store.close();}
});

test('foreign archive content and symlink parents fail closed without rewriting original or foreign directories',async()=>{
  for(const mode of ['archive','parent','input-parent']){
    const h=await fixture();try{
      h.status();h.request();const foreign=await artifactFixture('foreign');
      if(mode==='archive')await cp(join(foreign.root,'harness-source.json.gz'),join(h.artifact.root,'harness-source.json.gz'));
      else if(mode==='parent'){await mkdir(join(h.dataRoot,'admin'));await symlink(foreign.root,join(h.dataRoot,'admin/harness-workspaces'));}
      else {await cp(join(h.artifact.root,'.next'),join(h.dataRoot,'moved-next'),{recursive:true});await unlink(join(h.artifact.root,'.next/BUILD_ID'));
        // Replace the empty original directory only in this private fixture.
        const {rmdir}=await import('node:fs/promises');await rmdir(join(h.artifact.root,'.next'));await symlink(join(h.dataRoot,'moved-next'),join(h.artifact.root,'.next'));}
      assert.deepEqual(await prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}}),{prepared:0});
      assert.equal(h.status().actions[0].status,'failed');assert.equal(existsSync(h.destination),false);
      assert.equal(await readFile(join(foreign.root,'scripts/fixture.cjs'),'utf8'),'foreign');
    }finally{h.store.close();}
  }
});

test('stop during extraction fences each write and retains a partial private directory without declaring preparation complete',async()=>{
  const h=await fixture();try{
    h.status();h.request();let stopped=false;
    await assert.rejects(prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{
      if(!stopped&&existsSync(join(h.destination,'next.config.ts'))){stopped=true;h.store.setIntent('stopped','user-stop-extract');}
    }}),/运行意图|监督权/);
    assert.equal(stopped,true);assert.equal(existsSync(join(h.destination,'scripts/fixture.cjs')),false);
    const db=new Database(h.store.filename,{readonly:true});try{assert.equal((db.prepare('SELECT status FROM admin_command_actions').get() as {status:string}).status,'pending');}finally{db.close();}
    assert.equal(h.store.getCase(h.claim.repairCase.caseId)!.status,'running','a stop does not fabricate success or cleanup');
  }finally{h.store.close();}
});

test('terminal Admin submission prevents queued preparation from writing after the Agent has ended the round',async()=>{
  const h=await fixture();try{
    h.status();h.request();h.store.commandSubmit(h.credential,{outcome:'deferred',summary:'Continue by another method',nextMethod:'independent reproduction'});
    await assert.rejects(prepareAdminHarnessWorkspaces({...h,assertCurrent:()=>{}}),/已终止提交/);
    assert.equal(existsSync(h.destination),false);
    const db=new Database(h.store.filename,{readonly:true});try{assert.equal((db.prepare('SELECT status FROM admin_command_actions').get() as {status:string}).status,'pending');}finally{db.close();}
  }finally{h.store.close();}
});

test('actual native root-bound child prepares source with both business databases corrupt and exits before returning',{skip:process.platform==='win32'},async()=>{
  const h=await fixture(true,true);const worker=createNativeAdminBusinessWorker({...h,rootOwnerId:'root',appRoot:h.artifact.root,executable:process.execPath});
  try{
    h.status();h.request();await writeFile(join(h.dataRoot,'loop-ui.db'),'corrupt business database');await writeFile(join(h.dataRoot,'loopwork.db'),'corrupt application database');
    await writeFile(join(h.originalArtifact.root,'desktop-runners/host-service.cjs'),'damaged selected business executable');
    assert.deepEqual(await worker.run({operation:'harness-actions'}),{prepared:1});
    assert.equal(h.status().actions[0].status,'completed');assert.equal((await captureHarnessSource(h.destination)).sourceId,h.originalArtifact.sourceId);
    const allocation=h.store.adminBusinessWorkers()[0];assert.equal(allocation.operation,'harness-actions');assert.equal(allocation.status,'exited');
    assert.equal(allocation.artifact.artifactId,h.artifact.artifactId,'capability code uses the stable root, not the broken selected business image');
    assert.throws(()=>process.kill(allocation.pid!,0),/ESRCH/);assert.throws(()=>process.kill(-allocation.groupId!,0),/ESRCH/);
    assert.equal(await readFile(join(h.dataRoot,'loop-ui.db'),'utf8'),'corrupt business database');
    assert.equal(await readFile(join(h.dataRoot,'loopwork.db'),'utf8'),'corrupt application database');
  }finally{await worker.stopOwned();h.store.close();}
});
