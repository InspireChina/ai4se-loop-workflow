import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import test from 'node:test';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

test('compiled production host still invokes cached independent Admin when both application and business databases are corrupt', async () => {
  const result = await build({
    entryPoints: { host: 'src/infrastructure/runtime-supervision.ts', store: 'src/infrastructure/admin-management-store.ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['better-sqlite3'],
    write: false, outdir: join(tmpdir(), 'loopwork-corrupt-host-boundary'), logLevel: 'silent',
  });
  const root = join(process.env.LOOP_DATA_ROOT!, 'corrupt-production-host');
  mkdirSync(root, { recursive: true });
  for (const file of ['loop-ui.db', 'loopwork.db']) writeFileSync(join(root, file), 'not a SQLite database');
  const outputs = Object.fromEntries(result.outputFiles!.map(file => [basename(file.path, '.js'), file.text]));
  const program = `
    const {Module}=require('node:module'); const {join}=require('node:path'); const {readFileSync}=require('node:fs');
    const outputs=JSON.parse(readFileSync(0,'utf8'));
    function load(name) { const m=new Module(join(process.cwd(),name+'.cjs'),module); m.filename=join(process.cwd(),name+'.cjs');m.paths=module.paths;
      m._compile(outputs[name],m.filename);return m.exports; }
    const {AdminManagementStore}=load('store'); const {createManagedLoopRunLifecycle}=load('host');
    const store=new AdminManagementStore(join(process.env.LOOP_DATA_ROOT,'management.db'));
    const ownerId='compiled-independent-host'; store.setIntent('running','start'); const authority=store.acquireSupervisor(ownerId);
    store.cacheRuntimeConfiguration(authority,{configurationId:'cached-system',sourceVersion:'v1',executorId:'claude',executionOptions:{model:'cached-model'}},0);
    const repair=store.observe({observationId:'original-fault',scope:'runtime',scopeKey:'runtime',fingerprint:'original',sourceVersion:'v1',origin:'runtime',summary:'Original fault',evidence:{}});
    let calls=0;
    const host=createManagedLoopRunLifecycle({ownerId,adapter:'cli',management:{store,resolveExecutor:()=>({id:'claude',label:'Actual independent fixture',command:process.execPath,
      promptMode:'argument',buildArgs:(_prompt,_root,options)=>{if(options.model!=='cached-model')throw Error('cached model changed');calls++;
        return ['-e','console.log("cached independent admin started");setTimeout(()=>process.exit(1),400)'];},
      formatCommand:()=> 'node fixture',parseStdout:line=>line,parseStderr:line=>line})}});
    (async()=>{try {
      await host.start();const deadline=Date.now()+10000;
      while(!store.attempts(repair.caseId).some(a=>a.status==='failed')) {if(Date.now()>deadline)throw Error('Independent admin did not finish');await new Promise(r=>setTimeout(r,10));}
      const attempt=store.attempts(repair.caseId)[0];let alive=true;try {process.kill(attempt.pid,0);}catch {alive=false;}
      await host.shutdown();
      console.log(JSON.stringify({calls,alive,status:attempt.status,config:store.runtimeConfiguration().configuration,
        application:readFileSync(join(process.env.LOOP_DATA_ROOT,'loopwork.db'),'utf8'),business:readFileSync(join(process.env.LOOP_DATA_ROOT,'loop-ui.db'),'utf8'),
        original:store.getCase(repair.caseId).originalSummary}));
    }catch(error){console.error(error.stack);process.exitCode=1;}finally{await host.shutdown();store.close();}})();
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', LOOP_APP_ROOT: process.cwd(), LOOP_DATA_ROOT: root,
    LOOP_GLOBAL_DB_PATH: join(root, 'loop-ui.db'), LOOP_WORKSPACE_ROOT_OVERRIDE: join(root, 'workspace') };
  for (const key of Object.keys(env)) if (key.startsWith('LOOP_TEST') || key === 'NODE_TEST_CONTEXT') delete env[key];
  const child = spawnSync(process.execPath, ['-e', program], { cwd: process.cwd(), env,
    input: JSON.stringify(outputs), encoding: 'utf8', timeout: 20000, maxBuffer: 1000000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.calls, 1);
  assert.equal(actual.alive, false);
  assert.equal(actual.status, 'failed');
  assert.equal(actual.config.executionOptions.model, 'cached-model');
  assert.equal(actual.application, 'not a SQLite database');
  assert.equal(actual.business, 'not a SQLite database');
  assert.equal(actual.original, 'Original fault');
});

test('shared supervision protocol and configured Admin invocation compile without loading business or Web storage', async () => {
  const result = await build({
    entryPoints: {
      'supervision-protocol': 'src/application/runtime-supervision-host.ts',
      'configured-admin': 'src/application/admin-configured-execution.ts',
    },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    write: false, metafile: true, outdir: join(tmpdir(), 'loopwork-management-host-boundary'), logLevel: 'silent',
  });
  const forbidden = Object.keys(result.metafile!.inputs).filter(path =>
    /(?:infrastructure\/(?:database|app-database)|application\/(?:tasks|project-settings|interventions)|node_modules\/(?:next|electron)|src\/test)\//.test(path)
    || /(?:infrastructure\/(?:database|app-database)|application\/(?:tasks|project-settings|interventions))\.ts$/.test(path));
  assert.deepEqual(forbidden, [], 'management bootstrap and invocation use injected business adapters only');
  for (const file of result.outputFiles!) {
    const child = spawnSync(process.execPath, ['-e',
      "eval(require('node:fs').readFileSync(0,'utf8'));console.log(Object.keys(module.exports).join(','));"],
    { input: file.text, encoding: 'utf8', timeout: 5000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /create(?:RuntimeSupervisionHost|ConfiguredAdminExecution)/);
  }
});

test('external root and its configured Admin launch adapters compile and load without business storage', async () => {
  const result = await build({
    entryPoints: ['src/infrastructure/native-external-runtime.ts'],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['better-sqlite3'], write: false, metafile: true, logLevel: 'silent',
  });
  const forbidden = Object.keys(result.metafile!.inputs).filter(path =>
    /(?:infrastructure\/(?:database|app-database|runtime-supervision)|application\/(?:tasks|project-settings|interventions))\.ts$/.test(path)
    || /(?:^|\/)(?:src\/test|node_modules\/(?:next|electron))\//.test(path));
  assert.deepEqual(forbidden, [], 'root composition and launch adapters remain independent of business initialization');
  const child = spawnSync(process.execPath, ['-e',
    "eval(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify(Object.keys(module.exports)));"],
    { input: result.outputFiles![0].text, encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const exports = JSON.parse(child.stdout);
  for (const name of ['createNativeExternalRuntime', 'AdminManagementStore', 'createConfiguredAdminExecution',
    'createAdminExecutionLauncher', 'confirmAdminAttemptStopped', 'createLangfuseTelemetry',
    'createNativeAdminManagement', 'createNativeAdminBusinessWorker', 'createNativeExternalService']) {
    assert.ok(exports.includes(name), `independent external root is missing ${name}`);
  }
});

test('bundled runtime entrypoints cannot include historical test schedulers or legacy creation fixtures', async () => {
  const result = await build({
    entryPoints: {
      'agent-runner': 'scripts/loop/agent-runner.ts',
      'lifecycle-host': 'src/infrastructure/runtime-supervision.ts',
      'loop-agent': 'scripts/loop/loop-agent-entry.ts',
      'loop-admin': 'scripts/loop/loop-admin-entry.ts',
      'admin-business-worker': 'scripts/loop/admin-business-worker-entry.ts',
      'external-host': 'scripts/loop/external-host-entry.ts',
      'verification-worker': 'scripts/loop/verification-worker-entry.ts',
      'workspace-version': 'scripts/loop/workspace-version-entry.ts',
      'host-service': 'scripts/loop/host-service-entry.ts',
      'host-configure': 'scripts/host-service.ts',
      loopctl: 'scripts/loop/loopctl.ts',
    },
    // Match the installed runtime: ordinary packages must also be bundled,
    // rather than hiding their transitive imports behind packages: external.
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['better-sqlite3', 'next/cache'],
    outExtension: { '.js': '.cjs' },
    write: false, metafile: true, outdir: join(tmpdir(), 'loopwork-runtime-boundary-check'), logLevel: 'silent',
  });
  const fixtures = Object.keys(result.metafile!.inputs).filter(path => /(?:^|\/)src\/test\//.test(path));
  assert.deepEqual(fixtures, [], 'production artifacts must not contain the fixture injection path');
  const webInputs = Object.keys(result.metafile!.inputs).filter(path => /(?:^|\/)node_modules\/(?:next|electron)\//.test(path));
  assert.deepEqual(webInputs, [], 'Lifecycle and execution entrypoints cannot transitively load Web/Electron implementations');
  for (const output of Object.values(result.metafile!.outputs)) {
    assert.equal(output.imports.some(item => /^(?:next|electron)(?:\/|$)/.test(item.path)), false,
      'Web dependencies cannot be hidden behind external imports');
  }
  for (const path of ['src/application/work-items.ts', 'src/application/interventions.ts',
    'src/application/workflow-upgrade.ts', 'src/application/work-item-transitions.ts']) {
    assert.ok(result.metafile!.inputs[path], `packaged runtime must include ${path}`);
  }
  assert.equal(Object.keys(result.metafile!.outputs).filter(path => path.endsWith('.cjs')).length, 11);
  const externalOutput=Object.values(result.metafile!.outputs).find(output=>output.entryPoint==='scripts/loop/external-host-entry.ts')!;
  assert.equal(Object.keys(externalOutput.inputs).some(path=>/(?:application\/(?:tasks|project-settings|interventions)|infrastructure\/database)\.ts$/.test(path)),false,
    'OS root artifact must not preload business initialization');
  const adminOutput = Object.values(result.metafile!.outputs).find(output => output.entryPoint === 'scripts/loop/loop-admin-entry.ts');
  assert.ok(adminOutput);
  assert.equal(Object.keys(adminOutput.inputs).some(path => /(?:application\/tasks|infrastructure\/database|application\/interventions)\.ts$/.test(path)), false,
    'the Admin command entry must not load business storage or workflows');
  const dataRoot = join(process.env.LOOP_DATA_ROOT!, 'bundled-runtime');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', LOOP_APP_ROOT: process.cwd(), LOOP_DATA_ROOT: dataRoot,
    LOOP_GLOBAL_DB_PATH: join(dataRoot, 'loop-ui.db'), LOOP_WORKSPACE_ROOT_OVERRIDE: join(dataRoot, 'workspace') };
  // Run the actual compiled production code, not fixture-aware TS imports.
  // Each child uses an empty, isolated production database beneath test data.
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOOP_TEST') || key === 'NODE_TEST_CONTEXT'
      || /^LOOP_(EXECUTION|INTERNAL|VERIFICATION_ASSISTANCE|INTERVENTION)_/.test(key)) delete env[key];
  }
  const runBundle = (name: string, args: string[], inspectExports = false) => {
    const file = result.outputFiles!.find(file => basename(file.path) === `${name}.cjs`);
    assert.ok(file, `missing executable ${name}`);
    return spawnSync(process.execPath, ['-e',
      `process.argv = ${JSON.stringify([process.execPath, `${name}.cjs`, ...args])}; eval(require('node:fs').readFileSync(0, 'utf8'));`
      + (inspectExports ? '; console.log(JSON.stringify({ lifecycle: typeof module.exports.createManagedLoopRunLifecycle }));'
        + ';setTimeout(() => process.stderr.write(JSON.stringify({ diagnostic: "entry-did-not-exit",resources: process.getActiveResourcesInfo() })),1000).unref();' : ''),
    ], { cwd: process.cwd(), env, input: file.text, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000 });
  };
  const list = runBundle('loopctl', ['task-list']);
  assert.ifError(list.error);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trim(), '', 'an empty production database has no task rows to print');
  const configRoot=join(dataRoot,'external-host-config');
  const configured=runBundle('host-configure',['--platform','darwin','--executable',process.execPath,
    '--app-root',process.cwd(),'--data-root',dataRoot,'--output-dir',configRoot]);
  assert.ifError(configured.error);assert.equal(configured.status,0,configured.stderr);
  const generated=JSON.parse(configured.stdout);assert.equal(generated.registered,false);
  const {readFileSync}=await import('node:fs');
  const plist=readFileSync(join(configRoot,generated.files[0]),'utf8');
  assert.ok(plist.includes(`${process.cwd()}/desktop-runners/external-host.cjs`),
    'default standalone hosting must target the independent root, not the business host');
  const duplicate=runBundle('host-configure',['--platform','darwin','--executable',process.execPath,
    '--app-root',process.cwd(),'--data-root',dataRoot,'--output-dir',configRoot]);
  assert.equal(duplicate.status,1);assert.equal(readFileSync(join(configRoot,generated.files[0]),'utf8'),plist);
  const database = new Database(join(dataRoot, 'loop-ui.db'), { readonly: true, fileMustExist: true });
  try {
    for (const table of ['workflow_items', 'workflow_dependencies', 'workflow_item_events', 'interventions', 'intervention_attempts']) {
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0,
        `compiled CLI must initialize the unified ${table} schema without fixture data`);
    }
  } finally { database.close(); }
  const lifecycle = runBundle('lifecycle-host', [], true);
  if (lifecycle.error) throw new Error(`Lifecycle entry did not settle; stdout=${lifecycle.stdout}; stderr=${lifecycle.stderr}`, { cause: lifecycle.error });
  assert.ifError(lifecycle.error);
  assert.equal(lifecycle.status, 0, lifecycle.stderr);
  assert.deepEqual(JSON.parse(lifecycle.stdout), { lifecycle: 'function' });
  const command = runBundle('loop-agent', ['status']);
  assert.ifError(command.error);
  assert.equal(command.status, 1);
  assert.match(command.stderr, /命令只能在活动 Agent execution 内使用/);
  const admin = runBundle('loop-admin', ['status']);
  assert.ifError(admin.error);
  assert.equal(admin.status, 1);
  assert.match(admin.stderr, /有效的 Admin 执行上下文/);
  const runner = runBundle('agent-runner', []);
  assert.ifError(runner.error);
  assert.equal(runner.status, 1);
  assert.match(runner.stderr, /missing run id/);
});
