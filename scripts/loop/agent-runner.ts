#!/usr/bin/env tsx
import '../load-env.js';
import { createHash } from 'node:crypto';
import { agentExecutionOptions, getAgentExecutorSettings, getAgentRuntimeSettings, getLangfuseRuntimeEnv, type AgentExecutorSettings } from '../../src/application/project-settings';
import { buildAgentContextSnapshot, renderAgentWorkingContextPack } from '../../src/application/agent-context';
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
import { loadAgentRuntime } from '../../src/application/agent-profiles';
import {
  issueAgentCommandToken,
  readAgentCommandSubmission,
  resetAgentCommandStatusForContinuation,
} from '../../src/application/agent-command-drafts';
import {
  applyEvolutionResult,
  beginEvolutionRun,
  cancelEvolutionRun,
  recordEvolutionFailureAttempt,
  recordExecutionFailureObservation,
  updatePromptCanary,
  type EvolutionEvidence,
} from '../../src/application/agent-evolution';
import {
  issueInternalAgentCommandToken,
  readInternalAgentCommandSubmission,
} from '../../src/application/internal-agent-command-drafts';
import { applyAgentResult, applyNextQueuedAgentResult } from '../../src/application/agent-results';
import {
  cancelExecution,
  completeExecution,
  deferExecutionResult,
  executionCancellationRequested,
  EXECUTION_FAILURE_MAX_RETRIES,
  failExecutionWithRetryPolicy,
  markExecutionOutput,
  markExecutionStage,
  recordExecutionReceipt,
  recordCleanExitContinuationActivity,
  shouldRecordDevCodeCommit,
  type ExecutionAttempt,
} from '../../src/application/executions';
import { buildCleanExitContinuationPrompt, shouldContinueAfterCleanExit } from '../../src/application/terminal-command-recovery';
import {
  executionRecoveryModeForAttempt,
  executionRecoveryModeLabel,
  retryRecoveryPlanForFailure,
  shouldRetryReportedFailure,
  waitForExecutionRetryBackoff,
} from '../../src/application/execution-retry-policy';
import { appendLoopRunLog, CodeSlotBusyError, endRun, getRunStatus, getTask, getTaskContext, recordRuntimeEventWithFallback, startRunHeartbeat, type DelegationEnvelope } from '../../src/application/tasks';
import { progressDispatcher, type ReservedExecution } from '../../src/application/progress-dispatch';
import {
  buildVerificationAssistancePrompt,
  claimNextVerificationAssistance,
  completeVerificationAssistanceExecution,
  finishVerificationAssistanceAttempt,
  reconcileVerificationAssistanceJobs,
  verificationAssistanceJobStatus,
  type ClaimedVerificationAssistance,
} from '../../src/application/verification-assistance';
import {
  listRecoveryItemsForStage,
  recoveryStageForAgent,
} from '../../src/application/recovery-items';
import { AgentResultContractError, parseAgentResult } from '../../src/domain/agent-result';
import { agentCommandPrompt } from '../../src/domain/agent-command-profile';
import { agentLabel, deliveryUnitLabel } from '../../src/domain/terminology';
import { getAgentExecutor, type AgentExecutionOptions, type AgentExecutor, type AgentToolClass } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import {
  createAgentExecutionTempDirectory,
  removeAgentExecutionTempDirectory,
  type AgentExecutionTempDirectory,
} from '../../src/infrastructure/agent-workspace-temp';
import { resolveAgentExecutionLimits } from '../../src/infrastructure/agent-execution-limits';
import { databaseConnection, paths } from '../../src/infrastructure/database';
import { gitHead } from '../../src/infrastructure/git';
import { createLangfuseTelemetry, sanitizeLangfuseValue } from '../../src/infrastructure/langfuse';
import { InFlightWork } from '../../src/infrastructure/in-flight-work';
import { waitForRunnerStartGate } from '../../src/infrastructure/run-process';
import {
  subscribeRuntimeEvents,
  type RuntimeEventSubscription,
  type RuntimeEventTopic,
} from '../../src/infrastructure/runtime-event-hub';
import { RunnerWakeCoordinator } from '../../src/infrastructure/runner-wake-coordinator';

const runId = process.argv[2];
if (!runId) throw new Error('missing run id');
const backgroundEvaluations = new Set<Promise<void>>();
const activeExecutionTemporaries = new Map<string, AgentExecutionTempDirectory>();
const activeExecutionControllers = new Map<string, AbortController>();
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

async function runVerificationAssistanceAttempt(job: ClaimedVerificationAssistance, settings: AgentExecutorSettings) {
  const executor = getAgentExecutor(settings.executorId);
  const executionOptions = agentExecutionOptions(settings);
  const limits = resolveAgentExecutionLimits(process.env);
  const temporary = createAgentExecutionTempDirectory(paths.root, job.executionId);
  activeExecutionTemporaries.set(job.executionId, temporary);
  try {
    const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
    const execution = await executeDelegation({
      runId,
      prompt: buildVerificationAssistancePrompt(job),
      workspaceRoot: paths.root,
      executor,
      executionOptions,
      context: {
        agent: 'system-assistance-agent',
        taskId: job.taskId,
        storyIndex: job.storyIndex,
        pipeline: 'verification-assistance',
        lane: 'control',
      },
      description: `处理验证协助：${job.title}（第 ${job.attempt}/${job.maxAttempts} 次）`,
      telemetry,
      appendLog: (message) => appendLoopRunLog(runId, message),
      recordTelemetryEvent: async (event) => {
        await recordExecutionReceipt(
          job.executionId,
          'tool_event',
          String(event.sequence).padStart(8, '0'),
          event,
        );
        const input = event.input as Record<string, unknown> | undefined;
        if (typeof input?.command === 'string' && /loop-agent\.(?:mjs|cjs)/i.test(input.command)) {
          await advanceAndPublishRuntimeInvalidation('task.progressed', job.taskId);
        }
      },
      maxRuntimeMs: limits.maxRuntimeMs,
      startupTimeoutMs: limits.startupTimeoutMs,
      idleTimeoutMs: limits.idleTimeoutMs,
      environment: {
        LOOP_VERIFICATION_ASSISTANCE_JOB_ID: job.jobId,
        LOOP_VERIFICATION_ASSISTANCE_SESSION_ID: job.sessionId,
        LOOP_VERIFICATION_ASSISTANCE_COMMAND_TOKEN: job.token,
        LOOP_AGENT_TMP_DIR: temporary.directory,
      },
      cancellationRequested: async () => {
        const db = await databaseConnection();
        const row = db.prepare(`
          SELECT job.status, task.is_paused
          FROM verification_assistance_jobs job
          JOIN tasks task ON task.task_id = job.task_id
          WHERE job.job_id = ?
        `).get(job.jobId) as { status: string; is_paused: number } | undefined;
        return !row || row.status !== 'running' || Boolean(row.is_paused);
      },
      cancellationSignal: runnerAbort.signal,
    });
    const current = await verificationAssistanceJobStatus(job.jobId);
    if (current?.status !== 'running') {
      await completeVerificationAssistanceExecution(job.executionId);
      await appendLoopRunLog(
        runId,
        current?.status === 'resolved'
          ? `[系统辅助] 已解决验证协助 requirement=${job.taskId} attempt=${job.attempt}/${job.maxAttempts}`
          : `[系统辅助] 已提交本次未解决结论 requirement=${job.taskId} attempt=${job.attempt}/${job.maxAttempts} status=${current?.status || 'missing'}`,
      );
      return;
    }
    const reason = execution.cancelled
      ? '系统辅助 Agent 因需求暂停或 Runner 停止而中断'
      : execution.exitCode !== 0
        ? execution.terminationReason
          ? `系统辅助 Agent ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
          : `系统辅助 Agent CLI 退出码 ${execution.exitCode}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
        : '系统辅助 Agent 已退出，但未执行 resolve 或 defer 终止命令';
    const result = await finishVerificationAssistanceAttempt({ jobId: job.jobId, reason, outcome: 'failed' });
    await appendLoopRunLog(
      runId,
      result.escalated
        ? `[系统辅助] ${job.maxAttempts} 次验证协助均未解决，已转交人工 requirement=${job.taskId}：${reason}`
        : `[系统辅助] 验证协助第 ${job.attempt}/${job.maxAttempts} 次失败，将继续自动尝试 requirement=${job.taskId}：${reason}`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const result = await finishVerificationAssistanceAttempt({ jobId: job.jobId, reason, outcome: 'failed' });
    await appendLoopRunLog(
      runId,
      result.escalated
        ? `[系统辅助] 验证协助重试已耗尽，已转交人工 requirement=${job.taskId}：${reason}`
        : `[系统辅助] 验证协助执行异常，将继续自动尝试 requirement=${job.taskId} attempt=${job.attempt}/${job.maxAttempts}：${reason}`,
    );
  } finally {
    activeExecutionTemporaries.delete(job.executionId);
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

function boundedRecoveryText(value: string, limit: number) {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${value.slice(0, head)}\n\n[中间内容因恢复包限额省略；需要时通过角色命令和 agent-context 按需读取]\n\n${value.slice(-tail)}`;
}

async function buildPrompt(
  delegation: DelegationEnvelope,
  repositoryBaseCommit: string | null,
  attemptNumber = 1,
) {
  const runtime = await loadAgentRuntime(delegation.agent, delegation.pipeline);
  const full = await getTaskContext(delegation.taskId);
  const delegatedFeedbackIds = new Set([delegation.feedbackId, ...(delegation.feedbackIds || [])].filter(Boolean));
  const activeFeedback = full.documentComments.filter((comment) => delegatedFeedbackIds.has(comment.comment_id));
  const recoveryStage = recoveryStageForAgent(delegation.agent);
  const activeRecovery = recoveryStage
    ? await listRecoveryItemsForStage({ taskId: delegation.taskId, storyIndex: delegation.storyIndex, stage: recoveryStage })
    : [];
  const contextSnapshot = buildAgentContextSnapshot({
    delegation,
    full,
    activeFeedback,
    activeRecovery,
    repositoryBaseCommit,
  });
  const commandPrompt = agentCommandPrompt(paths.appRoot, delegation.agent, delegation.pipeline);
  if (!commandPrompt) {
    throw new Error(`${delegation.agent}/${delegation.pipeline} 没有配置渐进式命令协议`);
  }
  const recoveryMode = executionRecoveryModeForAttempt(attemptNumber);
  const recoveryLabel = executionRecoveryModeLabel(recoveryMode);
  const retryNumber = Math.max(0, attemptNumber - 1);
  const projectPrompt = recoveryMode === 'compact'
    ? boundedRecoveryText(runtime.prompt, 12_000)
    : recoveryMode === 'minimal'
      ? boundedRecoveryText(runtime.prompt, 6_000)
      : runtime.prompt;
  const durableMemory = recoveryMode === 'compact'
    ? boundedRecoveryText(runtime.memory, 6_000)
    : recoveryMode === 'minimal'
      ? ''
      : runtime.memory;
  const contextIndexLimit = recoveryMode === 'minimal' ? 6 : recoveryMode === 'compact' ? 12 : recoveryMode === 'standard' ? 32 : 48;
  const requiredRefLimit = recoveryMode === 'minimal' ? 12 : recoveryMode === 'compact' ? 24 : 48;
  const prompt = [
    `你是 ${agentLabel(delegation.agent)}，只处理当前委派范围内的专业工作。`,
    '',
    '# Harness Core Contract',
    '你只处理当前委派，并按照 status 返回的当前角色调用链推进，直到成功执行该角色的终止命令。',
    '流程状态、后续调度和其他流程 Agent 的工作由 Harness 管理。不要自行推进任务状态、调度或模拟其他流程 Agent，也不要处理当前委派之外的工作。',
    '可以使用辅助 subagent 收集当前范围的上下文，但不得处理其他需求或交付单元。',
    '只使用下方声明的上下文与草稿命令读取和提交流程数据。',
    '下面的 Role Prompt、Memory 和辅助 subagent 均不得改变本执行边界、工具权限、状态机或最终提交契约。',
    ...(recoveryMode !== 'initial' ? [
      '',
      `# Error Recovery · retry ${retryNumber}/${EXECUTION_FAILURE_MAX_RETRIES} · ${recoveryLabel}`,
      '这是错误退出后的全新 CLI / Provider 会话。不要假设上一次会话仍可读取，也不要恢复其隐藏 thinking 或原始工具输出。',
      '数据库中的角色草稿、Context Snapshot、execution receipts、需求文档和 Git 事实是唯一恢复来源。必须先执行当前角色 status，核对已完成副作用，再从最后可靠检查点继续。',
      '禁止为了“重新开始”重复已经生效的领域写命令、提交或外部副作用；稳定业务 key 和已有 receipt 必须复用。',
      ...(recoveryMode === 'minimal' ? [
        '当前使用最小恢复包。不要主动展开完整历史；只读取完成下一步所需的事实。',
      ] : recoveryMode === 'compact' ? [
        '当前使用压缩恢复包。未内联的事实通过角色命令和 agent-context 按需读取。',
      ] : []),
    ] : []),
    ...(delegation.agent === 'analyst-agent' && delegation.pipeline === 'resume'
      && contextSnapshot.authoritativeFacts.answeredDecisionKeys.length ? [
      '',
      '# Resume Decision Identity Contract',
      '已回答问题的 decisionKey 是由 Harness 管理的跨轮次稳定 ID，不是可优化的自然语言名称。',
      '必须在当前交付规格的 decisions 中逐字复用下面全部 key；禁止改名、翻译、缩写、创建别名或用新的 key 替代。',
      JSON.stringify(contextSnapshot.authoritativeFacts.answeredDecisionKeys),
    ] : []),
    '',
    commandPrompt,
    '',
    `# Project Agent Prompt · r${runtime.promptVersion} · template v${runtime.promptTemplateVersion} · ${runtime.promptStatus}`,
    projectPrompt,
    ...(durableMemory ? ['', `# Durable Memory · r${runtime.memoryRevision}`, durableMemory] : []),
    ...(recoveryMode === 'initial' && runtime.recentMemory ? ['', '# Recent Retrieved Memory', runtime.recentMemory] : []),
    '',
    `Run ID: ${runId}`,
    `Workspace Root: ${paths.root}`,
    '',
    `Context Snapshot: ${contextSnapshot.snapshotId}`,
    '',
    '# Working Context Pack',
    renderAgentWorkingContextPack(contextSnapshot, recoveryMode),
    '',
    '# Context Index',
    `快照共有 ${contextSnapshot.resourceCount} 个资源。下面是与当前工作最相关的索引，不代表全部资料。不要因为某份资料未内联就假设它不存在。`,
    JSON.stringify(contextSnapshot.startupIndex.slice(0, contextIndexLimit), null, 2),
    '',
    '# Required Context Refs',
    `优先检查的 Context refs（${contextSnapshot.requiredContextRefs.length}）：${contextSnapshot.requiredContextRefs.length ? contextSnapshot.requiredContextRefs.slice(0, requiredRefLimit).join(', ') : '无；根据当前任务按需搜索'}${contextSnapshot.requiredContextRefs.length > requiredRefLimit ? '；其余请通过 list 按需发现' : ''}`,
    '按照前面的 Agent Tool Contract 按需读取，不要一次性展开全部索引。',
    '发生冲突时，优先级依次为：当前 Active Obligations 和明确用户答复、当前未被替代的交付规格、当前交付单元及其冻结来源、已完成的业务变化上下文与交付计划、当前需求描述、supporting 文档、historical 记录。代码与测试结果用于判断实现现状，不能自行覆盖产品需求。',
    ...(activeFeedback.length ? [
      '',
      '# Active Feedback Contract',
      '下面的反馈已经由 Feedback Agent 完成 Triage，并明确路由给你。完成当前角色工作时必须处理这些 acceptance，并在 feedbackResolutions 中逐条提交 Resolution Claim；不要自行标记评论 resolved。',
      '具体内容已包含在 Working Context Pack 的 Active Obligations，并以 FEEDBACK ref 持久化在快照中。',
    ] : []),
    ...(activeRecovery.length ? [
      '',
      '# Active Recovery Contract',
      '下面是 Test Agent 持久化的未解决失败证据。它们不是历史备注，而是当前交付单元需要继续闭环的上下文。',
      '交付分析 Agent 和开发实现 Agent 应处理与当前阶段有关的事项；可以在 recoveryResolutions 中说明处理方式，但 Claim 不是推进的硬条件，也不能自行关闭事项。只有后续 Test Agent 独立验证通过才能关闭失败事项。',
      '具体内容已包含在 Working Context Pack 的 Active Obligations，并以 RECOVERY ref 持久化在快照中。',
    ] : []),
  ].join('\n');
  return {
    prompt,
    runtime,
    contextSnapshot,
    recovery: { mode: recoveryMode, label: recoveryLabel, retryNumber },
  };
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
  limitOverrides?: Partial<ReturnType<typeof resolveAgentExecutionLimits>>,
) {
  const limits = { ...resolveAgentExecutionLimits(process.env), ...limitOverrides };
  const { maxRuntimeMs, startupTimeoutMs, idleTimeoutMs } = limits;
  const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
  const durableToolEvent = createDurableToolEventNormalizer();
  const diagnostics: string[] = [];
  const temporary = createAgentExecutionTempDirectory(paths.root, executionId);
  activeExecutionTemporaries.set(executionId, temporary);
  try {
    const execution = await executeDelegation({
      runId,
      prompt,
      workspaceRoot: paths.root,
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

async function processDurableResult(attempt: ExecutionAttempt, delegation: DelegationEnvelope, result: ReturnType<typeof parseAgentResult>) {
  let codeCommit = attempt.code_commit || '';
  const current = await getTask(delegation.taskId);
  if (!current || current.task.is_paused || ['done', 'cancelled'].includes(current.task.agile_status)) {
    await markExecutionStage(attempt.execution_id, 'applying');
    const outcome = await applyAgentResult(runId, delegation, result, { codeCommit, executionId: attempt.execution_id });
    await recordExecutionReceipt(attempt.execution_id, 'application', outcome, { outcome, terminalTask: true });
    await completeExecution(attempt.execution_id);
    await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 返回时需求已结束或暂停，结果仅保留为证据，不再应用`);
    return { outcome };
  }
  if (shouldRecordDevCodeCommit(delegation.agent, result) && !codeCommit) {
    const currentHead = gitHead(paths.root);
    if (currentHead) {
      codeCommit = currentHead;
      await recordExecutionReceipt(attempt.execution_id, 'code_commit', codeCommit, {
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        mode: 'agent_committed',
      });
      await appendLoopRunLog(runId, `[运行] 记录开发实现 Agent 变更所在 commit：${codeCommit.slice(0, 10)}`);
    } else {
      await appendLoopRunLog(runId, '[运行] 开发实现 Agent 声明了代码变更，但当前 Git HEAD 不可读；不记录代码提交证据');
    }
  } else if (delegation.agent === 'dev-agent' && result.outcome === 'completed' && !result.changedFiles?.length) {
    await appendLoopRunLog(runId, '[运行] 开发实现 Agent 走查确认无需代码变更；不记录代码提交证据');
  }

  await markExecutionStage(attempt.execution_id, 'applying');
  const outcome = await applyAgentResult(runId, delegation, result, { codeCommit, executionId: attempt.execution_id });
  await recordExecutionReceipt(attempt.execution_id, 'application', outcome, { outcome });
  await completeExecution(attempt.execution_id);
  const outcomeLabel = { advanced: '已推进', blocked: '等待澄清', rewound: '已回退', discarded: '已丢弃副作用' }[outcome];
  await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 结构化结果已应用：${outcomeLabel}`);
  return { outcome };
}

async function runEvolutionEvaluator(
  evidence: EvolutionEvidence,
  executor: AgentExecutor,
  executionOptions: AgentExecutionOptions,
) {
  const evolution = await beginEvolutionRun(evidence);
  if (!evolution?.prompt || !evolution.evaluatorDirectory) return;
  for (let failureAttempt = 1; failureAttempt <= EXECUTION_FAILURE_MAX_RETRIES + 1; failureAttempt += 1) {
    try {
      const recoveryMode = executionRecoveryModeForAttempt(failureAttempt);
      const recoveryPrompt = recoveryMode === 'initial' ? evolution.prompt : [
        `# Error Recovery · retry ${failureAttempt - 1}/${EXECUTION_FAILURE_MAX_RETRIES} · ${executionRecoveryModeLabel(recoveryMode)}`,
        '这是错误退出后的全新 CLI / Provider 会话。只从持久化 Evolution 草稿继续，先读取当前 status，避免重复已经提交的观察。',
        '',
        recoveryMode === 'compact'
          ? boundedRecoveryText(evolution.prompt, 12_000)
          : recoveryMode === 'minimal'
            ? boundedRecoveryText(evolution.prompt, 6_000)
            : evolution.prompt,
      ].join('\n');
      const command = await issueInternalAgentCommandToken('evolution', evolution.evolutionId);
      await appendLoopRunLog(runId, `[演化] 开始总结 ${agentLabel(evidence.agentId)} execution=${evidence.executionId} recovery=${recoveryMode}`);
      const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
      const execution = await executeDelegation({
        runId,
        prompt: recoveryPrompt,
        workspaceRoot: evolution.evaluatorDirectory,
        executor,
        executionOptions,
        context: { agent: 'prompt-evolution-agent', taskId: evidence.taskId, storyIndex: evidence.storyIndex, pipeline: 'evolution' },
        description: `总结 ${evidence.agentId} 的可复用经验`,
        telemetry,
        appendLog: (message) => appendLoopRunLog(runId, message),
        maxRuntimeMs: Number(process.env.EVOLUTION_EVALUATOR_TIMEOUT_MS || 5 * 60 * 1000),
        startupTimeoutMs: Number(process.env.EVOLUTION_EVALUATOR_STARTUP_TIMEOUT_MS || 20 * 60 * 1000),
        idleTimeoutMs: Number(process.env.EVOLUTION_EVALUATOR_IDLE_TIMEOUT_MS || 2 * 60 * 1000),
        environment: {
          LOOP_APP_ROOT: paths.appRoot,
          LOOP_DATA_ROOT: paths.dataRoot,
          LOOP_INTERNAL_WORK_TYPE: 'evolution',
          LOOP_INTERNAL_WORK_ID: evolution.evolutionId,
          LOOP_INTERNAL_SESSION_ID: command.sessionId,
          LOOP_INTERNAL_COMMAND_TOKEN: command.token,
        },
        cancellationSignal: runnerAbort.signal,
      });
      if (execution.cancelled) {
        await cancelEvolutionRun(evolution.evolutionId, 'Runner 已停止，取消后台 Evolution Evaluator');
        await appendLoopRunLog(runId, `[演化] Runner 已停止，取消 ${agentLabel(evidence.agentId)} 的后台总结`);
        return;
      }
      const result = await readInternalAgentCommandSubmission('evolution', evolution.evolutionId);
      if (execution.exitCode !== 0 && !result) {
        throw new Error(execution.terminationReason
          ? `Evaluator CLI ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
          : `Evaluator CLI 退出码 ${execution.exitCode}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`);
      }
      if (!result) throw new Error('Evolution Evaluator 未通过 evolution complete 提交结果');
      await applyEvolutionResult(evolution.evolutionId, evidence, result);
      await appendLoopRunLog(runId, `[演化] ${agentLabel(evidence.agentId)} 产生 ${result.observations.length} 条结构化观察`);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const retry = await recordEvolutionFailureAttempt({
        evolutionId: evolution.evolutionId,
        evidence,
        error: reason,
        failureAttempt,
        maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
      });
      await appendLoopRunLog(
        runId,
        retry.willRetry
          ? `[演化] Evaluator 第 ${failureAttempt} 次失败，将自动重试 ${failureAttempt}/${EXECUTION_FAILURE_MAX_RETRIES}：${reason}`
          : `[演化] Evaluator ${EXECUTION_FAILURE_MAX_RETRIES} 次自动重试已耗尽，但不阻塞开发流程：${reason}`,
      );
      if (!retry.willRetry) return;
      await waitForExecutionRetryBackoff(failureAttempt, runnerAbort.signal);
    }
  }
}

async function handleExecutionFailure(
  attempt: ExecutionAttempt,
  delegation: DelegationEnvelope,
  reason: string,
  failureKind = 'agent-execution',
) {
  const retry = await failExecutionWithRetryPolicy(attempt.execution_id, reason, {
    kind: failureKind,
    maxRetries: EXECUTION_FAILURE_MAX_RETRIES,
  });
  if (retry.ignored) return;
  const willRetry = retry.willRetry;
  try {
    await updatePromptCanary(delegation.agent, false, attempt.execution_id);
    await recordExecutionFailureObservation({ executionId: attempt.execution_id, taskId: delegation.taskId, agentId: delegation.agent, reason });
  } catch (evolutionError) {
    await appendLoopRunLog(runId, `[演化] 失败观察写入失败但不影响主流程：${evolutionError instanceof Error ? evolutionError.message : String(evolutionError)}`);
  }
  if (willRetry) {
    const recovery = retryRecoveryPlanForFailure(retry.failureAttempt);
    await appendLoopRunLog(
      runId,
      `[恢复] ${failureKind} 执行失败，将自动重试 ${retry.failureAttempt}/${retry.maxRetries}${recovery ? `（${recovery.label}）` : ''}：${reason}`,
    );
    return;
  }
  await appendLoopRunLog(runId, `[错误] ${agentLabel(delegation.agent)} ${reason}`);
}

async function executeDelegationStep(
  reservation: ReservedExecution,
) {
  const delegation = reservation.work;
  if (!(await isRunActive())) {
    await progressDispatcher.settle({ reservationId: reservation.reservationId });
    return;
  }
  const task = await getTask(delegation.taskId);
  if (!task || task.task.agile_status === 'cancelled' || task.task.is_paused) {
    await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} 已取消或暂停，跳过尚未启动的 ${agentLabel(delegation.agent)}`);
    await progressDispatcher.settle({ reservationId: reservation.reservationId });
    return;
  }
  await appendLoopRunLog(runId, `[运行] 执行任务级 Agent：requirement=${delegation.taskId} agent=${delegation.agent}`);

  let attempt: ExecutionAttempt | null = null;
  let cycle: { executionId: string; eventFromId: number | null } | null = null;
  let unexpectedFailure: unknown;
  try {
    const runtimeSettings = await getAgentRuntimeSettings(delegation.agent);
    const executor = getAgentExecutor(runtimeSettings.executorId);
    const executionOptions = agentExecutionOptions(runtimeSettings);
    await appendLoopRunLog(runId, `[Runtime] requirement=${delegation.taskId} agent=${delegation.agent} executor=${executor.id} model=${executionOptions.model || 'default'} reasoning=${executionOptions.reasoningEffort || 'default'} web_search=${executionOptions.webSearch ? 'enabled' : 'disabled'}`);
    const headBefore = gitHead(paths.root);
    const builtPrompt = await buildPrompt(delegation, headBefore || null, reservation.attempt);
    const activated = await progressDispatcher.activate({
      reservationId: reservation.reservationId,
      prepared: {
        prompt: builtPrompt.prompt,
        baseCommit: headBefore,
        recovery: builtPrompt.recovery,
        promptMetadata: {
          version: builtPrompt.runtime.promptVersion,
          templateVersion: builtPrompt.runtime.promptTemplateVersion,
          hash: builtPrompt.runtime.promptHash,
        },
        memory: {
          revision: builtPrompt.runtime.memoryRevision,
          hash: builtPrompt.runtime.memoryHash,
        },
        evolutionCandidateId: builtPrompt.runtime.evolutionCandidateId,
        contextSnapshot: builtPrompt.contextSnapshot,
        runtime: {
          executorId: runtimeSettings.executorId,
          model: executionOptions.model,
          reasoningEffort: executionOptions.reasoningEffort,
          webSearchEnabled: Boolean(executionOptions.webSearch),
        },
      },
    });
    if (activated.kind === 'invalidated') {
      await appendLoopRunLog(runId, `[调度] requirement=${delegation.taskId} reservation=${reservation.reservationId} 启动前失效：${activated.reason}`);
      return;
    }
    attempt = activated.attempt;
    await appendLoopRunLog(runId, `[上下文] requirement=${delegation.taskId} execution=${attempt.execution_id} snapshot=${builtPrompt.contextSnapshot.snapshotId} resources=${builtPrompt.contextSnapshot.resourceCount} startup_index=${builtPrompt.contextSnapshot.startupIndex.length} recovery=${builtPrompt.recovery.mode}`);
    if (await executionCancellationRequested(attempt.execution_id)) {
      const currentTask = await getTask(delegation.taskId);
      const paused = Boolean(currentTask?.task.is_paused);
      await cancelExecution(attempt.execution_id, paused ? '需求已暂停' : '需求已取消');
      await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} 已${paused ? '暂停' : '取消'}，跳过尚未启动的 ${agentLabel(delegation.agent)}，执行资源已释放`);
      return;
    }
    cycle = await recordExecutionCycleStarted(attempt, delegation);

    const commandToken = await issueAgentCommandToken(attempt.execution_id);
    if (!commandToken) {
      throw new Error(`${delegation.agent}/${delegation.pipeline} 无法签发渐进式命令凭证`);
    }
    const cancellation = new AbortController();
    activeExecutionControllers.set(attempt.execution_id, cancellation);
    let execution: Awaited<ReturnType<typeof runDelegation>>;
    let commandSubmission: Awaited<ReturnType<typeof readAgentCommandSubmission>>;
    let continuationCount = 0;
    try {
      let nextPrompt = builtPrompt.prompt;
      let combinedDiagnostics: string[] = [];
      let previousStderrTail: string | undefined;
      let previousFailureDetail: string | undefined;
      while (true) {
        let currentExecution: Awaited<ReturnType<typeof runDelegation>>;
        try {
          currentExecution = await runDelegation(
            delegation,
            nextPrompt,
            attempt.execution_id,
            commandToken,
            executor,
            executionOptions,
            cancellation.signal,
          );
        } catch (error) {
          if (continuationCount > 0) {
            const reason = error instanceof Error ? error.message : String(error);
            await recordCleanExitContinuationActivity(attempt.execution_id, 'failed', continuationCount, reason);
          }
          throw error;
        }
        combinedDiagnostics = [...combinedDiagnostics, ...currentExecution.diagnostics];
        execution = {
          ...currentExecution,
          diagnostics: combinedDiagnostics,
          stderrTail: currentExecution.stderrTail || previousStderrTail,
          failureDetail: currentExecution.failureDetail || previousFailureDetail,
        };
        previousStderrTail = execution.stderrTail;
        previousFailureDetail = execution.failureDetail;
        commandSubmission = await readAgentCommandSubmission(attempt.execution_id);
        if (!shouldContinueAfterCleanExit({
          exitCode: execution.exitCode,
          hasSubmission: Boolean(commandSubmission),
          cancelled: Boolean(execution.cancelled),
          evidencePersistenceError: execution.evidencePersistenceError,
        })) break;

        continuationCount += 1;
        await recordCleanExitContinuationActivity(attempt.execution_id, 'scheduled', continuationCount);
        try {
          const statusGateReset = await resetAgentCommandStatusForContinuation(attempt.execution_id);
          await appendLoopRunLog(runId, `[自动续跑] requirement=${delegation.taskId} execution=${attempt.execution_id} CLI exit 0 但没有角色终止提交，立即继续同一 execution（第 ${continuationCount} 次，不消耗失败重试额度${statusGateReset ? '，已要求重新读取 status' : ''}）`);
          nextPrompt = buildCleanExitContinuationPrompt({
            originalPrompt: builtPrompt.prompt,
            previousFinalText: execution.finalText,
            continuationNumber: continuationCount,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await recordCleanExitContinuationActivity(attempt.execution_id, 'failed', continuationCount, `准备续跑失败：${reason}`);
          throw error;
        }
      }
      if (continuationCount > 0) {
        if (commandSubmission) {
          await recordCleanExitContinuationActivity(attempt.execution_id, 'succeeded', continuationCount);
          await appendLoopRunLog(runId, `[自动续跑] requirement=${delegation.taskId} execution=${attempt.execution_id} 经过 ${continuationCount} 次续跑后收到角色终止提交`);
        } else if (execution.cancelled) {
          await recordCleanExitContinuationActivity(attempt.execution_id, 'stopped', continuationCount, '需求已暂停或取消');
        } else {
          const reason = execution.evidencePersistenceError
            ? `本地执行证据写入失败：${execution.evidencePersistenceError}`
            : execution.terminationReason
              ? `${executor.label} CLI ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
              : `CLI 退出码 ${execution.exitCode}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`;
          await recordCleanExitContinuationActivity(attempt.execution_id, 'failed', continuationCount, reason);
        }
      }
    } finally {
      activeExecutionControllers.delete(attempt.execution_id);
    }
    await progressDispatcher.executionExited({ reservationId: reservation.reservationId });
    if (execution.cancelled) {
      const currentTask = await getTask(delegation.taskId);
      const paused = Boolean(currentTask?.task.is_paused);
      await cancelExecution(attempt.execution_id, paused ? '需求已暂停' : '需求已取消');
      await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} ${agentLabel(delegation.agent)} 已随需求${paused ? '暂停' : '取消'}，执行资源已释放`);
      return;
    }
    if (execution.evidencePersistenceError) {
      await handleExecutionFailure(
        attempt,
        delegation,
        `本地执行证据写入失败，将自动重试：${execution.evidencePersistenceError}`,
        'evidence-persistence',
      );
      return;
    }
    commandSubmission ||= await readAgentCommandSubmission(attempt.execution_id);
    if (execution.exitCode !== 0 && !commandSubmission) {
      const exitDiagnostic = [
        `退出码 ${execution.exitCode}`,
        execution.signal ? `signal ${execution.signal}` : '',
        execution.failureDetail || '',
      ].filter(Boolean).join('；');
      await handleExecutionFailure(
        attempt,
        delegation,
        execution.terminationReason
          ? `${executor.label} CLI ${execution.terminationReason}${execution.failureDetail ? `；${execution.failureDetail}` : ''}`
          : `${executor.label} CLI 执行失败，${exitDiagnostic}`,
        execution.terminationReason ? 'agent-timeout' : 'agent-cli-exit',
      );
      return;
    }

    let result;
    try {
      if (!commandSubmission) {
        throw new Error('Agent 退出前没有成功执行角色终止命令；普通最终文本不会推进流程');
      }
      result = commandSubmission;
      await appendLoopRunLog(runId, `[Agent 命令] requirement=${delegation.taskId} ${delegation.agent} 已通过领域终止命令提交结果`);
    } catch (error) {
      const reason = `Agent 未通过角色终止命令提交结果：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(attempt, delegation, reason, 'agent-missing-terminal-command');
      return;
    }
    if (shouldRetryReportedFailure(result, attempt.attempt)) {
      const reason = `Agent 提交失败结果，将按统一策略重试：${result.summary || result.outcome || result.verdict || '未提供摘要'}`;
      await handleExecutionFailure(attempt, delegation, reason, 'agent-reported-failure');
      return;
    }
    await markExecutionOutput(attempt.execution_id, result);
    try {
      const applied = await processDurableResult({ ...attempt, result_json: JSON.stringify(result), status: 'output_received' }, delegation, result);
      const succeeded = result.outcome !== 'failed' && result.verdict !== 'failed';
      await updatePromptCanary(delegation.agent, succeeded, attempt.execution_id);
      scheduleEvolution(runEvolutionEvaluator({
        executionId: attempt.execution_id,
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        agentId: delegation.agent,
        attempt: attempt.attempt,
        promptVersion: builtPrompt.runtime.promptVersion,
        result: { outcome: result.outcome, summary: result.summary },
        applicationOutcome: applied.outcome,
        diagnostics: execution.diagnostics,
      }, executor, executionOptions));
    } catch (error) {
      if (error instanceof CodeSlotBusyError) {
        await deferExecutionResult(attempt.execution_id, error.message);
        await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} ${agentLabel(delegation.agent)} 结果已进入队列，等待 ${error.ownerTaskId} 释放代码槽`);
        return;
      }
      const reason = `应用 Agent 结果失败：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(
        attempt,
        delegation,
        reason,
        error instanceof AgentResultContractError ? 'agent-result-contract' : 'agent-result-application',
      );
    }
  } catch (error) {
    unexpectedFailure = error;
    const reason = `任务级 Agent 执行异常：${error instanceof Error ? error.message : String(error)}`;
    if (attempt) await handleExecutionFailure(attempt, delegation, reason, 'agent-execution');
    else {
      const preparation = await progressDispatcher.preparationFailed({ reservationId: reservation.reservationId, error: reason });
      await appendLoopRunLog(runId, preparation.kind === 'retry'
        ? `[恢复] requirement=${delegation.taskId} prompt 准备失败，执行第 ${preparation.attempt}/${EXECUTION_FAILURE_MAX_RETRIES} 次重试（${retryRecoveryPlanForFailure(preparation.attempt)?.label || '恢复包'}）：${reason}`
        : `[错误] requirement=${delegation.taskId} agent=${delegation.agent} ${reason}`);
    }
  } finally {
    await progressDispatcher.executionExited({ reservationId: reservation.reservationId });
    await progressDispatcher.settle({ reservationId: reservation.reservationId });
    if (cycle) await recordExecutionCycleFinished(cycle, unexpectedFailure);
  }
}

function delegationLaneKey(reservation: ReservedExecution) {
  return `${reservation.work.taskId}:${reservation.work.lane}`;
}

function launchDelegation(
  reservation: ReservedExecution,
  inFlightExecutions: InFlightWork<ReservedExecution>,
) {
  const delegation = reservation.work;
  const key = delegationLaneKey(reservation);
  return inFlightExecutions.launch(
    key,
    reservation,
    () => executeDelegationStep(reservation).finally(() => runnerWake.wake('execution-completed')),
    async (error) => {
      try {
        await appendLoopRunLog(runId, `[错误] requirement=${delegation.taskId} lane=${delegation.lane} agent=${delegation.agent} 执行器退出：${error instanceof Error ? error.message : String(error)}`);
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
  const staleAssistance = await reconcileVerificationAssistanceJobs();
  if (staleAssistance) await appendLoopRunLog(runId, `[恢复] 已恢复 ${staleAssistance} 条未正常收尾的系统验证协助`);
  let recovery = await progressDispatcher.nextRecovery();
  while (recovery) {
    const { attempt: recoverable, work: delegation } = recovery;
    const cycle = await recordExecutionCycleStarted(recoverable, delegation);
    try {
      const runtimeSettings = await getAgentRuntimeSettings(delegation.agent);
      const executor = getAgentExecutor(runtimeSettings.executorId);
      const executionOptions = agentExecutionOptions(runtimeSettings);
      await appendLoopRunLog(runId, `[恢复] 继续 execution attempt ${recoverable.execution_id}，不重复调用 Agent`);
      const result = parseAgentResult(recoverable.result_json || '');
      const applied = await processDurableResult(recoverable, delegation, result);
      const succeeded = result.outcome !== 'failed' && result.verdict !== 'failed';
      await updatePromptCanary(delegation.agent, succeeded, recoverable.execution_id);
      scheduleEvolution(runEvolutionEvaluator({
        executionId: recoverable.execution_id,
        taskId: recoverable.task_id,
        storyIndex: recoverable.story_index,
        agentId: recoverable.agent,
        attempt: recoverable.attempt,
        promptVersion: recoverable.prompt_version,
        result: { outcome: result.outcome, summary: result.summary },
        applicationOutcome: applied.outcome,
        diagnostics: [],
      }, executor, executionOptions));
    } catch (error) {
      const reason = `恢复 execution attempt 失败：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(
        recoverable,
        delegation,
        reason,
        error instanceof AgentResultContractError ? 'agent-result-contract' : 'agent-result-application',
      );
    } finally {
      await progressDispatcher.settleRecoveredExecution({ executionId: recoverable.execution_id });
      await recordExecutionCycleFinished(cycle);
    }
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
    const assistance = await claimNextVerificationAssistance({
      runId,
      executorId: systemSettings.executorId,
      executionOptions: agentExecutionOptions(systemSettings),
    });
    if (assistance) {
      scheduleEvolution(runVerificationAssistanceAttempt(assistance, systemSettings));
      await appendLoopRunLog(
        runId,
        `[调度] 启动系统验证协助 Agent：requirement=${assistance.taskId} unit=${assistance.storyIndex ?? '-'} attempt=${assistance.attempt}/${assistance.maxAttempts}`,
      );
    }
    const dispatch = await progressDispatcher.reserveNext({ runId });
    let launched = 0;
    for (const reservation of dispatch.kind === 'reserved' ? dispatch.reservations : []) {
      const delegation = reservation.work;
      if (launchDelegation(reservation, inFlightExecutions)) {
        launched += 1;
        await appendLoopRunLog(runId, `[调度] 启动 Lane Agent：requirement=${delegation.taskId} lane=${delegation.lane} agent=${delegation.agent} resources=${reservation.claimedResources.join(',') || 'none'}`);
      }
    }
    if (launched) {
      await appendLoopRunLog(runId, `[调度] 当前运行 ${inFlightExecutions.size} 个 Lane Agent`);
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
