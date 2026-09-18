import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {AdminManagementStore} from './admin-management-store';
import {createNativeExternalRuntime} from './native-external-runtime';
import {createConfiguredAdminExecution} from '../application/admin-configured-execution';
import {confirmAdminAttemptStopped,createAdminExecutionLauncher} from './admin-execution';
import {createLangfuseTelemetry} from './langfuse';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';
import {stageRuntimeArtifact} from './runtime-selection';

test('native failed ordinary startup persists exact source and cached Admin consumes it with both business databases corrupt',{skip:process.platform==='win32'},async()=>{
  const root=join(process.env.LOOP_DATA_ROOT!,randomUUID());const app=join(root,'source');const workspace=join(root,'workspace');
  for(const directory of ['app','src','scripts','desktop','command-chains','migrations','app-migrations','desktop-runners','.next'])await mkdir(join(app,directory),{recursive:true});
  await mkdir(workspace,{recursive:true});
  for(const filename of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(app,filename),filename==='package.json'?JSON.stringify({version:'controlled-failed-startup'}):'{}');
  const program="console.error('original native startup: selected module missing');setTimeout(()=>process.exit(1),100);";
  await writeFile(join(app,'scripts','fixture.cjs'),program);await writeFile(join(app,'desktop-runners','host-service.cjs'),program);
  const source=await captureHarnessSource(app);await writeFile(join(app,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-startup-failure'}));
  await writeFile(join(app,'.next','BUILD_ID'),'controlled-startup-failure');const artifact=await writeHarnessArtifact(app);
  const staged=await stageRuntimeArtifact(artifact,root,new AbortController().signal,()=>{});
  const appDb=join(root,'loopwork.db'),bizDb=join(root,'loop-ui.db');await writeFile(appDb,'corrupt-app-sentinel');await writeFile(bizDb,'corrupt-business-sentinel');
  const store=new AdminManagementStore(join(root,'admin-management.db'));store.setIntent('running','saved-running-intent');
  const seed=store.acquireSupervisor('cache-seed')!;
  const configuration={configurationId:'already-configured',sourceVersion:'settings-original',executorId:'claude' as const,executionOptions:{model:'configured-fixture-model'}};
  store.cacheRuntimeConfiguration(seed,configuration,0);store.releaseSupervisor(seed);
  const proof=join(workspace,'cached-invocation.json');
  const managementOrder:string[]=[];
  const management={confirmStopped:confirmAdminAttemptStopped,
    prepareCapabilities:async()=>{managementOrder.push('prepare');},
    // Accelerate the real Controller timer, not a manual repair invocation.
    scheduleInterval:(callback:()=>void)=>setInterval(callback,10),
    launch:createConfiguredAdminExecution({store,refreshRuntime:async()=>{
      let db:Database.Database|undefined;
      try{db=new Database(appDb,{readonly:true,fileMustExist:true});db.prepare('SELECT * FROM app_settings').get();throw Error('corrupt DB unexpectedly readable');}
      finally{db?.close();}
    },launch:(selected,...args)=>createAdminExecutionLauncher({store,appRoot:process.cwd(),dataRoot:root,workspaceRoot:workspace,
      executor:{id:'claude',label:'Controlled Node cache consumer, not LLM',command:process.execPath,promptMode:'argument',
        buildArgs:()=>['-e',`require('node:fs').writeFileSync(${JSON.stringify(proof)},${JSON.stringify(JSON.stringify(selected))});console.log('cache consumer started');setTimeout(()=>process.exit(1),100);`],
        formatCommand:()=> 'controlled cached-runtime Node',parseStdout:line=>line,parseStderr:line=>line},
      executionOptions:selected.executionOptions,limits:{maxRuntimeMs:5000,startupTimeoutMs:2000,idleTimeoutMs:2000},
      telemetry:createLangfuseTelemetry({env:{LANGFUSE_ENABLED:'false'}}),
    })(...args)}),
  };
  let sleepAcquired=0,sleepReleased=0;
  const host=createNativeExternalRuntime({store,ownerId:'external-root',dataRoot:root,executable:process.execPath,bootstrap:staged,management,
    inhibitIdleSleep:async()=>{sleepAcquired++;return {isActive:()=>sleepReleased===0,release:async()=>{sleepReleased++;}};},
    // Miniature startup fixture launches no CLI descendants; these ports are
    // not claims about full production containment or update health.
    confirmDescendantsExited:async()=>true,confirmUntrackedHostsExited:async()=>{throw Error('updates outside fixture');},
    verifyStartup:async()=>{throw Error('updates outside fixture');},
  });
  const controller=host.management;
  try {
    assert.throws(()=>controller.reconcile(),/尚未取得所有权/);
    assert.equal(store.control().owner_id,null,'an external-root observer cannot acquire Admin supervision');
    // Standard desktop mode starts the selected runtime immediately. Admin
    // acquisition and capability cleanup run in the background and cannot
    // become an admission barrier for the ordinary host.
    await assert.rejects(host.reconcile(),/selected module missing/);
    const readManagement=new Database(store.filename,{readonly:true,fileMustExist:true});let caseId:string;
    try{assert.equal(readManagement.prepare('SELECT count(*) FROM repair_cases').pluck().get(),1);
      caseId=readManagement.prepare<[],{case_id:string}>('SELECT case_id FROM repair_cases').get()!.case_id;}
    finally{readManagement.close();}
    const observations=store.observations(caseId) as {evidence_json:string;source_version:string}[];
    assert.equal(observations.length,1);const evidence=JSON.parse(observations[0].evidence_json);
    assert.deepEqual(evidence.attemptedArtifact,staged);assert.equal(evidence.stage,'startup');
    assert.match(evidence.error.message,/selected module missing/);assert.equal(evidence.processes.length,1);
    assert.throws(()=>process.kill(evidence.processes[0].pid,0));
    const deadline=Date.now()+3000;
    while(!store.attempts(caseId).some(attempt=>attempt.status==='failed')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(store.attempts(caseId).some(attempt=>attempt.status==='failed'),'root-owned management timer automatically consumes the durable fault');
    assert.equal(store.control().owner_id,'external-root:management','background management belongs to the external root, not the failed business child');
    assert.equal(sleepAcquired,1,'background management owns the idle-sleep assertion, not the failed business child');
    assert.ok(managementOrder.length>=1&&managementOrder.every(step=>step==='prepare'),
      'background management prepares its capabilities before consuming the durable fault');
    await host.shutdown();
    await controller.waitForSettlements();
    assert.deepEqual(JSON.parse(await readFile(proof,'utf8')),configuration);
    const attempt=store.attempts(caseId).find(attempt=>attempt.status==='failed')!;assert.ok(attempt.pid);assert.throws(()=>process.kill(attempt.pid!,0));
    const invocation=store.evidence(caseId).find(raw=>(raw as {receipt_key:string;attempt_id:string}).receipt_key==='invocation-runtime'
      &&(raw as {attempt_id:string}).attempt_id===attempt.attemptId) as {payload_json:string};
    assert.equal(JSON.parse(invocation.payload_json).source,'durable-cache');
    assert.equal(store.getCase(caseId)!.status,'queued','cache consumer failure is not repair success');
    assert.equal(store.control().owner_id,null);
    assert.equal(sleepReleased,1);
    for(const attempt of store.attempts(caseId)){assert.ok(!['launching','running'].includes(attempt.status));if(attempt.pid)assert.throws(()=>process.kill(attempt.pid!,0));}
    assert.equal(await readFile(appDb,'utf8'),'corrupt-app-sentinel');assert.equal(await readFile(bizDb,'utf8'),'corrupt-business-sentinel');
  }finally{await host.shutdown();store.close();}
});
