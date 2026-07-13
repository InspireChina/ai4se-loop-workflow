import { execFileSync } from 'node:child_process';

export type DevCommitVerification = {
  ok: boolean;
  reason: string;
  commit: string;
};

function git(args: string[], workspaceRoot: string) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitHead(workspaceRoot: string) {
  try { return git(['rev-parse', 'HEAD'], workspaceRoot); } catch { return ''; }
}

export function checkDevWorkspaceReady(workspaceRoot: string) {
  try {
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
    return dirty ? { ok: false, reason: '工作区存在未提交改动，无法安全隔离当前 Story' } : { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: `无法检查 Git 工作区：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function commitDevStory(workspaceRoot: string, taskId: string, storyIndex: number, headBefore: string) {
  try {
    const currentHead = gitHead(workspaceRoot);
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
    if (currentHead !== headBefore) {
      if (dirty) return { ok: false, reason: 'Agent 修改了 Git 历史且仍有未提交改动，拒绝自动提交', commit: '' };
      const verification = verifyDevCommit(workspaceRoot, taskId, storyIndex);
      return verification.ok ? verification : { ...verification, reason: `Agent 创建了不可接受的提交：${verification.reason}` };
    }
    if (!dirty) return { ok: false, reason: 'Agent 没有产生代码变更', commit: '' };
    const sensitive = dirty.split(/\r?\n/).map((line) => line.slice(3).trim()).filter((file) => /(^|\/)(\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(\/|$)/i.test(file));
    if (sensitive.length) return { ok: false, reason: `检测到敏感文件，拒绝提交：${sensitive.join(', ')}`, commit: '' };
    git(['add', '-A'], workspaceRoot);
    git(['commit', '-m', `feat(${taskId}): Story-${storyIndex} 完成实现`], workspaceRoot);
    return verifyDevCommit(workspaceRoot, taskId, storyIndex);
  } catch (error) {
    try { git(['restore', '--staged', '.'], workspaceRoot); } catch { /* keep working tree changes for inspection */ }
    return { ok: false, reason: `自动提交失败：${error instanceof Error ? error.message : String(error)}`, commit: '' };
  }
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
