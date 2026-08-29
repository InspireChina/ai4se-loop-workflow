import { businessAnalysisPhases, businessAnalysisWorkflow } from './business-analysis-workflow';
import { loadCommandChainDefinition } from './command-chain-definition';
import { DELIVERY_ANALYSIS_AGENT, DELIVERY_ANALYSIS_TERMINAL_ACTIONS } from './delivery-analysis-workflow';

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
  type: 'builtin' | 'artifact' | 'confirmation' | 'direct' | 'legacy';
  commands: string[];
};

export type AgentCommandChain = {
  pipeline: string;
  entryCommand: string | null;
  phases: AgentCommandChainPhase[];
  terminalActions: string[];
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
    terminalActions: ['idea-context complete', 'idea-context request-clarification'],
  },
  {
    id: 'business-design',
    agent: 'business-design-agent',
    pipelines: ['ba-design', 'resume'],
    namespace: 'business-design',
    draftType: 'business_analysis',
    terminalActions: ['business-design complete', 'business-design request-clarification', 'business-design return-gap'],
  },
  {
    id: 'requirement-spec',
    agent: 'requirement-spec-agent',
    pipelines: ['ba-spec', 'resume'],
    namespace: 'requirement-spec',
    draftType: 'business_analysis',
    terminalActions: ['requirement-spec complete', 'requirement-spec return-gap'],
  },
  {
    id: 'spec-review',
    agent: 'spec-review-agent',
    pipelines: ['ba-review', 'resume'],
    namespace: 'spec-review',
    draftType: 'business_analysis',
    terminalActions: ['spec-review approve', 'spec-review return-revision'],
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
    agent: DELIVERY_ANALYSIS_AGENT,
    pipelines: ['analysis'],
    namespace: 'delivery-analysis',
    draftType: 'analysis',
    terminalActions: [...DELIVERY_ANALYSIS_TERMINAL_ACTIONS],
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
  return PROFILES.find((profile) =>
    profile.agent === agent
      && (profile.pipelines.includes(pipeline) || (pipeline === 'resume' && profile.supportsResume))) || null;
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
  if (profile.commandChainId) {
    const definition = loadCommandChainDefinition(profile.commandChainId);
    return Object.entries(definition.phases).map(([id, phase]) => ({
      id,
      title: phase.title,
      type: phase.type,
      commands: [...phase.workCommands, phase.completeCommand],
    }));
  }
  if (pipeline === 'direct') {
    return [{
      id: 'direct',
      title: 'DIRECT',
      type: 'direct',
      commands: ['direct submit --summary-file <简短结论> [--result-file <完整结果>]'],
    }];
  }
  if (profile.draftType === 'business_analysis') {
    const workflow = businessAnalysisWorkflow(profile.agent);
    if (workflow) return businessAnalysisPhases(profile.agent as Parameters<typeof businessAnalysisPhases>[0], false)
      .flatMap((id): AgentCommandChainPhase[] => {
        const phase = workflow.definitions[id];
        return phase ? [{
          id,
          title: phase.label,
          type: 'legacy',
          commands: phase.submit ? [phase.submit] : [],
        }] : [];
      });
  }
  return [{
    id: profile.id,
    title: profile.id.replaceAll('-', ' ').toUpperCase(),
    type: 'legacy',
    commands: [...profile.terminalActions],
  }];
}

export function agentCommandChains(agent: string): AgentCommandChain[] {
  const profiles = PROFILES.filter((profile) => profile.agent === agent);
  return profiles.map((profile) => {
    const pipeline = profile.pipelines[0];
    return {
      pipeline,
      entryCommand: pipeline === 'direct' ? 'direct run' : 'status',
      phases: commandChainPhases(profile, pipeline),
      terminalActions: [...profile.terminalActions],
    };
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

function terminalActionUsage(action: string) {
  if (action === 'business-design return-gap') return `${action} --reason-file <需求意图缺口> [--artifact-file <缺口报告>]`;
  if (action === 'requirement-spec return-gap') return `${action} --target <intent|business_design> --reason-file <理由> [--artifact-file <缺口报告>]`;
  if (action === 'spec-review approve') return `${action} --artifact-file <完整需求规格>`;
  if (action === 'spec-review return-revision') return `${action} --target <intent|business_design|specification> --reason-file <理由> [--artifact-file <审查报告>]`;
  return action;
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
  if (profile.commandChainId) {
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
  const helpTopics = profile.draftType === 'requirement_context'
    ? 'context|assertion|impact|decision-proposal|decision-resolution|answer-review|scope|finish'
    : profile.draftType === 'analysis'
        ? 'context|impact|decision-proposal|decision-resolution|answer-review|contract|finish'
        : profile.draftType === 'development'
          ? 'context|evidence|review|commit|input|finish'
          : profile.draftType === 'verification'
            ? 'context|plan|execute|evidence|input|finish'
            : profile.draftType === 'review'
              ? 'context|reconciliation|gap|assessment|report|forward|finish'
              : profile.draftType === 'business_analysis'
                ? 'context|workflow|artifact|decision|finish'
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
    ...(['requirement_context', 'analysis', 'development', 'verification', 'review', 'business_analysis'].includes(profile.draftType)
      ? ['', `\`${profile.namespace}\` 的 help 必须指定一个主题；当前阶段可执行命令以 \`status\` 返回的工作包为准。`]
      : []),
    '',
    '**编辑与提交规则：**',
    '',
    '- `status`、任意编辑命令、阶段校验、测试完成或 `COMMAND RESULT` 成功都只是中间状态。每次读取 `NEXT` 或 `NEXT WORK PACKET` 后必须继续整条命令链，不能在角色终止命令成功前主动结束 execution。',
    '- 命令失败时，根据返回的错误修正后自行重试；不要因为一次校验失败就结束工作。',
    ...(['requirement-context', 'delivery-plan', 'delivery-analysis', 'implementation', 'verification', 'review', 'idea-context', 'business-design', 'requirement-spec', 'spec-review'].includes(profile.namespace)
      ? [`- ${profile.namespace} 命令统一返回 \`COMMAND RESULT\`；继续当前阶段时读取 \`NEXT\`，阶段切换时读取 \`NEXT WORK PACKET\`。`]
      : []),
    '- 草稿命令可以反复增加、修改或删除内容，不会推进业务状态。',
    '- 长文本参数必须写入 `$LOOP_AGENT_TMP_DIR` 指向的工作区 `.tmp/agent-<execution-id>` 目录，再使用 `--text-file <UTF-8 文件路径>`；其他长文本参数同样支持对应的 `-file` 形式。不要自行拼接临时目录，不要把临时文件写入源码目录或提交到 Git；当前 execution 结束后 Harness 会清理该目录。',
    '- 只有成功执行下列终止命令，当前工作才算提交：',
    ...profile.terminalActions.map((action) => `  - \`${command} ${terminalActionUsage(action)}\``),
    '- 普通最终回复、Markdown 代码块、自由文本、阶段完成和 CLI exit 0 都不会推进或结束流程。终止命令成功后，只需简短结束本轮。',
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
