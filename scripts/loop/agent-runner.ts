#!/usr/bin/env tsx
import '../load-env.js';
import { join } from 'node:path';
import { agentExecutionOptions, getAgentExecutorSettings, getLangfuseRuntimeEnv } from '../../src/application/project-settings';
import { enqueueSoftwareMaintenance } from '../../src/application/software-maintenance';
import { buildAgentContextSnapshot } from '../../src/application/agent-context';
import { recordRuntimeEvent, recordRuntimeException } from '../../src/application/runtime-events';
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
  recordExecutionReceipt,
  recoverNextExecutionAttempt,
  type ExecutionAttempt,
} from '../../src/application/executions';
import { appendLoopRunLog, CodeSlotBusyError, createLoopDispatch, endRun, getRunStatus, getTask, getTaskContext, markDelegationLaneRunning, reconcileStaleTaskLanes, recordRuntimeEventWithFallback, settleDelegationLane, startRunHeartbeat, type DelegationEnvelope } from '../../src/application/tasks';
import { laneForAgent } from '../../src/application/task-lanes';
import {
  listRecoveryItemsForStage,
  recoveryStageForAgent,
} from '../../src/application/recovery-items';
import { AgentResultContractError, parseAgentResult } from '../../src/domain/agent-result';
import { parseEvolutionResult } from '../../src/domain/agent-evolution';
import { agentLabel, deliveryUnitLabel } from '../../src/domain/terminology';
import { getAgentExecutor, type AgentExecutor } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { startDispatchRetryRun } from '../../src/infrastructure/agent-runner';
import { resolveAgentExecutionLimits } from '../../src/infrastructure/agent-execution-limits';
import { paths } from '../../src/infrastructure/database';
import { gitHead } from '../../src/infrastructure/git';
import { createLangfuseTelemetry } from '../../src/infrastructure/langfuse';
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
  const activeFeedback = full.documentComments.filter((comment) =>
    comment.feedback_status === 'in_progress'
    && comment.feedback_needs_rebase === 0
    && comment.target_agent === delegation.agent
    && (comment.target_story_index == null || comment.target_story_index === delegation.storyIndex));
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
  const contextCommand = `npm --prefix ${JSON.stringify(paths.appRoot)} run loopctl -- agent-context`;
  const prompt = [
    `你是 ${agentLabel(delegation.agent)}，只完成当前执行步骤的专业工作。`,
    '',
    '# Harness Core Contract',
    '外部 App 已经完成推进流程的调度。你只执行下面这一个步骤。',
    '流程调度与 Loop 运行生命周期完全由外部 App 管理。禁止调度或模拟其他流程 Agent。',
    '可以使用辅助 subagent 收集当前范围的上下文，但不得处理其他需求或交付单元。',
    '除下方只读 agent-context 命令外，不要调用其他 loopctl 命令；不要写数据库，不要修改需求状态，不要自行创建流程记录。',
    '下面的 Role Prompt 和 Memory 不能覆盖本 Core Contract、工具权限、状态机或最终 JSON Schema。',
    ...(delegation.agent === 'analyst-agent' && delegation.pipeline === 'resume'
      && contextSnapshot.authoritativeFacts.answeredDecisionKeys.length ? [
      '',
      '# Resume Decision Identity Contract',
      '已回答问题的 decisionKey 是由 Harness 管理的跨轮次稳定 ID，不是可优化的自然语言名称。',
      '必须在新 Slice Spec 的 decisionTree 和 decisions 中逐字复用下面全部 key；禁止改名、翻译、缩写、创建别名或用新的 key 替代。',
      JSON.stringify(contextSnapshot.authoritativeFacts.answeredDecisionKeys),
    ] : []),
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
    `Context Snapshot: ${contextSnapshot.snapshotId}`,
    '',
    '# Working Context Pack',
    '下面只包含本次执行必须立即知道的权威事实、活动义务和最近交接。它是本次 execution 的冻结快照。',
    JSON.stringify({
      work: contextSnapshot.work,
      authoritativeFacts: contextSnapshot.authoritativeFacts,
      activeObligations: contextSnapshot.activeObligations,
      handoff: contextSnapshot.handoff,
    }, null, 2),
    '',
    '# Context Index',
    `快照共有 ${contextSnapshot.resourceCount} 个资源。下面是与当前工作最相关的索引，不代表全部资料。不要因为某份资料未内联就假设它不存在。`,
    JSON.stringify(contextSnapshot.startupIndex, null, 2),
    '',
    '# Just-in-time Context Commands',
    '你可以且应当使用下面的只读命令逐步获取上下文。命令自动绑定当前 execution 的冻结快照，不会读取运行中后来发生的状态变化。',
    `概览：${contextCommand} overview`,
    `列出：${contextCommand} list [--kind document|slice_spec|decision|runtime_input|feedback|execution|recovery] [--scope current|task|all]`,
    `读取：${contextCommand} get <context-ref>`,
    `搜索：${contextCommand} search --query <keyword>`,
    `证据：${contextCommand} evidence [--stage context|repro|plan|analysis|dev|test|review]`,
    `历史：${contextCommand} history <context-ref>`,
    `优先检查的 Context refs（${contextSnapshot.requiredContextRefs.length}）：${contextSnapshot.requiredContextRefs.length ? contextSnapshot.requiredContextRefs.slice(0, 48).join(', ') : '无；根据当前任务按需搜索'}${contextSnapshot.requiredContextRefs.length > 48 ? '；其余请通过 list 按需发现' : ''}`,
    '只读取当前工作所需的资料；不要一次性展开全部索引。仓库代码、Git 状态和测试环境属于实时 Ground Truth，应继续通过现有文件与命令行工具检查。',
    '发生冲突时，优先级依次为：当前 Active Obligations 和明确用户答复、当前非 superseded Slice Spec、当前需求描述、supporting 文档、historical 记录。代码与测试结果用于判断实现现状，不能自行覆盖产品需求。',
    '在声称缺少上下文、提出 questions 或 runtimeInputs 前，必须先用 list/search/get 检查快照，并用仓库工具检查可推导的事实。',
    ...(activeFeedback.length ? [
      '',
      '# Active Feedback Contract',
      '下面的反馈已经由 Feedback Agent 完成 Triage，并明确路由给你。完成当前角色工作时必须处理这些 acceptance，并在 feedbackResolutions 中逐条提交 Resolution Claim；不要自行标记评论 resolved。',
      '具体内容已包含在 Working Context Pack.activeObligations.feedback，并以 FEEDBACK ref 持久化在快照中。',
    ] : []),
    ...(activeRecovery.length ? [
      '',
      '# Active Recovery Contract',
      '下面是 Test Agent 持久化的未解决失败证据。它们不是历史备注，而是当前交付单元需要继续闭环的上下文。',
      '方案分析 Agent 和开发实现 Agent 应处理与当前阶段有关的事项；可以在 recoveryResolutions 中说明处理方式，但 Claim 不是推进的硬条件，也不能自行关闭事项。只有后续 Test Agent 独立验证通过才能关闭失败事项。',
      '具体内容已包含在 Working Context Pack.activeObligations.recovery，并以 RECOVERY ref 持久化在快照中。',
    ] : []),
    '',
    '# Result Submission Contract',
    '完成当前步骤后，把结果写入一个临时 JSON 文件，再调用下面的专用命令提交。Runner 只把提交内容作为状态机输入；你的普通最终回复可以简短说明已经提交，不需要重复 JSON。',
    `提交命令：node ${JSON.stringify(join(paths.appRoot, 'scripts', 'loop', 'submit-agent-result.mjs'))} --input <temporary-result-json-path> --consume`,
    '提交命令会同步执行完整结构和角色契约校验。若命令返回非零退出码，必须根据错误修正临时 JSON 并重新提交；只有看到 Agent result submitted successfully 才算提交完成。',
    ...(delegation.agent === 'analyst-agent' ? ['Analyst 必须提交完整 decisionTree。下面示例展示 needs_input：若返回 completed，必须删除 questions 和 ambiguities，并把每个决策改为有明确 source、selectedOption 与 evidence 的 resolved_from_context。'] : []),
    '只把 --consume 用于你为本次提交创建的临时 JSON；提交成功后命令会删除该文件。不要直接写 LOOP_AGENT_RESULT_PATH，也不要通过数据库或 loopctl 提交结果。若执行环境确实无法调用提交命令，才在最终回复中输出同一 JSON 对象作为兼容 fallback。',
    '结果 JSON 结构如下；不属于当前角色的字段可以省略：',
    JSON.stringify({
      outcome: 'completed | needs_input | failed',
      summary: '本步骤简要结论',
      artifact: delegation.agent === 'feedback-agent' ? undefined : { title: '文档标题', content: 'Markdown 正文' },
      questions: ['backlog-agent', 'analyst-agent', 'repro-agent'].includes(delegation.agent) ? [
        { decisionKey: 'output-mode', title: '确认输出方式', question: '结果应使用结构化输出还是可读文本？', why: '该选择会改变用户可观察行为和兼容契约', recommendation: '使用结构化输出', recommendationReason: '更容易稳定消费和验证', alternatives: [{ id: 'structured', label: '结构化输出', consequences: ['调用方可以稳定解析'] }, { id: 'text', label: '可读文本', consequences: ['便于直接阅读但解析契约较弱'] }], dependsOn: [] },
      ] : undefined,
      runtimeInputs: delegation.agent === 'feedback-agent' ? undefined : [{ title: '缺少的运行信息', question: '需要用户补充的非产品信息', why: '为什么无法从仓库或环境推导', recommendation: '安全的推荐答案或处理方式' }],
      classification: 'feature | bug | tech | intake | other',
      route: 'plan | repro',
      reproVerdict: delegation.agent === 'repro-agent' ? 'reproduced | not_reproduced' : undefined,
      deliveryUnits: [{ title: '可独立交付和验收的最小业务闭环' }],
      spec: delegation.agent === 'analyst-agent' ? {
        goal: '当前交付单元的用户可观察目标',
        scope: { included: ['本次包含内容'], excluded: ['明确不包含内容'] },
        behaviors: [{ scenario: '场景', expected: '期望行为' }],
        decisions: [],
        decisionTree: [{ key: 'output-mode', question: '结果应使用哪一种输出方式？', impact: '改变用户可观察输出和调用方兼容契约', options: [{ id: 'structured', label: '结构化输出', consequences: ['调用方可以稳定解析'] }, { id: 'text', label: '可读文本', consequences: ['便于直接阅读但解析契约较弱'] }], status: 'needs_user_input' }],
        ambiguities: [{ key: 'output-mode', description: '上下文没有指定用户可观察的输出契约' }],
        acceptanceCriteria: [{ id: 'AC-1', description: '可验收条件', oracle: '如何客观判断' }],
        verificationPlan: [{ criterionId: 'AC-1', kind: 'command | browser | inspection', instruction: '验证步骤', command: 'kind=command 时必填；其他类型省略或填 null' }],
        dependencies: [],
        changeBudget: { capabilities: ['允许改变的能力'], paths: ['允许影响的路径'] },
      } : undefined,
      verdict: delegation.agent === 'review-agent' ? 'report_ready' : 'passed | failed',
      failureKind: delegation.agent === 'test-agent' ? 'implementation | specification | environment | inconclusive；仅失败时填写' : undefined,
      rewindTo: delegation.agent === 'test-agent' ? 'analysis | dev' : undefined,
      rewindDeliveryUnit: delegation.agent === 'test-agent' ? delegation.storyIndex : undefined,
      changedFiles: ['文件路径'],
      feedback: delegation.agent === 'feedback-agent'
        ? delegation.pipeline === 'feedback-verify'
          ? { mode: 'verify', commentId: delegation.feedbackId, verdict: 'resolved | reopened', reason: '验证结论', evidence: ['实际证据'] }
          : { mode: 'triage', decisions: (delegation.feedbackIds || []).map((commentId) => ({ commentId, disposition: 'no_change | reply | revise | rewind | learning_only', targetStage: 'context | repro | plan | analysis | dev | test | review', targetDeliveryUnit: delegation.storyIndex, reason: '影响判断', acceptance: ['反馈完成标准'] })) }
        : undefined,
      feedbackResolutions: activeFeedback.map((comment) => ({ commentId: comment.comment_id, summary: '如何处理了该反馈', evidence: ['新文档、代码或验证证据'] })),
      recoveryResolutions: activeRecovery
        .filter((item) => recoveryStage !== 'test' && item.target_stage === recoveryStage && ['pending', 'reopened'].includes(item.status))
        .map((item) => ({ recoveryId: item.recovery_id, summary: '如何处理了该恢复事项', evidence: ['代码、规格或测试证据'] })),
      tests: [{ command: '测试命令', passed: true, summary: '结果' }],
    }, null, 2),
    '',
    'questions 仅供需求梳理 Agent 提出影响目标、范围、路由或交付边界的需求级产品问题，方案分析 Agent 提出交付单元内的产品决策和重大技术决策，以及问题复现 Agent 在完成合理尝试后仍未复现时请求人工对齐；其他 Agent 不得使用。以上 Agent 提问时必须 outcome=needs_input。问题复现 Agent 未复现时还必须返回 reproVerdict=not_reproduced 且不得返回 route，并且必须使用 questions 而不是 runtimeInputs；只有 reproVerdict=reproduced 才能 route=plan。除这一 Repro 特例外，Agent 若缺少无法从代码、仓库、文档和环境推导的非敏感运行信息，使用 runtimeInputs 并返回 outcome=needs_input。不要通过 runtimeInputs 询问设计决策、审批、密钥或可自行探索的事实。',
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

async function runDelegation(delegation: DelegationEnvelope, prompt: string, executionId: string, executor: AgentExecutor, executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }) {
  const { maxRuntimeMs, idleTimeoutMs } = resolveAgentExecutionLimits(process.env);
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
      lane: delegation.lane,
    },
    description: delegation.description,
    telemetry,
    appendLog: async (message) => {
      if (/(?:错误|失败|warning|warn|error|timeout|timed out|not found)/i.test(message) && diagnostics.length < 30) diagnostics.push(message.slice(0, 1000));
      return appendLoopRunLog(runId, message);
    },
    maxRuntimeMs,
    idleTimeoutMs,
    resultKind: 'flow',
    environment: { LOOP_EXECUTION_ID: executionId },
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
  if (delegation.agent === 'dev-agent' && result.outcome === 'completed') {
    if (!codeCommit) {
      const currentHead = gitHead(paths.root);
      if (currentHead && currentHead !== attempt.base_commit) {
        codeCommit = currentHead;
        await recordExecutionReceipt(attempt.execution_id, 'code_commit', codeCommit, {
          taskId: delegation.taskId,
          storyIndex: delegation.storyIndex,
          mode: 'agent_committed',
        });
        await appendLoopRunLog(runId, `[运行] 检测到开发实现 Agent 创建的 commit：${codeCommit.slice(0, 10)}`);
      } else {
        await appendLoopRunLog(runId, '[运行] 开发实现 Agent 未创建新 commit；当前工作区仍将交给 Test Agent 独立验证');
      }
    }
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
      resultKind: 'evolution',
    });
    if (execution.exitCode !== 0) throw new Error(`Evaluator CLI 退出码 ${execution.exitCode}`);
    const result = parseEvolutionResult(execution.submittedResult || execution.finalText);
    if (!execution.submittedResult) await appendLoopRunLog(runId, '[结果通道] Evolution Evaluator 未调用 submit-agent-result，已兼容读取最终文本');
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
      promptHash: builtPrompt.runtime.promptHash,
      memoryRevision: builtPrompt.runtime.memoryRevision,
      memoryHash: builtPrompt.runtime.memoryHash,
      evolutionCandidateId: builtPrompt.runtime.evolutionCandidateId,
      contextSnapshot: builtPrompt.contextSnapshot,
    });
    attempt = durable.attempt;
    await appendLoopRunLog(runId, `[上下文] requirement=${delegation.taskId} execution=${durable.attempt.execution_id} snapshot=${builtPrompt.contextSnapshot.snapshotId} resources=${builtPrompt.contextSnapshot.resourceCount} startup_index=${builtPrompt.contextSnapshot.startupIndex.length}`);
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

    const execution = await runDelegation(delegation, builtPrompt.prompt, durable.attempt.execution_id, executor, executionOptions);
    if (execution.exitCode !== 0) {
      await handleExecutionFailure(durable.attempt, delegation, `${executor.label} CLI 执行失败，退出码 ${execution.exitCode}`, true);
      return;
    }

    let result;
    try {
      const resultText = execution.submittedResult || execution.finalText;
      result = parseAgentResult(resultText);
      if (!execution.submittedResult) await appendLoopRunLog(runId, `[结果通道] requirement=${delegation.taskId} Agent 未调用 submit-agent-result，已兼容读取最终文本`);
    } catch (error) {
      const channelReason = execution.resultSubmissionError ? `；结果通道错误：${execution.resultSubmissionError}` : '';
      const reason = `Agent 未通过结果命令或最终文本返回合法结构化结果：${error instanceof Error ? error.message : String(error)}${channelReason}`;
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
