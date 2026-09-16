import { spawn } from 'node:child_process';
import { waitForWindowsJobAdmission } from '../../src/infrastructure/windows-job-containment';

async function main() {
  await waitForWindowsJobAdmission();
  const separator = process.argv.indexOf('--', 2);
  if (separator < 0 || !process.argv[separator + 1]) throw new Error('Windows contained command is missing its target');
  const command = process.argv[separator + 1];
  const args = process.argv.slice(separator + 2);
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env: process.env });
  const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* Job close is authoritative */ } };
  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.code ?? 1;
}

void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`); process.exitCode = 1; });
