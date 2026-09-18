export type InvocationAllocation = {
  attach: (pid: number, marker?: string, groupId?: number) => void;
  requestTermination: (reason: string) => void;
  finish: (confirmed: boolean, reason?: string) => void;
  containment?: { dataRoot: string; allocationId: string };
};
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import crossSpawn from 'cross-spawn';
import { createAgentFinalTextAccumulator, createAgentRunMetricsAccumulator, extractAgentFailureDetail, parseAgentTelemetryStderr, parseAgentTelemetryStdoutEvents, type AgentEnvironment, type AgentExecutionContext, type AgentExecutionOptions, type AgentExecutor, type AgentTelemetryEvent } from './agent-executor';
import { agentResultChannelEnv, createAgentResultChannel, readAgentResultChannel, removeAgentResultChannel, type AgentResultChannel, type AgentResultKind } from './agent-result-channel';
import type { LangfuseTelemetry } from './langfuse';
import { inspectProcessGroup, terminateProcessGroup, terminateProcessTree, waitForProcessIdentity } from './process-tree';
import { sanitizeDiagnosticText } from './diagnostic-text';
import {attachWindowsJobContainment,confirmWindowsJobContainmentExit,withWindowsJobAdmission} from './windows-job-containment';

export type DelegationExecutionInput = {
  runId: string;
  executionId?: string;
  isolateProcessGroup?: boolean;
  allocation?: { prepare: () => Promise<InvocationAllocation> };
  prompt: string;
  workspaceRoot: string;
  executor: AgentExecutor;
  executionOptions: AgentExecutionOptions;
  context: AgentExecutionContext;
  description: string;
  telemetry: LangfuseTelemetry;
  appendLog: (message: string) => Promise<unknown>;
  persistenceTimeoutMs?: number;
  recordTelemetryEvent?: (event: AgentTelemetryEvent & { sequence: number }) => Promise<unknown>;
  monitor?: {
    begin?: () => void;
    observe: (event: AgentTelemetryEvent & { sequence: number }) => void;
    failure: () => string | null;
    intervalMs: number;
    failureKind?: 'activity-stalled';
  };
  activityTimeoutMs?: number;
  activityPollIntervalMs?: number;
  maxRuntimeMs: number;
  startupTimeoutMs: number;
  idleTimeoutMs: number;
  resultSubmissionGraceMs?: number;
  resultKind?: AgentResultKind;
  environment?: AgentEnvironment;
  cancellationRequested?: () => boolean | Promise<boolean>;
  cancellationSignal?: AbortSignal;
  spawn?: typeof crossSpawn;
  processes?: {
    register: (runId: string, pid: number) => Promise<string>;
    markExited: (runId: string, pid: number, marker: string) => Promise<void>;
    terminate: typeof terminateProcessTree;
    confirmExit?: typeof terminateProcessTree;
  };
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
  logPersistenceError?: string | null;
  terminationReason?: string;
  terminationKind?: 'timeout' | 'cancelled' | 'activity-stalled' | 'submitted';
  cancelled?: true;
};

type TemporaryPrompt = { directory: string; file: string; reference: string };

export function createTemporaryPrompt(prompt: string): TemporaryPrompt {
  const directory = mkdtempSync(join(tmpdir(), 'lwp-'));
  const file = join(directory, 'prompt.md');
  try {
    try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the user profile. */ }
    writeFileSync(file, prompt, { encoding: 'utf8', mode: 0o600 });
    const reference = [
      '本次任务的完整指令保存在一个 UTF-8 文件中。',
      '你必须先使用文件读取工具完整读取该文件，再严格执行文件中的全部指令。不要只总结文件，也不要修改或删除文件。',
      `指令文件路径：${file}`,
      `PROMPT_FILE=${JSON.stringify(file)}`,
    ].join('\n');
    return { directory, file, reference };
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* preserve the original write failure */ }
    throw error;
  }
}

export function removeTemporaryPrompt(prompt: TemporaryPrompt | null) {
  if (!prompt) return;
  try { rmSync(prompt.directory, { recursive: true, force: true }); } catch { /* best-effort cleanup after the CLI exits */ }
}

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
export async function executeAgentInvocation(input: DelegationExecutionInput): Promise<DelegationExecutionResult> {
  if (input.monitor && (!Number.isFinite(input.monitor.intervalMs) || input.monitor.intervalMs <= 0)) throw new Error('Execution monitor interval must be positive');
  if (input.resultSubmissionGraceMs !== undefined
    && (!Number.isFinite(input.resultSubmissionGraceMs) || input.resultSubmissionGraceMs < 0)) {
    throw new Error('Result submission grace must be a non-negative finite number');
  }
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
  if (!input.processes) throw new Error("Agent invocation requires a physical process adapter");
  const processes = input.processes;
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
  let terminationKind:DelegationExecutionResult['terminationKind'];
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
  let logPersistenceError: string | null = null;
  let logSinkTimedOut = false;
  let evidenceSinkTimedOut = false;
  let temporaryPrompt: TemporaryPrompt | null = null;
  let resultChannel: AgentResultChannel | null = null;
  let startupTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let resultSubmissionTimer: NodeJS.Timeout | undefined;
  let resultSubmissionPollTimer: NodeJS.Timeout | undefined;
  let armIdleTimer = () => undefined;
  let requestSubmittedResultTermination = (_toolCompleted: boolean) => undefined;
  let receivedProcessOutput = false;
  let allocation: InvocationAllocation | null = null;
  let managedChild: ChildProcess | null = null;
  let managedMarker: string | undefined;
  let processSettled = false;
  const terminatePhysical = (pid:number,timeoutMs:number,marker?:string) => process.platform==='win32'&&allocation?.containment
    ? confirmWindowsJobContainmentExit({dataRoot:allocation.containment.dataRoot,
      process:{allocationId:allocation.containment.allocationId,pid,marker:marker??null},timeoutMs})
    : processes.terminate(pid,timeoutMs,marker);
  const confirmPhysical = (pid:number,timeoutMs:number,marker?:string) => process.platform==='win32'&&allocation?.containment
    ? terminatePhysical(pid,timeoutMs,marker)
    : (processes.confirmExit?.(pid,timeoutMs,marker)??Promise.resolve(false));
  const finalTextAccumulator = createAgentFinalTextAccumulator(executor.id);
  const metricsAccumulator = createAgentRunMetricsAccumulator(executor.id);
  const persistenceTimeoutMs = Math.max(1, input.persistenceTimeoutMs ?? 1000);
  class PersistenceTimeout extends Error {
    constructor() { super('Local persistence timeout'); }
  }
  const boundedPersistence = async (operation: () => Promise<unknown>) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PersistenceTimeout()), persistenceTimeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const safeAppendLog = async (message: string) => {
    if (logSinkTimedOut) return; // do not drain thousands of queued writes at one timeout each
    try { await boundedPersistence(() => appendLog(message)); }
    catch (error) {
      logPersistenceError ||= error instanceof Error ? error.message : String(error);
      if (error instanceof PersistenceTimeout) logSinkTimedOut = true;
    }
  };

  const enqueueLog = (message: string | null) => {
    if (!message) return;
    logQueue = logQueue.catch(() => undefined).then(async () => { await safeAppendLog(message); }).catch(() => undefined);
  };
  let monitorError: string | null = null;
  const enqueueTelemetry = (event: AgentTelemetryEvent | null) => {
    if (!event) return;
    const sequenced = { ...event, sequence: ++telemetrySequence };
    if (!monitorError) {
      try { input.monitor?.observe(sequenced); }
      catch (error) { monitorError = `Execution monitor failed: ${error instanceof Error ? error.message : String(error)}`; }
    }
    telemetryQueue = telemetryQueue.catch(() => undefined).then(async () => {
      try {
        if (input.recordTelemetryEvent && !evidenceSinkTimedOut) await boundedPersistence(() => input.recordTelemetryEvent!(sequenced));
      } catch (error) {
        if (error instanceof PersistenceTimeout) evidenceSinkTimedOut = true;
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
    temporaryPrompt = executor.promptMode === 'file-reference' ? createTemporaryPrompt(prompt) : null;
    resultChannel = input.resultKind ? createAgentResultChannel(input.resultKind) : null;
    if (input.allocation) allocation = await input.allocation.prepare();
    else if (input.executionId) throw new Error("Execution requires a durable physical allocation");
    const invocationPrompt = temporaryPrompt?.reference ?? prompt;
    let launch = buildAgentProcessLaunch(executor, invocationPrompt, workspaceRoot, executionOptions, {
      ...process.env,
      ...(input.environment || {}),
      ...(resultChannel ? agentResultChannelEnv(resultChannel, context.agent) : {}),
    });
    const strictWindowsContainment=process.env.LOOP_RUNTIME_SAFETY!=='standard';
    if(process.platform==='win32'&&allocation?.containment&&strictWindowsContainment){
      launch.env=withWindowsJobAdmission(launch.env as NodeJS.ProcessEnv,allocation.containment.dataRoot,allocation.containment.allocationId);
      const appRoot=String(launch.env.LOOP_APP_ROOT||'');
      const bundled=join(appRoot,'desktop-runners','windows-contained-command.cjs');
      const node=process.env.LOOP_DESKTOP_NODE||process.execPath;
      const wrapperArgs=existsSync(bundled)?[bundled]:['--import',pathToFileURL(join(appRoot,'node_modules','tsx','dist','loader.mjs')).href,
        join(appRoot,'scripts','loop','windows-contained-command-entry.ts')];
      launch={...launch,command:node,args:[...wrapperArgs,'--',launch.command,...launch.args]};
      if(process.env.LOOP_DESKTOP_NODE)launch.env.ELECTRON_RUN_AS_NODE='1';
    }
    await safeAppendLog(`[Agent] 开始 lane=${context.lane || 'control'} agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - ${description}`);
    await safeAppendLog(`[执行器] executor=${executor.id} agent=${context.agent} - 启动 ${executor.label} CLI：${executor.formatCommand(workspaceRoot, executionOptions)}`);
    if (input.cancellationSignal?.aborted) {
      traceStatus = 'cancelled';
      return { exitCode: 1, finalText: '', cancelled: true };
    }
    if (input.cancellationSignal?.aborted) {
      traceStatus = 'cancelled';
      return { exitCode: 1, finalText: '', cancelled: true };
    }
    const child: ChildProcess = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      env: launch.env as NodeJS.ProcessEnv,
      stdio: [executor.promptMode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: Boolean(input.executionId || input.isolateProcessGroup) && process.platform !== 'win32',
    });
    managedChild = child;
    // Observe completion before asynchronous identity registration: a fast CLI
    // can exit (including by signal) while registration is still in progress.
    const completion = new Promise<{ code: number | null; error?: unknown }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('close', (code) => resolve({ code }));
    });
    if (allocation && child.pid) allocation.attach(child.pid, undefined,
      process.platform === 'win32' ? undefined : child.pid);
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
    if(child.pid&&process.platform==='win32'&&allocation?.containment&&strictWindowsContainment
      &&!await attachWindowsJobContainment({...allocation.containment,pid:child.pid}))
      throw new Error('Agent CLI could not enter its Windows Job container');
    let processStartMarker: string | null = null;
    let childExited = child.exitCode !== null || child.signalCode !== null;
    child.once('exit', () => { childExited = true; });
    if (executor.promptMode === 'stdin') child.stdin?.end(prompt);

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const noteProcessOutput = () => {
      if (!receivedProcessOutput) {
        try { input.monitor?.begin?.(); }
        catch (error) { monitorError ||= `Execution monitor failed: ${error instanceof Error ? error.message : String(error)}`; }
      }
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
        const events = parseAgentTelemetryStdoutEvents(executor.id, line);
        for (const event of events) enqueueTelemetry(event);
        if (events.some((event) => event.phase === 'completed')) requestSubmittedResultTermination(true);
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

    // Drain stdout/stderr while identity lookup is in progress. Otherwise a
    // short-lived CLI can close its pipes before any data listener is attached.
    if (spawnOutcome.spawned) {
      if (!child.pid) throw new Error('Agent CLI 启动后未获得 PID');
      try {
        processStartMarker = await processes.register(runId, child.pid);
        managedMarker = processStartMarker.startsWith('test-') ? undefined : processStartMarker;
        if (allocation) allocation.attach(child.pid, processStartMarker);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          await terminatePhysical(child.pid, 5_000).catch(() => false);
          throw error;
        }
      }
    }

    let terminationTask: Promise<void> | undefined;
    let terminationConfirmed = true;
    const terminate = (reason: string, kind: NonNullable<DelegationExecutionResult['terminationKind']>) => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationReason = reason;
      terminationKind=kind;
      timedOut = kind === 'timeout' || kind === 'activity-stalled';
      cancelled = kind === 'cancelled';
      // Logging must never postpone termination, even if the log store hangs.
      enqueueLog(`[执行器] executor=${executor.id} agent=${context.agent} - ${reason}，正在终止`);
      if (allocation) {
        try { allocation.requestTermination(reason); } catch { /* killing must not depend on storage */ }
      }
      terminationTask = (async () => {
        if (child.pid) {
          const relaxedWindows=process.platform==='win32'&&process.env.LOOP_RUNTIME_SAFETY==='standard';
          const expectedStartMarker = relaxedWindows||processStartMarker?.startsWith('test-') ? undefined : processStartMarker || undefined;
          const terminated = await terminatePhysical(child.pid, 5_000, expectedStartMarker).catch(() => false);
          terminationConfirmed = terminated;
          if (!terminated && !childExited) {
            try { child.kill('SIGKILL'); } catch { /* completion remains authoritative */ }
          }
        } else {
          try { child.kill('SIGTERM'); } catch { /* spawn may have failed */ }
        }
      })();
      return terminationTask;
    };
    const hasSubmittedResult = () => {
      if (submittedResult) return true;
      if (!resultChannel) return false;
      try {
        const captured = readAgentResultChannel(resultChannel);
        if (!captured) return false;
        submittedResult = captured;
        return true;
      } catch {
        // Direct replacement can be observed between truncate and write. The
        // bounded poll or final read will retry and retain the exact error if
        // the file remains invalid after physical exit.
        return false;
      }
    };
    requestSubmittedResultTermination = (toolCompleted: boolean) => {
      if (terminationRequested || !hasSubmittedResult()) return;
      if (toolCompleted) {
        if (resultSubmissionTimer) clearTimeout(resultSubmissionTimer);
        void terminate('Agent 已提交结构化结果', 'submitted');
        return;
      }
      if (resultSubmissionTimer) return;
      resultSubmissionTimer = setTimeout(() => {
        void terminate('Agent 已提交结构化结果，终止提交后的继续执行', 'submitted');
      }, input.resultSubmissionGraceMs ?? 1_000);
      resultSubmissionTimer.unref();
    };
    if (resultChannel) {
      resultSubmissionPollTimer = setInterval(() => requestSubmittedResultTermination(false), 50);
      resultSubmissionPollTimer.unref();
      requestSubmittedResultTermination(false);
    }
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
    const monitorTimer = input.monitor ? setInterval(() => {
      if (terminationRequested) return;
      try {
        const reason = monitorError || input.monitor!.failure();
        if (reason) void terminate(reason, monitorError?'timeout':input.monitor!.failureKind??'timeout');
      } catch (error) {
        void terminate(`Execution monitor failed: ${error instanceof Error ? error.message : String(error)}`, 'timeout');
      }
    }, Math.max(1, input.monitor.intervalMs)) : null;
    if (cancellationTimer) void checkCancellation();
    const onCancellationSignal = () => void terminate('需求已取消', 'cancelled');
    input.cancellationSignal?.addEventListener('abort', onCancellationSignal, { once: true });
    if (input.cancellationSignal?.aborted) onCancellationSignal();
    try {
      if (launchError) throw launchError;
      const outcome = await completion;
      if (outcome.error) throw outcome.error;
      terminalExitCode = outcome.code;
    } catch (error) {
      terminalExitCode = undefined;
      executionFailed = true;
      await safeAppendLog(`[执行器错误] executor=${executor.id} agent=${context.agent} - ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(maxTimer);
      if (startupTimer) clearTimeout(startupTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (resultSubmissionTimer) clearTimeout(resultSubmissionTimer);
      if (resultSubmissionPollTimer) clearInterval(resultSubmissionPollTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      if (monitorTimer) clearInterval(monitorTimer);
      input.cancellationSignal?.removeEventListener('abort', onCancellationSignal);
      // Root close can precede descendant cleanup; do not settle the managed
      // source until the in-flight whole-tree termination has finished.
      await terminationTask;
      if (executionFailed && child.pid && !terminationRequested) {
        terminationConfirmed = await terminatePhysical(child.pid, 5_000, managedMarker).catch(() => false);
      }
      if (!terminationRequested && !executionFailed && child.pid && (processes.confirmExit||process.platform==='win32'&&allocation?.containment)) {
        terminationConfirmed = await confirmPhysical(child.pid, 5_000, managedMarker).catch(() => false);
      }
      if (allocation) allocation.finish( terminationConfirmed,
        'CLI 已结束，但无法确认所有子进程退出');
      processSettled = true;
      if (terminationConfirmed && child.pid && processStartMarker) {
        await processes.markExited(runId, child.pid, processStartMarker).catch(() => undefined);
      }
    }
    if (!terminationConfirmed) throw new Error('Agent CLI 进程树未确认退出；保留持久化资源屏障，禁止冲突执行');
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
        if (submittedResult) await safeAppendLog('[结果通道] Agent 已通过 submit-agent-result 提交结构化结果');
      } catch (error) {
        resultSubmissionError = error instanceof Error ? error.message : String(error);
        await safeAppendLog(`[结果通道] 提交内容无效，将尝试兼容最终文本：${resultSubmissionError}`);
      }
    }
    await safeAppendLog(`[执行器] executor=${executor.id} agent=${context.agent} - ${executor.label} CLI 已退出 code=${terminalExitCode ?? 'signal'}`);
    if (cancelled) await safeAppendLog(`[Agent] 已取消 lane=${context.lane || 'control'} agent=${context.agent} requirement=${context.taskId}`);
    else if (terminalExitCode && terminalExitCode !== 0) await safeAppendLog(`[错误] ${context.agent} 执行失败 code=${terminalExitCode}`);
    else await safeAppendLog(`[Agent] 完成 lane=${context.lane || 'control'} agent=${context.agent} requirement=${context.taskId} unit=${context.storyIndex ?? '-'} flow=${context.pipeline} - 处理完成`);
    traceStatus = submittedResult ? 'completed' : timedOut ? 'timed_out' : executionFailed ? 'execution_error' : terminalExitCode === 0 ? 'completed' : terminalExitCode === null ? 'cancelled' : 'failed';
    if (evidencePersistenceError) traceStatus = 'execution_error';
    const failureDetail = [
      structuredErrorTail.trim(),
      stderrTail.trim() ? `stderr：${stderrTail.trim()}` : '',
    ].filter(Boolean).join('\n');
    return {
      exitCode: submittedResult && terminationKind === 'submitted' ? 0 : terminalExitCode ?? 1,
      ...(child.signalCode ? { signal: child.signalCode } : {}),
      ...(stderrTail.trim() ? { stderrTail: sanitizeDiagnosticText(stderrTail.trim()) } : {}),
      ...(failureDetail ? { failureDetail: sanitizeDiagnosticText(failureDetail) } : {}),
      finalText,
      ...(input.resultKind ? { submittedResult, resultSubmissionError } : {}),
      ...(evidencePersistenceError ? { evidencePersistenceError } : {}),
      ...(logPersistenceError ? { logPersistenceError } : {}),
      ...(terminationReason ? { terminationReason } : {}),
      ...(terminationKind?{terminationKind}:{}),
      ...(cancelled ? { cancelled: true as const } : {}),
    };
  } finally {
    try {
      if (allocation && !processSettled) {
        let confirmed = !managedChild?.pid;
        if (managedChild?.pid) {
          const pid = managedChild.pid;
          if (!managedMarker && (input.executionId || input.isolateProcessGroup) && process.platform !== 'win32') {
            // The first durable attachment can throw before registration.
            // Only recover identity while our actual spawned child is still
            // live; a lost root never authorizes killing a reused PID/group.
            if (managedChild.exitCode === null && managedChild.signalCode === null) {
              const identity = await waitForProcessIdentity(pid, { timeoutMs: 1000 }).catch(() => null);
              if (identity && managedChild.exitCode === null && managedChild.signalCode === null) {
                confirmed = await terminateProcessGroup(pid, 5000, identity.startMarker).catch(() => false);
              }
            }
            if (!confirmed) confirmed = await inspectProcessGroup(pid).then(members => Boolean(members && members.length === 0)).catch(() => false);
          } else confirmed = await terminatePhysical(pid, 5_000, managedMarker).catch(() => false);
        }
        allocation.finish( confirmed, '执行准备中断，进程退出尚未确认');
      }
      await telemetryQueue;
      finalText = finalText || finalTextAccumulator.value();
      await trace.end({ status: traceStatus, output: submittedResult || finalText, exitCode: terminalExitCode ?? null, timedOut, metrics: metricsAccumulator.value() });
      await telemetry.flush();
    } finally {
      removeTemporaryPrompt(temporaryPrompt);
      removeAgentResultChannel(resultChannel);
    }
  }
}
