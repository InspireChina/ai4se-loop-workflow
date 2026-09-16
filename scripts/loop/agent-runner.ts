#!/usr/bin/env tsx
import '../load-env.js';
import { createHash } from 'node:crypto';
import { applyNextQueuedAgentResult } from '../../src/application/agent-results';
import { buildDelegationPrompt } from '../../src/application/delegation-prompt';
import { runEvolutionEvaluator } from '../../src/application/evolution-execution';
import { createExecutionCoordinator } from '../../src/application/execution-coordinator';
import {
  executionCancellationReason,
  executionCancellationRequested,
  recordExecutionReceipt,
  type ExecutionAttempt
} from '../../src/application/executions';
import {
  buildInterventionPrompt,
  cancelInterventionAttempt,
  claimNextIntervention,
  finishInterventionAttempt,
  interventionStatus,
  reconcileInterventions,
  type ClaimedIntervention,
} from '../../src/application/interventions';
import { appendLoopRunLog, recordRuntimeEventWithFallback } from '../../src/application/loop-run-log';
import { endRun, getRunStatus, startRunHeartbeat } from '../../src/application/loop-runs';
import { progressDispatcher, type ReservedExecution } from '../../src/application/progress-dispatch';
import { agentExecutionOptions, getAgentExecutorSettings, getLangfuseRuntimeEnv, type AgentExecutorSettings } from '../../src/application/project-settings';
import {
  advanceAndPublishRuntimeInvalidation,
  recordRuntimeEvent,
  recordRuntimeException,
  runtimeEventRevisionInDb,
} from '../../src/application/runtime-events';
import {
  materializeDueScheduledRequirements,
  nextScheduledRequirementWakeAt,
} from '../../src/application/scheduled-requirements';
import { getTask, type DelegationEnvelope } from '../../src/application/tasks';
import { agentLabel, deliveryUnitLabel } from '../../src/domain/terminology';
import { resolveAgentExecutionLimits } from '../../src/infrastructure/agent-execution-limits';
import { getAgentExecutor, type AgentExecutionOptions, type AgentExecutor, type AgentToolClass } from '../../src/infrastructure/agent-executor';
import {
  createAgentExecutionTempDirectory,
  removeAgentExecutionTempDirectory,
  type AgentExecutionTempDirectory,
} from '../../src/infrastructure/agent-workspace-temp';
import { databaseConnection, paths } from '../../src/infrastructure/database';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { InFlightWork, executionInFlightKey } from '../../src/infrastructure/in-flight-work';
import { createLangfuseTelemetry, sanitizeLangfuseValue } from '../../src/infrastructure/langfuse';
import { waitForRunnerStartGate } from '../../src/infrastructure/run-process';
import { RunnerWakeCoordinator } from '../../src/infrastructure/runner-wake-coordinator';
import {
  subscribeRuntimeEvents,
  type RuntimeEventSubscription,
  type RuntimeEventTopic,
} from '../../src/infrastructure/runtime-event-hub';

const runId = process.argv[2];
if (!runId) throw new Error('missing run id');
const backgroundEvaluations = new Set<Promise<void>>();
const activeExecutionTemporaries = new Map<string, AgentExecutionTempDirectory>();
const activeExecutionControllers = new Map<string, AbortController>();
const executionCoordinator = createExecutionCoordinator({
  runId, isRunActive, invoke: runDelegation,
  buildPrompt: (work, base, attempt, workspace, projectId) => buildDelegationPrompt(runId, work, base, attempt, workspace, projectId),
  evaluate: (evidence, executor, settings) => runEvolutionEvaluator(runId, runnerAbort.signal, evidence, executor, settings),
  scheduleEvaluation: scheduleEvolution,
  controllers: activeExecutionControllers,
  cycleStarted: recordExecutionCycleStarted, cycleFinished: recordExecutionCycleFinished,
});
const runnerWake = new RunnerWakeCoordinator();
const runnerAbort = new AbortController();
let cancellationSweepRequested = false;
const SAFETY_RECONCILE_MS = Number(process.env.LOOP_SAFETY_RECONCILE_MS || 30 * 60 * 1000);
const RUNNER_EVENT_TOPICS = [
  'dispatch.invalidated',
  'schedule.invalidated',
  'execution.cancel-requested',
  'lifecycle.runner-stop-requested',
] as const satisfies readonly RuntimeEventTopic[];

function scheduleEvolution(evaluation: Promise<void>) {
  const tracked = evaluation.finally(() => {
    backgroundEvaluations.delete(tracked);
    runnerWake.wake('background-completed');
  });
  backgroundEvaluations.add(tracked);
}


async function runInterventionAttempt(intervention: ClaimedIntervention, settings: AgentExecutorSettings) {
  const executor = getAgentExecutor(settings.executorId);
  const executionOptions = agentExecutionOptions(settings);
  const limits = resolveAgentExecutionLimits(process.env);
  const task = await getTask(intervention.taskId);
  const workspaceRoot = task?.task.work_dir || paths.root;
  const temporary = createAgentExecutionTempDirectory(workspaceRoot, intervention.executionId);
  activeExecutionTemporaries.set(intervention.executionId, temporary);
  try {
    const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
    const execution = await executeDelegation({
      runId,
      prompt: buildInterventionPrompt(intervention),
      executionId: intervention.executionId,
      workspaceRoot,
      executor,
      executionOptions,
      context: {
        agent: 'system-assistance-agent',
        taskId: intervention.taskId,
        storyIndex: intervention.storyIndex,
        pipeline: 'intervention',
        lane: 'control',
      },
      description: `处理${intervention.authority === 'arbitration' ? '仲裁' : '介入'}事项（第 ${intervention.attempt}/${intervention.maxAttempts} 次）`,
      telemetry,
      appendLog: (message) => appendLoopRunLog(runId, message),
      recordTelemetryEvent: async (event) => {
        await recordExecutionReceipt(
          intervention.executionId,
          'tool_event',
          String(event.sequence).padStart(8, '0'),
          event,
        );
        const input = event.input as Record<string, unknown> | undefined;
        if (typeof input?.command === 'string' && /loop-agent\.(?:mjs|cjs)/i.test(input.command)) {
          await advanceAndPublishRuntimeInvalidation('task.progressed', intervention.taskId);
        }
      },
      maxRuntimeMs: limits.maxRuntimeMs,
      startupTimeoutMs: limits.startupTimeoutMs,
      idleTimeoutMs: limits.idleTimeoutMs,
      environment: {
        LOOP_INTERVENTION_ID: intervention.interventionId,
        LOOP_INTERVENTION_SESSION_ID: intervention.sessionId,
        LOOP_INTERVENTION_COMMAND_TOKEN: intervention.token,
        LOOP_AGENT_TMP_DIR: temporary.directory,
      },
      cancellationRequested: async () => {
        const current = await interventionStatus(intervention.interventionId);
        return !current || current.status !== 'running'
          || await executionCancellationRequested(intervention.executionId, { resolvingInterventionId: intervention.interventionId });
      },
      cancellationSignal: runnerAbort.signal,
    });
    const current = await interventionStatus(intervention.interventionId);
    if (current?.status !== 'running') {
      await appendLoopRunLog(
        runId,
        current?.status === 'resolved'
          ? `[系统辅助] 已解决${intervention.authority === 'arbitration' ? '仲裁' : '介入'}事项 requirement=${intervention.taskId} attempt=${intervention.attempt}/${intervention.maxAttempts}`
          : `[系统辅助] 已提交本次未解决结论 requirement=${intervention.taskId} attempt=${intervention.attempt}/${intervention.maxAttempts} status=${current?.status || 'missing'}`,
      );
      return;
    }
    if (execution.cancelled || runnerAbort.signal.aborted
      || await executionCancellationRequested(intervention.executionId, { resolvingInterventionId: intervention.interventionId })) {
      await cancelInterventionAttempt(intervention.interventionId, await executionCancellationReason(intervention.executionId));
      await appendLoopRunLog(runId, `[系统辅助] 介入执行已中断，不消耗重试额度 requirement=${intervention.taskId}`);
      return;
    }
    const reason = execution.exitCode !== 0
      ? execution.terminationReason
        ? `系统辅助 Agent ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
        : `系统辅助 Agent CLI 退出码 ${execution.exitCode}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
      : '系统辅助 Agent 已退出，但未执行 resolve 或 defer 终止命令';
    const result = await finishInterventionAttempt({
      interventionId: intervention.interventionId,
      reason,
      outcome: 'failed',
    });
    await appendLoopRunLog(
      runId,
      result.escalated
        ? `[系统辅助] ${intervention.maxAttempts} 次介入均未解决，已转交人工 requirement=${intervention.taskId}：${reason}`
        : `[系统辅助] 介入第 ${intervention.attempt}/${intervention.maxAttempts} 次失败，将继续自动尝试 requirement=${intervention.taskId}：${reason}`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (runnerAbort.signal.aborted || await executionCancellationRequested(intervention.executionId, { resolvingInterventionId: intervention.interventionId })) {
      await cancelInterventionAttempt(intervention.interventionId, `系统辅助 Agent 中断：${reason}`);
      return;
    }
    const result = await finishInterventionAttempt({
      interventionId: intervention.interventionId,
      reason,
      outcome: 'failed',
    });
    await appendLoopRunLog(
      runId,
      result.escalated
        ? `[系统辅助] 介入重试已耗尽，已转交人工 requirement=${intervention.taskId}：${reason}`
        : `[系统辅助] 介入执行异常，将继续自动尝试 requirement=${intervention.taskId} attempt=${intervention.attempt}/${intervention.maxAttempts}：${reason}`,
    );
  } finally {
    activeExecutionTemporaries.delete(intervention.executionId);
    removeAgentExecutionTempDirectory(temporary);
  }
}

async function recordExecutionCycleStarted(attempt: ExecutionAttempt, delegation: DelegationEnvelope) {
  let eventFromId: number | null = null;
  eventFromId = await recordRuntimeEventWithFallback(
    runId,
    'cycle.started 结构化事件写入失败，不影响主流程',
    () => recordRuntimeEvent({
      eventName: 'loop.execution.cycle.started',
      component: 'loop-runner',
      body: `execution cycle started ${attempt.execution_id}`,
      context: { runId, executionId: attempt.execution_id, taskId: delegation.taskId, agentId: delegation.agent },
      attributes: { attempt: attempt.attempt, pipeline: delegation.pipeline, promptVersion: attempt.prompt_version, memoryRevision: attempt.memory_revision },
    }),
  );
  return { executionId: attempt.execution_id, eventFromId };
}

async function recordExecutionCycleFinished(context: { executionId: string; eventFromId: number | null }, failure?: unknown) {
  try {
    if (failure) await recordRuntimeException({ runId, executionId: context.executionId, component: 'loop-runner', stage: 'finally', error: failure, fatal: true });
    else await recordRuntimeEvent({
      eventName: 'loop.execution.cycle.finished', component: 'loop-runner', body: `execution cycle finished ${context.executionId}`,
      context: { runId, executionId: context.executionId }, attributes: { startedEventId: context.eventFromId },
    });
  } catch (error) {
    try { await appendLoopRunLog(runId, `[日志] 无法保存 execution 收尾事件，但不影响主 Loop：${error instanceof Error ? error.message : String(error)}`); } catch { /* main runner is already terminating */ }
  }
}

async function recordRunnerFailure(failure: unknown) {
  try {
    await recordRuntimeException({ runId, component: 'loop-runner', stage: 'finally', error: failure, fatal: true });
  } catch { /* runner failure remains the primary error */ }
}


async function isRunActive() {
  const run = await getRunStatus();
  return Boolean(run?.active && run.runId === runId);
}

function commandFromToolInput(input: unknown) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

function commandMetadata(command: string | undefined) {
  if (command === undefined) return {};
  return {
    commandHash: createHash('sha256').update(command).digest('hex'),
    originalLength: command.length,
  };
}

function createDurableToolEventNormalizer() {
  type StartedTool = {
    toolClass: AgentToolClass;
    command?: string;
  };
  const startedByCallId = new Map<string, StartedTool>();
  const anonymousStarts: StartedTool[] = [];

  return (event: {
    name: string;
    phase?: string;
    executor: string;
    tool?: string;
    toolClass?: AgentToolClass;
    toolCallId?: string;
    sequence: number;
    summary?: string;
    input?: unknown;
    success?: boolean;
    exitCode?: number | null;
    level?: string;
  }) => {
    if (event.name !== 'loop.agent.tool') return null;
    const eventToolClass = event.toolClass ?? 'unknown';
    const eventCommand = commandFromToolInput(event.input);
    let started: StartedTool | undefined;
    if (event.phase === 'started') {
      started = { toolClass: eventToolClass, command: eventCommand };
      if (event.toolCallId) startedByCallId.set(event.toolCallId, started);
      else anonymousStarts.push(started);
    } else if (event.phase === 'completed') {
      started = event.toolCallId
        ? startedByCallId.get(event.toolCallId)
        : anonymousStarts.shift();
      if (event.toolCallId) startedByCallId.delete(event.toolCallId);
    }
    const toolClass = eventToolClass === 'unknown'
      ? started?.toolClass ?? 'unknown'
      : eventToolClass;
    const command = eventCommand ?? started?.command;
    const isCompleted = event.phase === 'completed';
    const acceptedCheck = isCompleted && event.success === true;
    return sanitizeLangfuseValue({
      name: event.name,
      phase: event.phase,
      executor: event.executor,
      tool: event.tool,
      toolClass,
      toolCallId: event.toolCallId,
      sequence: event.sequence,
      summary: event.summary,
      level: isCompleted ? (acceptedCheck ? 'DEFAULT' : 'ERROR') : event.level,
      ...(isCompleted ? {
        success: event.success === true,
        exitCode: event.exitCode ?? null,
      } : {}),
      ...commandMetadata(command),
      ...(command !== undefined ? { input: { command } } : {}),
    });
  };
}

async function runDelegation(
  delegation: DelegationEnvelope,
  prompt: string,
  executionId: string,
  commandToken: string,
  executor: AgentExecutor,
  executionOptions: AgentExecutionOptions,
  cancellationSignal: AbortSignal,
  workspaceRoot: string,
  limitOverrides?: Partial<ReturnType<typeof resolveAgentExecutionLimits>>,
) {
  const limits = { ...resolveAgentExecutionLimits(process.env), ...limitOverrides };
  const { maxRuntimeMs, startupTimeoutMs, idleTimeoutMs } = limits;
  const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
  const durableToolEvent = createDurableToolEventNormalizer();
  const diagnostics: string[] = [];
  const temporary = createAgentExecutionTempDirectory(workspaceRoot, executionId);
  activeExecutionTemporaries.set(executionId, temporary);
  try {
    const execution = await executeDelegation({
      runId,
      prompt,
      executionId,
      workspaceRoot,
      executor,
      executionOptions,
      context: {
        agent: delegation.agent,
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        pipeline: delegation.pipeline,
        lane: delegation.lane,
      },
      description: delegation.description,
      telemetry,
      appendLog: async (message) => {
        if (/(?:错误|失败|warning|warn|error|timeout|timed out|not found)/i.test(message) && diagnostics.length < 30) diagnostics.push(message.slice(0, 1000));
        return appendLoopRunLog(runId, message);
      },
      recordTelemetryEvent: async (event) => {
        const receipt = durableToolEvent(event);
        if (!receipt) return;
        await recordExecutionReceipt(
          executionId,
          'tool_event',
          String(event.sequence).padStart(8, '0'),
          receipt,
        );
        const input = (receipt as Record<string, unknown>).input as Record<string, unknown> | undefined;
        if (typeof input?.command === 'string' && /loop-agent\.(?:mjs|cjs)/i.test(input.command)) {
          await advanceAndPublishRuntimeInvalidation('task.progressed', delegation.taskId);
        }
      },
      maxRuntimeMs,
      startupTimeoutMs,
      idleTimeoutMs,
      environment: {
        LOOP_EXECUTION_ID: executionId,
        LOOP_APP_ROOT: paths.appRoot,
        LOOP_DATA_ROOT: paths.dataRoot,
        LOOP_EXECUTION_TOKEN: commandToken,
        LOOP_AGENT_TMP_DIR: temporary.directory,
      },
      cancellationSignal,
    });
    return { ...execution, diagnostics };
  } finally {
    activeExecutionTemporaries.delete(executionId);
    const cleanup = removeAgentExecutionTempDirectory(temporary);
    if (!cleanup.ok) {
      try { await appendLoopRunLog(runId, `[临时文件] execution=${executionId} 临时目录清理失败：${cleanup.error}`); } catch { /* Execution result remains primary. */ }
    }
  }
}




function launchDelegation(
  reservation: ReservedExecution,
  inFlightExecutions: InFlightWork<ReservedExecution>,
) {
  const delegation = reservation.work;
  const key = executionInFlightKey(reservation);
  return inFlightExecutions.launch(
    key,
    reservation,
    () => executionCoordinator.execute(reservation).finally(() => runnerWake.wake('execution-completed')),
    async (error) => {
      try {
        await appendLoopRunLog(runId, `[错误] requirement=${delegation.taskId} execution=${reservation.executionId} work_item=${delegation.workItemId} revision=${delegation.workItemRevision} agent=${delegation.agent} 执行器退出：${error instanceof Error ? error.message : String(error)}`);
      } catch { /* An execution failure must not reject the scheduler promise. */ }
    },
  );
}

async function drainQueuedAgentResults() {
  let waiting = false;
  while (true) {
    const queued = await applyNextQueuedAgentResult();
    if (queued.status === 'none') break;
    if (queued.status === 'applied') {
      await appendLoopRunLog(runId, `[运行] 已应用排队结果：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''}，结果=${queued.outcome}`);
      continue;
    }
    if (queued.status === 'waiting') {
      waiting = true;
      await appendLoopRunLog(runId, `[运行] 排队结果等待代码槽释放：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''}，当前占用=${queued.ownerTaskId}`);
      break;
    }
    await appendLoopRunLog(
      runId,
      queued.willRetry
        ? `[恢复] 排队结果应用失败，已计入统一重试：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''} - ${queued.reason}`
        : `[错误] 排队结果应用失败且重试已耗尽：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''} - ${queued.reason}`,
    );
  }
  return waiting;
}

async function cancelInvalidExecutions() {
  if (!cancellationSweepRequested) return;
  cancellationSweepRequested = false;
  for (const [executionId, controller] of activeExecutionControllers) {
    if (await executionCancellationRequested(executionId)) controller.abort();
  }
}

async function main() {
  const staleLanes = await progressDispatcher.reconcileStaleLanes();
  if (staleLanes) await appendLoopRunLog(runId, `[恢复] 已恢复 ${staleLanes} 条失去活跃 execution 的 Lane`);
  const staleInterventions = await reconcileInterventions();
  if (staleInterventions) await appendLoopRunLog(runId, `[恢复] 已恢复 ${staleInterventions} 条未正常收尾的系统介入事项`);
  let recovery = await progressDispatcher.nextRecovery();
  while (recovery) {
    await executionCoordinator.recover(recovery.attempt, recovery.work);
    recovery = await progressDispatcher.nextRecovery();
  }

  const inFlightExecutions = new InFlightWork<ReservedExecution>();
  let safetyReconcileAt = Date.now() + SAFETY_RECONCILE_MS;
  while (await isRunActive()) {
    const wakeRevision = runnerWake.revision();
    await cancelInvalidExecutions();
    const scheduled = await materializeDueScheduledRequirements();
    for (const item of scheduled.created) {
      await appendLoopRunLog(runId, `[定时需求] plan=${item.planId} 已创建 requirement=${item.taskId} scheduled_for=${item.scheduledFor}`);
    }
    for (const item of scheduled.failed) {
      await appendLoopRunLog(runId, `[定时需求] plan=${item.planId} 创建失败，将在 ${item.retryAt} 重试：${item.error}`);
    }
    const completionRevision = inFlightExecutions.revision();
    await drainQueuedAgentResults();
    const systemSettings = await getAgentExecutorSettings();
    const intervention = await claimNextIntervention({
      runId,
      executorId: systemSettings.executorId,
      executionOptions: agentExecutionOptions(systemSettings),
    });
    if (intervention) {
      scheduleEvolution(runInterventionAttempt(intervention, systemSettings));
      await appendLoopRunLog(
        runId,
        `[调度] 启动系统${intervention.authority === 'arbitration' ? '仲裁' : '介入'} Agent：requirement=${intervention.taskId} attempt=${intervention.attempt}/${intervention.maxAttempts}`,
      );
    }
    const dispatch = await progressDispatcher.reserveNext({ runId });
    let launched = 0;
    for (const reservation of dispatch.kind === 'reserved' ? dispatch.reservations : []) {
      const delegation = reservation.work;
      if (launchDelegation(reservation, inFlightExecutions)) {
        launched += 1;
        await appendLoopRunLog(runId, `[调度] 启动 Work Item Agent：requirement=${delegation.taskId} execution=${reservation.executionId} work_item=${delegation.workItemId} revision=${delegation.workItemRevision} epoch=${delegation.workItemEpoch} agent=${delegation.agent} resources=${reservation.claimedResources.join(',') || 'none'}`);
      }
    }
    if (launched) {
      await appendLoopRunLog(runId, `[调度] 当前运行 ${inFlightExecutions.size} 个 Work Item 执行`);
    }
    if (inFlightExecutions.revision() !== completionRevision) {
      await appendLoopRunLog(runId, '[调度] Lane execution 已结束，立即重新计算可执行步骤');
      continue;
    }
    if (launched) continue;
    if (dispatch.kind === 'run-stopped') return;
    if (Date.now() >= safetyReconcileAt) safetyReconcileAt = Date.now() + SAFETY_RECONCILE_MS;
    const scheduleWakeAt = await nextScheduledRequirementWakeAt();
    const retryWakeAt = dispatch.kind === 'wait' && dispatch.wake.kind === 'retry-after'
      ? new Date(dispatch.wake.notBefore).getTime()
      : null;
    const deadline = [scheduleWakeAt, retryWakeAt, safetyReconcileAt]
      .filter((value): value is number => value !== null && Number.isFinite(value))
      .reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY);
    const waits: Promise<unknown>[] = [runnerWake.wait(wakeRevision, deadline)];
    if (inFlightExecutions.size) waits.push(inFlightExecutions.waitForNextCompletion(completionRevision));
    if (backgroundEvaluations.size) waits.push(Promise.race(backgroundEvaluations));
    if (!inFlightExecutions.size && !backgroundEvaluations.size) {
      const reason = scheduleWakeAt !== null && scheduleWakeAt === deadline
        ? `下一定时需求 ${new Date(scheduleWakeAt).toISOString()}`
        : retryWakeAt !== null && retryWakeAt === deadline
          ? `下一重试 ${new Date(retryWakeAt).toISOString()}`
          : '等待事件';
      await appendLoopRunLog(runId, `[运行] 当前没有可执行 Agent，事件驱动休眠：${reason}`);
    }
    await Promise.race(waits);
  }
}

async function run() {
  let stopHeartbeat: (() => void) | undefined;
  let runtimeEvents: RuntimeEventSubscription | undefined;
  try {
    const startGateToken = process.env.LOOP_RUNNER_START_GATE_TOKEN;
    if (startGateToken) await waitForRunnerStartGate(runId, startGateToken);
    stopHeartbeat = await startRunHeartbeat(runId, 'agent-runner');
    const eventRevisions = new Map<string, number>();
    const synchronizeEventRevisions = async () => {
      const db = await databaseConnection();
      let changed = false;
      for (const topic of RUNNER_EVENT_TOPICS) {
        const revision = runtimeEventRevisionInDb(db, topic);
        const seen = eventRevisions.get(topic) || 0;
        if (revision <= seen) continue;
        eventRevisions.set(topic, revision);
        if (topic === 'execution.cancel-requested') cancellationSweepRequested = true;
        changed = true;
      }
      if (changed) runnerWake.wake('runtime-event');
    };
    runtimeEvents = subscribeRuntimeEvents({
      topics: RUNNER_EVENT_TOPICS,
      onReady: synchronizeEventRevisions,
      onEvent: (event) => {
        const seen = eventRevisions.get(event.topic) || 0;
        if (event.revision <= seen) return;
        eventRevisions.set(event.topic, event.revision);
        if (event.topic === 'execution.cancel-requested') cancellationSweepRequested = true;
        if (event.topic === 'lifecycle.runner-stop-requested') {
          runnerAbort.abort();
          for (const controller of activeExecutionControllers.values()) controller.abort();
        }
        runnerWake.wake('runtime-event');
      },
    });
    await Promise.race([
      runtimeEvents.ready,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 Runtime Event Hub 就绪超时')), 10_000);
        timer.unref();
      }),
    ]);
    await main();
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    try { process.stderr.write(`[Runner 错误] run=${runId}\n${detail}\n`); } catch { /* raw diagnostic is best-effort */ }
    await appendLoopRunLog(runId, `[执行器错误] ${detail}`);
    await endRun(runId, true, {
      stopRunner: false,
      preserveRunIntent: true,
      reason: error instanceof Error ? error.message : String(error),
    });
    await recordRunnerFailure(error);
    process.exitCode = 1;
  } finally {
    runnerAbort.abort();
    for (const controller of activeExecutionControllers.values()) controller.abort();
    activeExecutionControllers.clear();
    runtimeEvents?.close();
    runnerWake.close();
    stopHeartbeat?.();
    for (const temporary of activeExecutionTemporaries.values()) {
      const cleanup = removeAgentExecutionTempDirectory(temporary);
      if (!cleanup.ok) {
        try { await appendLoopRunLog(runId, `[临时文件] Runner 收尾清理 execution=${temporary.executionId} 失败：${cleanup.error}`); } catch { /* Runner is already terminating. */ }
      }
    }
    activeExecutionTemporaries.clear();
  }
}

let fatalExitStarted = false;

function fatalRunnerExit(origin: 'uncaughtException' | 'unhandledRejection' | 'topLevelRejection', error: unknown) {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  const message = `[Runner 致命错误] run=${runId} origin=${origin}\n${detail}`;
  try { process.stderr.write(`${message}\n`); } catch { /* parent-owned diagnostic file remains best-effort */ }
  const forcedExit = setTimeout(() => process.exit(1), 2_000);
  void appendLoopRunLog(runId, message)
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(forcedExit);
      process.exit(1);
    });
}

process.on('uncaughtException', (error) => fatalRunnerExit('uncaughtException', error));
process.on('unhandledRejection', (error) => fatalRunnerExit('unhandledRejection', error));

void run().catch((error) => fatalRunnerExit('topLevelRejection', error));
