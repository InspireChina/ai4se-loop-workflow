import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { extractAgentFinalText, parseAgentTelemetryStderr, parseAgentTelemetryStdout, type AgentExecutionContext, type AgentExecutionOptions, type AgentExecutor } from './agent-executor';
import type { LangfuseTelemetry } from './langfuse';

export type DelegationExecutionInput = {
  runId: string;
  prompt: string;
  workspaceRoot: string;
  executor: AgentExecutor;
  executionOptions: AgentExecutionOptions;
  context: AgentExecutionContext;
  description: string;
  telemetry: LangfuseTelemetry;
  appendLog: (message: string) => Promise<unknown>;
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  spawn?: typeof nodeSpawn;
};

export type DelegationExecutionResult = { exitCode: number; finalText: string };

/**
 * Runs one already-dispatched delegation. Telemetry is deliberately best-effort:
 * every client failure is contained by the facade and cannot change this result.
 */
export async function executeDelegation(input: DelegationExecutionInput): Promise<DelegationExecutionResult> {
  const { runId, prompt, workspaceRoot, executor, executionOptions, context, description, telemetry, appendLog, maxRuntimeMs, idleTimeoutMs } = input;
  const spawn = input.spawn ?? nodeSpawn;
  const args = executor.buildArgs(prompt, workspaceRoot, executionOptions);
  const telemetryContext = { ...context, runToken: runId };
  const trace = await telemetry.startDelegationTrace(telemetryContext, { executor: executor.id, prompt });
  let lastOutputAt = Date.now();
  let timedOut = false;
  let logQueue = Promise.resolve();
  let traceStatus: 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'execution_error' = 'execution_error';
  let terminalExitCode: number | null | undefined;
  let executionFailed = false;
  let finalText = '';

  const enqueueLog = (message: string | null) => {
    if (!message) return;
    logQueue = logQueue.catch(() => undefined).then(async () => { await appendLog(message); }).catch(() => undefined);
  };
  const enqueueTelemetry = (event: ReturnType<typeof parseAgentTelemetryStdout>) => {
    if (event) void trace.event(event);
  };

  try {
    await trace.event({ name: 'loop.agent.lifecycle', executor: executor.id, phase: 'started', summary: 'Agent CLI started' });
    await appendLog(`[Agent] 开始 agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - ${description}`);
    await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - 启动 ${executor.label} CLI：${executor.formatCommand(workspaceRoot, executionOptions)}`);
    const child: ChildProcess = spawn(executor.command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: [executor.promptMode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (executor.promptMode === 'stdin') child.stdin?.end(prompt);

    let stdoutBuffer = '';
    let stderrBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      lastOutputAt = Date.now();
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        enqueueLog(executor.parseStdout(line, context));
        enqueueTelemetry(parseAgentTelemetryStdout(executor.id, line));
        finalText = extractAgentFinalText(executor.id, line) || finalText;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      lastOutputAt = Date.now();
      stderrBuffer += chunk.toString('utf8');
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        enqueueLog(executor.parseStderr(line, context));
        enqueueTelemetry(parseAgentTelemetryStderr(executor.id, line));
      }
    });

    const terminate = async (reason: string) => {
      if (timedOut) return;
      timedOut = true;
      await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - ${reason}，正在终止`);
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000).unref();
    };
    const maxTimer = setTimeout(() => void terminate(`超过最大运行时间 ${Math.round(maxRuntimeMs / 1000)} 秒`), maxRuntimeMs);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastOutputAt > idleTimeoutMs) void terminate(`超过空闲时间 ${Math.round(idleTimeoutMs / 1000)} 秒`);
    }, Math.min(30000, idleTimeoutMs));
    try {
      terminalExitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
    } catch (error) {
      terminalExitCode = undefined;
      executionFailed = true;
      await appendLog(`[执行器错误] executor=${executor.id} agent=${context.agent} - ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(maxTimer);
      clearInterval(idleTimer);
    }
    if (stdoutBuffer.trim()) {
      enqueueLog(executor.parseStdout(stdoutBuffer, context));
      enqueueTelemetry(parseAgentTelemetryStdout(executor.id, stdoutBuffer));
      finalText = extractAgentFinalText(executor.id, stdoutBuffer) || finalText;
    }
    if (stderrBuffer.trim()) {
      enqueueLog(executor.parseStderr(stderrBuffer, context));
      enqueueTelemetry(parseAgentTelemetryStderr(executor.id, stderrBuffer));
    }
    await logQueue;
    await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - ${executor.label} CLI 已退出 code=${terminalExitCode ?? 'signal'}`);
    if (terminalExitCode && terminalExitCode !== 0) await appendLog(`[错误] ${context.agent} 执行失败 code=${terminalExitCode}`);
    else await appendLog(`[Agent] 完成 agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - 处理完成`);
    traceStatus = timedOut ? 'timed_out' : executionFailed ? 'execution_error' : terminalExitCode === 0 ? 'completed' : terminalExitCode === null ? 'cancelled' : 'failed';
    return { exitCode: terminalExitCode ?? 1, finalText };
  } finally {
    await trace.event({ name: 'loop.agent.lifecycle', executor: executor.id, phase: 'completed', summary: `Agent CLI ${traceStatus}`, output: { exitCode: terminalExitCode ?? null, timedOut } });
    await trace.end({ status: traceStatus });
    await telemetry.flush();
  }
}
