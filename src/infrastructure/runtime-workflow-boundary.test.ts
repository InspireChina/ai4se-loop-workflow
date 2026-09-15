import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import test from 'node:test';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

test('bundled runtime entrypoints cannot include historical test schedulers or legacy creation fixtures', async () => {
  const result = await build({
    entryPoints: {
      'agent-runner': 'scripts/loop/agent-runner.ts',
      'lifecycle-host': 'src/application/loop-run-lifecycle.ts',
      'loop-agent': 'scripts/loop/loop-agent-entry.ts',
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
  for (const path of ['src/application/work-items.ts', 'src/application/interventions.ts',
    'src/application/workflow-upgrade.ts', 'src/application/work-item-transitions.ts']) {
    assert.ok(result.metafile!.inputs[path], `packaged runtime must include ${path}`);
  }
  assert.equal(Object.keys(result.metafile!.outputs).filter(path => path.endsWith('.cjs')).length, 4);
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
      + (inspectExports ? '; console.log(JSON.stringify({ lifecycle: typeof module.exports.createLoopRunLifecycle }));' : ''),
    ], { cwd: process.cwd(), env, input: file.text, encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000 });
  };
  const list = runBundle('loopctl', ['task-list']);
  assert.ifError(list.error);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trim(), '', 'an empty production database has no task rows to print');
  const database = new Database(join(dataRoot, 'loop-ui.db'), { readonly: true, fileMustExist: true });
  try {
    for (const table of ['workflow_items', 'workflow_dependencies', 'workflow_item_events', 'interventions', 'intervention_attempts']) {
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0,
        `compiled CLI must initialize the unified ${table} schema without fixture data`);
    }
  } finally { database.close(); }
  const lifecycle = runBundle('lifecycle-host', [], true);
  assert.ifError(lifecycle.error);
  assert.equal(lifecycle.status, 0, lifecycle.stderr);
  assert.deepEqual(JSON.parse(lifecycle.stdout), { lifecycle: 'function' });
  const command = runBundle('loop-agent', ['status']);
  assert.ifError(command.error);
  assert.equal(command.status, 1);
  assert.match(command.stderr, /命令只能在活动 Agent execution 内使用/);
  const runner = runBundle('agent-runner', []);
  assert.ifError(runner.error);
  assert.equal(runner.status, 1);
  assert.match(runner.stderr, /missing run id/);
});
