import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,realpath,unlink,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {artifactFixture} from '../test/harness-artifact-fixture';
import {AdminManagementStore} from './admin-management-store';
import {stageRuntimeArtifact} from './runtime-staging';
import {prepareAdminHarnessWorkspaces} from './admin-harness-workspaces';
import {extractHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {assertRuntimeVerificationInput} from './runtime-verification-input';
import {authorizePreparedVerification,originalVerificationTargets,independentPreparationHash} from '../domain/independent-verification-preparation';
import {createNativeAdminBusinessWorker} from './native-admin-business-worker';
import {createIndependentVerificationPreparation} from './independent-verification-preparation';
import {createDefaultRepairVerification} from './default-repair-verification';
import type {AgentExecutor} from './agent-executor';
import {buildAdminPrompt} from '../application/admin-prompt';
import {requestVerifiedRuntimeRepairUpdate} from '../application/admin-runtime-update';
import {confirmRuntimeRepairHandoff} from './runtime-repair-handoff';
import {inspectProcessIdentity,inspectProcessGroup,terminateProcessGroup} from './process-tree';
import Database from 'better-sqlite3';
import {createNativeAdminVerification} from './native-admin-verification';
import {runtimeArtifactVersionCommand} from './repair-workspace-version';
import {adminCommandReference} from './admin-execution';
import {createNativeRuntimeUpdate} from './native-runtime-update';
import {findRuntimeBusinessProgressCandidatesInDb,findRuntimeBusinessCohortChangesInDb} from '../application/runtime-business-progress';
import {runtimeBusinessProgressResultSchema,runtimeBusinessProgressCandidateSchema} from '../domain/runtime-business-progress';
import {dispatchTaskSelect} from '../application/dispatch-query';

async function fixture(native=false) {
  const original=await artifactFixture("console.log(JSON.stringify({status:'broken'}));");
  if(native){
    await mkdir(join(original.root,'node_modules'));
    for(const name of ['better-sqlite3','bindings','file-uri-to-path'])await cp(join(process.cwd(),'node_modules',name),join(original.root,'node_modules',name),{recursive:true});
    await build({entryPoints:[join(process.cwd(),'scripts/loop/admin-business-worker-entry.ts')],outfile:join(original.root,'desktop-runners','admin-business-worker.cjs'),bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
    await unlink(join(original.root,'harness-artifact.json'));original.descriptor=await writeHarnessArtifact(original.root);
  }
  const candidateSource=await artifactFixture(`
    if(process.argv.includes('--controlled-host')) {
      const index=process.argv.indexOf('--controlled-host');
      process.once('message',record=>{
        const {AdminManagementStore}=require(process.argv[index+1]);
        const store=new AdminManagementStore(process.argv[index+2]);
        try{store.certifyRuntimeCliHost(record);process.send({kind:'certified'});}finally{store.close();}
        const clis=new Map();
        process.on('message',async message=>{
          if(message.kind==='finish-controlled-cli'){clis.get(message.allocationId)?.send({kind:'finish'});return;}
          if(message.kind!=='spawn-controlled-cli')return;
          const {AdminManagementStore,inspectProcessIdentity,assertRuntimeCliCaller}=require(process.argv[index+1]);
          const store=new AdminManagementStore(process.argv[index+2]);
          try{
            await assertRuntimeCliCaller(store,record.allocationId);
            store.reserveRuntimeCli(record.allocationId,message.allocationId,message.executionId,process.pid);
            const cli=require('node:child_process').spawn(process.execPath,[__filename,'--controlled-cli'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
            clis.set(message.allocationId,cli);
            const closed=new Promise(resolve=>cli.once('close',resolve));
            const identity=await inspectProcessIdentity(cli.pid);
            if(!identity)throw new Error('controlled CLI identity missing');
            store.attachRuntimeCli(message.allocationId,cli.pid,identity.startMarker,cli.pid);
            process.send({kind:'cli-attached',allocationId:message.allocationId,pid:cli.pid,marker:identity.startMarker});
            await closed;store.finishRuntimeCli(message.allocationId,true);
            process.send({kind:'cli-closed',allocationId:message.allocationId});
          }catch(error){process.send({kind:'cli-error',error:String(error)});}finally{store.close();}
        });
      });setInterval(()=>{},1000);
    } else if(process.argv.includes('--controlled-cli'))process.once('message',()=>process.disconnect());
    else console.log(JSON.stringify({status:'ready',root:process.env.LOOP_APP_ROOT,dataRoot:process.env.LOOP_DATA_ROOT,dbOverride:process.env.LOOP_GLOBAL_DB_PATH??null}));
  `);
  const data=join(process.env.LOOP_DATA_ROOT!,randomUUID());await mkdir(data);const dataRoot=await realpath(data);
  const sourceArtifact=await stageRuntimeArtifact(original.descriptor,dataRoot,new AbortController().signal,()=>{});
  const candidate=await stageRuntimeArtifact(candidateSource.descriptor,dataRoot,new AbortController().signal,()=>{});
  const store=new AdminManagementStore(join(dataRoot,'admin-management.db'));store.setIntent('running','start');
  const root=store.acquireRuntimeHost('root')!;store.bindRuntimeHostArtifact(root,sourceArtifact);store.initializeRuntimeInstallation(sourceArtifact);
  const authority=store.acquireSupervisor('root:management')!;
  const observation=(id:string)=>({observationId:id,scope:'runtime' as const,scopeKey:'runtime-case',origin:'runtime' as const,fingerprint:'runtime-result-missing',
    sourceVersion:sourceArtifact.version,summary:'Actual compiled runtime response must have status ready',evidence:{artifact:sourceArtifact,operation:'compiled response',expected:{status:'ready'}}});
  const repairCase=store.observe(observation('original-1'));store.observe(observation('original-2'));
  const repair=store.claimNext(authority)!,credential=store.issueCommandCredential(repair);store.commandStatus(credential);
  store.commandRequestAction(credential,'source',{kind:'harness-workspace',observationId:'original-1',reason:'Restore exact original source'});
  await prepareAdminHarnessWorkspaces({store,authority,dataRoot,assertCurrent:()=>{}});
  store.commandRequestAction(credential,'candidate',{kind:'harness-build',workspaceKey:'source',reason:'Controlled candidate admission fixture'});
  const parent=join(dataRoot,'admin','harness-workspaces',createHash('sha256').update(repairCase.caseId).digest('hex'),repair.attempt.attemptId);
  const frozen=join(parent,'build-controlled','source');await mkdir(join(parent,'build-controlled'));
  await extractHarnessSource(await readFile(join(candidateSource.root,'harness-source.json.gz')),frozen);
  const finishBuild=()=>store.recordCommandActionResult(repair,'candidate','completed',{phase:'candidate-built',candidate,sourceArtifact,sourceId:candidate.sourceId,
    workspaceRoot:join(parent,'source'),frozenWorkspaceRoot:frozen,
    // Controlled host metadata for admission tests; NOT an actual compiler
    // success or evidence of autonomous product repair.
    receipts:['dependencies','tests','typescript','next-build','desktop-build'].map(stage=>({stage,exitCode:0,controlledFixture:true}))});
  const submission={outcome:'verification-requested' as const,summary:'Request independent actual compiled response checks',repairVersion:candidate.artifactId,
    originalObservationIds:['original-1','original-2'],repairEvidenceKeys:['candidate'],verification:{reproductionCommand:'echo REPAIRER_FAKE',versionCheckCommand:'echo REPAIRER_FAKE',
      acceptanceChecks:[{targetRef:'fake',command:'echo REPAIRER_FAKE',expected:'pass'}]}};
  const start=()=>{finishBuild();store.commandSubmit(credential,submission);store.finishAttempt(repair,{outcome:'verification-requested',reason:submission.summary,exitConfirmed:true});return store.claimVerification(authority)!;};
  return {store,dataRoot,root,authority,repair,credential,repairCase,candidate,sourceArtifact,frozen,submission,finishBuild,start};
}

/** Controlled source/compiler fixture, but checks below really execute the
 * compiled response and identity CLI in a separate, physically exited worker.
 * This is not a true-model repair or production workload acceptance. */
async function independentlyVerifyFixture(h:Awaited<ReturnType<typeof fixture>>) {
  const claim=h.start(),input=h.store.independentVerificationInput(claim);
  const command=adminCommandReference({command:process.execPath,args:['-e',`const assert=require('node:assert/strict');
    assert.equal(process.cwd(),${JSON.stringify(h.candidate.root)});
    const response=JSON.parse(require('node:child_process').execFileSync(process.execPath,['desktop-runners/host-service.cjs'],{encoding:'utf8'}));
    assert.equal(response.status,'ready');assert.equal(response.root,process.cwd());`]});
  const plan={sourceRepairAttemptId:h.repair.attempt.attemptId,expectedVersion:h.candidate.artifactId,
    originalObservationIds:input.originalObservations.map(row=>row.observationId),
    versionCommand:runtimeArtifactVersionCommand(process.cwd(),h.candidate),reproduction:{targetRef:'original-failures',command},
    acceptanceChecks:originalVerificationTargets(input).map(row=>({targetRef:row.targetRef,command}))};
  const launch=createNativeAdminVerification({store:h.store,appRoot:process.cwd(),
    resolvePlan:async()=>({plan,workspaceRoot:h.candidate.root,runtimeArtifact:h.candidate})});
  const handle=await launch(claim,(pid,marker,group)=>h.store.attachProcess(claim,pid,marker,group),new AbortController().signal);
  const checked=await handle.completion;assert.equal(checked.outcome,'verified',checked.reason);assert.equal(checked.exitConfirmed,true);
  assert.equal(h.store.finishVerification(claim,true),true);assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
  assert.throws(()=>process.kill(h.store.attempts(h.repairCase.caseId).find(row=>row.attemptId===claim.attempt.attemptId)!.pid!,0),/ESRCH/);
  return claim;
}

test('stable Root baseline capability freezes the real read-only database during update silence, replays and fences STOP',
  {skip:process.platform==='win32'},async()=>{
  const h=await fixture(true),worker=createNativeAdminBusinessWorker({store:h.store,appRoot:h.sourceArtifact.root,
    dataRoot:h.dataRoot,executable:process.execPath,rootOwnerId:'root'});
  let old:{pid:number;marker:string;closed:Promise<void>}|undefined;
  try{
    const verification=await independentlyVerifyFixture(h);
    // Controlled recurrence timestamps: native admission must bind the whole
    // saved original interval, not the Case's historical first-created time.
    const cohortEnd=Date.now(),cohortStart=cohortEnd-2000,metadata=new Database(h.store.filename);
    try{
      metadata.prepare('UPDATE repair_observations SET created_at=? WHERE case_id=? AND observation_id=?').run(cohortStart,h.repairCase.caseId,'original-1');
      metadata.prepare('UPDATE repair_observations SET created_at=? WHERE case_id=? AND observation_id=?').run(cohortEnd,h.repairCase.caseId,'original-2');
    }finally{metadata.close();}
    const filename=join(h.dataRoot,'loop-ui.db');const writer=new Database(filename);
    try{writer.exec(`CREATE TABLE tasks(task_id TEXT PRIMARY KEY,workflow_engine TEXT);
      CREATE TABLE workflow_items(item_id TEXT PRIMARY KEY,task_id TEXT,revision INTEGER,dispatch_epoch INTEGER,status TEXT,
        origin TEXT,created_at TEXT,completed_at TEXT,updated_at TEXT);
      CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY,task_id TEXT,work_item_id TEXT);
      INSERT INTO tasks VALUES('original-task','native');
      INSERT INTO workflow_items VALUES('original-item','original-task',1,2,'ready','native','2001-01-01',NULL,'2001-01-01');
      INSERT INTO execution_attempts VALUES('pre-update','original-task','original-item');`);
    }finally{writer.close();}
    const before=await readFile(filename);
    const oldAllocation=h.store.reserveRuntimeHostProcess(h.root,h.sourceArtifact);
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));assert.ok(child.pid);
    const identity=await inspectProcessIdentity(child.pid);assert.ok(identity);
    old={pid:child.pid,marker:identity.startMarker,closed};h.store.bindRuntimeHostProcess(oldAllocation,old.pid,old.marker,old.pid);
    const oldRecord=h.store.runtimeHostProcesses().find(record=>record.allocationId===oldAllocation.allocationId)!;
    const update=await requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:(input,assertCurrent)=>assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent})});
    const updater=h.store.acquireRuntimeUpdate(update.request.updateId,'root')!;
    assert.throws(()=>h.store.assertRuntimeBusinessBaselineReady(update),/尚未冻结/);
    await assert.rejects(worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}),/尚未退出/);
    // Adversarial false-exit metadata cannot substitute for actual group exit.
    // The controlled child never writes business data.
    h.store.confirmRuntimeHostProcessExit(oldRecord);
    await assert.rejects(worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}),/实际存活/);
    assert.equal(h.store.runtimeBusinessBaseline(verification.attempt.attemptId),null);
    assert.equal(await terminateProcessGroup(old.pid,5000,old.marker),true);await old.closed;
    assert.throws(()=>process.kill(old!.pid,0),/ESRCH/);
    await writeFile(filename,'controlled corrupt original database');
    await assert.rejects(worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}),/not a database/);
    assert.equal(await readFile(filename,'utf8'),'controlled corrupt original database');
    assert.equal(h.store.runtimeBusinessBaseline(verification.attempt.attemptId),null);await writeFile(filename,before);
    const baseline=await worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId});
    const saved=h.store.runtimeBusinessBaseline(verification.attempt.attemptId)!;
    assert.deepEqual(baseline,saved);assert.equal(saved.tasks.length,1);assert.equal(saved.tasks[0].taskId,'original-task');
    assert.equal(saved.originalStartBoundaryMs,cohortStart);assert.equal(saved.originalBoundaryMs,cohortEnd);
    assert.throws(()=>h.store.recordRuntimeBusinessBaseline(h.root,h.authority,update.request.updateId,
      {...saved,originalStartBoundaryMs:cohortStart+1}),/不能改写独立验证/);
    assert.deepEqual(saved.tasks[0].items[0].previousExecutionIds,['pre-update']);assert.deepEqual(saved.candidateArtifact,h.candidate);
    assert.deepEqual(await readFile(filename),before,'read-only capability cannot migrate or rewrite original business bytes');
    h.store.assertRuntimeBusinessBaselineReady(update);assert.equal(h.store.control().management_mode,'update-silence');
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
    const reader=new AdminManagementStore(h.store.filename);try{assert.deepEqual(reader.runtimeBusinessBaseline(verification.attempt.attemptId),saved);}finally{reader.close();}
    assert.throws(()=>h.store.recordRuntimeBusinessBaseline(h.root,h.authority,update.request.updateId,{...saved,tasks:[]}),/不允许重拍/);
    assert.deepEqual(await worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}),saved);
    for(const record of h.store.adminBusinessWorkers()){assert.equal(record.operation,'runtime-business-baseline');assert.equal(record.artifact.artifactId,h.sourceArtifact.artifactId);
      assert.equal(record.status,'exited');assert.throws(()=>process.kill(record.pid!,0),/ESRCH/);}
    h.store.advanceRuntimeUpdate(updater,'stopping','candidate-starting');
    await assert.rejects(worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}),/运行意图/);
    h.store.setIntent('stopped','user-stop');assert.deepEqual(h.store.runtimeBusinessBaseline(verification.attempt.attemptId),saved);
    await assert.rejects(worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}));
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');assert.equal(h.store.runtimeUpdateProcesses(update.request.updateId).length,0);
    assert.deepEqual(await readFile(filename),before);
  }finally{if(old){assert.equal(await terminateProcessGroup(old.pid,5000,old.marker),true);await old.closed;}
    await worker.stopOwned();h.store.close();}
});

test('verified candidate cannot start without the original business snapshot and absent storage is not fabricated work',
  {skip:process.platform==='win32'},async()=>{
  const h=await fixture(true),worker=createNativeAdminBusinessWorker({store:h.store,appRoot:h.sourceArtifact.root,
    dataRoot:h.dataRoot,executable:process.execPath,rootOwnerId:'root'});
  let updater:ReturnType<AdminManagementStore['acquireRuntimeUpdate']>;
  const native=createNativeRuntimeUpdate({store:h.store,dataRoot:h.dataRoot,executable:process.execPath,
    validateCompatibility:async()=>{},confirmOldHostsStopped:async()=>true});
  try{
    const verification=await independentlyVerifyFixture(h);
    const update=await requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:(input,assertCurrent)=>assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent})});
    updater=h.store.acquireRuntimeUpdate(update.request.updateId,'root')!;
    await assert.rejects(native.freezeBusinessBaseline(update,new AbortController().signal,()=>h.store.assertRuntimeUpdate(updater!)),/缺少独立/);
    const saved=await worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}) as {businessStore:string;tasks:unknown[]};
    assert.equal(saved.businessStore,'absent');assert.deepEqual(saved.tasks,[]);assert.equal(existsSync(join(h.dataRoot,'loop-ui.db')),false);
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
    // Controlled removal of the snapshot row, not a successful business/repair
    // receipt. Native admission must fail before creating a launch allocation.
    const db=new Database(h.store.filename);try{db.prepare('DELETE FROM repair_runtime_business_baselines WHERE verification_attempt_id=?').run(verification.attempt.attemptId);}finally{db.close();}
    h.store.advanceRuntimeUpdate(updater,'stopping','candidate-starting');
    await assert.rejects(native.startHeld(h.candidate,h.store.runtimeUpdate(update.request.updateId)!,new AbortController().signal,()=>h.store.assertRuntimeUpdate(updater!)),/尚未冻结/);
    assert.equal(h.store.runtimeUpdateProcesses(update.request.updateId).length,0);assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
  }finally{if(updater!)await native.cancelOwned(updater!);await worker.stopOwned();h.store.close();}
});

test('no-item runtime recovery closes only after the handed-back ordinary host performs the actual business protocol operation',
  {skip:process.platform==='win32'},async()=>{
  // Candidate build/verification inputs and the post-handoff SQL protocol are
  // controlled. Root capability isolation, immutable bytes and POSIX process
  // identity/exit are actual; this is not a true-model recovery claim.
  const h=await fixture(true),worker=createNativeAdminBusinessWorker({store:h.store,appRoot:h.sourceArtifact.root,
    dataRoot:h.dataRoot,executable:process.execPath,rootOwnerId:'root'});
  let host:ReturnType<typeof spawn>|undefined,closed:Promise<void>|undefined,renewing:NodeJS.Timeout|undefined;
  try{
    const verification=await independentlyVerifyFixture(h);
    const update=await requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:(input,assertCurrent)=>assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent})});
    const updater=h.store.acquireRuntimeUpdate(update.request.updateId,'root')!;
    const baseline=await worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId}) as {businessStore:string;tasks:unknown[]};
    assert.equal(baseline.businessStore,'absent');assert.deepEqual(baseline.tasks,[]);
    for(const [expected,phase] of [['stopping','candidate-starting'],['candidate-starting','candidate-activating'],
      ['candidate-activating','candidate-observing'],['candidate-observing','succeeded']] as const)
      h.store.advanceRuntimeUpdate(updater,expected,phase,{selected:h.candidate});
    renewing=setInterval(()=>{h.store.renewRuntimeHost(h.root);h.store.renewSupervisor(h.authority);},1000);
    await mkdir(join(h.dataRoot,'node_modules'));
    for(const name of ['better-sqlite3','bindings','file-uri-to-path'])await cp(join(process.cwd(),'node_modules',name),join(h.dataRoot,'node_modules',name),{recursive:true});
    const bridge=join(h.dataRoot,'controlled-original-operation-bridge.cjs');
    await build({stdin:{contents:`export {AdminManagementStore} from './src/infrastructure/admin-management-store';
      export {inspectProcessIdentity} from './src/infrastructure/process-tree';
      export {assertRuntimeCliCaller} from './src/infrastructure/runtime-cli-registry';`,resolveDir:process.cwd()},
      outfile:bridge,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
    const allocation=h.store.reserveRuntimeHostProcess(h.root,h.candidate);
    host=spawn(process.execPath,[join(h.candidate.root,'desktop-runners','host-service.cjs'),'--controlled-host',bridge,h.store.filename],
      {detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,LOOP_APP_ROOT:h.candidate.root,LOOP_DATA_ROOT:h.dataRoot}});
    closed=new Promise<void>(resolve=>host!.once('close',()=>resolve()));assert.ok(host.pid);
    const identity=await inspectProcessIdentity(host.pid);assert.ok(identity);
    h.store.bindRuntimeHostProcess(allocation,host.pid,identity.startMarker,host.pid);
    const certified=new Promise<void>((resolve,reject)=>{host!.once('error',reject);host!.once('message',message=>{
      if((message as {kind?:string}).kind==='certified')resolve();else reject(new Error('controlled host certification failed'));
    });host!.once('close',()=>reject(new Error('controlled host exited before certification')));});
    host.send(h.store.runtimeHostProcesses().find(row=>row.allocationId===allocation.allocationId)!);await certified;
    h.store.readyRuntimeHostProcess(h.root,allocation.allocationId,1234);
    await confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot});
    const filename=join(h.dataRoot,'loop-ui.db'),business=new Database(filename);
    business.exec(`PRAGMA user_version=125;
      CREATE TABLE tasks(task_id TEXT PRIMARY KEY);
      CREATE TABLE workflow_items(item_id TEXT PRIMARY KEY);
      CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY);
      CREATE TABLE loop_supervisor_lease(singleton INTEGER PRIMARY KEY,owner_id TEXT,fencing_token INTEGER,expires_at TEXT);
      CREATE TABLE loop_lifecycle_state(singleton INTEGER PRIMARY KEY,desired_intent TEXT,intent_revision INTEGER,
        mode TEXT,actual_phase TEXT,active_run_id TEXT,last_error TEXT);
      INSERT INTO loop_supervisor_lease VALUES(1,'controlled-host',9999,'2099-01-01T00:00:00.000Z');
      INSERT INTO loop_lifecycle_state VALUES(1,'running',1,'normal','stopped',NULL,NULL);`);
    business.close();
    await assert.rejects(worker.run({operation:'runtime-business-progress',caseId:h.repairCase.caseId}),/新鲜监督 lease/);
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
    assert.equal(h.store.runtimeOriginalOperationReceipt(verification.attempt.attemptId),null);
    const repair=new Database(filename);repair.prepare('UPDATE loop_supervisor_lease SET fencing_token=?').run(1234);repair.close();
    const before=await readFile(filename);
    assert.deepEqual(runtimeBusinessProgressResultSchema.parse(await worker.run({operation:'runtime-business-progress',caseId:h.repairCase.caseId})),
      {status:'closed',verificationAttemptId:verification.attempt.attemptId,progressCount:0,requiredCount:0});
    assert.deepEqual(await readFile(filename),before,'actual original-operation observation never writes business storage');
    const receipt=h.store.runtimeOriginalOperationReceipt(verification.attempt.attemptId)!;
    assert.deepEqual(receipt.originalObservationIds,['original-1','original-2']);
    assert.equal(receipt.handoff.businessSupervisionToken,1234);assert.equal(receipt.businessStoreBefore,'absent');
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'closed');
    assert.equal(h.store.closeRuntimeOriginalOperationCase(h.authority,h.repairCase.caseId,receipt,()=>receipt),true,
      'persisted exact operation receipt is replay-safe');
  }finally{
    if(renewing)clearInterval(renewing);
    if(host?.pid){const identity=await inspectProcessIdentity(host.pid);if(identity)await terminateProcessGroup(host.pid,5000,identity.startMarker);}
    if(closed)await closed;await worker.stopOwned();h.store.close();
  }
});

for(const mode of ['close','rewind','stop','stall','stall-stop'] as const)test(`native progress capability requires original provenance and physical exit: ${mode}`,
  {skip:process.platform==='win32'},async()=>{
  // The original SQL workload, compiler success metadata, supervision token
  // and update transitions are controlled fixtures, NOT true Agent recovery.
  // Capability isolation, source checks, CLI admission and POSIX exits are real.
  const h=await fixture(true),worker=createNativeAdminBusinessWorker({store:h.store,appRoot:h.sourceArtifact.root,
    dataRoot:h.dataRoot,executable:process.execPath,rootOwnerId:'root'});
  const filename=join(h.dataRoot,'loop-ui.db'),writer=new Database(filename);
  const owned:Array<{pid:number;marker:string}>=[];
  let hostChild:ReturnType<typeof spawn>|undefined,hostClosed:Promise<void>|undefined;
  let renewing:NodeJS.Timeout|undefined;
  try{
    const verification=await independentlyVerifyFixture(h);
    writer.exec(`CREATE TABLE projects(project_id TEXT PRIMARY KEY,deleted_at TEXT);
      CREATE TABLE tasks(task_id TEXT PRIMARY KEY,project_id TEXT,workflow_engine TEXT,is_paused INTEGER);
      CREATE TABLE workflow_items(item_id TEXT PRIMARY KEY,task_id TEXT,revision INTEGER,dispatch_epoch INTEGER,
        origin TEXT,status TEXT,completion_authority TEXT,created_at TEXT,completed_at TEXT,updated_at TEXT);
      CREATE TABLE execution_attempts(execution_id TEXT PRIMARY KEY,task_id TEXT,work_item_id TEXT,status TEXT,input_json TEXT);
      CREATE TABLE agent_results(result_id TEXT PRIMARY KEY,execution_id TEXT,task_id TEXT,application_status TEXT,effect_outcome TEXT,applied_at TEXT);
      CREATE TABLE workflow_item_events(event_id TEXT PRIMARY KEY,item_id TEXT,execution_id TEXT,event_key TEXT,event_type TEXT,authority TEXT);
      CREATE TABLE execution_processes(allocation_id TEXT PRIMARY KEY,execution_id TEXT,status TEXT);
      CREATE TABLE interventions(intervention_id TEXT PRIMARY KEY,task_id TEXT,item_id TEXT,status TEXT);
      INSERT INTO projects VALUES('project',NULL);
      INSERT INTO tasks VALUES('original-a','project','native',0),('original-b','project','native',0);
      INSERT INTO workflow_items VALUES('a','original-a',1,2,'native','ready',NULL,'2001-01-01',NULL,'2001-01-01'),
        ('b','original-b',1,3,'native','waiting',NULL,'2001-01-01',NULL,'2001-01-01');
      INSERT INTO execution_attempts VALUES('old-execution','original-a','a','retryable_failed','{"delegation":{"workItemEpoch":2}}');`);
    // The native capability must exercise the complete production dispatch
    // reader. Extend this deliberately small evidence fixture to the same read
    // contract instead of teaching Root to treat an incomplete schema as an
    // empty queue. Future plain task fields added to the production SELECT are
    // therefore required by this native test as well.
    const taskColumns=(dispatchTaskSelect.split('FROM tasks')[0].replace(/^\s*SELECT\s*/,'').split(',')
      .map(column=>column.trim()));
    assert.ok(taskColumns.length>20&&taskColumns.every(column=>/^[a-z_]+$/.test(column)));
    const existingTaskColumns=new Set((writer.pragma('table_info(tasks)') as {name:string}[]).map(column=>column.name));
    const integerTaskColumns=new Set(['analysis_index','dev_index','test_index','total_stories','spec_resolved_index',
      'resume_pending','review_revision','retry_cycle']);
    for(const column of taskColumns)if(!existingTaskColumns.has(column))writer.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${
      integerTaskColumns.has(column)?'INTEGER NOT NULL DEFAULT 0':'TEXT'}`);
    writer.exec(`UPDATE tasks SET priority='5',retry_cycle=1;
      ALTER TABLE workflow_items ADD COLUMN work_key TEXT;
      ALTER TABLE workflow_items ADD COLUMN kind TEXT;
      ALTER TABLE workflow_items ADD COLUMN title TEXT;
      ALTER TABLE workflow_items ADD COLUMN story_index INTEGER;
      ALTER TABLE workflow_items ADD COLUMN agent TEXT;
      ALTER TABLE workflow_items ADD COLUMN pipeline TEXT;
      ALTER TABLE workflow_items ADD COLUMN lane TEXT;
      ALTER TABLE workflow_items ADD COLUMN source_state_hash TEXT;
      ALTER TABLE workflow_items ADD COLUMN completion_reason TEXT;
      ALTER TABLE workflow_items ADD COLUMN superseded_by_item_id TEXT;
      ALTER TABLE workflow_items ADD COLUMN ready_at TEXT;
      ALTER TABLE workflow_items ADD COLUMN started_at TEXT;
      ALTER TABLE workflow_items ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workflow_items ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
      UPDATE workflow_items SET work_key=item_id,kind='agent',title=item_id,agent='direct-agent',pipeline='direct',lane='control';
      ALTER TABLE execution_attempts ADD COLUMN pipeline TEXT NOT NULL DEFAULT 'direct';
      ALTER TABLE execution_attempts ADD COLUMN agent TEXT;
      ALTER TABLE execution_attempts ADD COLUMN story_index INTEGER;
      ALTER TABLE workflow_item_events ADD COLUMN reason TEXT;
      ALTER TABLE workflow_item_events ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE workflow_item_events ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE interventions ADD COLUMN summary TEXT;
      ALTER TABLE interventions ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE interventions ADD COLUMN resolver_strategy TEXT;
      ALTER TABLE interventions ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
      CREATE TABLE workflow_dependencies(item_id TEXT,depends_on_item_id TEXT);
      CREATE TABLE task_dependencies(task_id TEXT,depends_on_task_id TEXT);
      CREATE TABLE project_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT);
      CREATE TABLE resource_claims(resource_key TEXT,resource_scope TEXT,owner_task_id TEXT,owner_lane TEXT,
        owner_story_index INTEGER,owner_execution_id TEXT,acquired_at TEXT,updated_at TEXT);
      CREATE TABLE execution_process_barriers(allocation_id TEXT,resource_key TEXT,resource_scope TEXT,
        owner_task_id TEXT,owner_lane TEXT,owner_story_index INTEGER,owner_execution_id TEXT,acquired_at TEXT,updated_at TEXT);
      CREATE TABLE repair_resource_claims(resource_key TEXT,resource_scope TEXT,task_id TEXT,acquired_at TEXT,updated_at TEXT);
      CREATE TABLE task_context_chat_sessions(task_id TEXT,state TEXT,updated_at TEXT);
      CREATE TABLE documents(document_id TEXT,task_id TEXT,title TEXT,content TEXT,format TEXT);
      CREATE TABLE execution_receipts(execution_id TEXT,kind TEXT,receipt_key TEXT,payload_json TEXT);
      CREATE TABLE document_comments(comment_id TEXT,task_id TEXT,status TEXT,feedback_status TEXT,target_agent TEXT,created_at TEXT);`);
    const update=await requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:(input,assertCurrent)=>assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent})});
    const updater=h.store.acquireRuntimeUpdate(update.request.updateId,'root')!;
    await worker.run({operation:'runtime-business-baseline',updateId:update.request.updateId});
    for(const [expected,phase] of [['stopping','candidate-starting'],['candidate-starting','candidate-activating'],
      ['candidate-activating','candidate-observing'],['candidate-observing','succeeded']] as const)
      h.store.advanceRuntimeUpdate(updater,expected,phase,{selected:h.candidate});
    renewing=setInterval(()=>{h.store.renewRuntimeHost(h.root);h.store.renewSupervisor(h.authority);},1000);
    await mkdir(join(h.dataRoot,'node_modules'));
    for(const name of ['better-sqlite3','bindings','file-uri-to-path'])await cp(join(process.cwd(),'node_modules',name),join(h.dataRoot,'node_modules',name),{recursive:true});
    const bridge=join(h.dataRoot,'controlled-progress-bridge.cjs');
    // Independent test bridge: never modify either immutable installation.
    await build({stdin:{contents:`export {AdminManagementStore} from './src/infrastructure/admin-management-store';
      export {inspectProcessIdentity} from './src/infrastructure/process-tree';
      export {assertRuntimeCliCaller} from './src/infrastructure/runtime-cli-registry';`,resolveDir:process.cwd()},
      outfile:bridge,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
    const host=h.store.reserveRuntimeHostProcess(h.root,h.candidate);
    hostChild=spawn(process.execPath,[join(h.candidate.root,'desktop-runners','host-service.cjs'),'--controlled-host',bridge,h.store.filename],
      {detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,LOOP_APP_ROOT:h.candidate.root,LOOP_DATA_ROOT:h.dataRoot}});
    hostClosed=new Promise<void>(resolve=>hostChild!.once('close',()=>resolve()));assert.ok(hostChild.pid);
    const identity=await inspectProcessIdentity(hostChild.pid);assert.ok(identity);
    owned.push({pid:hostChild.pid,marker:identity.startMarker});
    h.store.bindRuntimeHostProcess(host,hostChild.pid,identity.startMarker,hostChild.pid);
    const waitMessage=(kind:string,allocationId?:string)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
      const child=hostChild!;
      const done=()=>{clearTimeout(timer);child.off('message',receive);child.off('close',exit);};
      const receive=(raw:unknown)=>{const message=raw as Record<string,unknown>;
        if(message.kind==='cli-error'){done();reject(new Error(String(message.error)));}
        else if(message.kind===kind&&(!allocationId||message.allocationId===allocationId)){done();resolve(message);}};
      const exit=()=>{done();reject(new Error(`controlled host exited code=${child.exitCode} signal=${child.signalCode}`));};
      const timer=setTimeout(()=>{done();reject(new Error(`controlled ${kind} timed out`));},10000);
      child.on('message',receive);child.once('close',exit);
    });
    const certified=waitMessage('certified');hostChild.send(h.store.runtimeHostProcesses().find(row=>row.allocationId===host.allocationId)!);
    await certified;h.store.readyRuntimeHostProcess(h.root,host.allocationId,1234);
    await confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot});
    const run=async()=>runtimeBusinessProgressResultSchema.parse(await worker.run({operation:'runtime-business-progress',caseId:h.repairCase.caseId}));
    const read=()=>{const target=h.store.runtimeBusinessProgressTarget(h.authority,h.repairCase.caseId)!;
      const db=new Database(filename,{readonly:true,fileMustExist:true});try{return findRuntimeBusinessProgressCandidatesInDb(db,
        {baseline:target.baseline,handoffs:target.handoffs,clis:target.clis,assertCurrent:()=>{}});}finally{db.close();}};
    const apply=(itemId:string,executionId:string)=>{
      const item=writer.prepare('SELECT task_id,dispatch_epoch FROM workflow_items WHERE item_id=?').get(itemId) as {task_id:string;dispatch_epoch:number};
      writer.prepare(`INSERT INTO execution_attempts(execution_id,task_id,work_item_id,status,input_json,pipeline)
        VALUES(?,?,?,?,?,'direct')`).run(executionId,item.task_id,itemId,'applied',JSON.stringify({delegation:{workItemEpoch:item.dispatch_epoch}}));
      writer.prepare("UPDATE workflow_items SET status='completed',completion_authority='agent',completed_at='2026-09-16' WHERE item_id=?").run(itemId);
      writer.prepare('INSERT INTO agent_results VALUES(?,?,?,?,?,?)').run(`result:${executionId}`,executionId,item.task_id,'applied','advanced','2026-09-16');
      writer.prepare(`INSERT INTO workflow_item_events(event_id,item_id,execution_id,event_key,event_type,authority,reason,payload_json)
        VALUES(?,?,?,?,?,?,'completed','{}')`).run(`event:${executionId}`,itemId,executionId,`result:result:${executionId}`,'complete','agent');
    };
    assert.deepEqual(await run(),{status:'waiting',verificationAttemptId:verification.attempt.attemptId,progressCount:0,requiredCount:2});
    assert.equal(h.store.closeRuntimeObservedCase(h.authority,h.repairCase.caseId,()=>[]),false);
    if(mode==='stall'||mode==='stall-stop'){
      const watches=h.store.runtimeBusinessDispatchWatches(verification.attempt.attemptId);
      assert.deepEqual(watches.map(row=>[row.task_id,row.readiness,row.eligible_elapsed_ms]),[
        ['original-a','runnable',0],['original-b','waiting',0]]);
      const management=new Database(h.store.filename);
      try{
        if(mode==='stall'){
          // Controlled persisted-clock fixture: a gap larger than the sampling
          // bound cannot be presented as 20 minutes of continuous eligibility.
          management.prepare(`UPDATE repair_runtime_dispatch_watches SET eligible_elapsed_ms=?,last_sample_at=?
            WHERE verification_attempt_id=? AND task_id='original-a'`).run(20*60*1000,Date.now()-120001,verification.attempt.attemptId);
          assert.equal((await run()).status,'waiting');
          assert.equal(h.store.runtimeBusinessDispatchWatches(verification.attempt.attemptId)
            .find(row=>row.task_id==='original-a')!.eligible_elapsed_ms,0);
        }
        management.prepare(`UPDATE repair_runtime_dispatch_watches SET eligible_elapsed_ms=?,last_sample_at=?
          WHERE verification_attempt_id=? AND task_id='original-a'`).run(20*60*1000,Date.now()-1000,verification.attempt.attemptId);
      }finally{management.close();}
      const businessSnapshot=await readFile(filename);
      if(mode==='stall-stop'){
        h.store.setIntent('stopped','user-stop');
        await assert.rejects(run());
        assert.deepEqual(await readFile(filename),businessSnapshot);
        assert.equal(h.store.observations(h.repairCase.caseId).length,2);
        assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
        assert.equal(h.store.runtimeBusinessProgressHistory(verification.attempt.attemptId).length,0);
        return;
      }
      assert.deepEqual(await run(),{status:'source-changed',verificationAttemptId:verification.attempt.attemptId,
        progressCount:0,requiredCount:2});
      assert.deepEqual(await readFile(filename),businessSnapshot,'dispatch stall observation never writes business storage');
      assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'queued');
      assert.equal(h.store.verificationReceipt(verification.attempt.attemptId)!.passed,true);
      assert.equal(h.store.runtimeBusinessProgressHistory(verification.attempt.attemptId).length,0);
      assert.deepEqual(writer.prepare(`SELECT item_id,status,completion_authority FROM workflow_items ORDER BY item_id`).all(),[
        {item_id:'a',status:'ready',completion_authority:null},{item_id:'b',status:'waiting',completion_authority:null}]);
      const observations=h.store.observations(h.repairCase.caseId) as {observation_id:string;evidence_json:string}[];
      assert.equal(observations.length,3);
      const fact=observations.find(row=>JSON.parse(row.evidence_json).kind==='repair-runtime-dispatch-stalled')!;
      const evidence=JSON.parse(fact.evidence_json);
      assert.equal(evidence.originalFailure,false);assert.equal(evidence.observations.length,1);
      assert.equal(evidence.observations[0].taskId,'original-a');
      const recovery=h.store.claimNext(h.authority)!;
      assert.equal(h.store.commandStatus(h.store.issueCommandCredential(recovery)).requiredOriginalCoverage.count,2,
        'derived stall fact cannot replace original acceptance');
      return;
    }
    for(const [itemId,executionId] of [['a','new-a'],['b','new-b']]){
      const allocationId=randomUUID(),attached=waitMessage('cli-attached',allocationId),closed=waitMessage('cli-closed',allocationId);
      void closed.catch(()=>undefined);
      hostChild.send({kind:'spawn-controlled-cli',allocationId,executionId});const actual=await attached;
      owned.push({pid:actual.pid as number,marker:actual.marker as string});apply(itemId,executionId);
      if(itemId==='a'){
        h.store.finishRuntimeCli(allocationId,true); // Adversarial false-exit ledger.
        await assert.rejects(run(),/CLI 进程组实际存活/);
        assert.equal(h.store.runtimeBusinessProgressHistory(verification.attempt.attemptId).length,0);
        assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
      }
      hostChild.send({kind:'finish-controlled-cli',allocationId});await closed;assert.deepEqual(await inspectProcessGroup(actual.pid as number),[]);
      if(itemId==='a'){
        const snapshot=await readFile(filename),partial=await run();assert.equal(partial.status,'waiting');assert.equal(partial.progressCount,1);
        assert.deepEqual(await readFile(filename),snapshot,'observer never writes business storage');
        const candidates=read();assert.equal(candidates.length,1);
        assert.equal(h.store.recordRuntimeBusinessProgress(h.authority,h.repairCase.caseId,candidates[0]),false);
        assert.equal(h.store.closeRuntimeObservedCase(h.authority,h.repairCase.caseId,()=>candidates),false);
        assert.throws(()=>h.store.recordRuntimeBusinessProgress(h.authority,h.repairCase.caseId,{...candidates[0],executionId:'old-execution',
          cli:{...candidates[0].cli,executionId:'old-execution'}}),/新实际执行/);
        assert.equal(runtimeBusinessProgressCandidateSchema.safeParse({...candidates[0],cli:{...candidates[0].cli,ownerPid:process.pid}}).success,false);
        const reopened=new AdminManagementStore(join(h.dataRoot,'admin-management.db'));
        try{assert.equal(reopened.runtimeBusinessProgressHistory(verification.attempt.attemptId).length,1);}finally{reopened.close();}
        if(mode!=='close'){
          const time=new Date().toISOString();
          writer.prepare("UPDATE workflow_items SET status='superseded',superseded_by_item_id='b2',updated_at=? WHERE item_id='b'").run(time);
          writer.prepare(`INSERT INTO workflow_items(item_id,task_id,revision,dispatch_epoch,origin,status,created_at,updated_at,
            work_key,kind,title,agent,pipeline,lane,context_json)
            VALUES('b2','original-b',2,1,'native','ready',?,?,'b','agent','b2','direct-agent','direct','control','{}')`).run(time,time);
          const readChanges=()=>{const target=h.store.runtimeBusinessProgressTarget(h.authority,h.repairCase.caseId)!;
            const db=new Database(filename,{readonly:true,fileMustExist:true});try{return findRuntimeBusinessCohortChangesInDb(db,
              {baseline:target.baseline,progressTaskIds:read().map(row=>row.taskId),assertCurrent:()=>{}});}finally{db.close();}};
          const changes=readChanges();assert.equal(changes.length,1);assert.equal(changes[0].current!.successorId,'b2');
          assert.equal(h.store.recordRuntimeBusinessCohortChange(h.authority,h.repairCase.caseId,changes,()=>[]),false,'stale source read cannot invalidate');
          assert.throws(()=>h.store.recordRuntimeBusinessCohortChange(h.authority,h.repairCase.caseId,
            [{...changes[0],originalItemId:'unrelated'}],()=>changes),/已冻结原需求/);
          assert.throws(()=>h.store.recordRuntimeBusinessCohortChange(h.authority,h.repairCase.caseId,
            [{...changes[0],current:{...changes[0].current!,status:'waiting'}}],()=>changes),/实际变更/);
          if(mode==='stop'){
            const snapshot=await readFile(filename);h.store.setIntent('stopped','user-stop');
            assert.throws(()=>h.store.recordRuntimeBusinessCohortChange(h.authority,h.repairCase.caseId,changes,()=>changes));
            await assert.rejects(run());assert.deepEqual(await readFile(filename),snapshot);
            assert.equal(h.store.observations(h.repairCase.caseId).length,2,'STOP is not an authority-invalidation failure');
            assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
            assert.equal(h.store.runtimeBusinessProgressHistory(verification.attempt.attemptId).length,1);
            return;
          }
          const snapshot=await readFile(filename),changed=await run();assert.equal(changed.status,'source-changed');assert.equal(changed.progressCount,1);
          assert.deepEqual(await readFile(filename),snapshot,'cohort invalidation never writes business state');
          assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'queued');assert.equal(h.store.observations(h.repairCase.caseId).length,3);
          assert.equal(h.store.verificationReceipt(verification.attempt.attemptId)!.passed,true);
          assert.equal(h.store.runtimeBusinessProgressHistory(verification.attempt.attemptId).length,1);
          assert.throws(()=>h.store.closeRuntimeObservedCase(h.authority,h.repairCase.caseId,()=>candidates));
          assert.throws(()=>h.store.recordRuntimeBusinessCohortChange(h.authority,h.repairCase.caseId,changes,()=>changes));
          const recovery=h.store.claimNext(h.authority)!,credential=h.store.issueCommandCredential(recovery),status=h.store.commandStatus(credential);
          assert.equal(status.requiredOriginalCoverage.count,2,'derived authority invalidation cannot replace original acceptance');
          assert.deepEqual(status.requiredOriginalCoverage.observationIds.sort(),['original-1','original-2']);
          const fact=(h.store.observations(h.repairCase.caseId) as {observation_id:string;evidence_json:string}[])
            .find(row=>JSON.parse(row.evidence_json).kind==='repair-runtime-cohort-changed')!;
          assert.ok(fact);assert.ok(h.store.recoveryDecision(recovery.attempt.attemptId)!.failedAttemptIds.some(id=>id.startsWith('runtime-cohort:')));
          h.store.commandRequestAction(credential,'current-source',{kind:'harness-workspace',observationId:fact.observation_id,reason:'Revalidate the current candidate and original demand after rewind'});
          await prepareAdminHarnessWorkspaces({store:h.store,authority:h.authority,dataRoot:h.dataRoot,assertCurrent:()=>{}});
          const action=h.store.commandStatus(credential).actions.find(action=>action.key==='current-source')!;
          assert.equal(action.status,'completed','the next investigation can actually restore source for the current image');
          h.store.finishAttempt(recovery,{outcome:'failed',reason:'Controlled no-spawn re-admission inspection, not actual model repair',exitConfirmed:true});
          h.store.setIntent('stopped','user-stop');assert.equal(h.store.observations(h.repairCase.caseId).length,3);
          return;
        }
      }
    }
    // Fresh DB changes must not let old persisted progress close the Case.
    const all=read();assert.equal(all.length,2);
    for(const candidate of all)h.store.recordRuntimeBusinessProgress(h.authority,h.repairCase.caseId,candidate);
    writer.prepare("UPDATE tasks SET is_paused=1 WHERE task_id='original-b'").run();
    assert.equal(h.store.closeRuntimeObservedCase(h.authority,h.repairCase.caseId,read),false);
    writer.prepare("UPDATE tasks SET is_paused=0 WHERE task_id='original-b'").run();
    const snapshot=await readFile(filename);assert.equal((await run()).status,'closed');assert.deepEqual(await readFile(filename),snapshot);
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'closed');
    assert.deepEqual(h.store.runtimeBusinessProgressClosure(verification.attempt.attemptId),all);
    assert.equal(h.store.closeRuntimeObservedCase(h.authority,h.repairCase.caseId,()=>{throw new Error('closed replay must not read business');}),true);
    assert.equal(h.store.observations(h.repairCase.caseId).length,2,'original failures preserved');
    h.store.observe({observationId:'recurrence',scope:'runtime',scopeKey:'runtime-case',fingerprint:'runtime-result-missing',
      origin:'runtime',repairCaseId:h.repairCase.caseId,sourceVersion:h.candidate.version,summary:'new real fault fact',evidence:{artifact:h.candidate}});
    assert.notEqual(h.store.getCase(h.repairCase.caseId)!.status,'closed');
    assert.throws(()=>h.store.closeRuntimeObservedCase(h.authority,h.repairCase.caseId,()=>all));
    assert.equal(h.store.runtimeBusinessProgressHistory(verification.attempt.attemptId).length,2);
    h.store.setIntent('stopped','user-stop');await assert.rejects(run());
    assert.throws(()=>h.store.recordRuntimeBusinessProgress(h.authority,h.repairCase.caseId,all[0]));
  }finally{
    if(renewing)clearInterval(renewing);await worker.stopOwned();
    for(const record of owned)assert.equal(await terminateProcessGroup(record.pid,5000,record.marker),true);
    if(hostClosed)await hostClosed;writer.close();h.store.close();
  }
});

test('runtime progress faults persist original provenance, advance recovery strategy and reject STOP and stale cycles',async()=>{
  // Controlled switching metadata and no ordinary host. This exercises the
  // management failure policy, not successful physical/business recovery.
  const h=await fixture();try{
    const verification=await independentlyVerifyFixture(h);
    const update=await requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:(input,assertCurrent)=>assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent})});
    const updater=h.store.acquireRuntimeUpdate(update.request.updateId,'root')!;
    for(const [expected,phase] of [['stopping','candidate-starting'],['candidate-starting','candidate-activating'],
      ['candidate-activating','candidate-observing'],['candidate-observing','succeeded']] as const)
      h.store.advanceRuntimeUpdate(updater,expected,phase,{selected:h.candidate});
    assert.equal(h.store.closeRuntimeObservedCase(h.authority,h.repairCase.caseId,()=>[]),false);
    assert.throws(()=>h.store.recordRuntimeBusinessProgressFailure(h.authority,h.repairCase.caseId,'stale-cycle','fixture failure'),/来源已变化/);
    h.store.recordRuntimeBusinessProgressFailure(h.authority,h.repairCase.caseId,verification.attempt.attemptId,'controlled read failure');
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'queued');assert.equal(h.store.observations(h.repairCase.caseId).length,3);
    const recovery=h.store.claimNext(h.authority)!;
    assert.ok(h.store.recoveryDecision(recovery.attempt.attemptId)!.failedAttemptIds.includes(`runtime-progress:${verification.attempt.attemptId}`));
    assert.equal(h.store.verificationReceipt(verification.attempt.attemptId)!.passed,true,'original independent proof is never rewritten');
    h.store.finishAttempt(recovery,{outcome:'failed',reason:'Controlled no-spawn policy inspection',exitConfirmed:true});
    const before=h.store.observations(h.repairCase.caseId).length;h.store.setIntent('stopped','user-stop');
    assert.throws(()=>h.store.recordRuntimeBusinessProgressFailure(h.authority,h.repairCase.caseId,verification.attempt.attemptId,'user stop'));
    assert.equal(h.store.observations(h.repairCase.caseId).length,before,'manual stop creates no failure fact');
  }finally{h.store.close();}
});

test('runtime source binds completed candidate identity and all original facts without inventing a task or business contract',async()=>{
  const h=await fixture();try{
    const prompt=buildAdminPrompt(h.store,h.repair,'loop-admin');assert.match(prompt,/repairVersion.*result.candidate.artifactId/);
    assert.throws(()=>h.store.commandSubmit(h.credential,h.submission),/唯一已完成/);h.finishBuild();
    assert.throws(()=>h.store.commandSubmit(h.credential,{...h.submission,repairVersion:'fixture-v1'}),/唯一已完成/);
    assert.throws(()=>h.store.commandSubmit(h.credential,{...h.submission,repairEvidenceKeys:['invented']}),/真实候选构建/);
    assert.throws(()=>h.store.commandSubmit(h.credential,{...h.submission,originalObservationIds:['original-1']}),/遗漏/);
    const claim=h.start(),input=h.store.independentVerificationInput(claim);assert.equal(input.kind,'runtime');
    assert.equal(input.expectedVersion,h.candidate.artifactId);assert.equal(input.workspaceRoot,h.frozen);
    assert.equal('workspaceBinding' in input,false);assert.equal(input.originalObservations.length,2);
    const targets=originalVerificationTargets(input);assert.deepEqual(targets.map(row=>row.targetRef),['original-1:runtime-original','original-2:runtime-original']);
    const proposed={reproduction:{targetRef:'original-failures',command:'independent original runtime replay'},acceptanceChecks:targets.map(target=>({targetRef:target.targetRef,command:'actual compiled assertion'}))};
    assert.throws(()=>authorizePreparedVerification(input,{...proposed,acceptanceChecks:proposed.acceptanceChecks.slice(1)},'actual candidate identity'),/完整覆盖/);
    await assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent:()=>h.store.assertIndependentVerificationClaim(claim)});
    assert.equal(existsSync(join(h.dataRoot,'loop-ui.db')),false);assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'verifying');
  }finally{h.store.close();}
});

test('runtime input rejects changed frozen source, damaged executable bytes and foreign verification paths without business DB access',async()=>{
  const h=await fixture();try{
    const claim=h.start(),input=h.store.independentVerificationInput(claim),ports={store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent:()=>h.store.assertIndependentVerificationClaim(claim)};
    await assert.rejects(assertRuntimeVerificationInput({...input,workspaceRoot:process.cwd()},ports),/私有冻结构建/);
    const file=join(h.frozen,'scripts','fixture.cjs'),original=await readFile(file);await writeFile(file,'changed');
    await assert.rejects(assertRuntimeVerificationInput(input,ports),/冻结源码已变化/);await writeFile(file,original);
    await writeFile(join(h.candidate.root,'desktop-runners','host-service.cjs'),'damaged compiled image');
    await assert.rejects(assertRuntimeVerificationInput(input,ports));assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'verifying');
  }finally{h.store.close();}
});

test('actual root-bound runtime source checker survives corrupt business databases and physically exits',async()=>{
  const h=await fixture(true);const worker=createNativeAdminBusinessWorker({store:h.store,appRoot:h.sourceArtifact.root,dataRoot:h.dataRoot,executable:process.execPath,rootOwnerId:'root'});
  try{
    const claim=h.start(),input=h.store.independentVerificationInput(claim);
    await writeFile(join(h.dataRoot,'loop-ui.db'),'corrupt business database');await writeFile(join(h.dataRoot,'loopwork.db'),'corrupt application database');
    assert.equal(await worker.run({operation:'assert-runtime',caseId:h.repairCase.caseId,inputHash:independentPreparationHash(input)}),true);
    const records=h.store.adminBusinessWorkers();assert.equal(records.length,1);assert.equal(records[0].artifact.artifactId,h.sourceArtifact.artifactId);assert.equal(records[0].status,'exited');
    assert.throws(()=>process.kill(records[0].pid!,0),/ESRCH/);
    assert.equal(await readFile(join(h.dataRoot,'loop-ui.db'),'utf8'),'corrupt business database');
  }finally{await worker.stopOwned();h.store.close();}
});

test('an unknown live compiler allocation remains a physical barrier before runtime verification reuses frozen source',async()=>{
  const h=await fixture();try{
    const claim=h.start(),input=h.store.independentVerificationInput(claim);
    const compiler=h.store.reserveAdminBusinessWorker(h.root,h.authority,h.sourceArtifact,{operation:'harness-build'});
    assert.equal(compiler.pid,null);assert.equal(compiler.status,'launching');
    await assert.rejects(assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,
      assertCurrent:()=>h.store.assertIndependentVerificationClaim(claim)}),/构建进程尚未实际退出/);
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'verifying');
    assert.equal(h.store.adminBusinessWorker(compiler.allocationId)!.status,'launching','a controlled unknown allocation is not fabricated into an exited worker');
  }finally{h.store.close();}
});

for(const terminalPhase of ['aborted','rolled-back','succeeded'] as const) test(`default runtime verification executes the isolated candidate; ${terminalPhase} update admission cannot close the Case`,
  {skip:terminalPhase==='succeeded'&&process.platform==='win32'},async()=>{
  const h=await fixture();let preparations=0;
  const owned:Array<{pid:number;marker:string;closed:Promise<void>;allocationId:string}>=[];
  const executor:AgentExecutor={id:'claude',label:'Controlled independent runtime planner',command:process.execPath,promptMode:'argument',
    buildArgs:prompt=>{preparations++;assert.equal(prompt.includes('REPAIRER_FAKE'),false);return ['-e',`
      const fs=require('node:fs'),path=require('node:path');
      const input=JSON.parse(fs.readFileSync(path.join(process.env.LOOP_AGENT_TMP_DIR,'original-facts.json'),'utf8'));
      const script=path.join(process.env.LOOP_AGENT_TMP_DIR,'check.cjs');
      fs.writeFileSync(script,${JSON.stringify(`const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
        assert.equal(process.cwd(),${JSON.stringify(h.candidate.root)});assert.equal(process.env.LOOP_APP_ROOT,${JSON.stringify(h.candidate.root)});
        assert.notEqual(process.env.LOOP_DATA_ROOT,${JSON.stringify(h.dataRoot)});assert.equal(process.env.LOOP_GLOBAL_DB_PATH,undefined);
        const response=JSON.parse(require('node:child_process').execFileSync(process.execPath,['desktop-runners/host-service.cjs'],{encoding:'utf8'}));
        assert.equal(response.status,'ready');assert.equal(response.root,process.cwd());assert.equal(response.dbOverride,null);
        fs.writeFileSync(path.join(process.env.LOOP_DATA_ROOT,'actual-candidate-executed.json'),JSON.stringify(response));`)});
      const command=JSON.stringify(process.execPath)+' '+JSON.stringify(script);
      fs.writeFileSync(path.join(process.env.LOOP_AGENT_TMP_DIR,'verification-plan.json'),JSON.stringify({reproduction:{targetRef:'original-failures',command},acceptanceChecks:input.targets.map(target=>({targetRef:target.targetRef,command}))}));
      console.log('Controlled independent planner completed');setTimeout(()=>{},300);
    `];},formatCommand:()=> 'controlled runtime planner',parseStdout:line=>line,parseStderr:line=>line};
  const prepare=createIndependentVerificationPreparation({store:h.store,appRoot:process.cwd(),dataRoot:h.dataRoot,executor,executionOptions:{},limits:{maxRuntimeMs:10000,startupTimeoutMs:5000,idleTimeoutMs:5000}});
  const launch=createDefaultRepairVerification({store:h.store,appRoot:process.cwd(),prepare,assertWorkspace:async(caseId,input)=>assertRuntimeVerificationInput(input,{store:h.store,caseId,dataRoot:h.dataRoot,assertCurrent:()=>h.store.assertManagementAuthority(h.authority)})});
  try{
    const first=h.start();const prepared=await launch(first,(pid,marker,group)=>h.store.attachProcess(first,pid,marker,group),new AbortController().signal);
    const result=await prepared.completion;assert.equal(result.outcome,'verification-prepared',result.reason);assert.equal(result.exitConfirmed,true);
    h.store.finishAttempt(first,result);assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'verifying');
    const next=h.store.claimVerification(h.authority)!;const checking=await launch(next,(pid,marker,group)=>h.store.attachProcess(next,pid,marker,group),new AbortController().signal);
    const checked=await checking.completion;assert.equal(checked.outcome,'verified',checked.reason);assert.equal(checked.exitConfirmed,true);
    assert.equal(h.store.finishVerification(next,checked.exitConfirmed),true);
    assert.equal(preparations,1);assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');
    const proof=JSON.parse(await readFile(join(h.dataRoot,'admin','verification-runs',next.attempt.attemptId,'actual-candidate-executed.json'),'utf8'));
    assert.equal(proof.root,h.candidate.root);assert.equal(existsSync(join(h.dataRoot,'loop-ui.db')),false);
    for(const attempt of [first,next])assert.throws(()=>process.kill(h.store.attempts(h.repairCase.caseId).find(row=>row.attemptId===attempt.attempt.attemptId)!.pid!,0),/ESRCH/);
    assert.equal(h.store.handoffReceipt(next.attempt.attemptId),null,'candidate verification is not physical runtime handback or business progress');
    // Adversarial receipt-reader injection, not a persisted passing result:
    // retaining all observation IDs and passed=true must not hide a missing
    // original target. Restore the genuine physical receipt afterwards.
    const readReceipt=h.store.verificationReceipt.bind(h.store);
    try {
      h.store.verificationReceipt=id=>{
        const receipt=readReceipt(id);
        return receipt?{...receipt,plan:{...receipt.plan,acceptanceChecks:receipt.plan.acceptanceChecks.slice(1)}}:receipt;
      };
      assert.throws(()=>h.store.beginVerifiedRuntimeUpdate(h.authority,h.repairCase.caseId,next.attempt.attemptId),/完整覆盖/);
      assert.equal(h.store.activeRuntimeUpdate(),null);
    } finally {h.store.verificationReceipt=readReceipt;}
    assert.throws(()=>h.store.beginVerifiedRuntimeUpdate(h.authority,h.repairCase.caseId,'stale-verification'),/代次已改变/);
    let checkedInput=false;
    await assert.rejects(requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:async()=>{throw new Error('actual candidate bytes changed');}}),/actual candidate bytes changed/);
    assert.equal(h.store.activeRuntimeUpdate(),null,'failed native revalidation must not enter update silence');
    // An actual owned child establishes the physical capability barrier. It
    // performs no business operation; neither a fake PID nor status reset is
    // used to manufacture an exit proof.
    const capability=h.store.reserveAdminBusinessWorker(h.root,h.authority,h.sourceArtifact,{operation:'host-audit'});
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},200)'],{detached:true,stdio:'ignore'});
    const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`controlled capability exit ${code}`)));});
    assert.ok(child.pid);h.store.bindAdminBusinessWorker(capability,child.pid,undefined,child.pid);
    assert.throws(()=>h.store.beginVerifiedRuntimeUpdate(h.authority,h.repairCase.caseId,next.attempt.attemptId),/能力进程尚未实际退出/);
    await exited;assert.throws(()=>process.kill(child.pid!,0),/ESRCH/);assert.throws(()=>process.kill(-child.pid!,0),/ESRCH/);
    h.store.confirmAdminBusinessWorkerExit(h.store.adminBusinessWorker(capability.allocationId)!);
    let oldHost:ReturnType<AdminManagementStore['reserveRuntimeHostProcess']>|undefined;
    if(terminalPhase==='succeeded') {
      // Controlled predecessor with an actual process/group, no business
      // writes. It is intentionally kept alive for the false-exit regression.
      oldHost=h.store.reserveRuntimeHostProcess(h.root,h.sourceArtifact);
      const old=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      const closed=new Promise<void>(resolve=>old.once('close',()=>resolve()));assert.ok(old.pid);
      const identity=await inspectProcessIdentity(old.pid);assert.ok(identity);
      owned.push({pid:old.pid,marker:identity.startMarker,closed,allocationId:oldHost.allocationId});
      h.store.bindRuntimeHostProcess(oldHost,old.pid,identity.startMarker,old.pid);
      oldHost=h.store.runtimeHostProcesses().find(row=>row.allocationId===oldHost!.allocationId)!;
    }
    const update=await requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:async(input,assertCurrent)=>{checkedInput=true;await assertRuntimeVerificationInput(input,{store:h.store,caseId:h.repairCase.caseId,dataRoot:h.dataRoot,assertCurrent});}});
    assert.equal(checkedInput,true);assert.equal(update.phase,'stopping');
    assert.deepEqual(update.request.before,h.sourceArtifact);assert.deepEqual(update.request.candidate,h.candidate);
    assert.equal(h.store.control().management_mode,'update-silence');
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing','external switch admission is not Case closure');
    assert.equal(h.store.handoffReceipt(next.attempt.attemptId),null);
    // Controlled terminal metadata: no candidate/ordinary host was ever
    // launched by an external controller in this test. These transitions
    // test management policy, NOT actual startup or successful rollback.
    const updateAuthority=h.store.acquireRuntimeUpdate(update.request.updateId,'controlled-external-host')!;
    if(terminalPhase==='aborted')h.store.advanceRuntimeUpdate(updateAuthority,'stopping','aborted',{failure:'Controlled admission cancellation before any host launch'});
    else if(terminalPhase==='rolled-back') {
      h.store.advanceRuntimeUpdate(updateAuthority,'stopping','rolling-back',{failure:'Controlled candidate startup failure metadata'});
      h.store.advanceRuntimeUpdate(updateAuthority,'rolling-back','known-good-starting');
      h.store.advanceRuntimeUpdate(updateAuthority,'known-good-starting','known-good-activating');
      h.store.advanceRuntimeUpdate(updateAuthority,'known-good-activating','known-good-observing');
      h.store.advanceRuntimeUpdate(updateAuthority,'known-good-observing','rolled-back');
    } else {
      h.store.advanceRuntimeUpdate(updateAuthority,'stopping','candidate-starting');
      h.store.advanceRuntimeUpdate(updateAuthority,'candidate-starting','candidate-activating');
      h.store.advanceRuntimeUpdate(updateAuthority,'candidate-activating','candidate-observing',{selected:h.candidate});
      h.store.advanceRuntimeUpdate(updateAuthority,'candidate-observing','succeeded');
    }
    h.authority=h.store.acquireSupervisor('root:management')!;
    let repeatedRead=false;
    const repeated=await requestVerifiedRuntimeRepairUpdate({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,
      assertInput:async()=>{repeatedRead=true;}});
    assert.equal(repeated.phase,terminalPhase);assert.equal(repeatedRead,false,'a terminal failed request must not resubmit the same candidate');
    assert.equal(h.store.control().management_mode,'normal');
    if(terminalPhase==='succeeded') {
      assert.equal(await confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot}),null,
        'a completed switch without a new ready ordinary host is not handback');
      assert.equal(h.store.runtimeRepairHandoff(next.attempt.attemptId),null);
      // Explicit adversarial false-exit metadata. No success is accepted while
      // this actual predecessor remains alive; its group is physically checked.
      h.store.confirmRuntimeHostProcessExit(oldHost!);
      await mkdir(join(h.dataRoot,'node_modules'));
      for(const name of ['better-sqlite3','bindings','file-uri-to-path'])await cp(join(process.cwd(),'node_modules',name),join(h.dataRoot,'node_modules',name),{recursive:true});
      const bridge=join(h.dataRoot,'physical-store.cjs');
      await build({stdin:{contents:`export {AdminManagementStore} from ${JSON.stringify(join(process.cwd(),'src/infrastructure/admin-management-store.ts'))};`,resolveDir:process.cwd()},
        outfile:bridge,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
      const host=h.store.reserveRuntimeHostProcess(h.root,h.candidate);
      // Actual candidate fixture entry, not the product host: CLI certification
      // is real, while the business supervision token is controlled metadata.
      const candidate=spawn(process.execPath,[join(h.candidate.root,'desktop-runners','host-service.cjs'),'--controlled-host',bridge,h.store.filename],
        {detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,LOOP_APP_ROOT:h.candidate.root,LOOP_DATA_ROOT:h.dataRoot}});
      const closed=new Promise<void>(resolve=>candidate.once('close',()=>resolve()));assert.ok(candidate.pid);
      const identity=await inspectProcessIdentity(candidate.pid);assert.ok(identity);
      owned.push({pid:candidate.pid,marker:identity.startMarker,closed,allocationId:host.allocationId});
      h.store.bindRuntimeHostProcess(host,candidate.pid,identity.startMarker,candidate.pid);
      const certified=new Promise<void>((resolve,reject)=>{candidate.once('error',reject);candidate.once('message',message=>{
        if((message as {kind?:string}).kind==='certified')resolve();else reject(new Error('controlled host certification failed'));
      });candidate.once('close',()=>reject(new Error('controlled host exited before certification')));});
      candidate.send(h.store.runtimeHostProcesses().find(row=>row.allocationId===host.allocationId)!);
      let timer:NodeJS.Timeout|undefined;
      try{await Promise.race([certified,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('controlled certification timed out')),5000);})]);}
      finally{if(timer)clearTimeout(timer);}
      h.store.readyRuntimeHostProcess(h.root,host.allocationId,1234);
      await assert.rejects(confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot}),/旧宿主进程组仍存活/);
      assert.equal(h.store.runtimeRepairHandoff(next.attempt.attemptId),null,'false exited metadata cannot generate a receipt');
      assert.equal(await terminateProcessGroup(owned[0].pid,5000,owned[0].marker),true);await owned[0].closed;
      const receipt=await confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot});assert.ok(receipt);
      assert.equal(receipt.hostAllocationId,host.allocationId);assert.equal(receipt.artifact.artifactId,h.candidate.artifactId);
      assert.deepEqual(await confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot}),receipt);
      assert.deepEqual(h.store.runtimeRepairHandoffHistory(next.attempt.attemptId),[receipt],'repeated physical checks cannot duplicate a handback');
      assert.throws(()=>h.store.recordRuntimeRepairHandoff(h.authority,h.repairCase.caseId,{...receipt,pid:owned[0].pid}),/来源或代次已改变/);
      assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing');assert.equal(h.store.handoffReceipt(next.attempt.attemptId),null);
      const filename=h.store.filename;h.store.close();h.store=new AdminManagementStore(filename);
      assert.deepEqual(h.store.runtimeRepairHandoff(next.attempt.attemptId),receipt);
      assert.deepEqual(h.store.runtimeRepairHandoffHistory(next.attempt.attemptId),[receipt],'a management reopen preserves immutable physical handback evidence');
      assert.equal(await terminateProcessGroup(candidate.pid,5000,identity.startMarker),true);await closed;
      h.store.confirmRuntimeHostProcessExit(h.store.runtimeHostProcesses().find(row=>row.allocationId===host.allocationId)!);
      const successorHost=h.store.reserveRuntimeHostProcess(h.root,h.candidate);
      const successor=spawn(process.execPath,candidate.spawnargs.slice(1),{detached:true,stdio:['ignore','ignore','ignore','ipc'],
        env:{...process.env,LOOP_APP_ROOT:h.candidate.root,LOOP_DATA_ROOT:h.dataRoot}});
      const successorClosed=new Promise<void>(resolve=>successor.once('close',()=>resolve()));assert.ok(successor.pid);
      const successorIdentity=await inspectProcessIdentity(successor.pid);assert.ok(successorIdentity);
      owned.push({pid:successor.pid,marker:successorIdentity.startMarker,closed:successorClosed,allocationId:successorHost.allocationId});
      h.store.bindRuntimeHostProcess(successorHost,successor.pid,successorIdentity.startMarker,successor.pid);
      const successorCertified=new Promise<void>((resolve,reject)=>{successor.once('error',reject);successor.once('message',message=>{
        if((message as {kind?:string}).kind==='certified')resolve();else reject(new Error('successor certification failed'));
      });successor.once('close',()=>reject(new Error('successor exited before certification')));});
      successor.send(h.store.runtimeHostProcesses().find(row=>row.allocationId===successorHost.allocationId)!);
      try{await Promise.race([successorCertified,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('successor certification timed out')),5000);})]);}
      finally{if(timer)clearTimeout(timer);}
      h.store.readyRuntimeHostProcess(h.root,successorHost.allocationId,1235);
      const successorReceipt=await confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot});assert.ok(successorReceipt);
      assert.equal(successorReceipt.hostAllocationId,successorHost.allocationId);
      assert.deepEqual(h.store.runtimeRepairHandoffHistory(next.attempt.attemptId),[receipt,successorReceipt],'ordinary host replacement appends custody, never overwrites the original receipt');
      assert.deepEqual(h.store.runtimeRepairHandoff(next.attempt.attemptId),successorReceipt);
      assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'observing','even two physical handbacks cannot substitute for actual business progress');
      const entry=join(h.candidate.root,'desktop-runners','host-service.cjs'),bytes=await readFile(entry);
      let failure:unknown;
      try{
        await writeFile(entry,'throw new Error("actual fixture candidate byte damage")');
        try{await confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot});}
        catch(error){failure=error;}
        assert.ok(failure instanceof Error,'actual byte damage must reject physical handback');
      }finally{await writeFile(entry,bytes);}
      h.store.recordRuntimeHandoffFailure(h.authority,h.repairCase.caseId,next.attempt.attemptId,(failure as Error).message);
      assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'queued','failed physical handback queues investigation instead of silently remaining observing');
      assert.equal(h.store.observations(h.repairCase.caseId).length,3);assert.equal(h.store.runtimeRepairHandoffHistory(next.attempt.attemptId).length,2);
      const recovery=h.store.claimNext(h.authority)!;
      assert.ok(h.store.recoveryDecision(recovery.attempt.attemptId)!.failedAttemptIds.includes(`runtime-handoff:${next.attempt.attemptId}`),
        'a failed handback advances durable recovery budget without falsifying the passed verification');
      assert.equal(h.store.verificationReceipt(next.attempt.attemptId)!.passed,true);
      // Positive controlled no-spawn: this claim was never passed to a
      // launcher, and no model or process was created for it.
      h.store.finishAttempt(recovery,{outcome:'failed',reason:'Controlled no-spawn recovery decision inspection',exitConfirmed:true});
      h.store.setIntent('stopped','user-stop');
      await assert.rejects(confirmRuntimeRepairHandoff({store:h.store,authority:h.authority,caseId:h.repairCase.caseId,dataRoot:h.dataRoot}));
      assert.equal(existsSync(join(h.dataRoot,'loop-ui.db')),false,'physical receipt is not business DB mutation or completion');
      return;
    }
    h.store.recordUnappliedRuntimeRepairUpdate(h.authority,h.repairCase.caseId,next.attempt.attemptId);
    assert.equal(h.store.getCase(h.repairCase.caseId)!.status,'queued','failed external switch returns to investigation, not human or false completion');
    const observations=h.store.observations(h.repairCase.caseId) as {origin:string;evidence_json:string}[];
    assert.equal(observations.length,3);
    if(terminalPhase==='aborted') {
      assert.equal(observations.filter(row=>row.origin!=='admin').length,2,'cancellation is not another original failure');
      assert.equal(JSON.parse(observations.find(row=>row.origin==='admin')!.evidence_json).countsAsFailure,false);
    } else {
      assert.equal(observations.filter(row=>row.origin!=='admin').length,3,'actual failure metadata is retained as another original target');
      const failure=JSON.parse(observations.find(row=>JSON.parse(row.evidence_json).kind==='runtime-repair-update-failed')!.evidence_json);
      assert.equal(failure.phase,'rolled-back');assert.deepEqual(failure.artifact,h.sourceArtifact);
    }
    h.store.setIntent('stopped','user-stop');
    assert.throws(()=>h.store.beginVerifiedRuntimeUpdate(h.authority,h.repairCase.caseId,next.attempt.attemptId));
    assert.equal(h.store.activeRuntimeUpdate(),null,'user stop must not restart repair or update');
  }finally{
    for(const child of owned){assert.equal(await terminateProcessGroup(child.pid,5000,child.marker),true);await child.closed;
      assert.throws(()=>process.kill(child.pid,0),/ESRCH/);assert.throws(()=>process.kill(-child.pid,0),/ESRCH/);
      h.store.confirmRuntimeHostProcessExit(h.store.runtimeHostProcesses().find(row=>row.allocationId===child.allocationId)!);}
    h.store.close();
  }
});
