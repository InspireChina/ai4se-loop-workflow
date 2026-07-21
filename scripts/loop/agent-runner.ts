#!/usr/bin/env tsx
import '../load-env.js';
import { join } from 'node:path';
import { agentExecutionOptions, getAgentExecutorSettings, getLangfuseRuntimeEnv } from '../../src/application/project-settings';
import { enqueueSoftwareMaintenance } from '../../src/application/software-maintenance';
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
  reconcileStaleExecutions,
  recordExecutionReceipt,
  recoverNextExecutionAttempt,
  type ExecutionAttempt,
} from '../../src/application/executions';
import { appendLoopRunLog, CodeSlotBusyError, createLoopDispatch, endRun, getRunStatus, getTask, getTaskContext, markDelegationLaneRunning, reconcileStaleTaskLanes, rewindTask, settleDelegationLane, type DelegationEnvelope } from '../../src/application/tasks';
import { laneForAgent } from '../../src/application/task-lanes';
import { runHarnessVerification, type HarnessVerificationOutcome } from '../../src/application/verifications';
import { parseAgentResult } from '../../src/domain/agent-result';
import { parseEvolutionResult } from '../../src/domain/agent-evolution';
import { agentLabel, deliveryUnitLabel } from '../../src/domain/terminology';
import { getAgentExecutor, type AgentExecutor } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { startDispatchRetryRun } from '../../src/infrastructure/agent-runner';
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
  const eventFromId = await recordRuntimeEvent({
    eventName: 'loop.execution.cycle.started',
    component: 'loop-runner',
    body: `execution cycle started ${attempt.execution_id}`,
    context: { runId, executionId: attempt.execution_id, taskId: delegation.taskId, agentId: delegation.agent },
    attributes: { attempt: attempt.attempt, pipeline: delegation.pipeline, promptVersion: attempt.prompt_version, memoryRevision: attempt.memory_revision },
  });
  return { executionId: attempt.execution_id, eventFromId };
}

async function enqueueExecutionMaintenance(context: { executionId: string; eventFromId: number }, failure?: unknown) {
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

async function buildPrompt(delegation: DelegationEnvelope) {
  const runtime = await loadAgentRuntime(delegation.agent, delegation.pipeline);
  const full = await getTaskContext(delegation.taskId);
  const relevantStory = delegation.storyIndex ? full.stories.find((story) => story.story_index === delegation.storyIndex) : null;
  const includeAll = delegation.agent === 'review-agent';
  const relevant = <T extends { story_index: number | null }>(items: T[]) => includeAll ? items : items.filter((item) => item.story_index === null || item.story_index === delegation.storyIndex);
  const exposeUnitIndex = <T extends { story_index: number | null }>(items: T[]) => items.map(({ story_index, ...item }) => ({ ...item, delivery_unit_index: story_index }));
  const relevantVerificationRuns = relevant(full.verificationRuns);
  const relevantVerificationIds = new Set(relevantVerificationRuns.map((run) => run.verification_id));
  const relevantDocuments = relevant(full.documents);
  const relevantDocumentIds = new Set(relevantDocuments.map((document) => document.document_id));
  const currentFeedback = delegation.feedbackId
    ? full.documentComments.find((comment) => comment.comment_id === delegation.feedbackId) || null
    : null;
  const activeFeedback = full.documentComments.filter((comment) =>
    comment.feedback_status === 'in_progress'
    && comment.target_agent === delegation.agent
    && (comment.target_story_index == null || comment.target_story_index === delegation.storyIndex));
  const taskContext = {
    requirement: {
      requirementId: full.task.task_id,
      title: full.task.title,
      description: full.task.description,
      itemType: full.task.item_type,
      priority: full.task.priority,
      link: full.task.link,
      },
    lifecycle: {
      agileStatus: full.task.agile_status,
      lanes: full.lanes,
      progress: {
        analysis: full.task.analysis_index,
        development: full.task.dev_index,
        verification: full.task.test_index,
        total: full.task.total_stories,
      },
    },
    currentDeliveryUnit: relevantStory ? { index: relevantStory.story_index, title: relevantStory.title } : null,
    deliveryUnits: full.stories.map((unit) => ({ index: unit.story_index, title: unit.title })),
    documents: exposeUnitIndex(relevantDocuments),
    documentComments: full.documentComments.filter((comment) => relevantDocumentIds.has(comment.document_id)),
    sliceSpecs: exposeUnitIndex(relevant(full.storySpecs)).map((item) => ({ ...item, spec_json: JSON.parse(item.spec_json) })),
    verificationRuns: exposeUnitIndex(relevantVerificationRuns),
    verificationEvidence: full.verificationEvidence.filter((evidence) => relevantVerificationIds.has(evidence.verification_id)),
    executionAttempts: exposeUnitIndex(relevant(full.executionAttempts)),
    questions: exposeUnitIndex(relevant(full.questions)),
    currentFeedback,
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
      lane: delegation.lane,
      flow: delegation.pipeline,
      agent: delegation.agent,
      delivery_unit_index: delegation.storyIndex,
      feedback_id: delegation.feedbackId || null,
      description: delegation.description,
    }, null, 2),
    '',
    '完整需求上下文：',
    JSON.stringify(taskContext, null, 2),
    ...(activeFeedback.length ? [
      '',
      '# Active Feedback Contract',
      '下面的反馈已经由 Feedback Agent 完成 Triage，并明确路由给你。完成当前角色工作时必须处理这些 acceptance，并在 feedbackResolutions 中逐条提交 Resolution Claim；不要自行标记评论 resolved。',
      JSON.stringify(activeFeedback.map((comment) => ({
        commentId: comment.comment_id,
        content: comment.content,
        quotedText: comment.quoted_text,
        targetStage: comment.target_stage,
        targetDeliveryUnit: comment.target_story_index,
        reason: comment.triage_reason,
        acceptance: JSON.parse(comment.acceptance_json || '[]'),
      })), null, 2),
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
      questions: delegation.agent === 'backlog-agent' || delegation.agent === 'analyst-agent' ? [
        { decisionKey: 'output-mode', title: '确认输出方式', question: '结果应使用结构化输出还是可读文本？', why: '该选择会改变用户可观察行为和兼容契约', recommendation: '使用结构化输出', recommendationReason: '更容易稳定消费和验证', alternatives: [{ id: 'structured', label: '结构化输出', consequences: ['调用方可以稳定解析'] }, { id: 'text', label: '可读文本', consequences: ['便于直接阅读但解析契约较弱'] }], dependsOn: [] },
      ] : undefined,
      runtimeInputs: delegation.agent === 'feedback-agent' ? undefined : [{ title: '缺少的运行信息', question: '需要用户补充的非产品信息', why: '为什么无法从仓库或环境推导', recommendation: '安全的推荐答案或处理方式' }],
      classification: 'feature | bug | tech | intake | other',
      route: 'plan | repro',
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
      verdict: delegation.agent === 'review-agent' ? 'report_ready | changes_requested' : 'passed | failed',
      rewindTo: 'plan | analysis | dev | test',
      rewindDeliveryUnit: delegation.storyIndex,
      changedFiles: ['文件路径'],
      feedback: delegation.agent === 'feedback-agent'
        ? delegation.pipeline === 'feedback-verify'
          ? { mode: 'verify', commentId: delegation.feedbackId, verdict: 'resolved | reopened', reason: '验证结论', evidence: ['实际证据'] }
          : { mode: 'triage', commentId: delegation.feedbackId, disposition: 'no_change | reply | revise | rewind | learning_only', targetStage: 'plan | analysis | dev | test | review', targetAgent: '负责执行的 Agent', targetDeliveryUnit: delegation.storyIndex, reason: '影响判断', acceptance: ['反馈完成标准'] }
        : undefined,
      feedbackResolutions: activeFeedback.map((comment) => ({ commentId: comment.comment_id, summary: '如何处理了该反馈', evidence: ['新文档、代码或验证证据'] })),
      tests: [{ command: '测试命令', passed: true, summary: '结果' }],
    }, null, 2),
    '',
    'questions 仅供需求梳理 Agent 提出影响目标、范围、路由或交付边界的需求级产品问题，以及方案分析 Agent 提出交付单元内的产品决策和重大技术决策；其他 Agent 不得使用。需求梳理 Agent 或方案分析 Agent 提问时必须 outcome=needs_input。任何 Agent 若缺少无法从代码、仓库、文档和环境推导的非敏感运行信息，使用 runtimeInputs 并返回 outcome=needs_input。不要通过 runtimeInputs 询问设计决策、审批、密钥或可自行探索的事实。',
  ].join('\n');
  return { prompt, runtime };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRunActive() {
  const run = await getRunStatus();
  return Boolean(run?.active && run.runId === runId);
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
  });
  return { ...execution, diagnostics };
}

async function processDurableResult(attempt: ExecutionAttempt, delegation: DelegationEnvelope, result: ReturnType<typeof parseAgentResult>) {
  let codeCommit = attempt.code_commit || '';
  let harnessVerification: HarnessVerificationOutcome | null = null;
  const current = await getTask(delegation.taskId);
  if (!current || ['done', 'cancelled'].includes(current.task.agile_status)) {
    await markExecutionStage(attempt.execution_id, 'applying');
    const outcome = await applyAgentResult(runId, delegation, result, { codeCommit, executionId: attempt.execution_id });
    await recordExecutionReceipt(attempt.execution_id, 'application', outcome, { outcome, terminalTask: true });
    await completeExecution(attempt.execution_id);
    await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 返回时需求已结束，结果仅保留为证据，不再应用`);
    return { outcome, harnessVerification };
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
        await appendLoopRunLog(runId, '[运行] 开发实现 Agent 未创建新 commit；Runner 将直接验证当前工作区');
      }
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
  const outcomeLabel = { advanced: '已推进', blocked: '等待澄清', rewound: '已回退', discarded: '已丢弃副作用' }[outcome];
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
  let maintenance: { executionId: string; eventFromId: number } | null = null;
  let unexpectedFailure: unknown;
  try {
    const headBefore = delegation.agent === 'dev-agent' ? gitHead(paths.root) : '';
    const builtPrompt = await buildPrompt(delegation);
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
      leaseMinutes: Math.ceil(Number(process.env.AGENT_EXECUTOR_TIMEOUT_MS || 30 * 60 * 1000) / 60_000) + 10,
    });
    attempt = durable.attempt;
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
        await handleExecutionFailure(durable.attempt, delegation, error instanceof Error ? error.message : String(error), false);
      }
      return;
    }

    const execution = await runDelegation(delegation, builtPrompt.prompt, executor, executionOptions);
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
      const succeeded = result.outcome !== 'failed' && applied.harnessVerification?.passed !== false;
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
        harness: applied.harnessVerification,
        diagnostics: execution.diagnostics,
      }, executor, executionOptions));
    } catch (error) {
      if (error instanceof CodeSlotBusyError) {
        await failExecution(durable.attempt.execution_id, error.message, false);
        await appendLoopRunLog(runId, `[运行] requirement=${delegation.taskId} ${agentLabel(delegation.agent)} 结果已进入队列，等待 ${error.ownerTaskId} 释放代码槽`);
        return;
      }
      const reason = `应用 Agent 结果失败：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(durable.attempt, delegation, reason, false);
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
  const staleCount = await reconcileStaleExecutions();
  if (staleCount) await appendLoopRunLog(runId, `[恢复] 已回收 ${staleCount} 个失去租约且尚无输出的 execution attempt`);
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
      const succeeded = result.outcome !== 'failed' && applied.harnessVerification?.passed !== false;
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
        harness: applied.harnessVerification,
        diagnostics: [],
      }, executor, executionOptions));
    } catch (error) {
      const reason = `恢复 execution attempt 失败：${error instanceof Error ? error.message : String(error)}`;
      await handleExecutionFailure(recoverable, delegation, reason, false);
    } finally {
      await settleDelegationLane(delegation);
      await enqueueExecutionMaintenance(maintenance);
    }
    recoverable = await recoverNextExecutionAttempt();
  }

  const active = new Map<string, Promise<void>>();
  while (await isRunActive()) {
    const queuedWaiting = await drainQueuedAgentResults();
    const dispatch = await createLoopDispatch(runId, { includeRunHeader: false, logDelegations: false });
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
  try {
    await main();
  } catch (error) {
    await appendLoopRunLog(runId, `[执行器错误] ${error instanceof Error ? error.message : String(error)}`);
    await endRun(runId, true, { stopRunner: false, reason: error instanceof Error ? error.message : String(error) });
    await enqueueRunnerFailureMaintenance(error);
  }
}

void run();
