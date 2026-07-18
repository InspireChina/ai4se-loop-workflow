#!/usr/bin/env tsx
import '../load-env.js';
import { getAgentExecutorSettings, getLangfuseRuntimeEnv } from '../../src/application/project-settings';
import { enqueueSoftwareMaintenance } from '../../src/application/software-maintenance';
import { clearRuntimeEventContext, recordRuntimeEvent, recordRuntimeException, setRuntimeEventContext } from '../../src/application/runtime-events';
import { loadAgentRuntime } from '../../src/application/agent-profiles';
import {
  applyEvolutionResult,
  beginEvolutionRun,
  failEvolutionRun,
  recordExecutionFailureObservation,
  updatePromptCanary,
  type EvolutionEvidence,
} from '../../src/application/agent-evolution';
import { applyAgentResult, applyNextQueuedAgentResult, blockDelegation } from '../../src/application/agent-results';
import {
  beginExecutionAttempt,
  completeExecution,
  failExecution,
  markExecutionOutput,
  markExecutionStage,
  reconcileStaleExecutions,
  recordExecutionReceipt,
  recoverNextExecutionAttempt,
  type ExecutionAttempt,
} from '../../src/application/executions';
import { appendLoopRunLog, CodeSlotBusyError, createLoopDispatch, endRun, getRunStatus, getTaskContext, rewindTask, type DelegationEnvelope } from '../../src/application/tasks';
import { runHarnessVerification, type HarnessVerificationOutcome } from '../../src/application/verifications';
import { parseAgentResult } from '../../src/domain/agent-result';
import { parseEvolutionResult } from '../../src/domain/agent-evolution';
import { agentLabel, deliveryUnitLabel } from '../../src/domain/terminology';
import { getAgentExecutor, type AgentExecutor } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { startAgentRun, startDispatchRetryRun } from '../../src/infrastructure/agent-runner';
import { paths } from '../../src/infrastructure/database';
import { commitDevStory, prepareDevWorkspace } from '../../src/infrastructure/git';
import { createLangfuseTelemetry } from '../../src/infrastructure/langfuse';
import { startMaintenanceRunner } from '../../src/infrastructure/maintenance-runner';

const runId = process.argv[2];
if (!runId) throw new Error('missing run id');

let maintenanceExecutionId: string | null = null;
let maintenanceEventFromId: number | null = null;
let runnerTerminalError: unknown;

async function activateMaintenanceContext(attempt: ExecutionAttempt, delegation: DelegationEnvelope) {
  maintenanceExecutionId = attempt.execution_id;
  setRuntimeEventContext({
    runId,
    executionId: attempt.execution_id,
    taskId: delegation.taskId,
    agentId: delegation.agent,
    stage: attempt.status,
  });
  maintenanceEventFromId = await recordRuntimeEvent({
    eventName: 'loop.execution.cycle.started',
    component: 'loop-runner',
    body: `execution cycle started ${attempt.execution_id}`,
    context: { runId, executionId: attempt.execution_id, taskId: delegation.taskId, agentId: delegation.agent },
    attributes: { attempt: attempt.attempt, pipeline: delegation.pipeline, promptVersion: attempt.prompt_version, memoryRevision: attempt.memory_revision },
  });
}

async function enqueueFinallyMaintenance() {
  if (!maintenanceExecutionId && !runnerTerminalError) return;
  try {
    if (runnerTerminalError) await recordRuntimeException({ runId, executionId: maintenanceExecutionId || undefined, component: 'loop-runner', stage: 'finally', error: runnerTerminalError, fatal: true });
    else await recordRuntimeEvent({
      eventName: 'loop.execution.cycle.finished', component: 'loop-runner', body: `execution cycle finished ${maintenanceExecutionId}`,
      context: { runId, executionId: maintenanceExecutionId }, attributes: { maintenanceQueued: true },
    });
    const jobId = await enqueueSoftwareMaintenance({
      triggerKind: runnerTerminalError ? 'runner_error' : 'execution_finally',
      runId,
      executionId: maintenanceExecutionId,
      eventFromId: maintenanceEventFromId,
      severity: runnerTerminalError ? 'FATAL' : undefined,
      summary: runnerTerminalError instanceof Error ? runnerTerminalError.message : runnerTerminalError ? String(runnerTerminalError) : 'execution finally inspection',
    });
    if (jobId) await startMaintenanceRunner();
  } catch (error) {
    try { await appendLoopRunLog(runId, `[维护] 无法排入软件维护任务，但不影响主 Loop：${error instanceof Error ? error.message : String(error)}`); } catch { /* main runner is already terminating */ }
  } finally {
    clearRuntimeEventContext();
  }
}

async function buildPrompt(delegation: DelegationEnvelope) {
  const runtime = await loadAgentRuntime(delegation.agent, delegation.pipeline);
  const full = await getTaskContext(delegation.taskId);
  const relevantStory = delegation.storyIndex ? full.stories.find((story) => story.story_index === delegation.storyIndex) : null;
  const includeAll = delegation.agent === 'review-agent';
  const relevant = <T extends { story_index: number | null }>(items: T[]) => includeAll ? items : items.filter((item) => item.story_index === null || item.story_index === delegation.storyIndex);
  const exposeUnitIndex = <T extends { story_index: number | null }>(items: T[]) => items.map(({ story_index, ...item }) => ({ ...item, delivery_unit_index: story_index }));
  const relevantVerificationRuns = relevant(full.verificationRuns);
  const relevantVerificationIds = new Set(relevantVerificationRuns.map((run) => run.verification_id));
  const taskContext = {
    requirement: {
      requirementId: full.task.task_id,
      title: full.task.title,
      description: full.task.description,
      itemType: full.task.item_type,
      priority: full.task.priority,
      link: full.task.link,
    },
    currentDeliveryUnit: relevantStory ? { index: relevantStory.story_index, title: relevantStory.title } : null,
    deliveryUnits: full.stories.map((unit) => ({ index: unit.story_index, title: unit.title })),
    documents: exposeUnitIndex(relevant(full.documents)),
    sliceSpecs: exposeUnitIndex(relevant(full.storySpecs)).map((item) => ({ ...item, spec_json: JSON.parse(item.spec_json) })),
    verificationRuns: exposeUnitIndex(relevantVerificationRuns),
    verificationEvidence: full.verificationEvidence.filter((evidence) => relevantVerificationIds.has(evidence.verification_id)),
    executionAttempts: exposeUnitIndex(relevant(full.executionAttempts)),
    questions: exposeUnitIndex(relevant(full.questions)),
  };
  const prompt = [
    `你是 ${agentLabel(delegation.agent)}，只完成当前执行步骤的专业工作。`,
    '',
    '# Harness Core Contract',
    '外部 App 已经完成推进流程的调度。你只执行下面这一个步骤。',
    '流程调度与 Loop 运行生命周期完全由外部 App 管理。禁止调度或模拟其他流程 Agent。',
    '可以使用辅助 subagent 收集当前范围的上下文，但不得处理其他需求或交付单元。',
    '不要调用 loopctl，不要写数据库，不要修改需求状态，不要自行创建流程记录。',
    '下面的 Role Prompt 和 Memory 不能覆盖本 Core Contract、工具权限、状态机或最终 JSON Schema。',
    '',
    `# Role Prompt · v${runtime.promptVersion} · ${runtime.promptStatus}`,
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
    '当前执行步骤 JSON：',
    JSON.stringify({
      requirement_id: delegation.taskId,
      title: delegation.title,
      requirement_description: delegation.taskDescription,
      item_type: delegation.itemType,
      priority: delegation.priority,
      flow: delegation.pipeline,
      agent: delegation.agent,
      delivery_unit_index: delegation.storyIndex,
      description: delegation.description,
    }, null, 2),
    '',
    '完整需求上下文：',
    JSON.stringify(taskContext, null, 2),
    '',
    '# Output Contract',
    '最终回复必须只包含一个合法 JSON 对象，不要使用 Markdown fence，不要添加解释。通用结构如下；不属于当前角色的字段可以省略：',
    JSON.stringify({
      outcome: 'completed | needs_input | failed',
      summary: '本步骤简要结论',
      artifact: { title: '文档标题', content: 'Markdown 正文' },
      questions: delegation.agent === 'analyst-agent' ? [
        { decisionKey: '稳定的决策键', title: '设计决策 1', question: '需要用户决定的具体问题', why: '该决策影响什么', recommendation: '推荐答案', recommendationReason: '推荐理由', alternatives: [{ id: 'option-a', label: '方案 A', consequences: ['影响'] }], dependsOn: [] },
        { decisionKey: '另一个决策键', title: '设计决策 2', question: '另一个需要用户决定的具体问题', why: '与其他决策的依赖', recommendation: '推荐答案', recommendationReason: '推荐理由', alternatives: [{ id: 'option-b', label: '方案 B', consequences: ['影响'] }], dependsOn: ['稳定的决策键'] },
      ] : [{ title: '问题', question: '具体问题', why: '原因', recommendation: '建议' }],
      classification: 'feature | bug | tech | intake | other',
      route: 'plan | repro',
      deliveryUnits: [{ title: '可独立交付和验收的最小业务闭环' }],
      spec: delegation.agent === 'analyst-agent' ? {
        goal: '当前交付单元的用户可观察目标',
        scope: { included: ['本次包含内容'], excluded: ['明确不包含内容'] },
        behaviors: [{ scenario: '场景', expected: '期望行为' }],
        decisions: [{ key: '决策键', decision: '已确定结论', rationale: '依据', source: 'code | user | convention | safe_default' }],
        ambiguities: [],
        acceptanceCriteria: [{ id: 'AC-1', description: '可验收条件', oracle: '如何客观判断' }],
        verificationPlan: [{ criterionId: 'AC-1', kind: 'command | browser | inspection', instruction: '验证步骤', command: '可选命令' }],
        dependencies: [],
        changeBudget: { capabilities: ['允许改变的能力'], paths: ['允许影响的路径'] },
      } : undefined,
      verdict: delegation.agent === 'review-agent' ? 'report_ready' : 'passed | failed',
      rewindTo: 'plan | analysis | dev | test',
      rewindDeliveryUnit: delegation.storyIndex,
      changedFiles: ['文件路径'],
      tests: [{ command: '测试命令', passed: true, summary: '结果' }],
    }, null, 2),
  ].join('\n');
  return { prompt, runtime };
}

function delayLabel(ms: number) {
  return ms >= 60000 ? `${Math.max(1, Math.round(ms / 60000))} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRunActive() {
  const run = await getRunStatus();
  return Boolean(run?.active && run.runId === runId);
}

async function scheduleNextLoop() {
  const retryMs = Number(process.env.LOOP_ACTIVE_DISPATCH_RETRY_MS || 60 * 1000);
  await appendLoopRunLog(runId, `[运行] 本轮 Agent 已完成，${delayLabel(retryMs)}后继续 Loop`);
  await sleep(retryMs);
  if (!(await isRunActive())) return;

  await appendLoopRunLog(runId, '[运行] 继续下一轮派发');
  const dispatch = await createLoopDispatch(runId, { includeRunHeader: false });
  if (dispatch.delegations.length > 0) {
    await appendLoopRunLog(runId, `[运行] 下一轮发现 ${dispatch.delegations.length} 个执行步骤，启动逐个执行器`);
    await startAgentRun(runId);
    return;
  }
  await startDispatchRetryRun(runId);
}

async function runDelegation(delegation: DelegationEnvelope, prompt: string, executor: AgentExecutor, executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }) {
  const maxRuntimeMs = Number(process.env.AGENT_EXECUTOR_TIMEOUT_MS || process.env.CURSOR_AGENT_TIMEOUT_MS || 30 * 60 * 1000);
  const idleTimeoutMs = Number(process.env.AGENT_EXECUTOR_IDLE_TIMEOUT_MS || process.env.CURSOR_AGENT_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
  const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
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
    },
    description: delegation.description,
    telemetry,
    appendLog: async (message) => {
      if (/(?:错误|失败|warning|warn|error|timeout|timed out|not found)/i.test(message) && diagnostics.length < 30) diagnostics.push(message.slice(0, 1000));
      return appendLoopRunLog(runId, message);
    },
    maxRuntimeMs,
    idleTimeoutMs,
  });
  return { ...execution, diagnostics };
}

async function processDurableResult(attempt: ExecutionAttempt, delegation: DelegationEnvelope, result: ReturnType<typeof parseAgentResult>) {
  let codeCommit = attempt.code_commit || '';
  let harnessVerification: HarnessVerificationOutcome | null = null;
  if (delegation.agent === 'dev-agent' && result.outcome === 'completed') {
    if (!codeCommit) {
      const commit = commitDevStory(paths.root, delegation.taskId, delegation.storyIndex!, attempt.base_commit || '');
      if (!commit.ok) throw new Error(`开发实现 Agent 代码提交失败：${commit.reason}`);
      codeCommit = commit.commit;
      await recordExecutionReceipt(attempt.execution_id, 'code_commit', codeCommit, {
        taskId: delegation.taskId,
        storyIndex: delegation.storyIndex,
        mode: commit.changed ? 'committed' : 'reviewed_existing',
        reason: commit.reason,
      });
      await appendLoopRunLog(runId, commit.changed
        ? `[运行] Runner 已提交${deliveryUnitLabel(delegation.storyIndex)}：${codeCommit.slice(0, 10)}`
        : `[运行] 开发实现 Agent 已完成现有实现走查，无需新增代码；验证基线=${codeCommit.slice(0, 10)}`);
    }
    await markExecutionStage(attempt.execution_id, 'verifying');
    harnessVerification = await runHarnessVerification(delegation.taskId, delegation.storyIndex!, codeCommit, attempt.execution_id);
    await recordExecutionReceipt(attempt.execution_id, 'verification', harnessVerification.verificationId, harnessVerification);
    await appendLoopRunLog(runId, `[验证] Harness ${harnessVerification.passed ? '通过' : '失败'}：${harnessVerification.summary}`);
  }

  await markExecutionStage(attempt.execution_id, 'applying');
  const outcome = await applyAgentResult(runId, delegation, result, { codeCommit, executionId: attempt.execution_id });
  await recordExecutionReceipt(attempt.execution_id, 'application', outcome, { outcome });
  await completeExecution(attempt.execution_id);
  const outcomeLabel = { advanced: '已推进', blocked: '等待澄清', rewound: '已回退' }[outcome];
  await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 结构化结果已应用：${outcomeLabel}`);
  if (delegation.agent === 'dev-agent' && harnessVerification && !harnessVerification.passed) {
    await rewindTask({
      taskId: delegation.taskId,
      actor: 'system',
      to: 'dev',
      story: delegation.storyIndex,
      reason: `Harness 确定性验证失败：${harnessVerification.summary}`,
    });
    await appendLoopRunLog(runId, `[验证] 已自动回退${deliveryUnitLabel(delegation.storyIndex)}到开发实现，不需要人工裁决`);
  }
  return { outcome, harnessVerification };
}

async function runEvolutionEvaluator(
  evidence: EvolutionEvidence,
  executor: AgentExecutor,
  executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' },
) {
  const evolution = await beginEvolutionRun(evidence);
  if (!evolution?.prompt || !evolution.evaluatorDirectory) return;
  try {
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
    });
    if (execution.exitCode !== 0) throw new Error(`Evaluator CLI 退出码 ${execution.exitCode}`);
    const result = parseEvolutionResult(execution.finalText);
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

async function main() {
  const settings = await getAgentExecutorSettings();
  const executor = getAgentExecutor(settings.executorId);
  const executionOptions = settings.executorId === 'codex' ? {
    model: settings.codexModel || undefined,
    reasoningEffort: settings.codexReasoningEffort === 'default' ? undefined : settings.codexReasoningEffort,
  } : {};
  const staleCount = await reconcileStaleExecutions();
  if (staleCount) await appendLoopRunLog(runId, `[恢复] 已回收 ${staleCount} 个失去租约且尚无输出的 execution attempt`);
  const recoverable = await recoverNextExecutionAttempt();
  if (recoverable) {
    const snapshot = JSON.parse(recoverable.input_json) as { delegation: DelegationEnvelope };
    await activateMaintenanceContext(recoverable, snapshot.delegation);
    try {
      await appendLoopRunLog(runId, `[恢复] 继续 execution attempt ${recoverable.execution_id}，不重复调用 Agent`);
      const result = parseAgentResult(recoverable.result_json || '');
      const applied = await processDurableResult(recoverable, snapshot.delegation, result);
      const succeeded = result.outcome !== 'failed' && applied.harnessVerification?.passed !== false;
      await updatePromptCanary(snapshot.delegation.agent, succeeded, recoverable.execution_id);
      await runEvolutionEvaluator({
        executionId: recoverable.execution_id,
        taskId: recoverable.task_id,
        storyIndex: recoverable.story_index,
        agentId: recoverable.agent,
        attempt: recoverable.attempt,
        promptVersion: recoverable.prompt_version,
        result: { outcome: result.outcome, summary: result.summary },
        applicationOutcome: applied.outcome,
        harness: applied.harnessVerification,
        diagnostics: [],
      }, executor, executionOptions);
    } catch (error) {
      const reason = `恢复 execution attempt 失败：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(recoverable, snapshot.delegation, reason, false);
    }
    await scheduleNextLoop();
    return;
  }
  const queued = await applyNextQueuedAgentResult();
  let queuedWaiting = false;
  if (queued.status === 'applied') {
    await appendLoopRunLog(runId, `[运行] 已应用排队结果：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''}，结果=${queued.outcome}`);
    await scheduleNextLoop();
    return;
  }
  if (queued.status === 'waiting') {
    queuedWaiting = true;
    await appendLoopRunLog(runId, `[运行] 排队结果等待代码槽释放：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''}，当前占用=${queued.ownerTaskId}`);
  } else if (queued.status === 'failed') {
    await appendLoopRunLog(runId, `[错误] 排队结果应用失败：${agentLabel(queued.agent)} ${queued.taskId}${queued.storyIndex ? ` · ${deliveryUnitLabel(queued.storyIndex)}` : ''} - ${queued.reason}`);
  }
  const dispatch = await createLoopDispatch(runId, { includeRunHeader: false, logDelegations: false });
  if (!dispatch.delegations.length) {
    if (queuedWaiting) {
      await scheduleNextLoop();
      return;
    }
    await startDispatchRetryRun(runId);
    return;
  }
  const delegation = dispatch.delegations[0];
  if (!(await isRunActive())) return;
  await appendLoopRunLog(runId, `[运行] 使用 ${executor.label} CLI，执行 1 个 Agent 步骤`);
  await appendLoopRunLog(runId, `[运行] 执行 Agent：${agentLabel(delegation.agent)}`);

  let headBefore = '';
  if (delegation.agent === 'dev-agent') {
    const preparation = prepareDevWorkspace(paths.root, delegation.taskId, delegation.storyIndex!);
    if (!preparation.ok) {
      await blockDelegation(delegation, preparation.reason);
      await appendLoopRunLog(runId, `[错误] ${agentLabel(delegation.agent)} 未启动：${preparation.reason}`);
      await scheduleNextLoop();
      return;
    }
    if (preparation.checkpointCommit) {
      await appendLoopRunLog(runId, `[运行] Runner 已保存开发前工作区 checkpoint：${preparation.checkpointCommit}`);
    }
    headBefore = preparation.head;
  }

  const builtPrompt = await buildPrompt(delegation);
  const prompt = builtPrompt.prompt;
  const durable = await beginExecutionAttempt({
    runId,
    delegation,
    prompt,
    baseCommit: headBefore,
    promptVersion: builtPrompt.runtime.promptVersion,
    promptHash: builtPrompt.runtime.promptHash,
    memoryRevision: builtPrompt.runtime.memoryRevision,
    memoryHash: builtPrompt.runtime.memoryHash,
    evolutionCandidateId: builtPrompt.runtime.evolutionCandidateId,
    leaseMinutes: Math.ceil(Number(process.env.AGENT_EXECUTOR_TIMEOUT_MS || 30 * 60 * 1000) / 60_000) + 10,
  });
  await activateMaintenanceContext(durable.attempt, delegation);
  if (durable.recovered && durable.attempt.status === 'applied') {
    await appendLoopRunLog(runId, `[恢复] execution attempt ${durable.attempt.execution_id} 已应用，跳过重复执行`);
    await scheduleNextLoop();
    return;
  }
  if (durable.recovered && durable.attempt.result_json) {
    try {
      await processDurableResult(durable.attempt, delegation, parseAgentResult(durable.attempt.result_json));
    } catch (error) {
      await handleExecutionFailure(durable.attempt, delegation, error instanceof Error ? error.message : String(error), false);
    }
    await scheduleNextLoop();
    return;
  }

  const execution = await runDelegation(delegation, prompt, executor, executionOptions);
  if (execution.exitCode !== 0) {
    await handleExecutionFailure(durable.attempt, delegation, `${executor.label} CLI 执行失败，退出码 ${execution.exitCode}`, true);
    await scheduleNextLoop();
    return;
  }

  let result;
  try {
    result = parseAgentResult(execution.finalText);
  } catch (error) {
    const reason = `Agent 未返回合法结构化结果：${error instanceof Error ? error.message : String(error)}`;
    await handleExecutionFailure(durable.attempt, delegation, reason, true);
    await scheduleNextLoop();
    return;
  }
  await markExecutionOutput(durable.attempt.execution_id, result);
  try {
    const applied = await processDurableResult({ ...durable.attempt, result_json: JSON.stringify(result), status: 'output_received' }, delegation, result);
    const succeeded = result.outcome !== 'failed' && applied.harnessVerification?.passed !== false;
    await updatePromptCanary(delegation.agent, succeeded, durable.attempt.execution_id);
    await runEvolutionEvaluator({
      executionId: durable.attempt.execution_id,
      taskId: delegation.taskId,
      storyIndex: delegation.storyIndex,
      agentId: delegation.agent,
      attempt: durable.attempt.attempt,
      promptVersion: builtPrompt.runtime.promptVersion,
      result: { outcome: result.outcome, summary: result.summary },
      applicationOutcome: applied.outcome,
      harness: applied.harnessVerification,
      diagnostics: execution.diagnostics,
    }, executor, executionOptions);
  } catch (error) {
    if (error instanceof CodeSlotBusyError) {
      await failExecution(durable.attempt.execution_id, error.message, false);
      await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 结果已进入队列，等待 ${error.ownerTaskId} 释放代码槽`);
      await scheduleNextLoop();
      return;
    }
    const reason = `应用 Agent 结果失败：${error instanceof Error ? error.message : String(error)}`;
    await handleExecutionFailure(durable.attempt, delegation, reason, false);
  }
  await scheduleNextLoop();
}

async function run() {
  try {
    await main();
  } catch (error) {
    runnerTerminalError = error;
    await appendLoopRunLog(runId, `[执行器错误] ${error instanceof Error ? error.message : String(error)}`);
    await endRun(runId, true, { stopRunner: false, reason: error instanceof Error ? error.message : String(error) });
  } finally {
    await enqueueFinallyMaintenance();
  }
}

void run();
