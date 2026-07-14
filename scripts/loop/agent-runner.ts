#!/usr/bin/env tsx
import '../load-env.js';
import { getAgentExecutorSettings } from '../../src/application/project-settings';
import { applyAgentResult, applyNextQueuedAgentResult, blockDelegation } from '../../src/application/agent-results';
import { appendLoopRunLog, CodeSlotBusyError, createLoopDispatch, endRun, getRunStatus, getTaskContext, type DelegationEnvelope } from '../../src/application/tasks';
import { parseAgentResult } from '../../src/domain/agent-result';
import { getAgentExecutor, type AgentExecutor } from '../../src/infrastructure/agent-executor';
import { executeDelegation } from '../../src/infrastructure/delegation-execution';
import { startAgentRun, startDispatchRetryRun } from '../../src/infrastructure/agent-runner';
import { paths } from '../../src/infrastructure/database';
import { commitDevStory, prepareDevWorkspace } from '../../src/infrastructure/git';
import { getLangfuseTelemetry } from '../../src/infrastructure/langfuse';

const runId = process.argv[2];
if (!runId) throw new Error('missing run id');

function roleInstruction(delegation: DelegationEnvelope) {
  switch (delegation.agent) {
    case 'backlog-agent':
      return '判断 Task 类型并整理后续上下文。完成时提供 artifact、classification 和 route（plan/repro）。';
    case 'story-splitter-agent':
      return '把 Task 拆成可独立分析、开发和测试的 Story。完成时提供 artifact 和非空 stories 数组。';
    case 'analyst-agent':
      return [
        delegation.pipeline === 'resume'
          ? '根据上下文中的用户答复更新当前 Story 分析。'
          : '只分析当前 Story 的需求、验收标准、约束和实现方案。',
        '系统性走遍当前 Story 的设计决策树，识别所有需要用户决定的分支，并解析决策之间的依赖。',
        '一次性把所有尚未解决的设计决策放入 questions；不要一次只提一个问题。每个问题都必须提供推荐答案。',
        '能够通过探索代码库确认的事实必须自行查明，不要向用户提问；产品与设计决策必须交给用户决定。',
        '在 questions 中仍有未解决决策时，不得假定用户已经同意方案。',
        '完成时提供完整 artifact。',
      ].join('\n');
    case 'repro-agent':
      return '复现 Bug 并记录现象、步骤、证据和根因假设。完成时提供 artifact 和 route=plan。';
    case 'dev-agent':
      return [
        '只实现当前 Story 所需代码并运行必要测试。',
        '不要 git add、不要 git commit、不要修改 Task 状态；流程会检查并提交代码。',
        '完成时提供 summary 和 tests；实现说明可放入 artifact。不得创建或修改密钥及环境变量文件。',
      ].join('\n');
    case 'test-agent':
      return '对当前 Story 做黑盒和回归验证。提供 artifact、tests 和 verdict=passed/failed；失败时给出 rewindTo=dev/analysis。';
    case 'review-agent':
      return delegation.pipeline === 'resume'
        ? '阅读用户对最终交付问题的答复。接受交付时提供 artifact 和 verdict=ready_for_approval；要求修改时给出 changes_requested、rewindTo 和 rewindStory。流程会据此完成或回流。'
        : '审查整个 Task 的完整性、风险和验收结果。提供 artifact 和 verdict=ready_for_approval；要求修改时给出 changes_requested、rewindTo 和 rewindStory。';
    default:
      return `你是 ${delegation.agent}。只执行当前 delegation，不调度其他 agent。`;
  }
}

async function buildPrompt(delegation: DelegationEnvelope) {
  const full = await getTaskContext(delegation.taskId);
  const relevantStory = delegation.storyIndex ? full.stories.find((story) => story.story_index === delegation.storyIndex) : null;
  const includeAll = delegation.agent === 'review-agent';
  const relevant = <T extends { story_index: number | null }>(items: T[]) => includeAll ? items : items.filter((item) => item.story_index === null || item.story_index === delegation.storyIndex);
  const taskContext = {
    task: {
      taskId: full.task.task_id,
      title: full.task.title,
      description: full.task.description,
      itemType: full.task.item_type,
      priority: full.task.priority,
      link: full.task.link,
    },
    currentStory: relevantStory,
    stories: full.stories,
    documents: relevant(full.documents),
    questions: relevant(full.questions),
    approvals: relevant(full.approvals),
  };
  return [
    `你是 ${delegation.agent}，只完成当前 delegation 的专业工作。`,
    '',
    '外部 App 已经完成 pipeline 派发。你只执行下面这一条 delegation。',
    'Pipeline 派发与 Run 生命周期完全由外部 App 管理。禁止调度或模拟其他 pipeline agent。',
    '可以使用辅助 subagent 收集当前范围的上下文，但不得处理其他 Task 或 Story。',
    '不要调用 loopctl，不要写数据库，不要修改 Task 状态，不要创建流程问题。',
    '',
    `Run ID: ${runId}`,
    `Loop App Root: ${paths.appRoot}`,
    `Workspace Root: ${paths.root}`,
    '',
    '当前 delegation JSON：',
    JSON.stringify({
      task_id: delegation.taskId,
      title: delegation.title,
      task_description: delegation.taskDescription,
      item_type: delegation.itemType,
      priority: delegation.priority,
      pipeline: delegation.pipeline,
      agent: delegation.agent,
      story_index: delegation.storyIndex,
      description: delegation.description,
    }, null, 2),
    '',
    '完整 Task 上下文：',
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
      stories: [{ title: 'Story 标题' }],
      verdict: 'passed | failed | ready_for_approval | changes_requested',
      rewindTo: 'plan | analysis | dev | test',
      rewindStory: delegation.storyIndex,
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
  await appendLoopRunLog(runId, `[运行] 本轮 agent 已完成，${delayLabel(retryMs)}后继续 loop`);
  await sleep(retryMs);
  if (!(await isRunActive())) return;

  await appendLoopRunLog(runId, '[运行] 继续下一轮派发');
  const dispatch = await createLoopDispatch(runId, { includeRunHeader: false });
  if (dispatch.delegations.length > 0) {
    await appendLoopRunLog(runId, `[运行] 下一轮发现 ${dispatch.delegations.length} 个 agent，启动逐个执行 runner`);
    await startAgentRun(runId);
    return;
  }
  await startDispatchRetryRun(runId);
}

async function runDelegation(delegation: DelegationEnvelope, executor: AgentExecutor, executionOptions: { model?: string; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }) {
  const prompt = await buildPrompt(delegation);
  const maxRuntimeMs = Number(process.env.AGENT_EXECUTOR_TIMEOUT_MS || process.env.CURSOR_AGENT_TIMEOUT_MS || 30 * 60 * 1000);
  const idleTimeoutMs = Number(process.env.AGENT_EXECUTOR_IDLE_TIMEOUT_MS || process.env.CURSOR_AGENT_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
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
    telemetry: getLangfuseTelemetry(),
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
    await appendLoopRunLog(runId, `[运行] 已应用排队结果：${queued.agent} ${queued.taskId}${queued.storyIndex ? ` Story-${queued.storyIndex}` : ''}，结果=${queued.outcome}`);
    await scheduleNextLoop();
    return;
  }
  if (queued.status === 'waiting') {
    queuedWaiting = true;
    await appendLoopRunLog(runId, `[运行] 排队结果等待代码槽释放：${queued.agent} ${queued.taskId}${queued.storyIndex ? ` Story-${queued.storyIndex}` : ''}，当前占用=${queued.ownerTaskId}`);
  } else if (queued.status === 'failed') {
    await appendLoopRunLog(runId, `[错误] 排队结果应用失败：${queued.agent} ${queued.taskId}${queued.storyIndex ? ` Story-${queued.storyIndex}` : ''} - ${queued.reason}`);
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
  await appendLoopRunLog(runId, `[运行] 使用 ${executor.label} CLI，执行 1 个 agent`);
  await appendLoopRunLog(runId, `[运行] 执行 agent：${delegation.agent}`);

  let headBefore = '';
  if (delegation.agent === 'dev-agent') {
    const preparation = prepareDevWorkspace(paths.root, delegation.taskId, delegation.storyIndex!);
    if (!preparation.ok) {
      await blockDelegation(delegation, preparation.reason);
      await appendLoopRunLog(runId, `[错误] ${delegation.agent} 未启动：${preparation.reason}`);
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
    await appendLoopRunLog(runId, `[错误] ${delegation.agent} ${reason}`);
    await blockDelegation(delegation, reason);
    await scheduleNextLoop();
    return;
  }

  let codeCommit = '';
  if (delegation.agent === 'dev-agent' && result.outcome === 'completed') {
    const commit = commitDevStory(paths.root, delegation.taskId, delegation.storyIndex!, headBefore);
    if (!commit.ok) {
      await appendLoopRunLog(runId, `[错误] dev-agent 代码提交失败：${commit.reason}`);
      await blockDelegation(delegation, commit.reason);
      await scheduleNextLoop();
      return;
    }
    codeCommit = commit.commit;
    await appendLoopRunLog(runId, `[运行] Runner 已提交 Story-${delegation.storyIndex}：${commit.commit}`);
  }

  try {
    const outcome = await applyAgentResult(runId, delegation, result, { codeCommit });
    await appendLoopRunLog(runId, `[运行] ${delegation.agent} 结构化结果已应用：${outcome}`);
  } catch (error) {
    if (error instanceof CodeSlotBusyError) {
      await appendLoopRunLog(runId, `[运行] ${delegation.agent} 结果已进入队列，等待 ${error.ownerTaskId} 释放代码槽`);
      await scheduleNextLoop();
      return;
    }
    const reason = `应用 Agent 结果失败：${error instanceof Error ? error.message : String(error)}`;
    await appendLoopRunLog(runId, `[错误] ${delegation.agent} ${reason}`);
    await blockDelegation(delegation, reason);
  }
  await scheduleNextLoop();
}

main().catch(async (error) => {
  await appendLoopRunLog(runId, `[执行器错误] ${error instanceof Error ? error.message : String(error)}`);
  await endRun(runId, true, { stopRunner: false, reason: error instanceof Error ? error.message : String(error) });
});
