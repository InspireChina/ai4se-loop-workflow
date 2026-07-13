import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDevWorkspaceReady, commitDevStory, gitHead } from './git';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'loopwork-git-'));
  git(cwd, 'init');
  git(cwd, 'config', 'user.email', 'loopwork@example.invalid');
  git(cwd, 'config', 'user.name', 'LoopWork Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'README.md'), 'baseline\n');
  git(cwd, 'add', 'README.md');
  git(cwd, 'commit', '-m', 'initial');
  return cwd;
}

test('runner commits a cleanly isolated dev story', () => {
  const cwd = repository();
  const head = gitHead(cwd);
  assert.deepEqual(checkDevWorkspaceReady(cwd), { ok: true, reason: '' });
  writeFileSync(join(cwd, 'feature.ts'), 'export const ready = true;\n');
  const result = commitDevStory(cwd, 'TASK-1234', 2, head);
  assert.equal(result.ok, true);
  assert.match(result.commit, /TASK-1234/);
  assert.match(result.commit, /Story-2/);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('runner refuses a dirty workspace before dev starts', () => {
  const cwd = repository();
  writeFileSync(join(cwd, 'README.md'), 'user change\n');
  const result = checkDevWorkspaceReady(cwd);
  assert.equal(result.ok, false);
  assert.match(result.reason, /未提交改动/);
});

test('runner refuses to commit sensitive files', () => {
  const cwd = repository();
  const head = gitHead(cwd);
  writeFileSync(join(cwd, '.env.local'), 'TOKEN=secret\n');
  const result = commitDevStory(cwd, 'TASK-1234', 1, head);
  assert.equal(result.ok, false);
  assert.match(result.reason, /敏感文件/);
});
