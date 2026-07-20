import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { paths } from './database';
import { gitHead } from './git';

function git(args: string[], cwd = paths.appRoot, timeout = 60_000) {
  // Porcelain status uses the leading columns as data. Removing leading whitespace
  // turns ` M src/file.ts` into `M src/file.ts` and corrupts the first path below.
  const platformArgs = process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args;
  return execFileSync('git', platformArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 20 * 1024 * 1024 }).trimEnd();
}

function safeJobId(jobId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(jobId)) throw new Error('invalid maintenance job id');
  return jobId;
}

function shortJobId(jobId: string) {
  return createHash('sha256').update(safeJobId(jobId)).digest('hex').slice(0, 12);
}

function worktreeRootFor(platform: NodeJS.Platform, temporaryDirectory: string, repoHash: string) {
  const path = platform === 'win32' ? win32 : posix;
  return platform === 'win32'
    ? path.join(temporaryDirectory, 'lwm', repoHash.slice(0, 8))
    : path.join(temporaryDirectory, 'loopwork-software-maintenance', repoHash);
}

function repairWorktreePathFor(platform: NodeJS.Platform, temporaryDirectory: string, repoHash: string, jobId: string) {
  const path = platform === 'win32' ? win32 : posix;
  const jobDirectory = platform === 'win32' ? shortJobId(jobId) : safeJobId(jobId);
  return path.join(worktreeRootFor(platform, temporaryDirectory, repoHash), jobDirectory);
}

function worktreeRoot() {
  return worktreeRootFor(process.platform, tmpdir(), paths.repoHash);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function retryWindowsFilesystemOperation<T>(operation: () => T, platform = process.platform) {
  const delays = platform === 'win32' ? [0, 100, 250, 500] : [0];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    try { return operation(); } catch (error) { lastError = error; }
  }
  throw lastError;
}

function worktreeMetadataPath(repoRoot: string, worktree: string, platform = process.platform) {
  const commonDirectory = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
  const path = platform === 'win32' ? win32 : posix;
  return join(commonDirectory, 'worktrees', path.basename(worktree));
}

function removeWorktreePath(repoRoot: string, worktree: string, platform = process.platform) {
  const errors: string[] = [];
  if (existsSync(worktree)) {
    try {
      retryWindowsFilesystemOperation(() => git(['worktree', 'remove', '--force', worktree], repoRoot, 120_000), platform);
    } catch (gitError) {
      try {
        retryWindowsFilesystemOperation(() => rmSync(worktree, { recursive: true, force: true }), platform);
      } catch (filesystemError) {
        errors.push(`无法删除维护工作目录：${errorMessage(filesystemError)}；Git 原始错误：${errorMessage(gitError)}`);
      }
    }
  }

  // If Git removal failed after deleting files, remove only this job's deterministic
  // administrative directory. A global `worktree prune` lets one inaccessible stale
  // entry block every later maintenance job on Windows.
  let metadata = '';
  try { metadata = worktreeMetadataPath(repoRoot, worktree, platform); }
  catch (error) { errors.push(`无法定位维护 worktree 元数据：${errorMessage(error)}`); }
  if (metadata) {
    try {
      retryWindowsFilesystemOperation(() => rmSync(metadata, { recursive: true, force: true }), platform);
    } catch (error) {
      errors.push(`无法删除维护 worktree 元数据 ${metadata}：${errorMessage(error)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function createRepairWorktreeAt(repoRoot: string, root: string, worktree: string, branch: string, baseCommit: string, platform = process.platform) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const cleanup = removeWorktreePath(repoRoot, worktree, platform);
  if (!cleanup.ok || existsSync(worktree)) {
    throw new Error(`无法清理当前维护 worktree：${cleanup.errors.join('；') || worktree}`);
  }
  try { git(['branch', '-D', branch], repoRoot); }
  catch (error) {
    if (gitBranchExists(repoRoot, branch)) throw new Error(`无法清理当前维护分支 ${branch}：${errorMessage(error)}`);
  }
  git(['worktree', 'add', '-b', branch, worktree, baseCommit], repoRoot, 120_000);
}

function gitBranchExists(repoRoot: string, branch: string) {
  try { git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot); return true; }
  catch { return false; }
}

export function repairWorktreePath(jobId: string) {
  return repairWorktreePathFor(process.platform, tmpdir(), paths.repoHash, jobId);
}

export function repairBranchName(jobId: string) {
  return `loop-maintenance/${safeJobId(jobId)}`;
}

export function prepareRepairDependencies(worktree: string) {
  const source = join(paths.appRoot, 'node_modules');
  const target = join(worktree, 'node_modules');
  if (!existsSync(source)) throw new Error('应用依赖不存在，无法运行隔离 Harness');
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

export function createRepairWorktree(jobId: string, baseCommit: string) {
  if (!baseCommit) throw new Error('应用仓库没有可用的 Git base commit');
  const root = worktreeRoot();
  const worktree = repairWorktreePath(jobId);
  const branch = repairBranchName(jobId);
  createRepairWorktreeAt(paths.appRoot, root, worktree, branch, baseCommit);
  return { worktree, branch };
}

function statusPaths(worktree: string) {
  const status = git(['status', '--porcelain', '--untracked-files=all'], worktree);
  if (!status) return [];
  return status.split(/\r?\n/).filter(Boolean).map((line) => {
    const path = line.slice(3).trim();
    return path.includes(' -> ') ? path.split(' -> ').pop()! : path;
  });
}

const protectedPath = /^(?:\.git(?:\/|$)|\.env(?:\.|$)|data\/|node_modules\/|migrations\/|app-migrations\/|package(?:-lock)?\.json$|(?:pnpm-lock\.yaml|yarn\.lock)$|tsconfig\.json$|next\.config\.[^/]+$|scripts\/loop\/maintenance-runner\.ts$|src\/application\/(?:software-maintenance|runtime-events)\.ts$|src\/infrastructure\/(?:software-repair|maintenance-runner)\.ts$)/i;
const sensitivePath = /(^|\/)(?:credentials?|secrets?)(?:\.[^/]*)?$/i;

function untrackedLineCount(worktree: string, files: string[]) {
  let count = 0;
  for (const file of files) {
    const path = resolve(worktree, file);
    const child = relative(resolve(worktree), path);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !existsSync(path) || !lstatSync(path).isFile()) continue;
    try { count += readFileSync(path, 'utf8').split(/\r?\n/).length; } catch { count += 500; }
  }
  return count;
}

export function inspectRepairChanges(worktree: string) {
  const files = statusPaths(worktree).filter((file) => file !== 'node_modules');
  const protectedFiles = files.filter((file) => protectedPath.test(file) || sensitivePath.test(file));
  const untracked = files.filter((file) => {
    try { return git(['ls-files', '--error-unmatch', '--', file], worktree) === ''; } catch { return true; }
  });
  let changedLines = 0;
  try {
    const numstat = git(['diff', '--numstat', 'HEAD', '--'], worktree);
    for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
      const [added, removed] = line.split('\t');
      changedLines += (Number(added) || 0) + (Number(removed) || 0);
    }
  } catch { changedLines = 10_000; }
  changedLines += untrackedLineCount(worktree, untracked);
  const errors: string[] = [];
  if (!files.length) errors.push('Maintenance Agent 没有产生代码变更');
  if (files.length > 8) errors.push(`变更文件超过预算：${files.length}/8`);
  if (changedLines > 500) errors.push(`变更行数超过预算：${changedLines}/500`);
  if (protectedFiles.length) errors.push(`修改了自修复保护边界：${protectedFiles.join(', ')}`);
  for (const file of files.filter((path) => /(?:^|\/)\w[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))) {
    let before = '';
    let after = '';
    try { before = git(['show', `HEAD:${file}`], worktree); } catch { /* new regression test */ }
    try { after = readFileSync(resolve(worktree, file), 'utf8'); } catch { /* deleted test */ }
    const beforeCount = (before.match(/\b(?:test|it)\s*\(/g) || []).length;
    const afterCount = (after.match(/\b(?:test|it)\s*\(/g) || []).length;
    if (afterCount < beforeCount) errors.push(`既有测试数量减少：${file} ${beforeCount}→${afterCount}`);
  }
  return { ok: errors.length === 0, files, changedLines, errors };
}

export function mainRepositorySnapshot() {
  const status = git(['status', '--porcelain', '--untracked-files=all'], paths.appRoot);
  let diff = '';
  try { diff = git(['diff', '--binary', 'HEAD', '--'], paths.appRoot, 120_000); } catch { /* status still contributes */ }
  const untrackedMetadata = status.split(/\r?\n/).filter((line) => line.startsWith('?? ')).map((line) => {
    const file = resolve(paths.appRoot, line.slice(3));
    try { const stat = lstatSync(file); return `${line.slice(3)}:${stat.size}:${stat.mtimeMs}`; } catch { return `${line.slice(3)}:missing`; }
  }).join('\n');
  const digest = createHash('sha256').update(`${gitHead(paths.appRoot)}\n${status}\n${diff}\n${untrackedMetadata}`).digest('hex');
  return { head: gitHead(paths.appRoot), status, digest };
}

export function mainRepositorySnapshotMatches(snapshot: ReturnType<typeof mainRepositorySnapshot>) {
  try {
    const current = mainRepositorySnapshot();
    return current.head === snapshot.head && current.status === snapshot.status && current.digest === snapshot.digest;
  } catch { return false; }
}

function runNpm(worktree: string, args: string[], timeout: number) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, args, {
    cwd: worktree,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, LOOP_APP_ROOT: worktree, LOOP_WORKSPACE_ROOT_OVERRIDE: worktree },
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return {
    command: `npm ${args.join(' ')}`,
    passed: result.status === 0 && !result.error,
    exitCode: result.status,
    summary: output.length > 6000 ? `${output.slice(-6000)}\n…[truncated]` : output,
    error: result.error?.message || '',
  };
}

export function runSoftwareRepairHarness(worktree: string) {
  const tests = runNpm(worktree, ['test'], 10 * 60_000);
  if (!tests.passed) return { passed: false, checks: [tests] };
  const build = runNpm(worktree, ['run', 'build'], 10 * 60_000);
  return { passed: build.passed, checks: [tests, build] };
}

export function commitRepairCandidate(worktree: string, fingerprint: string) {
  git(['add', '-A'], worktree);
  git(['commit', '-m', `fix(loop): autonomous repair ${fingerprint}`], worktree, 120_000);
  return gitHead(worktree);
}

export function mainRepositoryCanApply(baseCommit: string) {
  try {
    if (gitHead(paths.appRoot) !== baseCommit) return { ok: false, reason: '应用仓库 HEAD 已离开维护任务基线' };
    if (git(['status', '--porcelain', '--untracked-files=all'], paths.appRoot)) return { ok: false, reason: '应用仓库存在未提交改动' };
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function applyRepairCandidate(commit: string) {
  try {
    git(['cherry-pick', commit], paths.appRoot, 120_000);
    return { ok: true, commit: gitHead(paths.appRoot), reason: '' };
  } catch (error) {
    try { git(['cherry-pick', '--abort'], paths.appRoot); } catch { /* preserve original error */ }
    return { ok: false, commit: '', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function removeRepairWorktree(jobId: string, deleteBranch = false) {
  const worktree = repairWorktreePath(jobId);
  const cleanup = removeWorktreePath(paths.appRoot, worktree);
  if (deleteBranch) {
    try { git(['branch', '-D', repairBranchName(jobId)], paths.appRoot); }
    catch (error) {
      if (gitBranchExists(paths.appRoot, repairBranchName(jobId))) {
        cleanup.errors.push(`无法删除维护分支 ${repairBranchName(jobId)}：${errorMessage(error)}`);
        cleanup.ok = false;
      }
    }
  }
  return cleanup;
}

export function relativeToApp(path: string) {
  return relative(paths.appRoot, path);
}

export const softwareRepairInternals = {
  isProtectedPath: (path: string) => protectedPath.test(path) || sensitivePath.test(path),
  worktreeRootFor,
  repairWorktreePathFor,
  createRepairWorktreeAt,
  removeWorktreePath,
};
