import { loadAgentRuntime } from "./agent-profiles";
import { getTaskContext, type DelegationEnvelope } from "./tasks";
import { buildAgentContextSnapshot, renderAgentWorkingContextPack } from "./agent-context";
import { listRecoveryItemsForStage, recoveryStageForAgent } from "./recovery-items";
import { agentCommandPrompt } from "../domain/agent-command-profile";
import { EXECUTION_FAILURE_MAX_RETRIES, executionRecoveryModeForAttempt, executionRecoveryModeLabel } from "./execution-retry-policy";
import { agentLabel } from "../domain/terminology";
import { paths } from "../infrastructure/database";
export function boundedRecoveryText(value: string, limit: number) {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${value.slice(0, head)}\n\n[中间内容因恢复包限额省略；需要时通过角色命令和 agent-context 按需读取]\n\n${value.slice(-tail)}`;
}

export async function buildDelegationPrompt(
  runId: string,
  delegation: DelegationEnvelope,
  repositoryBaseCommit: string | null,
  attemptNumber = 1,
  workspaceRoot = paths.root,
  projectId?: string,
) {
  const runtime = await loadAgentRuntime(delegation.agent, delegation.pipeline, projectId);
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
    workspaceRoot,
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
    `# Role Prompt + Project Overlay · overlay r${runtime.promptVersion} · role v${runtime.promptTemplateVersion} · ${runtime.promptStatus}`,
    projectPrompt,
    ...(durableMemory ? ['', `# Durable Memory · r${runtime.memoryRevision}`, durableMemory] : []),
    ...(recoveryMode === 'initial' && runtime.recentMemory ? ['', '# Recent Retrieved Memory', runtime.recentMemory] : []),
    '',
    `Run ID: ${runId}`,
    `Workspace Root: ${workspaceRoot}`,
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
