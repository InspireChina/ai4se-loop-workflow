import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Node's test runner may preload this module in both the coordinator and its
// child processes. Each process gets a separate database root so parallel test
// files can never share SQLite state or inherit the coordinator's fixture.
if (process.env.LOOP_TEST_SETUP_PID !== String(process.pid)) {
  const sourceRoot = process.cwd();
  const testRoot = mkdtempSync(join(tmpdir(), 'loopwork-test-'));
  const workspaceRoot = join(testRoot, 'workspace');
  const dataRoot = join(testRoot, 'data');
  mkdirSync(workspaceRoot, { recursive: true });

  process.env.LOOP_TEST = '1';
  process.env.LOOP_TEST_SETUP_PID = String(process.pid);
  // A compiler/parent's explicit overrides defeat per-process isolation even
  // when LOOP_DATA_ROOT is replaced. Never open those databases in tests.
  delete process.env.LOOP_GLOBAL_DB_PATH;
  delete process.env.LOOP_LEGACY_DB_PATH;
  delete process.env.LOOP_WORKSPACE_ROOT;
  process.env.LOOP_APP_ROOT = sourceRoot;
  process.env.LOOP_DATA_ROOT = dataRoot;
  process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = workspaceRoot;

  process.on('exit', code => {
    // Preserve failed process tests' DB/ownership/log evidence. Deleting it
    // can erase the only identity of a CLI whose exit was not confirmed.
    if(code!==0){process.stderr.write(`Failed test evidence retained at ${testRoot}\n`);return;}
    try { rmSync(testRoot, { recursive: true, force: true }); } catch { /* Windows may retain a SQLite handle until process teardown. */ }
  });
}
