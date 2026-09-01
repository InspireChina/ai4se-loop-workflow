import { loadCommandChainDefinition } from './command-chain-definition';

export type AgentCommandProfile = {
  id: string;
  agent: string;
  pipelines: string[];
  supportsResume?: boolean;
  namespace: string;
  draftType: 'direct' | 'requirement_context' | 'delivery_plan' | 'reproduction' | 'analysis' | 'development' | 'verification' | 'feedback' | 'review' | 'business_analysis';
  terminalActions: string[];
  commandChainId?: string;
};

export type AgentCommandChainPhase = {
  id: string;
  title: string;
  type: 'builtin' | 'artifact' | 'confirmation' | 'metadata' | 'direct';
  commands: string[];
};

export type AgentCommandChain = {
  pipeline: string;
  entryCommand: string | null;
  phases: AgentCommandChainPhase[];
  terminalActions: string[];
  configurationError?: string;
};

const PROFILES: AgentCommandProfile[] = [
  {
    id: 'direct',
    agent: 'direct-agent',
    pipelines: ['direct'],
    namespace: 'direct',
    draftType: 'direct',
    terminalActions: ['direct submit --summary-file <简短结论> [--result-file <完整结果>]'],
  },
  {
    id: 'idea-context',
    agent: 'idea-context-agent',
    pipelines: ['ba-intent', 'resume'],
    namespace: 'idea-context',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'idea-context',
  },
  {
    id: 'business-design',
    agent: 'business-design-agent',
    pipelines: ['ba-design', 'resume'],
    namespace: 'business-design',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'business-design',
  },
  {
    id: 'requirement-spec',
    agent: 'requirement-spec-agent',
    pipelines: ['ba-spec', 'resume'],
    namespace: 'requirement-spec',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'requirement-spec',
  },
  {
    id: 'spec-review',
    agent: 'spec-review-agent',
    pipelines: ['ba-review', 'resume'],
    namespace: 'spec-review',
    draftType: 'business_analysis',
    terminalActions: ['phase complete'],
    commandChainId: 'spec-review',
  },
  {
    id: 'requirement-context',
    agent: 'backlog-agent',
    pipelines: ['backlog', 'resume'],
    namespace: 'requirement-context',
    draftType: 'requirement_context',
    terminalActions: ['phase complete'],
    commandChainId: 'requirement-context',
  },
  {
    id: 'reproduction',
    agent: 'repro-agent',
    pipelines: ['repro', 'resume', 'feedback-repro'],
    namespace: 'reproduction',
    draftType: 'reproduction',
    terminalActions: ['phase complete'],
    commandChainId: 'reproduction',
  },
  {
    id: 'delivery-analysis',
    agent: 'analyst-agent',
    pipelines: ['analysis'],
    namespace: 'delivery-analysis',
    draftType: 'analysis',
    terminalActions: ['phase complete'],
    supportsResume: true,
    commandChainId: 'delivery-analysis',
  },
  {
    id: 'implementation',
    agent: 'dev-agent',
    pipelines: ['dev', 'resume'],
    namespace: 'implementation',
    draftType: 'development',
    terminalActions: ['phase complete'],
    commandChainId: 'development',
  },
  {
    id: 'verification',
    agent: 'test-agent',
    pipelines: ['test', 'resume'],
    namespace: 'verification',
    draftType: 'verification',
    terminalActions: ['phase complete'],
    commandChainId: 'verification',
  },
  {
    id: 'feedback-triage',
    agent: 'feedback-agent',
    pipelines: ['feedback-triage'],
    namespace: 'feedback',
    draftType: 'feedback',
    terminalActions: ['phase complete'],
    commandChainId: 'feedback-triage',
  },
  {
    id: 'feedback-verify',
    agent: 'feedback-agent',
    pipelines: ['feedback-verify'],
    namespace: 'feedback',
    draftType: 'feedback',
    terminalActions: ['phase complete'],
    commandChainId: 'feedback-verify',
  },
  {
    id: 'review',
    agent: 'review-agent',
    pipelines: ['review', 'feedback-report'],
    namespace: 'review',
    draftType: 'review',
    terminalActions: ['phase complete'],
    commandChainId: 'review',
  },
  {
    id: 'delivery-plan',
    agent: 'story-splitter-agent',
    pipelines: ['split', 'feedback-split'],
    namespace: 'delivery-plan',
    draftType: 'delivery_plan',
    terminalActions: ['phase complete'],
    commandChainId: 'delivery-plan',
  },
];

export function agentCommandProfile(agent: string, pipeline: string) {
  const profile = PROFILES.find((profile) =>
    profile.agent === agent
      && (profile.pipelines.includes(pipeline) || (pipeline === 'resume' && profile.supportsResume))) || null;
  return profile ? { ...profile } : null;
}

export function agentCommandProfiles() {
  return PROFILES.map((profile) => ({
    ...profile,
    pipelines: [...profile.pipelines],
    terminalActions: [...profile.terminalActions],
  }));
}

const PIPELINE_LABELS: Record<string, string> = {
  direct: 'Direct',
  'ba-intent': '需求意图确认',
  'ba-design': '业务方案设计',
  'ba-spec': '需求规格编写',
  'ba-review': '规格独立审查',
  backlog: '需求梳理',
  repro: '问题复现',
  analysis: '交付分析',
  dev: '开发实现',
  test: '独立验证',
  review: '结卡报告',
  split: '交付规划',
  resume: '恢复执行',
};

function commandChainPhases(profile: AgentCommandProfile, pipeline: string): AgentCommandChainPhase[] {
  if (pipeline === 'direct') {
    return [{
      id: 'direct',
      title: 'DIRECT',
      type: 'direct',
      commands: ['direct submit --summary-file <简短结论> [--result-file <完整结果>]'],
    }];
  }
  if (!profile.commandChainId) {
    throw new Error(`${profile.agent}/${pipeline} 未绑定 YAML 命令链`);
  }
  const definition = loadCommandChainDefinition(profile.commandChainId);
  return Object.entries(definition.phases).map(([id, phase]) => ({
    id,
    title: phase.title,
    type: phase.type,
    commands: [...phase.workCommands, phase.completeCommand],
  }));
}

export function agentCommandChains(agent: string): AgentCommandChain[] {
  const profiles = PROFILES.filter((profile) => profile.agent === agent);
  return profiles.map((profile) => {
    const pipeline = profile.pipelines[0];
    try {
      return {
        pipeline,
        entryCommand: pipeline === 'direct' ? 'direct run' : 'status',
        phases: commandChainPhases(profile, pipeline),
        terminalActions: [...profile.terminalActions],
      };
    } catch (error) {
      return {
        pipeline,
        entryCommand: null,
        phases: [],
        terminalActions: [],
        configurationError: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function agentPipelineLabel(pipeline: string) {
  return PIPELINE_LABELS[pipeline] || pipeline;
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
  if (profile.draftType === 'business_analysis') return `business-analysis:${taskId}:${agent}`;
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
  if (process.env.LOOP_DESKTOP === '1') {
    const node = process.env.LOOP_DESKTOP_NODE || process.execPath;
    return `${JSON.stringify(node)} ${JSON.stringify(`${appRoot}/desktop-runners/loop-agent.cjs`)}`;
  }
  return `node ${JSON.stringify(`${appRoot}/scripts/loop/loop-agent.mjs`)}`;
}

export function agentContextCommandPrefix(appRoot: string) {
  if (process.env.LOOP_DESKTOP === '1') {
    const node = process.env.LOOP_DESKTOP_NODE || process.execPath;
    return `${JSON.stringify(node)} ${JSON.stringify(`${appRoot}/desktop-runners/loopctl.cjs`)} agent-context`;
  }
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

export function agentCommandPrompt(appRoot: string, agent: string, pipeline: string) {
  const profile = agentCommandProfile(agent, pipeline);
  if (!profile) return null;
  const command = loopAgentCommandPrefix(appRoot);
  if (profile.draftType === 'direct') {
    return [
      '# Agent Tool Contract',
      '当前 execution 只有 RUN → SUBMIT 两步，不创建渐进式草稿。',
      '',
      '**第一步：**',
      '```bash',
      `${command} direct run`,
      '```',
      '',
      'run 成功后直接完成需求描述中的真实工作。',
      'RUN、真实工作或普通总结完成都不是 execution 终点；即使过程命令成功，也必须继续到下一步 SUBMIT。',
      '',
      '**第二步：**',
      '```bash',
      `${command} direct submit --summary-file <简短结论文件> --result-file <完整 Markdown 结果文件>`,
      '```',
      '',
      'summary 和 result 文件必须位于 `$LOOP_AGENT_TMP_DIR`。result 可省略，此时使用 summary 作为结果文档。只有 submit 成功后才能结束 execution；普通最终文本、阶段完成或 CLI exit 0 都不会完成需求。',
      '',
      '# 冻结业务上下文（只读）',
      ...agentContextHelpLines(appRoot),
    ].join('\n');
  }
  if (!profile.commandChainId) {
    throw new Error(`${profile.agent}/${pipeline} 未绑定 YAML 命令链`);
  }
  return [
    '# Agent Tool Contract',
    '当前 execution 使用 YAML 声明的通用命令链。命令不绑定 Agent namespace；Artifact、Decision 和 Phase 是共享协议。',
    '',
    '**首次必须执行：**',
    '```bash',
    `${command} status`,
    '```',
    '',
    'status 会恢复草稿、当前 Phase、稳定 key 和当前工作包允许的命令。未查看状态前，所有编辑、校验和提交都会被拒绝。',
    '',
    '**通用帮助：**',
    '```bash',
    `${command} help`,
    '```',
    '',
    '**执行规则：**',
    '- 只执行 status 当前工作包列出的命令；Artifact/Decision 编辑不会自动推进 Phase。',
    '- 长文本和 YAML 写入 `$LOOP_AGENT_TMP_DIR` 后使用对应 `--content-file`、`--decision-file` 等参数。',
    '- 所有 Phase 都使用 `phase complete` 完成；Harness 会按 Phase type 校验、推进、等待输入或完成整个命令链。',
    '- Artifact 必须通过当前工作包列出的命令写入，不能把内容直接附加在 `phase complete` 上。',
    '- 发现遗漏时使用 `phase rewind --to <earlier-phase> --reason <原因>` 回到任一更早阶段。',
    '- 普通最终文本和 CLI exit 0 都不是终点；只有末尾 Phase 的 `phase complete` 成功后才能结束 execution。',
    '- 命令失败时修正后自行重试，不能以普通最终文本代替提交。',
    '',
    '## 冻结业务上下文（只读）',
    ...agentContextHelpLines(appRoot),
  ].join('\n');
}
