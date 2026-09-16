import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { AdminManagementStore } from './admin-management-store';
import { renderRuntimeHostService } from '../domain/runtime-host-service';
import { confirmAdminAttemptStopped } from './admin-execution';
import { inspectProcessIdentity } from './process-tree';

let compiled: Promise<string> | undefined;
function entrySource() {
  return compiled ||= build({ entryPoints: ['scripts/loop/host-service-entry.ts'], bundle: true, platform: 'node', format: 'cjs',
    external: ['better-sqlite3', 'next/cache'], write: false, logLevel: 'silent' }).then(result => result.outputFiles![0]!.text);
}
async function fixture() {
  const root = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  const dataRoot = join(root, 'private-data'); await mkdir(dataRoot, { recursive: true });
  const entry = join(root, 'host.cjs'); await writeFile(entry, await entrySource());
  const store = new AdminManagementStore(join(dataRoot, 'admin-management.db'));
  store.setIntent('stopped', 'saved-user-stop'); store.close();
  const protectedDb = join(root, 'do-not-touch.db'); await writeFile(protectedDb, 'protected foreign database');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules'),
    LOOP_GLOBAL_DB_PATH: protectedDb, LOOP_APP_ROOT: '/invalid-inherited-root', LOOP_DATA_ROOT: '/invalid-inherited-data' };
  for (const key of Object.keys(env)) if (key.startsWith('LOOP_TEST') || key === 'NODE_TEST_CONTEXT' || key === 'LOOP_WORKSPACE_ROOT_OVERRIDE') delete env[key];
  return { root, dataRoot, entry, env, protectedDb };
}
async function records(dataRoot: string) {
  try { return (await readFile(join(dataRoot, 'host-service.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; pid: number; businessSuccess?: string }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function eventually<T>(read: () => Promise<T | null>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result !== null) return result; await delay(25); }
  throw new Error('Hosted process state did not converge');
}
function childHost(h: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, [h.entry, '--app-root', process.cwd(), '--data-root', h.dataRoot], { env: h.env, stdio: ['ignore','pipe','pipe','ipc'] });
  let diagnostic = ''; child.stdout?.on('data', () => undefined); child.stderr?.on('data', chunk => { diagnostic += chunk.toString(); });
  const closed = new Promise<void>((resolve, reject) => { child.once('close', code => { if (code && code !== 0) reject(new Error(`Host exited ${code}: ${diagnostic}`)); else resolve(); }); });
  // Fatal-crash assertions observe signal exit through this same promise.
  return { child, closed, diagnostic: () => diagnostic };
}
async function stop(child: ChildProcess, closed: Promise<void>) {
  if (child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ kind: 'shutdown-host' }); else child.kill('SIGTERM');
  }
  await closed;
}

test('actual standalone entry preserves saved user stop, binds explicit private databases before imports and exits gracefully', async () => {
  const h = await fixture(); const host = childHost(h);
  try {
    const initialized = await eventually(async () => (await records(h.dataRoot)).find(record => record.kind === 'host-initialized') || null);
    assert.equal(initialized.pid, host.child.pid); assert.equal(initialized.businessSuccess, 'not-asserted');
    const store = new AdminManagementStore(join(h.dataRoot, 'admin-management.db'));
    try { assert.equal(store.control().desired_intent, 'stopped'); assert.equal(store.attempts().length, 0); } finally { store.close(); }
    assert.equal(await readFile(h.protectedDb, 'utf8'), 'protected foreign database');
    assert.ok((await readFile(join(h.dataRoot, 'loop-ui.db'))).length > 0);
    await stop(host.child, host.closed);
    assert.ok((await records(h.dataRoot)).some(record => record.kind === 'host-stopped'));
    assert.throws(() => process.kill(host.child.pid!, 0));
  } finally { await stop(host.child, host.closed); }
});

test('actual standalone restart cannot turn the persisted management stop into a new repair attempt', async () => {
  const h = await fixture();
  for (let index = 0; index < 2; index++) {
    const host = childHost(h);
    try {
      await eventually(async () => (await records(h.dataRoot)).find(record => record.kind === 'host-initialized' && record.pid === host.child.pid) || null);
      const store = new AdminManagementStore(join(h.dataRoot, 'admin-management.db'));
      try { assert.equal(store.control().desired_intent, 'stopped'); assert.deepEqual(store.attempts(), []); } finally { store.close(); }
    } finally { await stop(host.child, host.closed); }
  }
  assert.equal((await records(h.dataRoot)).filter(record => record.kind === 'host-initialized').length, 2);
});

test('standalone entry rejects unknown or duplicate arguments before database bootstrap and reports missing runtime version', async () => {
  const h = await fixture();
  for (const args of [['--unknown','x'], ['--app-root','/a','--app-root','/b'], ['--data-root','relative']]) {
    const result = spawnSync(process.execPath, [h.entry, ...args], { env: h.env, encoding: 'utf8', timeout: 5_000 });
    assert.ifError(result.error); assert.equal(result.status, 1); assert.match(result.stderr, /参数|绝对路径/);
  }
  const missing = join(h.root, 'missing-runtime'); await mkdir(missing);
  const result = spawnSync(process.execPath, [h.entry,'--app-root',missing,'--data-root',h.dataRoot], { env: h.env, encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error); assert.equal(result.status, 1);
  assert.ok((await records(h.dataRoot)).some(record => record.kind === 'host-fatal'));
});

test('actual configuration CLI generates private artifacts only, never registers or overwrites an existing definition', async () => {
  const h = await fixture(); const output = join(h.root,'service-definition');
  const args = ['--import','tsx','scripts/host-service.ts','--platform',process.platform,'--executable',process.execPath,
    '--app-root',process.cwd(),'--data-root',h.dataRoot,'--entry',h.entry,'--output-dir',output];
  const generated = spawnSync(process.execPath,args,{encoding:'utf8',timeout:5_000});
  assert.ifError(generated.error);assert.equal(generated.status,0,generated.stderr);
  const result = JSON.parse(generated.stdout) as {label:string;files:string[];registered:boolean};
  assert.equal(result.registered,false);assert.ok(result.files.length>0);
  const path = join(output,result.files[0]!);const original = await readFile(path,'utf8');
  const duplicate = spawnSync(process.execPath,args,{encoding:'utf8',timeout:5_000});
  assert.equal(duplicate.status,1);assert.match(duplicate.stderr,/EEXIST/);
  assert.equal(await readFile(path,'utf8'),original);
  if(process.platform==='darwin')assert.notEqual(spawnSync('/bin/launchctl',['print',`gui/${process.getuid!()}/${result.label}`],{timeout:5_000}).status,0);
});

test('actual configuration CLI can preview Windows without confusing local output and target installed configuration roots', async () => {
  const h = await fixture();const output = join(h.root,'windows-preview');
  const result = spawnSync(process.execPath,['--import','tsx','scripts/host-service.ts','--platform','win32','--executable','C:\\LoopWork\\node.exe',
    '--app-root','C:\\LoopWork','--data-root','C:\\LoopWorkData','--entry','C:\\LoopWork\\host.cjs',
    '--output-dir',output,'--config-root','C:\\LoopWorkData\\host-service'],{encoding:'utf8',timeout:5_000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  const data = JSON.parse(result.stdout) as {files:string[];configurationRoot:string;registered:boolean};
  assert.equal(data.configurationRoot,'C:\\LoopWorkData\\host-service');assert.equal(data.registered,false);
  assert.equal(data.files.length,2);
  assert.match(await readFile(join(output,data.files.find(file=>file.endsWith('.register.ps1'))!),'utf8'),/-EncodedCommand/);
});

test('actual wrapped standalone host exits after its owning wrapper is killed, preserving stopped intent and no repair attempts', async () => {
  const h=await fixture();
  const program=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,${JSON.stringify([h.entry,'--app-root',process.cwd(),'--data-root',h.dataRoot])}.concat(['--watch-parent',String(process.pid)]),{stdio:'ignore'});console.log(JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);`;
  const parent=spawn(process.execPath,['-e',program],{env:h.env,stdio:['ignore','pipe','pipe']});
  const parentClosed=new Promise<void>(resolve=>parent.once('close',()=>resolve()));
  let childPid:number|undefined;let marker:string|undefined;
  try{
    childPid=await new Promise<number>((resolve,reject)=>{
      let text='';const timeout=setTimeout(()=>reject(new Error('Wrapper did not report child PID')),5_000);
      parent.stdout.on('data',chunk=>{text+=chunk.toString();if(text.includes('\n')){clearTimeout(timeout);resolve(JSON.parse(text.split('\n')[0]!).pid);}});
      parent.once('close',()=>{clearTimeout(timeout);reject(new Error('Wrapper exited before startup'));});
    });
    await eventually(async()=>(await records(h.dataRoot)).find(record=>record.kind==='host-initialized'&&record.pid===childPid)||null);
    marker=(await inspectProcessIdentity(childPid))?.startMarker;assert.ok(marker);
    parent.kill('SIGKILL');await parentClosed;
    await eventually(async()=>{try{process.kill(childPid!,0);return null;}catch{return true;}},10_000);
    assert.ok((await records(h.dataRoot)).some(record=>record.kind==='host-fatal'&&record.pid===childPid));
    const store=new AdminManagementStore(join(h.dataRoot,'admin-management.db'));
    try{assert.equal(store.control().desired_intent,'stopped');assert.deepEqual(store.attempts(),[]);}finally{store.close();}
  }finally{
    if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');await parentClosed;
    if(childPid&&marker&&(await inspectProcessIdentity(childPid))?.startMarker===marker)process.kill(childPid,'SIGKILL');
  }
});

test('actual temporary launchd job respawns a forcibly terminated standalone host without resuming user-stopped work', async () => {
  if (process.platform !== 'darwin') return;
  const h = await fixture(); const uid = process.getuid!(); const domain = `gui/${uid}`;
  execFileSync('/bin/launchctl', ['print', domain], { timeout: 5_000 });
  const label = `com.loopwork.test-host.${randomUUID()}`;
  const specification = renderRuntimeHostService({ platform: 'darwin', executable: process.execPath, appRoot: process.cwd(),
    dataRoot: h.dataRoot, outputRoot: h.root, target: { kind: 'standalone', entry: h.entry }, label, restartSeconds: 1 });
  // Test fixture resolution only; production installed files resolve native
  // modules inside their installed runtime, checked separately by packaging.
  const content = specification.files[0]!.content.replace('<key>EnvironmentVariables</key><dict>',
    `<key>EnvironmentVariables</key><dict><key>NODE_PATH</key><string>${join(process.cwd(),'node_modules')}</string>`);
  const plist = join(h.root, `${label}.plist`); await writeFile(plist, content);
  execFileSync('/usr/bin/plutil', ['-lint', plist], { timeout: 5_000 });
  let loaded = false; let firstPid: number | undefined; let secondPid: number | undefined;
  try {
    execFileSync('/bin/launchctl', ['bootstrap',domain,plist], { timeout: 5_000 }); loaded = true;
    firstPid = (await eventually(async () => (await records(h.dataRoot)).find(record => record.kind === 'host-initialized') || null)).pid;
    process.kill(firstPid, 0); process.kill(firstPid, 'SIGKILL');
    secondPid = (await eventually(async () => (await records(h.dataRoot)).find(record => record.kind === 'host-initialized' && record.pid !== firstPid) || null, 15_000)).pid;
    assert.notEqual(secondPid, firstPid); process.kill(secondPid, 0);
    const source = execFileSync('/bin/launchctl', ['print',`${domain}/${label}`], { encoding: 'utf8', timeout: 5_000 });
    assert.match(source, new RegExp(`pid = ${secondPid}`));
    const store = new AdminManagementStore(join(h.dataRoot, 'admin-management.db'));
    try { assert.equal(store.control().desired_intent, 'stopped'); assert.deepEqual(store.attempts(), []); } finally { store.close(); }
  } finally {
    if (loaded) execFileSync('/bin/launchctl', ['bootout',`${domain}/${label}`], { timeout: 10_000 });
    if (secondPid) await eventually(async () => { try { process.kill(secondPid!,0); return null; } catch { return true; } });
  }
  const absent = spawnSync('/bin/launchctl', ['print',`${domain}/${label}`], { encoding: 'utf8', timeout: 5_000 });
  assert.notEqual(absent.status, 0);
  if (firstPid) assert.throws(() => process.kill(firstPid!, 0));
});

test('actual launchd restart recovers cached independent Admin despite corrupt business databases, then stops all repair on durable user stop', async () => {
  if (process.platform !== 'darwin') return;
  const h = await fixture(); const domain = `gui/${process.getuid!()}`;
  const bin = join(h.root, 'bin'); await mkdir(bin);
  await writeFile(join(h.dataRoot,'loopwork.db'), 'corrupt application database');
  await writeFile(join(h.dataRoot,'loop-ui.db'), 'corrupt business database');
  const store = new AdminManagementStore(join(h.dataRoot,'admin-management.db'));
  store.setIntent('running','run-controlled-repair');
  const repair = store.observe({ observationId: 'original-os-fault', scope: 'runtime', scopeKey: 'controlled-runtime',
    fingerprint: 'original-runtime-unavailable', sourceVersion: 'fixture-version', origin: 'runtime', summary: 'Original runtime diagnosis', evidence: { original: true } });
  const seed = store.acquireSupervisor('fixture-seed')!;
  store.cacheRuntimeConfiguration(seed,{configurationId:'cached-os-runtime',sourceVersion:'fixture-version',executorId:'claude',executionOptions:{model:'controlled-fixture'}},0);
  store.releaseSupervisor(seed);
  // Only this Case is intentionally kept alive for host-crash/stop tests.
  // Fair scheduling may investigate the separately observed configuration
  // fault first; that controlled invocation must finish, not monopolize the
  // management slot for the production 20-minute activity window.
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'controlled-os-fixture'}));
    if(process.env.LOOP_ADMIN_CASE_ID===${JSON.stringify(repair.caseId)})setInterval(()=>{},1000);
    else setTimeout(()=>process.exit(1),400);\n`, { mode: 0o700 });
  const label = `com.loopwork.test-repair-host.${randomUUID()}`;
  const specification = renderRuntimeHostService({ platform:'darwin',executable:process.execPath,appRoot:process.cwd(),dataRoot:h.dataRoot,
    outputRoot:h.root,target:{kind:'standalone',entry:h.entry},label,restartSeconds:1,path:`${bin}:${process.env.PATH}` });
  const content = specification.files[0]!.content.replace('<key>EnvironmentVariables</key><dict>',
    `<key>EnvironmentVariables</key><dict><key>NODE_PATH</key><string>${join(process.cwd(),'node_modules')}</string>`);
  const plist = join(h.root, `${label}.plist`); await writeFile(plist,content);
  let loaded = false; let currentHostPid: number | undefined;let primaryError:unknown;
  try {
    execFileSync('/bin/launchctl',['bootstrap',domain,plist],{timeout:5_000});loaded=true;
    const first = await eventually(async()=>store.attempts(repair.caseId).find(attempt=>attempt.status==='running' && !!attempt.pid) || null);
    currentHostPid = (await eventually(async()=>(await records(h.dataRoot)).find(record=>record.kind==='host-initialized') || null)).pid;
    process.kill(currentHostPid,'SIGKILL');
    currentHostPid = (await eventually(async()=>(await records(h.dataRoot)).find(record=>record.kind==='host-initialized' && record.pid!==currentHostPid) || null,15_000)).pid;
    // No lease timestamp edits: wait for the actual persisted lease to expire
    // and for production recovery to confirm the old invocation's real exit.
    const second = await eventually(async()=>store.attempts(repair.caseId).find(attempt=>attempt.generation>first.generation && attempt.status==='running' && !!attempt.pid) || null,45_000);
    assert.notEqual(second.pid,first.pid);assert.equal(second.caseId,repair.caseId);
    const otherAttempts=store.attempts().filter(attempt=>attempt.caseId!==repair.caseId);
    assert.ok(otherAttempts.some(attempt=>attempt.status==='failed'),'other queued faults receive a turn before the original Case resumes');
    for(const attempt of otherAttempts)if(attempt.pid)assert.throws(()=>process.kill(attempt.pid!,0));
    assert.throws(()=>process.kill(first.pid!,0));process.kill(second.pid!,0);
    assert.equal(store.getCase(repair.caseId)?.originalSummary,'Original runtime diagnosis');
    assert.equal(JSON.parse((store.observations(repair.caseId)[0] as {evidence_json:string}).evidence_json).original,true);
    assert.equal(await readFile(join(h.dataRoot,'loopwork.db'),'utf8'),'corrupt application database');
    assert.equal(await readFile(join(h.dataRoot,'loop-ui.db'),'utf8'),'corrupt business database');
    store.setIntent('stopped','stop-controlled-os-test');
    await eventually(async()=>store.attempts(repair.caseId).every(attempt=>!['running','launching'].includes(attempt.status)) ? true : null,15_000);
    assert.throws(()=>process.kill(second.pid!,0));
    assert.equal(store.attempts(repair.caseId).length,2);
    assert.equal(store.control().desired_intent,'stopped');
  } catch(error){primaryError=error;throw error;} finally {
    const cleanupErrors:unknown[]=[];
    try{store.setIntent('stopped','cleanup-controlled-os-test');}catch(error){cleanupErrors.push(error);}
    try{if(loaded)execFileSync('/bin/launchctl',['bootout',`${domain}/${label}`],{timeout:10_000});}catch(error){cleanupErrors.push(error);}
    try {
      for(const attempt of store.attempts()) if(attempt.pid && ['running','launching'].includes(attempt.status)) {
        try{assert.equal(await confirmAdminAttemptStopped(attempt),true,`Unconfirmed cleanup: ${JSON.stringify(attempt)}`);}
        catch(error){cleanupErrors.push(error);}
      }
      try{if(currentHostPid)await eventually(async()=>{try{process.kill(currentHostPid!,0);return null;}catch{return true;}});}catch(error){cleanupErrors.push(error);}
    }finally{store.close();}
    if(cleanupErrors.length)throw new AggregateError([...(primaryError?[primaryError]:[]),...cleanupErrors],
      `OS repair test cleanup failed; original failure: ${String(primaryError)}; retained fixture ${h.root}; cleanup: ${cleanupErrors.map(String).join('; ')}`);
  }
});
