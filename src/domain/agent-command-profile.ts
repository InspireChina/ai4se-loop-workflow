export type AgentCommandProfile = {
  id: string;
  agent: string;
  pipelines: string[];
  namespace: string;
  draftType: 'requirement_context' | 'delivery_plan' | 'reproduction' | 'analysis' | 'development' | 'verification' | 'feedback' | 'review';
  terminalActions: string[];
};

const PROFILES: AgentCommandProfile[] = [
  {
    id: 'requirement-context',
    agent: 'backlog-agent',
    pipelines: ['backlog', 'resume'],
    namespace: 'requirement-context',
    draftType: 'requirement_context',
    terminalActions: [
      'requirement-context complete',
      'requirement-context request-clarification',
    ],
  },
  {
    id: 'reproduction',
    agent: 'repro-agent',
    pipelines: ['repro', 'resume', 'feedback-repro'],
    namespace: 'reproduction',
    draftType: 'reproduction',
    terminalActions: [
      'reproduction complete',
      'reproduction request-alignment',
    ],
  },
  {
    id: 'delivery-analysis',
    agent: 'analyst-agent',
    pipelines: ['analysis', 'resume'],
    namespace: 'delivery-analysis',
    draftType: 'analysis',
    terminalActions: [
      'delivery-analysis complete',
      'delivery-analysis request-clarification',
    ],
  },
  {
    id: 'implementation',
    agent: 'dev-agent',
    pipelines: ['dev', 'resume'],
    namespace: 'implementation',
    draftType: 'development',
    terminalActions: [
      'implementation complete',
      'implementation request-input',
      'implementation fail',
    ],
  },
  {
    id: 'verification',
    agent: 'test-agent',
    pipelines: ['test', 'resume'],
    namespace: 'verification',
    draftType: 'verification',
    terminalActions: [
      'verification complete',
      'verification request-input',
    ],
  },
  {
    id: 'feedback-triage',
    agent: 'feedback-agent',
    pipelines: ['feedback-triage'],
    namespace: 'feedback',
    draftType: 'feedback',
    terminalActions: [
      'feedback triage-complete',
      'feedback request-clarification',
    ],
  },
  {
    id: 'feedback-verify',
    agent: 'feedback-agent',
    pipelines: ['feedback-verify'],
    namespace: 'feedback',
    draftType: 'feedback',
    terminalActions: [
      'feedback resolve',
      'feedback reopen',
    ],
  },
  {
    id: 'review',
    agent: 'review-agent',
    pipelines: ['review', 'feedback-report'],
    namespace: 'review',
    draftType: 'review',
    terminalActions: [
      'review complete',
    ],
  },
  {
    id: 'delivery-plan',
    agent: 'story-splitter-agent',
    pipelines: ['split', 'feedback-split'],
    namespace: 'delivery-plan',
    draftType: 'delivery_plan',
    terminalActions: [
      'delivery-plan complete',
    ],
  },
];

export function agentCommandProfile(agent: string, pipeline: string) {
  return PROFILES.find((profile) =>
    profile.agent === agent && profile.pipelines.includes(pipeline)) || null;
}

export function agentCommandWorkKey(
  agent: string,
  pipeline: string,
  taskId: string,
  storyIndex: number | null,
  delegationKey?: string,
  scopeKey?: string,
) {
  const profile = agentCommandProfile(agent, pipeline);
  if (!profile) return null;
  if (profile.draftType === 'requirement_context') return `requirement-context:${taskId}`;
  if (profile.draftType === 'delivery_plan') {
    return `delivery-plan:${taskId}:${pipeline}:${delegationKey || storyIndex || 'task'}`;
  }
  if (profile.draftType === 'reproduction') {
    return pipeline === 'feedback-repro'
      ? `reproduction:${taskId}:feedback:${scopeKey || delegationKey || 'group'}`
      : `reproduction:${taskId}:task`;
  }
  if (profile.draftType === 'analysis') {
    return `delivery-analysis:${taskId}:${storyIndex ?? 'unit'}`;
  }
  if (profile.draftType === 'development') {
    return `development:${taskId}:${storyIndex ?? 'unit'}`;
  }
  if (profile.draftType === 'verification') {
    return `verification:${taskId}:${storyIndex ?? 'unit'}`;
  }
  if (profile.draftType === 'feedback') {
    return `feedback:${taskId}:${pipeline}:${scopeKey || delegationKey || 'work'}`;
  }
  if (profile.draftType === 'review') {
    return `review:${taskId}:${pipeline === 'feedback-report' ? 'feedback' : 'closure'}:${scopeKey || delegationKey || 'report'}`;
  }
  return `${profile.draftType}:${taskId}:${storyIndex ?? 'task'}`;
}

export function loopAgentCommandPrefix(appRoot: string) {
  return `node ${JSON.stringify(`${appRoot}/scripts/loop/loop-agent.mjs`)}`;
}

export function agentContextCommandPrefix(appRoot: string) {
  return `npm --prefix ${JSON.stringify(appRoot)} run loopctl -- agent-context`;
}

export function agentContextHelpLines(appRoot: string) {
  const command = agentContextCommandPrefix(appRoot);
  return [
    `- \`${command} overview\``,
    '  重新查看当前工作、权威事实、活动义务和当前角色可见的最近执行摘要。',
    '',
    `- \`${command} list [--kind document|delivery_spec|decision|runtime_input|feedback|execution|recovery] [--scope current|task|all]\``,
    '  按资料类型或范围浏览冻结快照；不知道准确 ref 时使用。',
    '',
    `- \`${command} get <context-ref>\``,
    '  读取已知 ref 的完整内容；Prompt 给出 Required Context Refs 时优先使用。',
    '',
    `- \`${command} search --query <keyword>\``,
    '  按关键词发现相关资料；不能因为启动索引未展示某项就假设它不存在。',
    '',
    `- \`${command} evidence [--stage context|repro|plan|analysis|dev|test|review]\``,
    '  检查当前角色获准读取的执行与恢复证据；不能用它替代当前仓库事实。',
    '',
    `- \`${command} history <context-ref>\``,
    '  仅在资料存在版本、替代或冲突疑问时检查历史。',
  ];
}

function terminalActionUsage(action: string) {
  return action === 'implementation fail'
    ? `${action} --reason <原因与证据>`
    : action;
}

export function agentCommandPrompt(appRoot: string, agent: string, pipeline: string) {
  const profile = agentCommandProfile(agent, pipeline);
  if (!profile) return null;
  const command = loopAgentCommandPrefix(appRoot);
  const helpTopics = profile.draftType === 'requirement_context'
    ? 'context|assertion|impact|question|scope|finish'
    : profile.draftType === 'delivery_plan'
      ? 'context|unit|source|dependency|revision|finish'
      : profile.draftType === 'analysis'
        ? 'context|impact|decision-proposal|decision-resolution|contract|finish'
        : profile.draftType === 'development'
          ? 'context|evidence|review|commit|input|finish'
          : profile.draftType === 'verification'
            ? 'context|plan|execute|evidence|input|finish'
            : profile.draftType === 'review'
              ? 'context|reconciliation|gap|assessment|report|forward|finish'
            : 'context';
  return [
    '# Agent Tool Contract',
    '当前 execution 有三类工具面。先判断需要恢复状态、读取冻结上下文，还是检查实时仓库事实；不要把所有资料一次性展开。',
    '',
    '## 1. 工作状态与结果提交',
    `当前角色使用 execution 绑定的 \`${profile.namespace}\` 命令空间渐进提交工作，不再生成或提交通用结果 JSON。`,
    '',
    '**首次必须执行：**',
    '',
    '```bash',
    `${command} ${profile.namespace} status`,
    '```',
    '',
    '这一步会恢复上一次 attempt 或澄清轮次留下的草稿。未查看状态前，所有编辑、校验和终止命令都会被拒绝。',
    '',
    '**稳定标识：** `status` 会列出当前草稿中的稳定 key。修改既有语义时必须复用原 key；只有新增语义才能创建新 key。decision key 和 unit key 均不可跨轮次改名。',
    '',
    '**查看命令帮助：**',
    '',
    '```bash',
    `${command} help <${helpTopics}>`,
    '```',
    ...(['requirement_context', 'delivery_plan', 'analysis', 'development', 'verification', 'review'].includes(profile.draftType)
      ? ['', `\`${profile.namespace}\` 的 help 必须指定一个主题；当前阶段可执行命令以 \`status\` 返回的工作包为准。`]
      : []),
    '',
    '**编辑与提交规则：**',
    '',
    '- 命令失败时，根据 Application 返回的错误修正后自行重试；不要因为一次校验失败就结束工作。',
    ...(['requirement-context', 'delivery-plan', 'delivery-analysis', 'implementation', 'verification', 'review'].includes(profile.namespace)
      ? [`- ${profile.namespace} 命令统一返回 \`COMMAND RESULT\`；继续当前阶段时读取 \`NEXT\`，阶段切换时读取 \`NEXT WORK PACKET\`。`]
      : []),
    '- 草稿命令可以反复增加、修改或删除内容，不会推进业务状态。',
    '- 长文本参数必须写入 `$LOOP_AGENT_TMP_DIR` 指向的工作区 `.tmp/loop-<run-id>/agent-<execution-id>` 目录，再使用 `--text-file <UTF-8 文件路径>`；其他长文本参数同样支持对应的 `-file` 形式。不要把临时文件写入源码目录或提交到 Git；本次 Loop Run 结束后 Harness 会统一清理整个 Run 临时目录。',
    '- 只有成功执行下列终止命令，当前工作才算提交：',
    ...profile.terminalActions.map((action) => `  - \`${command} ${terminalActionUsage(action)}\``),
    '- 普通最终回复、Markdown 代码块和自由文本不会推进流程。终止命令成功后，只需简短结束本轮。',
    '',
    '## 2. 冻结业务上下文（只读）',
    '先阅读 Prompt 已内联的 Working Context Pack 和 Required Context Refs。需要完整内容或发现更多资料时，使用下面的只读命令；它们不会修改需求、草稿或流程状态：',
    '',
    ...agentContextHelpLines(appRoot),
    '',
    '## 3. 实时项目事实（只读调查）',
    profile.draftType === 'review'
      ? 'Review 只对账冻结的需求、交付规格、最终仓库执行记录和独立 Test 证据；不要重新运行测试、修改仓库或开启新的实现调查。无法从已有事实闭合时声明 closure gap；Review 不创建问题或运行信息请求。'
      : '使用执行器提供的文件搜索、代码阅读、Git、配置检查和测试工具确认当前 AS-IS 与真实影响。仓库事实可以证明当前实现，但不能自行覆盖上游业务承诺或用户决定。只有完成冻结上下文读取和实时调查后仍无法从证据唯一确定，才声明缺少信息、提交问题或运行信息请求。',
  ].join('\n');
}
