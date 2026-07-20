import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { commitDevStory, gitHead, prepareDevWorkspace, verifyDevCommit } from './git';

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

function installCommitMessageHook(cwd: string) {
  const hook = join(cwd, '.git', 'hooks', 'commit-msg');
  writeFileSync(hook, [
    '#!/bin/sh',
    "grep -Eq '^\\[[^]]+\\] #[^ ]+ (feat|chore): .+' \"$1\" || {",
    "  echo 'commit 消息格式不合规：要求 [姓名] #卡号 type: 描述' >&2",
    '  exit 1',
    '}',
    '',
  ].join('\n'));
  chmodSync(hook, 0o755);
}

test('runner commits a cleanly isolated dev story', () => {
  const cwd = repository();
  const head = gitHead(cwd);
  const preparation = prepareDevWorkspace(cwd, 'TASK-1234', 2);
  assert.equal(preparation.ok, true);
  assert.equal(preparation.checkpointCommit, '');
  assert.equal(preparation.head, head);
  writeFileSync(join(cwd, 'feature.ts'), 'export const ready = true;\n');
  const result = commitDevStory(cwd, 'TASK-1234', 2, head);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.commit, gitHead(cwd));
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('runner accepts a completed dev walkthrough without creating an empty commit', () => {
  const cwd = repository();
  const head = gitHead(cwd);
  const result = commitDevStory(cwd, 'TASK-1234', 2, head);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.commit, head);
  assert.match(result.reason, /无需产生新代码/);
  assert.equal(git(cwd, 'rev-list', '--count', 'HEAD'), '1');
});

test('runner checkpoints a dirty workspace before dev starts', () => {
  const cwd = repository();
  writeFileSync(join(cwd, 'README.md'), 'user change\n');
  const result = prepareDevWorkspace(cwd, 'TASK-1234', 3);
  assert.equal(result.ok, true);
  assert.equal(result.checkpointCommit, gitHead(cwd));
  assert.match(git(cwd, 'log', '-1', '--pretty=%s'), /checkpoint before TASK-1234 Unit-3/);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('runner refuses to checkpoint sensitive existing files', () => {
  const cwd = repository();
  writeFileSync(join(cwd, '.env.local'), 'TOKEN=secret\n');
  const result = prepareDevWorkspace(cwd, 'TASK-1234', 3);
  assert.equal(result.ok, false);
  assert.match(result.reason, /敏感文件/);
  assert.equal(git(cwd, 'status', '--porcelain'), '?? .env.local');
});

test('runner refuses to commit sensitive files', () => {
  const cwd = repository();
  const head = gitHead(cwd);
  writeFileSync(join(cwd, '.env.local'), 'TOKEN=secret\n');
  const result = commitDevStory(cwd, 'TASK-1234', 1, head);
  assert.equal(result.ok, false);
  assert.match(result.reason, /敏感文件/);
});

test('verification can find a story commit after later commits', () => {
  const cwd = repository();
  const head = gitHead(cwd);
  writeFileSync(join(cwd, 'feature.ts'), 'export const ready = true;\n');
  const result = commitDevStory(cwd, 'TASK-1234', 2, head);
  assert.equal(result.ok, true);

  writeFileSync(join(cwd, 'later.ts'), 'export const later = true;\n');
  git(cwd, 'add', 'later.ts');
  git(cwd, 'commit', '-m', 'chore: unrelated later work');

  const verification = verifyDevCommit(cwd, 'TASK-1234', 2);
  assert.equal(verification.ok, true);
  assert.equal(verification.commit, result.commit);
});

test('classifies commit-msg policy rejection as recoverable Git input and accepts a supplied title', () => {
  const cwd = repository();
  installCommitMessageHook(cwd);
  const head = gitHead(cwd);
  writeFileSync(join(cwd, 'feature.ts'), 'export const ready = true;\n');

  const rejected = commitDevStory(cwd, 'TASK-1234', 2, head);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.needsInput, true);
  assert.match(rejected.reason, /消息格式不合规/);

  const accepted = commitDevStory(cwd, 'TASK-1234', 2, head, '[landi] #VAQRU-117 feat: 完成实现');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.changed, true);
  assert.equal(git(cwd, 'log', '-1', '--pretty=%s'), '[landi] #VAQRU-117 feat: 完成实现');
});

test('uses the same recoverable Git input path for checkpoint commits', () => {
  const cwd = repository();
  installCommitMessageHook(cwd);
  writeFileSync(join(cwd, 'README.md'), 'user change\n');

  const rejected = prepareDevWorkspace(cwd, 'TASK-1234', 3);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.needsInput, true);

  const accepted = prepareDevWorkspace(cwd, 'TASK-1234', 3, '[landi] #TASK-1234 chore: checkpoint before Unit-3');
  assert.equal(accepted.ok, true);
  assert.equal(git(cwd, 'log', '-1', '--pretty=%s'), '[landi] #TASK-1234 chore: checkpoint before Unit-3');
});
