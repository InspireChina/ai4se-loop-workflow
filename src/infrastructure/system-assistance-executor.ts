import crossSpawn from 'cross-spawn';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutorId } from '../domain/agent-executor';
import { buildAgentProcessLaunch, createTemporaryPrompt, removeTemporaryPrompt } from './delegation-execution';
import { resolveAgentExecutionLimits } from './agent-execution-limits';
import { createAgentFinalTextAccumulator, getAgentExecutor, type AgentExecutionOptions } from './agent-executor';
import { taskContextChatProgressEvents, type TaskContextChatProgressEvent } from './task-context-chat-executor';
import { terminateProcessTree } from './process-tree';

export async function runSystemAssistancePrompt(input: {
  executorId: AgentExecutorId;
  executionOptions: AgentExecutionOptions;
  prompt: string;
  onProgress?: (event: TaskContextChatProgressEvent) => void;
}) {
  const executor = getAgentExecutor(input.executorId);
  const workspace = mkdtempSync(join(tmpdir(), 'loopwork-config-chat-'));
  const temporaryPrompt = executor.promptMode === 'file-reference' ? createTemporaryPrompt(input.prompt) : null;
  const invocationPrompt = temporaryPrompt?.reference || input.prompt;
  const launch = buildAgentProcessLaunch(executor, invocationPrompt, workspace, input.executionOptions);
  const limits = resolveAgentExecutionLimits(process.env);
  const accumulator = createAgentFinalTextAccumulator(executor.id);
  const publishProgress = (line: string) => {
    try {
      for (const event of taskContextChatProgressEvents(executor.id, line)) input.onProgress?.(event);
    } catch { /* UI progress must not affect execution. */ }
  };
  let stderr = '';
  let terminationReason = '';
  try {
    const child = crossSpawn(launch.command, launch.args, {
      cwd: workspace,
      env: launch.env as NodeJS.ProcessEnv,
      stdio: [executor.promptMode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let pending = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        accumulator.ingest(line);
        publishProgress(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-12_000); });
    if (executor.promptMode === 'stdin') child.stdin?.end(input.prompt);
    const timer = setTimeout(() => {
      terminationReason = '系统辅助 Agent 执行超时';
      if (child.pid) void terminateProcessTree(child.pid, 5_000).then((stopped) => { if (!stopped) child.kill('SIGKILL'); });
      else child.kill('SIGKILL');
    }, Math.min(limits.maxRuntimeMs, 20 * 60 * 1000));
    timer.unref();
    const result = await new Promise<{ exitCode: number }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1 }));
    });
    clearTimeout(timer);
    if (pending.trim()) {
      accumulator.ingest(pending);
      publishProgress(pending);
    }
    if (result.exitCode !== 0) throw new Error(terminationReason || stderr.trim() || `系统辅助 Agent 退出：${result.exitCode}`);
    const answer = accumulator.value().trim();
    if (!answer) throw new Error('系统辅助 Agent 没有返回配置');
    return answer;
  } finally {
    removeTemporaryPrompt(temporaryPrompt);
    rmSync(workspace, { recursive: true, force: true });
  }
}
