import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp,mkdir,readdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';
import Database from 'better-sqlite3';
import {existsSync,readdirSync} from 'node:fs';
import {appDatabaseConnection,databaseConnection} from './database';
import {createRuntimeDatabaseCompatibility} from './runtime-database-compatibility';
import type {RuntimeUpdateRecord} from '../domain/runtime-update';
import {RuntimeCompatibilityResample} from '../domain/runtime-update';
import {captureHarnessSource,encodeHarnessSource} from '../../scripts/harness-source.mjs';
import {writeHarnessArtifact} from '../../scripts/harness-artifact.mjs';

async function stamp(root:string) {
  const source=await captureHarnessSource(root);await writeFile(join(root,'harness-source.json.gz'),encodeHarnessSource(source,{buildId:'controlled-reader-build'}));
  await unlink(join(root,'harness-artifact.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});return writeHarnessArtifact(root);
}

async function fixture() {
  const root=join(process.env.LOOP_DATA_ROOT!,`compat-${randomUUID()}`);await mkdir(root,{recursive:true});const before=join(root,'before'),candidate=join(root,'candidate'),dataRoot=join(root,'live');
  await mkdir(before);await mkdir(join(before,'desktop-runners'));await mkdir(join(before,'node_modules'));
  for(const directory of ['app','src','scripts','desktop','command-chains','.next'])await mkdir(join(before,directory));
  for(const name of ['package.json','package-lock.json','tsconfig.json','next.config.ts'])await writeFile(join(before,name),name==='package.json'?JSON.stringify({version:'controlled-before'}):'{}');
  await writeFile(join(before,'.next','BUILD_ID'),'controlled-reader-build');
  for(const folder of ['migrations','app-migrations'])await cp(join(process.cwd(),folder),join(before,folder),{recursive:true});
  for(const packageName of ['better-sqlite3','bindings','file-uri-to-path'])await cp(join(process.cwd(),'node_modules',packageName),join(before,'node_modules',packageName),{recursive:true});
  await build({entryPoints:[join(process.cwd(),'scripts/loop/database-reader-entry.ts')],outfile:join(before,'desktop-runners','database-reader.cjs'),bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
  const beforeArtifact=await stamp(before);await cp(before,candidate,{recursive:true});await writeFile(join(candidate,'package.json'),JSON.stringify({version:'controlled-candidate'}));const candidateArtifact=await stamp(candidate);await mkdir(dataRoot);
  await appDatabaseConnection().backup(join(dataRoot,'loopwork.db'));await(await databaseConnection()).backup(join(dataRoot,'loop-ui.db'));
  const live=new Database(join(dataRoot,'loop-ui.db'));live.pragma('journal_mode = WAL');
  live.exec("CREATE TABLE user_notes(k TEXT, v BLOB);INSERT INTO user_notes VALUES('original',X'010203')");
  const update:RuntimeUpdateRecord={request:{updateId:randomUUID(),caseId:'original-case',before:beforeArtifact,candidate:candidateArtifact},phase:'candidate-starting',
    selected:beforeArtifact,intentRevision:1,ownerId:'controller',token:1,expiresAt:Date.now()+30000,failure:null,createdAt:Date.now(),updatedAt:Date.now()};
  const compatibility=createRuntimeDatabaseCompatibility({dataRoot,executable:process.execPath});
  return {root,before,candidate,dataRoot,update,live,compatibility};
}

test('actual independent production readers verify a WAL snapshot, candidate and known-good roundtrip without migrating live data',{skip:process.platform==='win32'},async()=>{
  const h=await fixture();try {
    const version=h.live.pragma('data_version',{simple:true});
    await h.compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined);
    assert.equal(h.live.pragma('data_version',{simple:true}),version);assert.deepEqual(h.live.prepare('SELECT * FROM user_notes').get(),{k:'original',v:Buffer.from([1,2,3])});
    const directory=join(h.dataRoot,'runtime-updates','compatibility');const probes=(await readdir(directory)).filter(name=>name.startsWith('probe-'));assert.equal(probes.length,1);
    const receipt=JSON.parse(await readFile(join(directory,probes[0],'receipt.json'),'utf8'));assert.equal(receipt.passed,true);assert.equal(receipt.before.business.tables.find((table:{name:string})=>table.name==='user_notes').rows,1);
    assert.deepEqual(await readdir(join(directory,'pending-readers')),[]);assert.equal(await h.compatibility.stopOwned(),true);
  }finally{h.live.close();}
});

test('historical rollback executes its actual production reader rather than damaged original bytes, retaining live data and original identity',{skip:process.platform==='win32'},async()=>{
  const h=await fixture();try {
    const historicalRoot=join(h.root,'historical');await cp(h.before,historicalRoot,{recursive:true});
    await writeFile(join(historicalRoot,'package.json'),JSON.stringify({version:'historical-reader'}));
    const historical=await stamp(historicalRoot);
    await writeFile(join(h.before,'desktop-runners','database-reader.cjs'),'throw new Error("original reader physically damaged");');
    const original=h.update.request.before;h.update.rollback={artifact:historical,sourceUpdateId:'retained-actual-startup'};
    const version=h.live.pragma('data_version',{simple:true});
    await h.compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined);
    assert.deepEqual(h.update.request.before,original);assert.equal(h.live.pragma('data_version',{simple:true}),version);
    assert.deepEqual(h.live.prepare('SELECT * FROM user_notes').get(),{k:'original',v:Buffer.from([1,2,3])});
    const directory=join(h.dataRoot,'runtime-updates','compatibility');const probes=(await readdir(directory)).filter(name=>name.startsWith('probe-'));
    const receipt=JSON.parse(await readFile(join(directory,probes[0],'receipt.json'),'utf8'));
    assert.equal(receipt.passed,true);assert.deepEqual(receipt.originalInstallation,original);
    assert.deepEqual(receipt.rollbackArtifact,historical);assert.equal(receipt.rollbackSourceUpdateId,h.update.rollback.sourceUpdateId);
    assert.deepEqual(await readdir(join(directory,'pending-readers')),[]);assert.equal(await h.compatibility.stopOwned(),true);
    const name=(await readdir(join(h.before,'migrations'))).filter(name=>name.endsWith('.sql')).sort()[0];
    await writeFile(join(h.before,'migrations',name),(await readFile(join(h.before,'migrations',name),'utf8'))+'\n-- original executed SQL differs\n');
    await assert.rejects(h.compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined),/候选改变已执行迁移/);
    assert.equal(h.live.prepare('SELECT k FROM user_notes').pluck().get(),'original');assert.equal(await h.compatibility.stopOwned(),true);
  }finally{h.live.close();}
});

test('live writes after online backup invalidate compatibility instead of approving a stale database snapshot',{skip:process.platform==='win32'},async()=>{
  const h=await fixture();let wrote=false;try {
    const directory=join(h.dataRoot,'runtime-updates','compatibility');
    const check=()=>{
      if(wrote||!existsSync(directory))return;
      const probe=readdirSync(directory).find(name=>name.startsWith('probe-'));
      if(probe&&existsSync(join(directory,probe,'original-projection.json'))){h.live.exec("INSERT INTO user_notes VALUES('late-write',X'0405')");wrote=true;}
    };
    await assert.rejects(h.compatibility(h.update.request.candidate,h.update,new AbortController().signal,check),error=>
      error instanceof RuntimeCompatibilityResample && /真实数据改变/.test(error.message));
    assert.equal(wrote,true);assert.equal(h.live.prepare('SELECT count(*) FROM user_notes').pluck().get(),2);assert.equal(await h.compatibility.stopOwned(),true);
    await h.compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined);
    assert.equal(h.live.prepare('SELECT count(*) FROM user_notes').pluck().get(),2,'fresh snapshot never restores old live data');
  }finally{h.live.close();}
});

test('same-name executed migration edits and future reader incompatibility reject candidates while retaining live originals',{skip:process.platform==='win32'},async()=>{
  for(const mode of ['rewrite','future','data-change']) {
    const h=await fixture();try {
      if(mode==='rewrite') {
        const name=(await readdir(join(h.candidate,'migrations'))).filter(name=>name.endsWith('.sql')).sort()[0];await writeFile(join(h.candidate,'migrations',name),(await readFile(join(h.candidate,'migrations',name),'utf8'))+'\n-- changed executed SQL\n');
      }else await writeFile(join(h.candidate,'migrations','999_controlled_candidate.sql'),mode==='future'?'CREATE TABLE candidate_extra(n INTEGER);':"UPDATE user_notes SET k='changed';");
      h.update.request.candidate=await stamp(h.candidate);
      await assert.rejects(h.compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined),/已执行迁移|不支持的已应用迁移|原有数据/);
      assert.equal(h.live.prepare('SELECT k FROM user_notes').pluck().get(),'original');assert.equal(h.live.prepare("SELECT 1 FROM schema_migrations WHERE name='999_controlled_candidate.sql'").get(),undefined);
      assert.equal(await h.compatibility.stopOwned(),true);
    }finally {h.live.close();}
  }
});

test('timed-out actual reader is killed and journaled before retry; concurrent callers cannot cancel another active probe',{skip:process.platform==='win32'},async()=>{
  const h=await fixture();try {
    await writeFile(join(h.candidate,'desktop-runners','database-reader.cjs'),"setInterval(()=>console.log('not meaningful progress'),25);");h.update.request.candidate=await stamp(h.candidate);
    const compatibility=createRuntimeDatabaseCompatibility({dataRoot:h.dataRoot,executable:process.execPath,timeoutMs:1500});
    const running=compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined);void running.catch(()=>undefined);
    await assert.rejects(compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined),/并发/);
    await assert.rejects(running,/超时/);assert.equal(await compatibility.stopOwned(),true);
    const directory=join(h.dataRoot,'runtime-updates','compatibility');assert.deepEqual(await readdir(join(directory,'pending-readers')),[]);
    const probe=(await readdir(directory)).find(name=>name.startsWith('probe-'))!;
    for(const file of (await readdir(join(directory,probe))).filter(name=>name.endsWith('.exited'))) {
      const record=JSON.parse(await readFile(join(directory,probe,file),'utf8'));assert.throws(()=>process.kill(record.pid,0));
    }
    assert.equal(h.live.prepare('SELECT k FROM user_notes').pluck().get(),'original');
  }finally{h.live.close();}
});

test('unknown PID reservation is a durable exit barrier, not permission to create another compatibility reader',{skip:process.platform==='win32'},async()=>{
  const h=await fixture();try {
    const pending=join(h.dataRoot,'runtime-updates','compatibility','pending-readers');await mkdir(pending,{recursive:true});
    await writeFile(join(pending,'unknown.json'),JSON.stringify({updateId:h.update.request.updateId,ownerId:'controller',token:1,pid:null,marker:null,groupId:null}));
    await assert.rejects(h.compatibility(h.update.request.candidate,h.update,new AbortController().signal,()=>undefined),/退出未确认/);
    assert.equal(await h.compatibility.stopOwned(),false);assert.equal((await readdir(pending)).length,1);
  }finally {h.live.close();}
});
