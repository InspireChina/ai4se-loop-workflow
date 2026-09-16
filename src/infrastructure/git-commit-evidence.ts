import { execFile } from 'node:child_process';

function readGit(workspace: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: workspace, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export type GitCommitEvidence =
  | { kind: 'changed'; baseCommit: string; commit: string; changedFiles: string[] }
  | { kind: 'unchanged'; baseCommit: string; commit: string }
  | { kind: 'unavailable'; reason: string };

export async function readGitExecutionBaseline(workspace: string) {
  try {
    const head = (await readGit(workspace, ['rev-parse', 'HEAD'])).trim();
    const status = await readGit(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const readable = /^[a-f0-9]{40,64}$/i.test(head)
      && (await readGit(workspace, ['rev-parse', 'HEAD'])).trim() === head;
    return { head, clean: !status, readable };
  } catch {
    return { head: '', clean: false, readable: false };
  }
}

/** Read actual tracked changes asynchronously: Git inspection must not starve
 * the Runner heartbeat. No model declaration or existing HEAD proves a change. */
export async function readGitCommitEvidence(workspace: string, baseCommit: string): Promise<GitCommitEvidence> {
  if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) return { kind: 'unavailable', reason: '执行基线不可读' };
  try {
    const commit = (await readGit(workspace, ['rev-parse', 'HEAD'])).trim();
    if (!/^[a-f0-9]{40,64}$/i.test(commit)) return { kind: 'unavailable', reason: '当前 Git HEAD 不可读' };
    await readGit(workspace, ['merge-base', '--is-ancestor', baseCommit, commit]);
    // NUL delimiters preserve spaces, newlines and non-ASCII Windows paths.
    const changedFiles = (await readGit(workspace, ['diff', '--name-only', '-z', baseCommit, commit, '--']))
      .split('\0').filter(Boolean);
    const status = await readGit(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status) return { kind: 'unavailable', reason: '工作区仍有未提交变更，不能认定当前 HEAD 为最终代码成果' };
    if ((await readGit(workspace, ['rev-parse', 'HEAD'])).trim() !== commit) {
      return { kind: 'unavailable', reason: '采集期间 Git HEAD 已变化' };
    }
    return changedFiles.length ? { kind: 'changed', baseCommit, commit, changedFiles }
      : { kind: 'unchanged', baseCommit, commit };
  } catch {
    return { kind: 'unavailable', reason: 'Git 读取失败、超时或 HEAD 并非执行基线的后代' };
  }
}
