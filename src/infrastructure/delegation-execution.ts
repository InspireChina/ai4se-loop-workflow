import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { documentFilesRoot } from './document-files';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import crossSpawn from 'cross-spawn';
import { createAgentFinalTextAccumulator, createAgentRunMetricsAccumulator, extractAgentFailureDetail, parseAgentTelemetryStderr, parseAgentTelemetryStdoutEvents, type AgentEnvironment, type AgentExecutionContext, type AgentExecutionOptions, type AgentExecutor, type AgentTelemetryEvent } from './agent-executor';
import { agentResultChannelEnv, createAgentResultChannel, readAgentResultChannel, removeAgentResultChannel, type AgentResultChannel, type AgentResultKind } from './agent-result-channel';
import type { LangfuseTelemetry } from './langfuse';
import { markManagedAgentProcessExited, registerManagedAgentProcess } from './managed-process-registry';
import { terminateProcessTree } from './process-tree';
import { sanitizeDiagnosticText } from './diagnostic-text';

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
  recordTelemetryEvent?: (event: AgentTelemetryEvent & { sequence: number }) => Promise<unknown>;
  maxRuntimeMs: number;
  startupTimeoutMs: number;
  idleTimeoutMs: number;
  resultKind?: AgentResultKind;
  environment?: AgentEnvironment;
  cancellationRequested?: () => boolean | Promise<boolean>;
  cancellationSignal?: AbortSignal;
  /** Authoritative domain submission, never an assistant's completion claim. */
  completionRequested?: () => boolean | Promise<boolean>;
  spawn?: typeof crossSpawn;
};

export type DelegationExecutionResult = {
  exitCode: number;
  signal?: string;
  stderrTail?: string;
  failureDetail?: string;
  finalText: string;
  submittedResult?: string | null;
  resultSubmissionError?: string | null;
  evidencePersistenceError?: string | null;
  terminationReason?: string;
  cancelled?: true;
  completionDetected?: true;
};

export function buildAgentProcessLaunch(executor: AgentExecutor, prompt: string, workspaceRoot: string, executionOptions: AgentExecutionOptions, baseEnv: AgentEnvironment = process.env) {
  const rpc = executor.transport === 'omp-rpc';
  const sessions = executionOptions.sessionDirectory || join(documentFilesRoot(), 'sessions', String(baseEnv.LOOP_EXECUTION_ID || randomUUID()));
  let input = prompt;
  // 辅助会话不能继承父执行的 slash command；仅显式绑定的主流程才设置它。
  let commandEnvironment: AgentEnvironment = { LOOP_OMP_COMMAND: undefined, LOOP_OMP_COMMAND_PATH: undefined, LOOP_OMP_COMMAND_HASH: undefined };
  if (rpc && executionOptions.nativeCommand) {
    const command = executionOptions.nativeCommand;
    const source = readFileSync(command.path, 'utf8');
    if (createHash('sha256').update(source).digest('hex') !== command.sourceHash) throw new Error('Command Prompt 在执行准备期间发生变化，请重新派发以读取一致版本');
    mkdirSync(sessions, { recursive: true });
    // 只作审计，不把专业正文重复追加到 system prompt；由 OMP 原生 slash 展开。
    writeFileSync(join(sessions, `command-${command.name}-${command.sourceHash}.md`), source, { mode: 0o600 });
    // OMP 参数解析会移除引号。把工作包编码为一个完整参数，保留 JSON 引号、
    // 换行和空格；这段字符串不经过 Shell。无占位符的命令会在模板渲染后原样追加它。
    input = `/${command.name} '${prompt.replaceAll("'", "'\"'\"'")}'`;
    commandEnvironment = { LOOP_OMP_COMMAND: command.name, LOOP_OMP_COMMAND_PATH: command.path, LOOP_OMP_COMMAND_HASH: command.sourceHash };
    executionOptions = { ...executionOptions, systemPromptFile: undefined,
      systemPromptText: '# LoopWork Harness boundary\n仅在当前 execution 的授权角色和范围内工作。使用 loopwork 工具读取当前阶段及提交结果；普通回复不能推进任务。专业指令由本轮原生 Command 提供。' };
  }
  if (rpc && executionOptions.systemPromptText) {
    mkdirSync(sessions, { recursive: true });
    const core = baseEnv.LOOP_EXECUTION_TOKEN || baseEnv.LOOP_VERIFICATION_ASSISTANCE_COMMAND_TOKEN
      ? '\n\n# Harness boundary\n只处理当前 execution 授权的角色和范围。任务状态、调度、其他 Agent 和结果应用由 LoopWork 管理。使用 loopwork 工具查询状态与提交产物；只有对应终止命令成功才表示完成。'
      : '';
    const content = executionOptions.systemPromptText + core;
    const path = join(sessions, `agent-${createHash('sha256').update(content).digest('hex')}.md`);
    if (!existsSync(path)) writeFileSync(path, content, { mode: 0o600 });
    executionOptions = { ...executionOptions, systemPromptFile: path };
  }

  return {
    input,
    command: rpc ? process.execPath : executor.command,
    args: [...(rpc ? [join(process.env.LOOP_APP_ROOT || process.cwd(), 'scripts', 'omp-rpc.mjs'), executor.command] : []), ...executor.buildArgs(input, workspaceRoot, executionOptions)],
    env: { ...baseEnv, ...(executor.env || {}), ...(rpc ? { LOOP_NODE: process.execPath, LOOP_APP_ROOT: process.env.LOOP_APP_ROOT || process.cwd() } : {}), ...(rpc ? { LOOP_OMP_SESSION_DIR: sessions } : {}), ...commandEnvironment } as AgentEnvironment,
  };
}

/**
 * Runs one already-dispatched delegation. Telemetry is deliberately best-effort:
 * every client failure is contained by the facade and cannot change this result.
 */
export async function executeDelegation(input: DelegationExecutionInput): Promise<DelegationExecutionResult> {
  const {
    runId,
    prompt,
    workspaceRoot,
    executor,
    executionOptions,
    context,
    description,
    telemetry,
    appendLog,
    maxRuntimeMs,
    startupTimeoutMs,
    idleTimeoutMs,
  } = input;
  const spawn = input.spawn ?? crossSpawn;
  const telemetryContext = { ...context, runToken: runId };
  const trace = await telemetry.startDelegationTrace(telemetryContext, {
    executor: executor.id,
    prompt,
    model: executionOptions.model,
    reasoningEffort: executionOptions.reasoningEffort,
  });
  let timedOut = false;
  let cancelled = false;
  let terminationRequested = false;
  let terminationReason = '';
  let logQueue = Promise.resolve();
  let telemetryQueue = Promise.resolve();
  let telemetrySequence = 0;
  let traceStatus: 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'execution_error' = 'execution_error';
  let terminalExitCode: number | null | undefined;
  let executionFailed = false;
  let finalText = '';
  let stderrTail = '';
  let structuredErrorTail = '';
  let submittedResult: string | null = null;
  let resultSubmissionError: string | null = null;
  let evidencePersistenceError: string | null = null;
  let resultChannel: AgentResultChannel | null = null;
  let startupTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let armIdleTimer = () => undefined;
  let receivedProcessOutput = false;
  const finalTextAccumulator = createAgentFinalTextAccumulator(executor.id);
  const metricsAccumulator = createAgentRunMetricsAccumulator(executor.id);

  const enqueueLog = (message: string | null) => {
    if (!message) return;
    logQueue = logQueue.catch(() => undefined).then(async () => { await appendLog(message); }).catch(() => undefined);
  };
  const enqueueTelemetry = (event: AgentTelemetryEvent | null) => {
    if (!event) return;
    const sequenced = { ...event, sequence: ++telemetrySequence };
    telemetryQueue = telemetryQueue.catch(() => undefined).then(async () => {
      try {
        await input.recordTelemetryEvent?.(sequenced);
      } catch (error) {
        if (!evidencePersistenceError) {
          evidencePersistenceError = error instanceof Error ? error.message : String(error);
          enqueueLog(`[执行器错误] executor=${executor.id} agent=${context.agent} - 本地执行证据写入失败：${evidencePersistenceError}`);
        }
      }
      try { await trace.event(sequenced); } catch { /* telemetry is best-effort and must not block the CLI */ }
    }).catch(() => undefined);
  };
  const captureStructuredError = (line: string) => {
    const detail = extractAgentFailureDetail(executor.id, line);
    if (!detail) return;
    structuredErrorTail = `${structuredErrorTail}${structuredErrorTail ? '\n' : ''}${detail}`.slice(-24_000);
  };

  try {
    resultChannel = input.resultKind ? createAgentResultChannel(input.resultKind) : null;
    const invocationPrompt = prompt;
    const launch = buildAgentProcessLaunch(executor, invocationPrompt, workspaceRoot, executionOptions, {
      ...process.env,
      ...(input.environment || {}),
      ...(resultChannel ? agentResultChannelEnv(resultChannel, context.agent) : {}),
    });
    await appendLog(`[Agent] 开始 lane=${context.lane || 'control'} agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - ${description}`);
    await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - 启动 ${executor.label} CLI：${executor.formatCommand(workspaceRoot, executionOptions)}`);
    const child: ChildProcess = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      env: launch.env as NodeJS.ProcessEnv,
      stdio: [executor.promptMode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const spawnOutcome = await new Promise<{ spawned: true } | { spawned: false; error: unknown }>((resolve) => {
      const onSpawn = () => {
        cleanup();
        resolve({ spawned: true });
      };
      const onError = (error: unknown) => {
        cleanup();
        resolve({ spawned: false, error });
      };
      const cleanup = () => {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    const launchError = spawnOutcome.spawned ? undefined : spawnOutcome.error;
    let processStartMarker: string | null = null;
    if (spawnOutcome.spawned) {
      if (!child.pid) throw new Error('Agent CLI 启动后未获得 PID');
      try {
        processStartMarker = await registerManagedAgentProcess(runId, child.pid);
      } catch (error) {
        await terminateProcessTree(child.pid, 5_000).catch(() => false);
        throw error;
      }
    }
    let childExited = child.exitCode !== null;
    child.once('exit', () => { childExited = true; });
    if (executor.promptMode === 'stdin') child.stdin?.end(launch.input);

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const noteProcessOutput = () => {
      receivedProcessOutput = true;
      if (startupTimer) clearTimeout(startupTimer);
      armIdleTimer();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      noteProcessOutput();
      stdoutBuffer += stdoutDecoder.write(chunk);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        const message = executor.parseStdout(line, context);
        captureStructuredError(line);
        enqueueLog(message);
        for (const event of parseAgentTelemetryStdoutEvents(executor.id, line)) enqueueTelemetry(event);
        finalTextAccumulator.ingest(line);
        metricsAccumulator.ingest(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      noteProcessOutput();
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-24_000);
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        enqueueLog(executor.parseStderr(line, context));
        enqueueTelemetry(parseAgentTelemetryStderr(executor.id, line));
      }
    });

    let completionDetected = false;
    const terminate = async (reason: string, kind: 'timeout' | 'cancelled' | 'completed') => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationReason = reason;
      timedOut = kind === 'timeout';
      cancelled = kind === 'cancelled';
      completionDetected = kind === 'completed';
      await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - ${reason}，正在终止`);
      if (child.pid) {
        const expectedStartMarker = processStartMarker?.startsWith('test-') ? undefined : processStartMarker || undefined;
        const terminated = await terminateProcessTree(child.pid, 5_000, expectedStartMarker).catch(() => false);
        if (!terminated && !childExited) child.kill('SIGKILL');
      } else {
        child.kill('SIGTERM');
      }
    };
    armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void terminate(`超过空闲时间 ${Math.ceil(idleTimeoutMs / 1000)} 秒`, 'timeout');
      }, idleTimeoutMs);
      idleTimer.unref();
    };
    const maxTimer = setTimeout(() => void terminate(`超过最大运行时间 ${Math.round(maxRuntimeMs / 1000)} 秒`, 'timeout'), maxRuntimeMs);
    if (receivedProcessOutput) {
      armIdleTimer();
    } else {
      startupTimer = setTimeout(() => {
        void terminate(`启动后 ${Math.ceil(startupTimeoutMs / 1000)} 秒内没有任何输出`, 'timeout');
      }, startupTimeoutMs);
      startupTimer.unref();
    }
    let cancellationCheckRunning = false;
    const checkCancellation = async () => {
      if (!input.cancellationRequested || cancellationCheckRunning || terminationRequested) return;
      cancellationCheckRunning = true;
      try {
        if (await input.cancellationRequested()) await terminate('需求已取消', 'cancelled');
      } catch {
        // Cancellation polling is best-effort; execution remains authoritative.
      } finally {
        cancellationCheckRunning = false;
      }
    };
    const cancellationTimer = !input.cancellationSignal && input.cancellationRequested
      ? setInterval(() => void checkCancellation(), 500)
      : null;
    if (cancellationTimer) void checkCancellation();
    const onCancellationSignal = () => void terminate('需求已取消', 'cancelled');
    // OMP may continue native todo/maintenance turns after the Workflow result
    // has committed. Reclaim only after the caller verifies that durable result.
    let checkingCompletion = false;
    const completionTimer = input.completionRequested ? setInterval(async () => {
      if (checkingCompletion || terminationRequested || childExited) return;
      checkingCompletion = true;
      try {
        if (await input.completionRequested!()) await terminate('领域结果已提交，回收执行资源', 'completed');
      } catch { /* A failed read cannot establish completion; existing limits still apply. */ }
      finally { checkingCompletion = false; }
    }, 500) : null;
    input.cancellationSignal?.addEventListener('abort', onCancellationSignal, { once: true });
    if (input.cancellationSignal?.aborted) onCancellationSignal();
    try {
      terminalExitCode = await new Promise<number | null>((resolve, reject) => {
        if (launchError) {
          reject(launchError);
          return;
        }
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.once('error', reject);
        child.once('exit', resolve);
      });
    } catch (error) {
      terminalExitCode = undefined;
      executionFailed = true;
      await appendLog(`[执行器错误] executor=${executor.id} agent=${context.agent} - ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(maxTimer);
      if (startupTimer) clearTimeout(startupTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      if (completionTimer) clearInterval(completionTimer);
      input.cancellationSignal?.removeEventListener('abort', onCancellationSignal);
      if (child.pid && processStartMarker) {
        await markManagedAgentProcessExited(runId, child.pid, processStartMarker).catch(() => undefined);
      }
    }
    stdoutBuffer += stdoutDecoder.end();
    stderrBuffer += stderrDecoder.end();
    if (stdoutBuffer.trim()) {
      const message = executor.parseStdout(stdoutBuffer, context);
      captureStructuredError(stdoutBuffer);
      enqueueLog(message);
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
    await logQueue;
    finalText = finalTextAccumulator.value();
    if (resultChannel) {
      try {
        submittedResult = readAgentResultChannel(resultChannel);
        if (submittedResult) await appendLog('[结果通道] Agent 已通过 submit-agent-result 提交结构化结果');
      } catch (error) {
        resultSubmissionError = error instanceof Error ? error.message : String(error);
        await appendLog(`[结果通道] 提交内容无效，将尝试兼容最终文本：${resultSubmissionError}`);
      }
    }
    await appendLog(`[执行器] executor=${executor.id} agent=${context.agent} - ${executor.label} CLI 已退出 code=${terminalExitCode ?? 'signal'}`);
    if (cancelled) await appendLog(`[Agent] 已取消 lane=${context.lane || 'control'} agent=${context.agent} requirement=${context.taskId}`);
    else if (completionDetected) await appendLog(`[Agent] 领域终止结果已持久化，执行资源已回收 agent=${context.agent} requirement=${context.taskId}`);
    else if (terminalExitCode && terminalExitCode !== 0) await appendLog(`[错误] ${context.agent} 执行失败 code=${terminalExitCode}`);
    else await appendLog(`[Agent] 完成 lane=${context.lane || 'control'} agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - 处理完成`);
    traceStatus = timedOut ? 'timed_out' : executionFailed ? 'execution_error' : completionDetected || terminalExitCode === 0 ? 'completed' : terminalExitCode === null ? 'cancelled' : 'failed';
    if (evidencePersistenceError) traceStatus = 'execution_error';
    const failureDetail = [
      structuredErrorTail.trim(),
      stderrTail.trim() ? `stderr：${stderrTail.trim()}` : '',
    ].filter(Boolean).join('\n');
    return {
      exitCode: terminalExitCode ?? 1,
      ...(child.signalCode ? { signal: child.signalCode } : {}),
      ...(stderrTail.trim() ? { stderrTail: sanitizeDiagnosticText(stderrTail.trim()) } : {}),
      ...(failureDetail ? { failureDetail: sanitizeDiagnosticText(failureDetail) } : {}),
      finalText,
      ...(input.resultKind ? { submittedResult, resultSubmissionError } : {}),
      ...(evidencePersistenceError ? { evidencePersistenceError } : {}),
      ...(terminationReason ? { terminationReason } : {}),
      ...(cancelled ? { cancelled: true as const } : {}),
      ...(completionDetected ? { completionDetected: true as const } : {}),
    };
  } finally {
    try {
      await telemetryQueue;
      finalText = finalText || finalTextAccumulator.value();
      await trace.end({ status: traceStatus, output: submittedResult || finalText, exitCode: terminalExitCode ?? null, timedOut, metrics: metricsAccumulator.value() });
      await telemetry.flush();
    } finally {
      removeAgentResultChannel(resultChannel);
    }
  }
}
