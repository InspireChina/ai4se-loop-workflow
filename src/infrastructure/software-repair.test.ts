import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectRepairChanges, softwareRepairInternals } from './software-repair';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('protects the self-repair engine, migrations, runtime data, and secrets from autonomous patches', () => {
  for (const path of [
    '.env.local',
    'data/project/loop-ui.db',
    'migrations/021_change.sql',
    'app-migrations/002_change.sql',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'next.config.ts',
    'scripts/loop/maintenance-runner.ts',
    'scripts/loop/submit-agent-result.mjs',
    'src/application/software-maintenance.ts',
    'src/application/runtime-events.ts',
    'src/infrastructure/agent-result-channel.ts',
    'src/infrastructure/software-repair.ts',
    'config/secrets.json',
  ]) assert.equal(softwareRepairInternals.isProtectedPath(path), true, path);

  assert.equal(softwareRepairInternals.isProtectedPath('src/application/tasks.ts'), false);
  assert.equal(softwareRepairInternals.isProtectedPath('app/runs/page.tsx'), false);
});

test('preserves the first character of the first modified worktree path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'loopwork-repair-status-'));
  git(cwd, 'init');
  git(cwd, 'config', 'user.email', 'loopwork@example.invalid');
  git(cwd, 'config', 'user.name', 'LoopWork Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/example.ts'), 'export const value = 1;\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'initial');
  writeFileSync(join(cwd, 'src/example.ts'), 'export const value = 2;\n');

  const changes = inspectRepairChanges(cwd);
  assert.deepEqual(changes.files, ['src/example.ts']);
  assert.equal(changes.ok, true);
});

test('uses a short deterministic maintenance worktree path on Windows', () => {
  const temporaryDirectory = String.raw`C:\Users\cloud-desktop-user\AppData\Local\Temp`;
  const jobId = '4b564fe2-897c-4ea5-96db-1e98889f92f4';
  const first = softwareRepairInternals.repairWorktreePathFor('win32', temporaryDirectory, '8a8d0af77c1b', jobId);
  const second = softwareRepairInternals.repairWorktreePathFor('win32', temporaryDirectory, '8a8d0af77c1b', jobId);

  assert.equal(first, second);
  assert.match(first, /\\lwm\\8a8d0af7\\[a-f0-9]{12}$/);
  assert.ok(first.length < temporaryDirectory.length + 40, first);
  assert.equal(first.includes(jobId), false);
});

test('keeps descriptive maintenance worktree paths on non-Windows systems', () => {
  const path = softwareRepairInternals.repairWorktreePathFor('darwin', '/tmp', '8a8d0af77c1b', 'job-123');
  assert.equal(path, '/tmp/loopwork-software-maintenance/8a8d0af77c1b/job-123');
});

test('creates and removes one maintenance worktree without globally pruning unrelated metadata', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'loopwork-repair-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'loopwork-repair-worktrees-'));
  const worktree = join(root, 'current-job');
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  git(cwd, 'init');
  git(cwd, 'config', 'user.email', 'loopwork@example.invalid');
  git(cwd, 'config', 'user.name', 'LoopWork Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'README.md'), 'maintenance fixture\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'initial');
  const unrelated = join(cwd, '.git', 'worktrees', 'unrelated-stale-entry');
  mkdirSync(join(cwd, '.git', 'worktrees'), { recursive: true });
  writeFileSync(unrelated, 'not a worktree directory');

  softwareRepairInternals.createRepairWorktreeAt(cwd, root, worktree, 'loop-maintenance/current-job', 'HEAD', 'darwin');

  assert.equal(existsSync(worktree), true);
  assert.equal(existsSync(unrelated), true);
  assert.match(git(cwd, 'worktree', 'list', '--porcelain'), /branch refs\/heads\/loop-maintenance\/current-job/);

  const cleanup = softwareRepairInternals.removeWorktreePath(cwd, worktree, 'darwin');
  assert.deepEqual(cleanup, { ok: true, errors: [] });
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(unrelated), true);
});
