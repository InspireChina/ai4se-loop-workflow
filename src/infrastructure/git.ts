import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(args: string[], workspaceRoot: string) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitHead(workspaceRoot: string) {
  try { return git(['rev-parse', 'HEAD'], workspaceRoot); } catch { return ''; }
}

export function gitChangedFilesBetween(workspaceRoot: string, from: string, to: string) {
  if (!from || !to || from === to) return [];
  try { return git(['diff', '--name-only', `${from}..${to}`], workspaceRoot).split(/\r?\n/).filter(Boolean); } catch { return []; }
}

export function gitIsAncestor(workspaceRoot: string, ancestor: string, descendant: string) {
  if (!ancestor || !descendant) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function gitWorkingTreeChanges(workspaceRoot: string) {
  try {
    const output = git(['status', '--porcelain=v1', '--untracked-files=all'], workspaceRoot);
    if (!output) return [];
    return output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function gitWorkspaceTree(workspaceRoot: string) {
  const directory = mkdtempSync(join(tmpdir(), 'loopwork-git-index-'));
  const index = join(directory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync('git', ['read-tree', 'HEAD'], {
      cwd: workspaceRoot,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['add', '-A', '--', '.'], {
      cwd: workspaceRoot,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return execFileSync('git', ['write-tree'], {
      cwd: workspaceRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function gitWorkingTreeSnapshot(workspaceRoot: string) {
  const head = gitHead(workspaceRoot);
  if (!head) return { head: '', changes: [], fingerprint: '', tree: '', readable: false };
  try {
    const statusOutput = git(['status', '--porcelain=v1', '--untracked-files=all'], workspaceRoot);
    const status = statusOutput ? statusOutput.split(/\r?\n/).filter(Boolean) : [];
    const changes = status.map((line) => line.slice(3).trim()).filter(Boolean);
    if (!changes.length) {
      const tree = gitTree(workspaceRoot, 'HEAD');
      return {
        head,
        changes,
        fingerprint: '',
        tree,
        readable: Boolean(tree) && gitHead(workspaceRoot) === head,
      };
    }
    const patch = git(['diff', '--binary', 'HEAD', '--'], workspaceRoot);
    const untracked = git(['ls-files', '--others', '--exclude-standard'], workspaceRoot)
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => {
        try { return [path, git(['hash-object', '--no-filters', '--', path], workspaceRoot)]; }
        catch { return [path, 'unreadable']; }
      });
    const tree = gitWorkspaceTree(workspaceRoot);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ status, patch, untracked }))
      .digest('hex');
    return {
      head,
      changes,
      fingerprint,
      tree,
      readable: Boolean(tree)
        && untracked.every(([, hash]) => hash !== 'unreadable')
        && gitHead(workspaceRoot) === head,
    };
  } catch {
    return { head, changes: [], fingerprint: '', tree: '', readable: false };
  }
}

export function gitTree(workspaceRoot: string, ref: string) {
  if (!ref) return '';
  try { return git(['rev-parse', `${ref}^{tree}`], workspaceRoot); } catch { return ''; }
}

export function gitCommitWithTreeBetween(
  workspaceRoot: string,
  from: string,
  to: string,
  tree: string,
) {
  if (!from || !to || !tree || from === to || !gitIsAncestor(workspaceRoot, from, to)) return '';
  try {
    const commits = git(['rev-list', '--reverse', `${from}..${to}`], workspaceRoot)
      .split(/\r?\n/)
      .filter(Boolean);
    let match = '';
    for (const commit of commits) {
      if (gitTree(workspaceRoot, commit) === tree) match = commit;
    }
    return match;
  } catch {
    return '';
  }
}
