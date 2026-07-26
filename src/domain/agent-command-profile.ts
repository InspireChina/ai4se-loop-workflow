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
      'verification pass',
      'verification fail',
      'verification block',
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
    pipelines: ['review', 'feedback-report', 'resume'],
    namespace: 'review',
    draftType: 'review',
    terminalActions: [
      'review complete',
      'review request-input',
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
    `  ${command} overview`,
    '    重新查看当前工作、权威事实、活动义务和当前角色可见的最近执行摘要。',
    `  ${command} list [--kind document|delivery_spec|decision|runtime_input|feedback|execution|recovery] [--scope current|task|all]`,
    '    按资料类型或范围浏览冻结快照；不知道准确 ref 时使用。',
    `  ${command} get <context-ref>`,
    '    读取已知 ref 的完整内容；Prompt 给出 required refs 时优先使用。',
    `  ${command} search --query <keyword>`,
    '    按关键词发现相关资料；不能因为启动索引未展示某项就假设它不存在。',
    `  ${command} evidence [--stage context|repro|plan|analysis|dev|test|review]`,
    '    检查当前角色获准读取的执行与恢复证据；不能用它替代当前仓库事实。',
    `  ${command} history <context-ref>`,
    '    仅在资料存在版本、替代或冲突疑问时检查历史。',
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
        ? 'context|impact|decision|contract|finish'
        : profile.draftType === 'development'
          ? 'context|evidence|input|finish'
          : 'context';
  return [
    '# Agent Tool Contract',
    '当前 execution 有三类工具面。先判断需要恢复状态、读取冻结上下文，还是检查实时仓库事实；不要把所有资料一次性展开。',
    '',
    '## 1. 工作状态与结果提交',
    `当前角色使用 execution 绑定的 \`${profile.namespace}\` 命令空间渐进提交工作，不再生成或提交通用结果 JSON。`,
    `每次 Agent 进程启动后的第一条草稿命令必须是：${command} ${profile.namespace} status`,
    '这一步会恢复上一次 attempt 或澄清轮次留下的草稿。未查看状态前，所有编辑、校验和终止命令都会被拒绝。',
    'status 会列出当前角色草稿中的稳定 key。修改既有语义时必须复用原 key，并使用当前角色提供的编辑或显式修订命令；只有新增语义才创建新 key，禁止通过换名制造重复条目。问题的 decision key 和交付单元的 unit key 都跨轮次不可改名。',
    `使用 ${command} help 查看当前 execution 实际允许的命令；可使用 ${command} help <${helpTopics}> 查看相应主题。`,
    '',
    '## 2. 冻结业务上下文（只读）',
    '下面的命令只读取当前 execution 创建时冻结的 Context Snapshot，不修改需求、草稿或流程状态：',
    ...agentContextHelpLines(appRoot),
    '',
    '## 3. 实时项目事实（只读调查）',
    '使用执行器提供的文件搜索、代码阅读、Git、配置检查和测试工具确认当前 AS IS 与真实影响。仓库事实可以证明当前实现，但不能自行覆盖上游业务承诺或用户决定。',
    '',
    '## 工具选择顺序',
    `1. 始终先执行 ${profile.namespace} status，恢复已有草稿和稳定 key。`,
    '2. 阅读 Prompt 已内联的 Working Context Pack 与 required context refs；需要完整内容时使用 agent-context get。',
    '3. 不知道 ref 或怀疑资料未展示时使用 agent-context search/list；检查前序执行事实时使用 evidence；只有版本或替代冲突时使用 history。',
    '4. 使用仓库工具确认代码、配置、数据模型、Git 和测试中的实时 Ground Truth。',
    '5. 只有完成上述调查后仍无法从现有证据唯一确定，才声明缺少信息、提交问题或运行信息请求。',
    '',
    '## 命令行为',
    '命令失败时根据 Application 返回的错误修正后自行重试，不要因为一次校验失败就结束工作。',
    '长文本不要塞进命令行：任意 `--text <内容>` 一类参数都可改成 `--text-file <UTF-8 文件路径>`（例如 `--statement-file`、`--question-file`），尤其在 Windows 上应优先使用文件参数。',
    '草稿命令可以反复增加、修改或删除内容，不会推进业务状态。只有一个成功的终止命令才会结束当前工作。',
    `允许的终止命令：${profile.terminalActions.map((action) => `${command} ${terminalActionUsage(action)}`).join('；')}`,
    '普通最终回复、Markdown 代码块和自由文本都不会推进流程。成功执行终止命令后，只需简短结束本轮。',
  ].join('\n');
}
