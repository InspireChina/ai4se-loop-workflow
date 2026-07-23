import { execFileSync } from 'node:child_process';

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
