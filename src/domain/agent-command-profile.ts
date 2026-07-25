export type AgentCommandProfile = {
  id: string;
  agent: string;
  pipelines: string[];
  namespace: string;
  draftType: 'requirement_context' | 'delivery_plan' | 'reproduction' | 'analysis' | 'development' | 'verification' | 'feedback';
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
    id: 'analysis',
    agent: 'analyst-agent',
    pipelines: ['analysis', 'resume'],
    namespace: 'analysis',
    draftType: 'analysis',
    terminalActions: [
      'analysis complete',
      'analysis request-clarification',
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
    return `analysis:${taskId}:${storyIndex ?? 'unit'}`;
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
  return `${profile.draftType}:${taskId}:${storyIndex ?? 'task'}`;
}

export function agentCommandPrompt(appRoot: string, agent: string, pipeline: string) {
  const profile = agentCommandProfile(agent, pipeline);
  if (!profile) return null;
  const command = `node ${JSON.stringify(`${appRoot}/scripts/loop/loop-agent.mjs`)}`;
  return [
    '# Agent Command Contract',
    `当前角色使用 execution 绑定的 \`${profile.namespace}\` 命令空间渐进提交工作，不再生成或提交通用结果 JSON。`,
    `每次 Agent 进程启动后的第一条领域命令必须是：${command} ${profile.namespace} status`,
    '这一步会恢复上一次 attempt 或澄清轮次留下的草稿。未查看状态前，所有编辑、校验和终止命令都会被拒绝。',
    'status 会列出当前角色草稿中的稳定 key。修改既有语义时必须复用原 key 进行覆盖或删除；只有新增语义才创建新 key，禁止通过换名制造重复条目。问题的 decision key 和交付单元的 unit key 都跨轮次不可改名。',
    `使用 ${command} help 查看当前 execution 实际允许的命令；命令失败时根据错误修正后自行重试，不要因为一次校验失败就结束工作。`,
    '长文本不要塞进命令行：任意 `--text <内容>` 一类参数都可改成 `--text-file <UTF-8 文件路径>`（例如 `--statement-file`、`--question-file`），尤其在 Windows 上应优先使用文件参数。',
    '草稿命令可以反复增加、修改或删除内容，不会推进业务状态。只有一个成功的终止命令才会结束当前工作。',
    `允许的终止命令：${profile.terminalActions.map((action) => `${command} ${action}`).join('；')}`,
    '普通最终回复、Markdown 代码块和自由文本都不会推进流程。成功执行终止命令后，只需简短结束本轮。',
  ].join('\n');
}
