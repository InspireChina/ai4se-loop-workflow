import { spawn } from 'node:child_process';

export type CommandVerificationResult = {
  exitCode: number;
  output: string;
  timedOut: boolean;
};

/**
 * Harness commands run with the same unrestricted workspace authority as Agents.
 * The command belongs to the resolved Slice Spec, which is the execution contract.
 */
export function assertVerificationCommandAllowed(command: string) {
  const normalized = command.trim();
  if (!normalized) throw new Error('Harness 验证命令不能为空');
  return normalized;
}

export async function executeVerificationCommand(command: string, workspaceRoot: string, timeoutMs = 10 * 60 * 1000): Promise<CommandVerificationResult> {
  const normalized = assertVerificationCommandAllowed(command);
  const child = spawn(normalized, {
    cwd: workspaceRoot,
    env: process.env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let timedOut = false;
  const append = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > 100_000) output = output.slice(-100_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  timer.unref();
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    return { exitCode, output, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
