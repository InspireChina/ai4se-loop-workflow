import { spawn } from 'node:child_process';
import {waitForWindowsJobAdmission} from '../../src/infrastructure/windows-job-containment';

// This worker has no business/management DB access or Agent credentials.
// Its parent owns authorization, durable receipts and physical group cleanup.
async function main(){
  let busy = false;
  const seen = new Set<string>();
  await waitForWindowsJobAdmission();
  process.on('disconnect', () => process.exit(0));
  process.on('message', (input: unknown) => {
  const request = input as { id?: unknown; command?: unknown; workspaceRoot?: unknown };
  if (busy || typeof request.id !== 'string' || seen.has(request.id)
    || typeof request.command !== 'string' || !request.command.trim() || typeof request.workspaceRoot !== 'string') {
    process.send?.({ kind: 'protocol-error', message: 'Invalid or duplicate verification command' });
    return;
  }
  busy = true;
  const id = request.id;
  seen.add(id);
  let stdout = '';
  let stderr = '';
  let overflow = false;
  const limit = 2 * 1024 * 1024;
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', request.command], { cwd: request.workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    : spawn('/bin/sh', ['-c', request.command], { cwd: request.workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (target: 'stdout' | 'stderr', text: string) => {
    process.send?.({ kind: 'output', id, stream: target, text });
    if (target === 'stdout') { stdout += text; if (stdout.length > limit) { stdout = stdout.slice(0, limit); overflow = true; } }
    else { stderr += text; if (stderr.length > limit) { stderr = stderr.slice(0, limit); overflow = true; } }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => capture('stdout', chunk));
  child.stderr.on('data', chunk => capture('stderr', chunk));
  child.once('error', error => { stderr += error.message; });
  child.once('close', code => {
    busy = false;
    process.send?.({ kind: 'result', id, result: { exitCode: overflow ? 1 : code, stdout,
      stderr: overflow ? `${stderr}\nVerification output exceeded evidence limit` : stderr, exitConfirmed: false } });
  });
  });
  process.send?.({ kind: 'ready' });
}

void main().catch(error=>{process.stderr.write(`${error instanceof Error?error.stack||error.message:String(error)}\n`);process.exitCode=1;});
