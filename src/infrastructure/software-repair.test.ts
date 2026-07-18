import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    'src/application/software-maintenance.ts',
    'src/application/runtime-events.ts',
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
