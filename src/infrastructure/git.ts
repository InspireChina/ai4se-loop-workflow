import { execFileSync } from 'node:child_process';

export type DevCommitVerification = {
  ok: boolean;
  reason: string;
  commit: string;
  changed: boolean;
  needsInput?: boolean;
  attemptedMessage?: string;
};

function git(args: string[], workspaceRoot: string) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitHead(workspaceRoot: string) {
  try { return git(['rev-parse', 'HEAD'], workspaceRoot); } catch { return ''; }
}

function sensitiveFiles(status: string) {
  return status.split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter((file) => /(^|\/)(\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(\/|$)/i.test(file));
}

function commandErrorText(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
  return [error.message, detail.stderr?.toString(), detail.stdout?.toString()].filter(Boolean).join('\n').trim();
}

export function isGitCommitPolicyFailure(error: unknown) {
  const message = commandErrorText(error);
  return /(?:commit[- ]msg|commitlint|commit message|commit 消息|提交信息|提交消息|message format|消息格式|subject.*(?:format|pattern)|header.*(?:format|pattern)|husky.*commit-msg)/i.test(message);
}

export function prepareDevWorkspace(workspaceRoot: string, taskId: string, storyIndex: number, commitMessage = `chore(loop): checkpoint before ${taskId} Unit-${storyIndex}`) {
  try {
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
    if (!dirty) return { ok: true, reason: '', checkpointCommit: '', head: gitHead(workspaceRoot) };
    const sensitive = sensitiveFiles(dirty);
    if (sensitive.length) {
      return { ok: false, reason: `已有改动包含敏感文件，拒绝自动 checkpoint：${sensitive.join(', ')}`, checkpointCommit: '', head: '' };
    }
    git(['add', '-A'], workspaceRoot);
    git(['commit', '-m', commitMessage], workspaceRoot);
    const remaining = git(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
    if (remaining) {
      return { ok: false, reason: 'checkpoint 提交后工作区仍有改动', checkpointCommit: '', head: '' };
    }
    const head = gitHead(workspaceRoot);
    return { ok: true, reason: '', checkpointCommit: head, head };
  } catch (error) {
    try { git(['restore', '--staged', '.'], workspaceRoot); } catch { /* preserve workspace changes for inspection */ }
    return {
      ok: false,
      reason: `无法创建开发前 checkpoint：${commandErrorText(error)}`,
      checkpointCommit: '',
      head: '',
      needsInput: isGitCommitPolicyFailure(error),
      attemptedMessage: commitMessage,
    };
  }
}

export function commitDevStory(workspaceRoot: string, taskId: string, storyIndex: number, headBefore: string, commitMessage = `feat(${taskId}): Unit-${storyIndex} 完成实现`) {
  try {
    const currentHead = gitHead(workspaceRoot);
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
    if (currentHead !== headBefore) {
      if (dirty) return { ok: false, reason: 'Agent 修改了 Git 历史且仍有未提交改动，拒绝自动提交', commit: '', changed: false };
      const verification = verifyDevCommit(workspaceRoot, taskId, storyIndex, currentHead);
      return verification.ok ? { ...verification, changed: true } : { ...verification, reason: `Agent 创建了不可接受的提交：${verification.reason}` };
    }
    if (!dirty) return { ok: true, reason: '现有实现已满足当前交付单元，无需产生新代码', commit: currentHead, changed: false };
    const sensitive = sensitiveFiles(dirty);
    if (sensitive.length) return { ok: false, reason: `检测到敏感文件，拒绝提交：${sensitive.join(', ')}`, commit: '', changed: false };
    git(['add', '-A'], workspaceRoot);
    git(['commit', '-m', commitMessage], workspaceRoot);
    return { ...verifyDevCommit(workspaceRoot, taskId, storyIndex, gitHead(workspaceRoot)), changed: true };
  } catch (error) {
    try { git(['restore', '--staged', '.'], workspaceRoot); } catch { /* keep working tree changes for inspection */ }
    return {
      ok: false,
      reason: `自动提交失败：${commandErrorText(error)}`,
      commit: '',
      changed: false,
      needsInput: isGitCommitPolicyFailure(error),
      attemptedMessage: commitMessage,
    };
  }
}

function subjectMatches(subject: string, taskId: string, storyIndex: number) {
  const hasTask = subject.toLowerCase().includes(taskId.toLowerCase());
  const hasDeliveryUnit = new RegExp(`\\b(?:unit|story)[- _]?${storyIndex}\\b`, 'i').test(subject);
  return hasTask && hasDeliveryUnit;
}

export function verifyDevCommit(workspaceRoot: string, taskId: string, storyIndex: number, expectedCommit?: string): DevCommitVerification {
  try {
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
    if (dirty) return { ok: false, reason: '工作区仍有未提交改动', commit: '', changed: false };
    if (expectedCommit) {
      git(['cat-file', '-e', `${expectedCommit}^{commit}`], workspaceRoot);
      return { ok: true, reason: '', commit: expectedCommit, changed: true };
    }
    const commits = git(['log', '--all', '--format=%H%x09%s'], workspaceRoot);
    const match = commits.split(/\r?\n/).find((line) => {
      const [, subject = ''] = line.split(/\t/, 2);
      return subjectMatches(subject, taskId, storyIndex);
    });
    if (!match) return { ok: false, reason: `未找到包含 ${taskId} 和 Unit-${storyIndex} 的提交`, commit: '', changed: false };
    const [commit = ''] = match.split(/\t/, 2);
    return { ok: true, reason: '', commit, changed: true };
  } catch (error) {
    return { ok: false, reason: `无法验证 Git commit：${error instanceof Error ? error.message : String(error)}`, commit: '', changed: false };
  }
}
