import { spawn } from 'node:child_process';

export type CommandVerificationResult = {
  exitCode: number;
  output: string;
  timedOut: boolean;
};

const allowedCommand = /^(?:npm|pnpm|yarn|bun|npx|node|tsx|tsc|vitest|jest|pytest|python\s+-m\s+pytest|cargo\s+(?:test|check|clippy)|go\s+test|make\s+(?:test|check|lint)|eslint)(?:\s|$)/;

export function assertVerificationCommandAllowed(command: string) {
  const normalized = command.trim();
  if (!allowedCommand.test(normalized)) throw new Error(`Harness 拒绝执行未允许的验证命令：${normalized}`);
  if (/[;&|`]|\$\(|\n|\r/.test(normalized)) throw new Error('Harness 验证命令不能包含 shell 组合、管道或命令替换');
  return normalized;
}

export async function executeVerificationCommand(command: string, workspaceRoot: string, timeoutMs = 10 * 60 * 1000): Promise<CommandVerificationResult> {
  const normalized = assertVerificationCommandAllowed(command);
  const [program, ...args] = normalized.split(/\s+/);
  const child = spawn(program, args, { cwd: workspaceRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
