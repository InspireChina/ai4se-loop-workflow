import { execFileSync } from 'node:child_process';

export type DevCommitVerification = {
  ok: boolean;
  reason: string;
  commit: string;
};

function git(args: string[], workspaceRoot: string) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function verifyDevCommit(workspaceRoot: string, taskId: string, storyIndex: number): DevCommitVerification {
  try {
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
    if (dirty) return { ok: false, reason: '工作区仍有未提交改动', commit: '' };
    const commit = git(['log', '-1', '--pretty=%s'], workspaceRoot);
    const hasTask = commit.toLowerCase().includes(taskId.toLowerCase());
    const hasStory = new RegExp(`\\bstory[- _]?${storyIndex}\\b`, 'i').test(commit);
    if (!hasTask || !hasStory) {
      return { ok: false, reason: `最新提交标题必须包含 ${taskId} 和 Story-${storyIndex}`, commit };
    }
    return { ok: true, reason: '', commit };
  } catch (error) {
    return { ok: false, reason: `无法验证 Git commit：${error instanceof Error ? error.message : String(error)}`, commit: '' };
  }
}
