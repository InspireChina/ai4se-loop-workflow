#!/usr/bin/env tsx
import '../load-env.js';
import { getAgentExecutorSettings, getLangfuseRuntimeEnv } from '../../src/application/project-settings';
import { applyAgentResult, applyNextQueuedAgentResult, blockDelegation } from '../../src/application/agent-results';
import { appendLoopRunLog, CodeSlotBusyError, createLoopDispatch, endRun, getRunStatus, getTaskContext, type DelegationEnvelope } from '../../src/application/tasks';
import { parseAgentResult } from '../../src/domain/agent-result';
import { agentLabel, deliveryUnitLabel } from '../../src/domain/terminology';
import { getAgentExecutor, type AgentExecutor } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { startAgentRun, startDispatchRetryRun } from '../../src/infrastructure/agent-runner';
import { paths } from '../../src/infrastructure/database';
import { commitDevStory, prepareDevWorkspace } from '../../src/infrastructure/git';
import { createLangfuseTelemetry } from '../../src/infrastructure/langfuse';

const runId = process.argv[2];
if (!runId) throw new Error('missing run id');

function roleInstruction(delegation: DelegationEnvelope) {
  switch (delegation.agent) {
    case 'backlog-agent':
      return '判断需求类型并整理后续上下文。完成时提供 artifact、classification 和 route（plan/repro）。';
    case 'story-splitter-agent':
      return [
        '把需求拆成可独立交付和验收的交付单元。',
        '每个交付单元必须是最小业务闭环，并适合一个开发实现 Agent 在一次上下文中完成。',
        '不要按数据库、接口、页面、测试等技术层拆分；这些属于交付单元内部的实现步骤。',
        '完成时提供 artifact 和非空 deliveryUnits 数组。',
      ].join('\n');
    case 'analyst-agent':
      return [
        delegation.pipeline === 'resume'
          ? '根据上下文中的用户答复更新当前交付单元的方案分析。'
          : '只分析当前交付单元的目标、验收标准、约束和实现方案。',
        '系统性走遍当前交付单元的设计决策树，识别所有需要用户决定的分支，并解析决策之间的依赖。',
        '一次性把所有尚未解决的设计决策放入 questions；不要一次只提一个问题。每个问题都必须提供推荐答案。',
        '能够通过探索代码库确认的事实必须自行查明，不要向用户提问；产品与设计决策必须交给用户决定。',
        '在 questions 中仍有未解决决策时，不得假定用户已经同意方案。',
        '完成时提供完整 artifact。',
      ].join('\n');
    case 'repro-agent':
      return '复现 Bug 并记录现象、步骤、证据和根因假设。完成时提供 artifact 和 route=plan。';
    case 'dev-agent':
      return [
        '只实现当前交付单元所需代码并运行必要测试。',
        '不要 git add、不要 git commit、不要修改需求状态；推进流程会检查并提交代码。',
        '完成时提供 summary 和 tests；实现说明可放入 artifact。不得创建或修改密钥及环境变量文件。',
      ].join('\n');
    case 'test-agent':
      return '对当前交付单元做黑盒和回归验证。提供 artifact、tests 和 verdict=passed/failed；失败时给出 rewindTo=dev/analysis。';
    case 'review-agent':
      return delegation.pipeline === 'resume'
        ? '阅读用户对最终交付问题的答复。接受交付时提供 artifact 和 verdict=ready_for_approval；要求修改时给出 changes_requested、rewindTo 和 rewindDeliveryUnit。流程会据此完成或回流。'
        : '对整个需求进行整体验收，检查全部交付单元组合后的完整性、风险和验收结果。提供 artifact 和 verdict=ready_for_approval；要求修改时给出 changes_requested、rewindTo 和 rewindDeliveryUnit。';
    default:
      return `你是 ${agentLabel(delegation.agent)}。只执行当前步骤，不调度其他 Agent。`;
  }
}

async function buildPrompt(delegation: DelegationEnvelope) {
  const full = await getTaskContext(delegation.taskId);
  const relevantStory = delegation.storyIndex ? full.stories.find((story) => story.story_index === delegation.storyIndex) : null;
  const includeAll = delegation.agent === 'review-agent';
  const relevant = <T extends { story_index: number | null }>(items: T[]) => includeAll ? items : items.filter((item) => item.story_index === null || item.story_index === delegation.storyIndex);
  const exposeUnitIndex = <T extends { story_index: number | null }>(items: T[]) => items.map(({ story_index, ...item }) => ({ ...item, delivery_unit_index: story_index }));
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
    questions: exposeUnitIndex(relevant(full.questions)),
    confirmations: exposeUnitIndex(relevant(full.approvals)),
  };
  return [
    `你是 ${agentLabel(delegation.agent)}，只完成当前执行步骤的专业工作。`,
    '',
    '外部 App 已经完成推进流程的调度。你只执行下面这一个步骤。',
    '流程调度与 Loop 运行生命周期完全由外部 App 管理。禁止调度或模拟其他流程 Agent。',
    '可以使用辅助 subagent 收集当前范围的上下文，但不得处理其他需求或交付单元。',
    '不要调用 loopctl，不要写数据库，不要修改需求状态，不要自行创建流程记录。',
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
    roleInstruction(delegation),
    '',
    '最终回复必须只包含一个合法 JSON 对象，不要使用 Markdown fence，不要添加解释。通用结构如下；不属于当前角色的字段可以省略：',
    JSON.stringify({
      outcome: 'completed | needs_input | failed',
      summary: '本步骤简要结论',
      artifact: { title: '文档标题', content: 'Markdown 正文' },
      questions: delegation.agent === 'analyst-agent' ? [
        { title: '设计决策 1', question: '需要用户决定的具体问题', why: '该决策影响什么', recommendation: '推荐答案及理由' },
        { title: '设计决策 2', question: '另一个需要用户决定的具体问题', why: '与其他决策的依赖', recommendation: '推荐答案及理由' },
      ] : [{ title: '问题', question: '具体问题', why: '原因', recommendation: '建议' }],
      classification: 'feature | bug | tech | intake | other',
      route: 'plan | repro',
      deliveryUnits: [{ title: '可独立交付和验收的最小业务闭环' }],
      verdict: 'passed | failed | ready_for_approval | changes_requested',
      rewindTo: 'plan | analysis | dev | test',
      rewindDeliveryUnit: delegation.storyIndex,
      changedFiles: ['文件路径'],
      tests: [{ command: '测试命令', passed: true, summary: '结果' }],
    }, null, 2),
  ].join('\n');
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

async function runDelegation(delegation: DelegationEnvelope, executor: AgentExecutor, executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }) {
  const prompt = await buildPrompt(delegation);
  const maxRuntimeMs = Number(process.env.AGENT_EXECUTOR_TIMEOUT_MS || process.env.CURSOR_AGENT_TIMEOUT_MS || 30 * 60 * 1000);
  const idleTimeoutMs = Number(process.env.AGENT_EXECUTOR_IDLE_TIMEOUT_MS || process.env.CURSOR_AGENT_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
  const telemetry = createLangfuseTelemetry({ env: await getLangfuseRuntimeEnv() });
  return executeDelegation({
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
    appendLog: (message) => appendLoopRunLog(runId, message),
    maxRuntimeMs,
    idleTimeoutMs,
  });
}

async function main() {
  const settings = await getAgentExecutorSettings();
  const executor = getAgentExecutor(settings.executorId);
  const executionOptions = settings.executorId === 'codex' ? {
    model: settings.codexModel || undefined,
    reasoningEffort: settings.codexReasoningEffort === 'default' ? undefined : settings.codexReasoningEffort,
  } : {};
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

  const execution = await runDelegation(delegation, executor, executionOptions);
  if (execution.exitCode !== 0) {
    await blockDelegation(delegation, `${executor.label} CLI 执行失败，退出码 ${execution.exitCode}`);
    await scheduleNextLoop();
    return;
  }

  let result;
  try {
    result = parseAgentResult(execution.finalText);
  } catch (error) {
    const reason = `Agent 未返回合法结构化结果：${error instanceof Error ? error.message : String(error)}`;
    await appendLoopRunLog(runId, `[错误] ${agentLabel(delegation.agent)} ${reason}`);
    await blockDelegation(delegation, reason);
    await scheduleNextLoop();
    return;
  }

  let codeCommit = '';
  if (delegation.agent === 'dev-agent' && result.outcome === 'completed') {
    const commit = commitDevStory(paths.root, delegation.taskId, delegation.storyIndex!, headBefore);
    if (!commit.ok) {
      await appendLoopRunLog(runId, `[错误] 开发实现 Agent 代码提交失败：${commit.reason}`);
      await blockDelegation(delegation, commit.reason);
      await scheduleNextLoop();
      return;
    }
    codeCommit = commit.commit;
    await appendLoopRunLog(runId, `[运行] Runner 已提交${deliveryUnitLabel(delegation.storyIndex)}：${commit.commit}`);
  }

  try {
    const outcome = await applyAgentResult(runId, delegation, result, { codeCommit });
    const outcomeLabel = { advanced: '已推进', blocked: '等待确认', rewound: '已回退' }[outcome];
    await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 结构化结果已应用：${outcomeLabel}`);
  } catch (error) {
    if (error instanceof CodeSlotBusyError) {
      await appendLoopRunLog(runId, `[运行] ${agentLabel(delegation.agent)} 结果已进入队列，等待 ${error.ownerTaskId} 释放代码槽`);
      await scheduleNextLoop();
      return;
    }
    const reason = `应用 Agent 结果失败：${error instanceof Error ? error.message : String(error)}`;
    await appendLoopRunLog(runId, `[错误] ${agentLabel(delegation.agent)} ${reason}`);
    await blockDelegation(delegation, reason);
  }
  await scheduleNextLoop();
}

main().catch(async (error) => {
  await appendLoopRunLog(runId, `[执行器错误] ${error instanceof Error ? error.message : String(error)}`);
  await endRun(runId, true, { stopRunner: false, reason: error instanceof Error ? error.message : String(error) });
});
