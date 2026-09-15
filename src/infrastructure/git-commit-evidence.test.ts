import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGitCommitEvidence, readGitExecutionBaseline } from './git-commit-evidence';

test('actual Git evidence distinguishes committed change, no change, dirty tree and divergent history', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-commit-evidence-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(workspace, 'initial.txt'), 'initial');
    git('add', '--', '.'); git('commit', '-m', 'Initial');
    const baseCommit = git('rev-parse', 'HEAD');
    assert.deepEqual(await readGitExecutionBaseline(workspace), { head: baseCommit, clean: true, readable: true });
    assert.deepEqual(await readGitCommitEvidence(workspace, baseCommit), { kind: 'unchanged', baseCommit, commit: baseCommit });
    const name = '中文 file.txt';
    writeFileSync(join(workspace, name), 'actual content');
    assert.deepEqual(await readGitExecutionBaseline(workspace), { head: baseCommit, clean: false, readable: true });
    assert.equal((await readGitCommitEvidence(workspace, baseCommit)).kind, 'unavailable');
    git('add', '--', '.'); git('commit', '-m', 'Actual change');
    const commit = git('rev-parse', 'HEAD');
    assert.deepEqual(await readGitCommitEvidence(workspace, baseCommit), { kind: 'changed', baseCommit, commit, changedFiles: [name] });
    git('commit', '--allow-empty', '-m', 'Empty commit');
    assert.equal((await readGitCommitEvidence(workspace, commit)).kind, 'unchanged');
    git('checkout', '--orphan', 'unrelated'); git('commit', '-m', 'Unrelated history');
    assert.equal((await readGitCommitEvidence(workspace, baseCommit)).kind, 'unavailable');
    assert.equal((await readGitCommitEvidence(workspace, '--unsafe-ref')).kind, 'unavailable');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
