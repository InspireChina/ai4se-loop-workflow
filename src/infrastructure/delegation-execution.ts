import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { createAgentFinalTextAccumulator, createAgentRunMetricsAccumulator, parseAgentTelemetryStderr, parseAgentTelemetryStdoutEvents, type AgentEnvironment, type AgentExecutionContext, type AgentExecutionOptions, type AgentExecutor, type AgentTelemetryEvent } from './agent-executor';
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
  spawn?: typeof crossSpawn;
};

export type DelegationExecutionResult = { exitCode: number; finalText: string };

export function buildAgentProcessLaunch(executor: AgentExecutor, prompt: string, workspaceRoot: string, executionOptions: AgentExecutionOptions, baseEnv: AgentEnvironment = process.env) {
  return {
    command: executor.command,
    args: [...(executor.prefixArgs || []), ...executor.buildArgs(prompt, workspaceRoot, executionOptions)],
    env: { ...baseEnv, ...(executor.env || {}) },
  };
}

/**
 * Runs one already-dispatched delegation. Telemetry is deliberately best-effort:
 * every client failure is contained by the facade and cannot change this result.
 */
export async function executeDelegation(input: DelegationExecutionInput): Promise<DelegationExecutionResult> {
  const { runId, prompt, workspaceRoot, executor, executionOptions, context, description, telemetry, appendLog, maxRuntimeMs, idleTimeoutMs } = input;
  const spawn = input.spawn ?? crossSpawn;
  const launch = buildAgentProcessLaunch(executor, prompt, workspaceRoot, executionOptions);
  const telemetryContext = { ...context, runToken: runId };
  const trace = await telemetry.startDelegationTrace(telemetryContext, {
    executor: executor.id,
    prompt,
    model: executionOptions.model,
    reasoningEffort: executionOptions.reasoningEffort,
  });
  let lastOutputAt = Date.now();
  let timedOut = false;
  let logQueue = Promise.resolve();
  let telemetryQueue = Promise.resolve();
  let telemetrySequence = 0;
  let traceStatus: 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'execution_error' = 'execution_error';
  let terminalExitCode: number | null | undefined;
  let executionFailed = false;
  let finalText = '';
  const finalTextAccumulator = createAgentFinalTextAccumulator(executor.id);
  const metricsAccumulator = createAgentRunMetricsAccumulator(executor.id);

  const enqueueLog = (message: string | null) => {
    if (!message) return;
    logQueue = logQueue.catch(() => undefined).then(async () => { await appendLog(message); }).catch(() => undefined);
  };
  const enqueueTelemetry = (event: AgentTelemetryEvent | null) => {
    if (!event) return;
    const sequenced = { ...event, sequence: ++telemetrySequence };
    telemetryQueue = telemetryQueue.catch(() => undefined).then(async () => { await trace.event(sequenced); }).catch(() => undefined);
  };

  try {
    await appendLog(`[Agent] 开始 agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - ${description}`);
    await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - 启动 ${executor.label} CLI：${executor.formatCommand(workspaceRoot, executionOptions)}`);
    const child: ChildProcess = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      env: launch.env as NodeJS.ProcessEnv,
      stdio: [executor.promptMode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
        for (const event of parseAgentTelemetryStdoutEvents(executor.id, line)) enqueueTelemetry(event);
        finalTextAccumulator.ingest(line);
        metricsAccumulator.ingest(line);
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
      for (const event of parseAgentTelemetryStdoutEvents(executor.id, stdoutBuffer)) enqueueTelemetry(event);
      finalTextAccumulator.ingest(stdoutBuffer);
      metricsAccumulator.ingest(stdoutBuffer);
    }
    if (stderrBuffer.trim()) {
      enqueueLog(executor.parseStderr(stderrBuffer, context));
      enqueueTelemetry(parseAgentTelemetryStderr(executor.id, stderrBuffer));
    }
    await logQueue;
    await telemetryQueue;
    finalText = finalTextAccumulator.value();
    await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - ${executor.label} CLI 已退出 code=${terminalExitCode ?? 'signal'}`);
    if (terminalExitCode && terminalExitCode !== 0) await appendLog(`[错误] ${context.agent} 执行失败 code=${terminalExitCode}`);
    else await appendLog(`[Agent] 完成 agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - 处理完成`);
    traceStatus = timedOut ? 'timed_out' : executionFailed ? 'execution_error' : terminalExitCode === 0 ? 'completed' : terminalExitCode === null ? 'cancelled' : 'failed';
    return { exitCode: terminalExitCode ?? 1, finalText };
  } finally {
    await telemetryQueue;
    finalText = finalText || finalTextAccumulator.value();
    await trace.end({ status: traceStatus, output: finalText, exitCode: terminalExitCode ?? null, timedOut, metrics: metricsAccumulator.value() });
    await telemetry.flush();
  }
}
