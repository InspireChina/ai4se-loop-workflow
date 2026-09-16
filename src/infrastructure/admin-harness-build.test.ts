import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runHarnessBuildStage} from './admin-harness-build';
import {harnessBuildEnvironment,harnessTestEnvironment} from '../../scripts/harness-build-environment.mjs';

async function fixture(){const root=join(process.env.LOOP_DATA_ROOT!,randomUUID()),workspaceRoot=join(root,'source');await mkdir(workspaceRoot,{recursive:true});
  return {workspaceRoot,logFile:join(root,'build.log'),env:harnessBuildEnvironment(root,workspaceRoot,{...process.env,LOOP_ADMIN_TOKEN:'must-not-inherit'})};}

test('actual build stage isolates live credentials and preserves stderr when a subprocess fails',async()=>{
  const h=await fixture();
  await assert.rejects(runHarnessBuildStage({...h,node:process.execPath,stage:'controlled-failure',assertCurrent:()=>{},
    args:['--eval',`if(process.env.LOOP_ADMIN_TOKEN)throw new Error('live credential inherited');console.error('specific compiler failure');process.exitCode=1;`]}),/specific compiler failure/);
  const log=await readFile(h.logFile,'utf8');assert.match(log,/controlled-failure/);assert.match(log,/specific compiler failure/);assert.ok(!log.includes('must-not-inherit'));
});

test('candidate tests do not inherit the compiler database, workspace or management identity',()=>{
  const env=harnessTestEnvironment({LOOP_GLOBAL_DB_PATH:'/compiler/shared.db',LOOP_LEGACY_DB_PATH:'/foreign/legacy.db',
    LOOP_WORKSPACE_ROOT:'/compiler/workspace',LOOP_TEST_SETUP_PID:'1',LOOP_ADMIN_TOKEN:'private',NODE_ENV:'production',PATH:process.env.PATH});
  assert.equal(env.NODE_ENV,'test');assert.equal(env.PATH,process.env.PATH);assert.ok(!Object.keys(env).some(key=>key.startsWith('LOOP_')));
});

test('actual preloaded parallel test processes clear explicit compiler database overrides before business imports',async()=>{
  const h=await fixture(),run=promisify(execFile),root=process.cwd();
  const code=`console.log(JSON.stringify({data:process.env.LOOP_DATA_ROOT,global:process.env.LOOP_GLOBAL_DB_PATH,legacy:process.env.LOOP_LEGACY_DB_PATH,workspace:process.env.LOOP_WORKSPACE_ROOT}));`;
  const outputs=await Promise.all([1,2].map(()=>run(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),
    '--import',join(root,'src/test/setup.ts'),'--eval',code],{cwd:root,env:h.env})));
  const values=outputs.map(output=>JSON.parse(output.stdout));assert.notEqual(values[0].data,values[1].data);
  for(const value of values){assert.equal(value.global,undefined);assert.equal(value.legacy,undefined);assert.equal(value.workspace,undefined);}
});

test('loss of source authorization terminates an actual long build subprocess and cannot report a successful stage',async()=>{
  const h=await fixture(),pidFile=join(h.workspaceRoot,'pid');
  await assert.rejects(runHarnessBuildStage({...h,node:process.execPath,stage:'controlled-long-build',
    args:['--eval',`require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`,pidFile],
    assertCurrent:()=>{if(existsSync(pidFile))throw new Error('source authority lost');}}),/source authority lost/);
  const pid=Number(await readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),/ESRCH/);
});
