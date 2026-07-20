import { execFileSync } from 'node:child_process';

function git(args: string[], workspaceRoot: string) {
  return execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitHead(workspaceRoot: string) {
  try { return git(['rev-parse', 'HEAD'], workspaceRoot); } catch { return ''; }
}
