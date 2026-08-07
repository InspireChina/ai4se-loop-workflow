#!/usr/bin/env tsx
import '../load-env.js';
import { createHash } from 'node:crypto';
import { agentExecutionOptions, getAgentExecutorSettings, getLangfuseRuntimeEnv } from '../../src/application/project-settings';
import { enqueueSoftwareMaintenance } from '../../src/application/software-maintenance';
import { buildAgentContextSnapshot, renderAgentWorkingContextPack } from '../../src/application/agent-context';
import { recordRuntimeEvent, recordRuntimeException } from '../../src/application/runtime-events';
import { loadAgentRuntime } from '../../src/application/agent-profiles';
import {
  issueAgentCommandToken,
  readAgentCommandSubmission,
} from '../../src/application/agent-command-drafts';
import {
  applyEvolutionResult,
  beginEvolutionRun,
  failEvolutionRun,
  recordExecutionFailureObservation,
  updatePromptCanary,
  type EvolutionEvidence,
} from '../../src/application/agent-evolution';
import {
  issueInternalAgentCommandToken,
  readInternalAgentCommandSubmission,
} from '../../src/application/internal-agent-command-drafts';
import { applyAgentResult, applyNextQueuedAgentResult, blockDelegation } from '../../src/application/agent-results';
import {
  beginExecutionAttempt,
  cancelExecution,
  completeExecution,
  executionCancellationRequested,
  failExecution,
  markExecutionOutput,
  markExecutionStage,
  recordExecutionReceipt,
  recoverNextExecutionAttempt,
  shouldRecordDevCodeCommit,
  PromptCanaryDeferredError,
  type ExecutionAttempt,
} from '../../src/application/executions';
import { appendLoopRunLog, CodeSlotBusyError, createLoopDispatch, endRun, getRunStatus, getTask, getTaskContext, markDelegationLaneRunning, reconcileStaleTaskLanes, recordRuntimeEventWithFallback, settleDelegationLane, startRunHeartbeat, type DelegationEnvelope } from '../../src/application/tasks';
import { laneForAgent } from '../../src/application/task-lanes';
import {
  listRecoveryItemsForStage,
  recoveryStageForAgent,
} from '../../src/application/recovery-items';
import { AgentResultContractError, parseAgentResult } from '../../src/domain/agent-result';
import { agentCommandPrompt } from '../../src/domain/agent-command-profile';
import { agentLabel, deliveryUnitLabel } from '../../src/domain/terminology';
import { getAgentExecutor, type AgentExecutor, type AgentToolClass } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { startDispatchRetryRun } from '../../src/infrastructure/agent-runner';
import { resolveAgentExecutionLimits } from '../../src/infrastructure/agent-execution-limits';
import { paths } from '../../src/infrastructure/database';
import { gitHead } from '../../src/infrastructure/git';
import { createLangfuseTelemetry, sanitizeLangfuseValue } from '../../src/infrastructure/langfuse';
import { startMaintenanceRunner } from '../../src/infrastructure/maintenance-runner';

const runId = process.argv[2];
if (!runId) throw new Error('missing run id');
const backgroundEvaluations = new Set<Promise<void>>();

function scheduleEvolution(evaluation: Promise<void>) {
  const tracked = evaluation.finally(() => { backgroundEvaluations.delete(tracked); });
  backgroundEvaluations.add(tracked);
}

async function activateMaintenanceContext(attempt: ExecutionAttempt, delegation: DelegationEnvelope) {
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

async function enqueueExecutionMaintenance(context: { executionId: string; eventFromId: number | null }, failure?: unknown) {
  try {
    if (failure) await recordRuntimeException({ runId, executionId: context.executionId, component: 'loop-runner', stage: 'finally', error: failure, fatal: true });
    else await recordRuntimeEvent({
      eventName: 'loop.execution.cycle.finished', component: 'loop-runner', body: `execution cycle finished ${context.executionId}`,
      context: { runId, executionId: context.executionId }, attributes: { maintenanceQueued: true },
    });
    const jobId = await enqueueSoftwareMaintenance({
      triggerKind: failure ? 'runner_error' : 'execution_finally',
      runId,
      executionId: context.executionId,
      eventFromId: context.eventFromId,
      severity: failure ? 'FATAL' : undefined,
      summary: failure instanceof Error ? failure.message : failure ? String(failure) : 'execution finally inspection',
    });
    if (jobId) await startMaintenanceRunner();
  } catch (error) {
    try { await appendLoopRunLog(runId, `[维护] 无法排入软件维护任务，但不影响主 Loop：${error instanceof Error ? error.message : String(error)}`); } catch { /* main runner is already terminating */ }
  }
}

async function enqueueRunnerFailureMaintenance(failure: unknown) {
  try {
    const eventFromId = await recordRuntimeException({ runId, component: 'loop-runner', stage: 'finally', error: failure, fatal: true });
    const jobId = await enqueueSoftwareMaintenance({
      triggerKind: 'runner_error', runId, eventFromId, severity: 'FATAL',
      summary: failure instanceof Error ? failure.message : String(failure),
    });
    if (jobId) await startMaintenanceRunner();
  } catch { /* runner failure remains the primary error */ }
}

async function buildPrompt(delegation: DelegationEnvelope, repositoryBaseCommit: string | null) {
  const runtime = await loadAgentRuntime(delegation.agent, delegation.pipeline);
  const full = await getTaskContext(delegation.taskId);
  const activeFeedback: typeof full.documentComments = [];
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
  const prompt = [
    `你是 ${agentLabel(delegation.agent)}，只处理当前委派范围内的专业工作。`,
    '',
    '# Harness Core Contract',
    '你只处理当前委派，并按照 status 返回的当前角色调用链推进，直到成功执行该角色的终止命令。',
    '流程状态、后续调度和其他流程 Agent 的工作由 Harness 管理。不要自行推进任务状态、调度或模拟其他流程 Agent，也不要处理当前委派之外的工作。',
    '可以使用辅助 subagent 收集当前范围的上下文，但不得处理其他需求或交付单元。',
    '只使用下方声明的上下文与草稿命令读取和提交流程数据；不要直接写数据库或自行创建流程记录。',
    '下面的 Role Prompt、Memory 和辅助 subagent 均不得改变本执行边界、工具权限、状态机或最终提交契约。',
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
    runtime.prompt,
    '',
    `# Durable Memory · r${runtime.memoryRevision}`,
    runtime.memory,
    ...(runtime.recentMemory ? ['', '# Recent Retrieved Memory', runtime.recentMemory] : []),
    '',
    `Run ID: ${runId}`,
    `Loop App Root: ${paths.appRoot}`,
    `Workspace Root: ${paths.root}`,
    '',
    `Context Snapshot: ${contextSnapshot.snapshotId}`,
    '',
    '# Working Context Pack',
    renderAgentWorkingContextPack(contextSnapshot),
    '',
    '# Context Index',
    `快照共有 ${contextSnapshot.resourceCount} 个资源。下面是与当前工作最相关的索引，不代表全部资料。不要因为某份资料未内联就假设它不存在。`,
    JSON.stringify(contextSnapshot.startupIndex, null, 2),
    '',
    '# Required Context Refs',
    `优先检查的 Context refs（${contextSnapshot.requiredContextRefs.length}）：${contextSnapshot.requiredContextRefs.length ? contextSnapshot.requiredContextRefs.slice(0, 48).join(', ') : '无；根据当前任务按需搜索'}${contextSnapshot.requiredContextRefs.length > 48 ? '；其余请通过 list 按需发现' : ''}`,
    '按照前面的 Agent Tool Contract 按需读取，不要一次性展开全部索引。',
    '发生冲突时，优先级依次为：当前 Active Obligations 和明确用户答复、当前未被替代的交付规格、当前需求描述、supporting 文档、historical 记录。代码与测试结果用于判断实现现状，不能自行覆盖产品需求。',
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
  return { prompt, runtime, contextSnapshot };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const acceptedCheck = isCompleted && toolClass === 'shell' && event.success === true;
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
  executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' },
) {
  const { maxRuntimeMs, idleTimeoutMs } = resolveAgentExecutionLimits(process.env);
  const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
  const durableToolEvent = createDurableToolEventNormalizer();
  const diagnostics: string[] = [];
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
    },
    maxRuntimeMs,
    idleTimeoutMs,
    environment: {
      LOOP_EXECUTION_ID: executionId,
      LOOP_APP_ROOT: paths.appRoot,
      LOOP_DATA_ROOT: paths.dataRoot,
      LOOP_EXECUTION_TOKEN: commandToken,
    },
    cancellationRequested: () => executionCancellationRequested(executionId),
  });
  return { ...execution, diagnostics };
}

async function processDurableResult(attempt: ExecutionAttempt, delegation: DelegationEnvelope, result: ReturnType<typeof parseAgentResult>) {
  let codeCommit = attempt.code_commit || '';
  const current = await getTask(delegation.taskId);
  if (!current || ['done', 'cancelled'].includes(current.task.agile_status)) {
    await markExecutionStage(attempt.execution_id, 'applying');
    const outcome = await applyAgentResult(runId, delegation, result, { codeCommit, executionId: attempt.execution_id });
    await recordExecutionReceipt(attempt.execution_id, 'application', outcome, { outcome, terminalTask: true });
    await completeExecution(attempt.execution_id);
    await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 返回时需求已结束，结果仅保留为证据，不再应用`);
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
  executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' },
) {
  const evolution = await beginEvolutionRun(evidence);
  if (!evolution?.prompt || !evolution.evaluatorDirectory) return;
  try {
    const command = await issueInternalAgentCommandToken('evolution', evolution.evolutionId);
    await appendLoopRunLog(runId, `[演化] 开始总结 ${agentLabel(evidence.agentId)} execution=${evidence.executionId}`);
    const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
    const execution = await executeDelegation({
      runId,
      prompt: evolution.prompt,
      workspaceRoot: evolution.evaluatorDirectory,
      executor,
      executionOptions,
      context: { agent: 'prompt-evolution-agent', taskId: evidence.taskId, storyIndex: evidence.storyIndex, pipeline: 'evolution' },
      description: `总结 ${evidence.agentId} 的可复用经验`,
      telemetry,
      appendLog: (message) => appendLoopRunLog(runId, message),
      maxRuntimeMs: Number(process.env.EVOLUTION_EVALUATOR_TIMEOUT_MS || 5 * 60 * 1000),
      idleTimeoutMs: Number(process.env.EVOLUTION_EVALUATOR_IDLE_TIMEOUT_MS || 2 * 60 * 1000),
      environment: {
        LOOP_APP_ROOT: paths.appRoot,
        LOOP_DATA_ROOT: paths.dataRoot,
        LOOP_INTERNAL_WORK_TYPE: 'evolution',
        LOOP_INTERNAL_WORK_ID: evolution.evolutionId,
        LOOP_INTERNAL_SESSION_ID: command.sessionId,
        LOOP_INTERNAL_COMMAND_TOKEN: command.token,
      },
    });
    const result = await readInternalAgentCommandSubmission('evolution', evolution.evolutionId);
    if (execution.exitCode !== 0 && !result) throw new Error(`Evaluator CLI 退出码 ${execution.exitCode}`);
    if (!result) throw new Error('Evolution Evaluator 未通过 evolution complete 提交结果');
    await applyEvolutionResult(evolution.evolutionId, evidence, result);
    await appendLoopRunLog(runId, `[演化] ${agentLabel(evidence.agentId)} 产生 ${result.observations.length} 条结构化观察`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failEvolutionRun(evolution.evolutionId, reason);
    await appendLoopRunLog(runId, `[演化] Evaluator 失败但不阻塞开发流程：${reason}`);
  }
}

async function handleExecutionFailure(attempt: ExecutionAttempt, delegation: DelegationEnvelope, reason: string, retryable: boolean) {
  const willRetry = retryable && attempt.attempt < 3;
  await failExecution(attempt.execution_id, reason, !willRetry);
  try {
    await updatePromptCanary(delegation.agent, false, attempt.execution_id);
    await recordExecutionFailureObservation({ executionId: attempt.execution_id, taskId: delegation.taskId, agentId: delegation.agent, reason });
  } catch (evolutionError) {
    await appendLoopRunLog(runId, `[演化] 失败观察写入失败但不影响主流程：${evolutionError instanceof Error ? evolutionError.message : String(evolutionError)}`);
  }
  if (willRetry) {
    await appendLoopRunLog(runId, `[恢复] execution attempt ${attempt.attempt}/3 失败，将自动重试：${reason}`);
    return;
  }
  await appendLoopRunLog(runId, `[错误] ${agentLabel(delegation.agent)} ${reason}`);
  await blockDelegation(delegation, reason);
}

async function executeDelegationStep(
  delegation: DelegationEnvelope,
  executor: AgentExecutor,
  executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' },
) {
  if (!(await isRunActive())) return;
  const task = await getTask(delegation.taskId);
  if (!task || task.task.agile_status === 'cancelled') {
    await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} 已取消，跳过尚未启动的 ${agentLabel(delegation.agent)}`);
    return;
  }
  await appendLoopRunLog(runId, `[运行] 执行任务级 Agent：requirement=${delegation.taskId} agent=${delegation.agent}`);

  let attempt: ExecutionAttempt | null = null;
  let maintenance: { executionId: string; eventFromId: number | null } | null = null;
  let unexpectedFailure: unknown;
  try {
    const headBefore = gitHead(paths.root);
    const builtPrompt = await buildPrompt(delegation, headBefore || null);
    const durable = await beginExecutionAttempt({
      runId,
      delegation,
      prompt: builtPrompt.prompt,
      baseCommit: headBefore,
      promptVersion: builtPrompt.runtime.promptVersion,
      promptTemplateVersion: builtPrompt.runtime.promptTemplateVersion,
      promptHash: builtPrompt.runtime.promptHash,
      memoryRevision: builtPrompt.runtime.memoryRevision,
      memoryHash: builtPrompt.runtime.memoryHash,
      evolutionCandidateId: builtPrompt.runtime.evolutionCandidateId,
      contextSnapshot: builtPrompt.contextSnapshot,
    });
    attempt = durable.attempt;
    await appendLoopRunLog(runId, `[上下文] requirement=${delegation.taskId} execution=${durable.attempt.execution_id} snapshot=${builtPrompt.contextSnapshot.snapshotId} resources=${builtPrompt.contextSnapshot.resourceCount} startup_index=${builtPrompt.contextSnapshot.startupIndex.length}`);
    if (await executionCancellationRequested(durable.attempt.execution_id)) {
      await cancelExecution(durable.attempt.execution_id);
      await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} 已取消，跳过尚未启动的 ${agentLabel(delegation.agent)}，代码槽已释放`);
      return;
    }
    await markDelegationLaneRunning(delegation);
    maintenance = await activateMaintenanceContext(durable.attempt, delegation);

    if (durable.recovered && durable.attempt.status === 'applied') {
      await appendLoopRunLog(runId, `[恢复] requirement=${delegation.taskId} execution attempt ${durable.attempt.execution_id} 已应用，跳过重复执行`);
      return;
    }
    if (durable.recovered && durable.attempt.result_json) {
      try {
        await processDurableResult(durable.attempt, delegation, parseAgentResult(durable.attempt.result_json));
      } catch (error) {
        await handleExecutionFailure(
          durable.attempt,
          delegation,
          error instanceof Error ? error.message : String(error),
          error instanceof AgentResultContractError,
        );
      }
      return;
    }

    const commandToken = await issueAgentCommandToken(durable.attempt.execution_id);
    if (!commandToken) {
      throw new Error(`${delegation.agent}/${delegation.pipeline} 无法签发渐进式命令凭证`);
    }
    const execution = await runDelegation(
      delegation,
      builtPrompt.prompt,
      durable.attempt.execution_id,
      commandToken,
      executor,
      executionOptions,
    );
    if (execution.cancelled) {
      await cancelExecution(durable.attempt.execution_id);
      await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} ${agentLabel(delegation.agent)} 已随需求取消，代码槽已释放`);
      return;
    }
    if (execution.evidencePersistenceError) {
      await handleExecutionFailure(
        durable.attempt,
        delegation,
        `本地执行证据写入失败，将自动重试：${execution.evidencePersistenceError}`,
        true,
      );
      return;
    }
    const commandSubmission = await readAgentCommandSubmission(durable.attempt.execution_id);
    if (execution.exitCode !== 0 && !commandSubmission) {
      await handleExecutionFailure(durable.attempt, delegation, `${executor.label} CLI 执行失败，退出码 ${execution.exitCode}`, true);
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
      await handleExecutionFailure(durable.attempt, delegation, reason, true);
      return;
    }
    await markExecutionOutput(durable.attempt.execution_id, result);
    try {
      const applied = await processDurableResult({ ...durable.attempt, result_json: JSON.stringify(result), status: 'output_received' }, delegation, result);
      const succeeded = result.outcome !== 'failed' && result.verdict !== 'failed';
      await updatePromptCanary(delegation.agent, succeeded, durable.attempt.execution_id);
      scheduleEvolution(runEvolutionEvaluator({
        executionId: durable.attempt.execution_id,
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        agentId: delegation.agent,
        attempt: durable.attempt.attempt,
        promptVersion: builtPrompt.runtime.promptVersion,
        result: { outcome: result.outcome, summary: result.summary },
        applicationOutcome: applied.outcome,
        diagnostics: execution.diagnostics,
      }, executor, executionOptions));
    } catch (error) {
      if (error instanceof CodeSlotBusyError) {
        await failExecution(durable.attempt.execution_id, error.message, false);
        await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} ${agentLabel(delegation.agent)} 结果已进入队列，等待 ${error.ownerTaskId} 释放代码槽`);
        return;
      }
      const reason = `应用 Agent 结果失败：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(durable.attempt, delegation, reason, error instanceof AgentResultContractError);
    }
  } catch (error) {
    if (error instanceof PromptCanaryDeferredError) {
      await appendLoopRunLog(runId, `[演化] requirement=${delegation.taskId} agent=${delegation.agent} ${error.message}`);
      await sleep(Number(process.env.LOOP_CANARY_DISPATCH_RETRY_MS || 5_000));
      return;
    }
    unexpectedFailure = error;
    const reason = `任务级 Agent 执行异常：${error instanceof Error ? error.message : String(error)}`;
    if (attempt) await handleExecutionFailure(attempt, delegation, reason, false);
    else {
      await appendLoopRunLog(runId, `[错误] requirement=${delegation.taskId} agent=${delegation.agent} ${reason}`);
      await blockDelegation(delegation, reason);
    }
  } finally {
    await settleDelegationLane(delegation);
    if (maintenance) await enqueueExecutionMaintenance(maintenance, unexpectedFailure);
  }
}

function normalizeDelegation(delegation: DelegationEnvelope) {
  return { ...delegation, lane: delegation.lane || laneForAgent(delegation.agent) } as DelegationEnvelope;
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
    await appendLoopRunLog(runId, `[错误] 排队结果应用失败：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''} - ${queued.reason}`);
  }
  return waiting;
}

async function main() {
  const settings = await getAgentExecutorSettings();
  const executor = getAgentExecutor(settings.executorId);
  const executionOptions = agentExecutionOptions(settings);
  const staleLanes = await reconcileStaleTaskLanes();
  if (staleLanes) await appendLoopRunLog(runId, `[恢复] 已恢复 ${staleLanes} 条失去活跃 execution 的 Lane`);
  let recoverable = await recoverNextExecutionAttempt();
  while (recoverable) {
    const snapshot = JSON.parse(recoverable.input_json) as { delegation: DelegationEnvelope };
    const delegation = normalizeDelegation(snapshot.delegation);
    const maintenance = await activateMaintenanceContext(recoverable, delegation);
    try {
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
      await handleExecutionFailure(recoverable, delegation, reason, error instanceof AgentResultContractError);
    } finally {
      await settleDelegationLane(delegation);
      await enqueueExecutionMaintenance(maintenance);
    }
    recoverable = await recoverNextExecutionAttempt();
  }

  const active = new Map<string, Promise<void>>();
  let firstDispatch = true;
  while (await isRunActive()) {
    const queuedWaiting = await drainQueuedAgentResults();
    const dispatch = await createLoopDispatch(runId, { includeRunHeader: false, logDelegations: firstDispatch });
    firstDispatch = false;
    let started = 0;
    for (const rawDelegation of dispatch.delegations) {
      const delegation = normalizeDelegation(rawDelegation);
      const key = `${delegation.taskId}:${delegation.lane}`;
      if (active.has(key)) continue;
      const execution = executeDelegationStep(delegation, executor, executionOptions)
        .catch(async (error) => {
          await appendLoopRunLog(runId, `[错误] requirement=${delegation.taskId} lane=${delegation.lane} agent=${delegation.agent} 执行器退出：${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => { active.delete(key); });
      active.set(key, execution);
      started += 1;
    }
    if (started) await appendLoopRunLog(runId, `[运行] 使用 ${executor.label} CLI，新启动 ${started} 个 Lane Agent；已有 ${active.size - started} 个继续运行`);
    if (active.size) {
      await Promise.race(active.values());
      continue;
    }
    if (backgroundEvaluations.size) {
      await Promise.race(backgroundEvaluations);
      continue;
    }
    if (queuedWaiting) {
      await sleep(Number(process.env.LOOP_ACTIVE_DISPATCH_RETRY_MS || 60 * 1000));
      continue;
    }
    await startDispatchRetryRun(runId);
    return;
  }
  await Promise.allSettled(active.values());
}

async function run() {
  let stopHeartbeat: (() => void) | undefined;
  try {
    stopHeartbeat = await startRunHeartbeat(runId, 'agent-runner');
    await main();
  } catch (error) {
    await appendLoopRunLog(runId, `[执行器错误] ${error instanceof Error ? error.message : String(error)}`);
    await endRun(runId, true, { stopRunner: false, reason: error instanceof Error ? error.message : String(error) });
    await enqueueRunnerFailureMaintenance(error);
  } finally {
    stopHeartbeat?.();
  }
}

void run();
