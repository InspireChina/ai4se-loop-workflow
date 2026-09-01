import { parse } from 'yaml';
import { activeCommandChainYaml } from '../infrastructure/agent-configuration-store';
import { COMMAND_CHAIN_FILE_BY_ID, commandChainCatalogItem } from './command-chain-catalog';
import {
  parseRequirementMetadata,
  requirementMetadataDefinition,
  type RequirementMetadataKey,
} from './requirement-metadata';

export type CommandChainFieldDefinition = {
  type: 'string' | 'enum' | 'array';
  required: boolean;
  label?: string;
  values?: string[];
  minItems?: number;
};

export type CommandChainBlockDefinition = {
  title: string;
  cardinality: 'one' | 'many';
  format: 'markdown' | 'yaml' | 'text';
  writable: boolean;
  required: boolean;
  render: boolean;
  fields: Record<string, CommandChainFieldDefinition>;
};

export type CommandChainArtifactStorage = 'builtin' | 'repository';

export type CommandChainArtifactDefinition = {
  type: CommandChainArtifactStorage;
  adapter: string | null;
  title: string;
  blocks: Record<string, CommandChainBlockDefinition>;
};

export type CommandChainPhaseDefinition = {
  type: 'builtin' | 'artifact' | 'confirmation' | 'metadata';
  builtin: string | null;
  artifactBlocks: { artifactId: string; blockId: string }[];
  inputs: string[];
  title: string;
  instructions: string;
  objective: string;
  required: string;
  prohibited: string;
  contexts: string[];
  workCommands: string[];
  completeCommand: 'phase complete';
  rewindCommand: string | null;
  commands: string[];
  reviewBeforeSubmit: string[];
  validators: string[];
  transitions: string[];
};

export type CommandChainInputDefinition = {
  metadataKey: RequirementMetadataKey;
  required: boolean;
  defaultValue?: string;
};

type ArtifactBlockReference = {
  artifactId: string;
  blockId: string;
  block: CommandChainBlockDefinition;
};

export type CommandChainDecisionTreeDefinition = {
  builtin: string;
  minOptions: number;
  recommendationAuthorities: string[];
  resolutionAuthorities: string[];
};

export type CommandChainDefinition = {
  version: number;
  id: string;
  agent: string;
  artifacts: Record<string, CommandChainArtifactDefinition>;
  inputs: Record<string, CommandChainInputDefinition>;
  decisionTrees: Record<string, CommandChainDecisionTreeDefinition>;
  phases: Record<string, CommandChainPhaseDefinition>;
};

export { COMMAND_CHAIN_FILE_BY_ID } from './command-chain-catalog';

const REQUIRED_BUILT_IN_PHASES: Record<string, string[]> = {
  'idea-context': [
    'decision-proposal',
    'decision-resolution',
    'decision-answer-review',
    'business-analysis-finalize',
  ],
  'business-design': [
    'decision-proposal',
    'decision-resolution',
    'decision-answer-review',
    'business-analysis-finalize',
  ],
  'requirement-spec': [
    'business-analysis-finalize',
  ],
  'spec-review': [
    'business-analysis-finalize',
  ],
  'requirement-context': [
    'decision-proposal',
    'decision-resolution',
    'decision-answer-review',
    'acceptance-definition',
    'requirement-context-finalize',
  ],
  'delivery-plan': [
    'delivery-plan-inputs',
    'delivery-plan-finalize',
  ],
  reproduction: [
    'decision-proposal',
    'decision-resolution',
    'decision-answer-review',
    'reproduction-finalize',
  ],
  'delivery-analysis': [
    'delivery-unit',
    'decision-proposal',
    'decision-resolution',
    'decision-answer-review',
  ],
  development: [
    'delivery-spec',
    'implementation-evidence',
    'command-verification',
  ],
  verification: [
    'verification-inputs',
    'verification-plan',
    'verification-execution',
    'verification-finalize',
  ],
  review: [
    'review-inputs',
    'review-reconciliation',
    'review-output',
    'review-finalize',
  ],
  'feedback-triage': [
    'feedback-triage-inputs',
    'decision-proposal',
    'decision-resolution',
    'decision-answer-review',
    'feedback-triage-finalize',
  ],
  'feedback-verify': [
    'feedback-verify-inputs',
    'feedback-verify-finalize',
  ],
};

export function commandChainAuthoringGuide(commandChainId: string) {
  const requiredBuiltins = REQUIRED_BUILT_IN_PHASES[commandChainId] || [];
  return [
    '根节点只允许 version、id、agent、inputs、artifacts、phases；不要声明 decisionTrees。',
    'version 是正整数；id 与 agent 不得改变。',
    'artifacts.<artifact> 可声明 type: builtin 或 repository；默认是 builtin。repository Artifact 必须声明 adapter；每个 Block 必须声明 title、cardinality(one|many)、format(markdown|yaml|text)。',
    'Block 默认进入最终文档；仅工作过程使用的 Block 声明 render: false。Block 还可声明 required、writable。',
    'YAML Block 可声明 fields，field type 只允许 string、enum、array；所有声明字段都会按顺序渲染，label 是面向人的字段名。',
    'inputs 将命令链输入映射到已有需求 Metadata key，可声明 required 与 default；Phase 只会收到自己显式引用的 inputs。',
    'phases 是有序映射，声明顺序就是执行顺序。每个 Phase 必须使用 type: builtin、artifact、confirmation 或 metadata。',
    'artifact Phase 只允许 type、artifacts、inputs、instructions；artifacts 引用使用 <artifact>.<block>。',
    'confirmation Phase 只允许 type、inputs、instructions。',
    'metadata Phase 只允许 type、inputs、instructions；只能 set/remove 当前 Phase 引用的 Metadata。',
    'builtin Phase 只允许 type、builtin、artifacts、inputs；不得自行配置命令、validator、transition、objective 等 Harness 内部属性。',
    `当前命令链必须保留并按相对顺序包含这些内置 Phase：${requiredBuiltins.length ? requiredBuiltins.join(' → ') : '无' }。`,
    '不要手写命令。Artifact 命令由 Block 自动生成；repository Artifact 使用同步命令，不直接写入数据库；Decision、Acceptance、Phase 和终止门禁由 builtin 自动生成。',
    '允许新增、删除、重排普通 artifact/confirmation/metadata Phase，但不能形成绕过必要 builtin 的完成路径。',
  ].join('\n');
}

function builtInDecisionTree(id: string): CommandChainDecisionTreeDefinition {
  if (id !== 'decisions') throw new Error(`未知内置 Decision Tree：${id}`);
  return {
    builtin: id,
    minOptions: 2,
    recommendationAuthorities: ['upstream', 'user', 'project_evidence', 'agent_authority'],
    resolutionAuthorities: ['upstream', 'user', 'project_evidence', 'agent_authority'],
  };
}

function phaseTitle(id: string) {
  return id.replaceAll('_', ' ').toUpperCase();
}

function phaseNavigation(phaseId: string, phaseIds: string[]) {
  const index = phaseIds.indexOf(phaseId);
  const next = phaseIds[index + 1];
  const earlier = phaseIds.slice(0, index);
  return {
    next,
    earlier,
    completeCommand: 'phase complete' as const,
    rewindCommand: earlier.length ? 'phase rewind --to <earlier-phase> --reason <原因>' : null,
    transitions: [...earlier, ...(next ? [next] : [])],
  };
}

function artifactPutCommand({ artifactId, blockId, block }: ArtifactBlockReference) {
  const key = block.cardinality === 'many' ? ' --key <key>' : '';
  return `artifact put --artifact ${artifactId} --block ${blockId}${key} --content-file <${block.format}>`;
}

function artifactCommands(outputs: ArtifactBlockReference[]) {
  return outputs.flatMap((output) => {
    const { artifactId, blockId, block } = output;
    return [
      artifactPutCommand(output),
      ...(block.cardinality === 'many'
        ? [`artifact remove --artifact ${artifactId} --block ${blockId} --key <key>`]
        : []),
    ];
  });
}

function phaseCommands(workCommands: string[], navigation: ReturnType<typeof phaseNavigation>) {
  return [
    ...workCommands,
    navigation.completeCommand,
    ...(navigation.rewindCommand ? [navigation.rewindCommand] : []),
  ];
}

function builtInPhase(
  commandChainId: string,
  id: string,
  phaseId: string,
  phaseIds: string[],
  artifacts: ArtifactBlockReference[],
): Omit<CommandChainPhaseDefinition, 'inputs'> {
  const navigation = phaseNavigation(phaseId, phaseIds);

  if (id === 'acceptance-definition') {
    if (commandChainId !== 'requirement-context') {
      throw new Error('acceptance-definition 仅用于 Requirement Context');
    }
    if (artifacts.length !== 1
      || artifacts[0].artifactId !== 'requirement-context'
      || artifacts[0].blockId !== 'acceptance') {
      throw new Error(`内置 Phase phases.${phaseId} 必须将 Acceptance 投影到 requirement-context.acceptance`);
    }
    const workCommands = [
      'acceptance put --key <key> --content-file <yaml>',
      'acceptance remove --key <key>',
    ];
    return {
      type: 'builtin', builtin: id,
      artifactBlocks: artifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId })),
      title: 'ACCEPTANCE',
      instructions: '根据最终 Target 与 Scope 定义需求级、用户可观察的 Acceptance。每项 Acceptance 必须使用稳定 key，声明可观察结果、判定 Oracle 和来源；不要写测试步骤或实现方案。Acceptance 是跨 Agent 流转的内置实体，不是 Artifact。',
      objective: '定义可被 Delivery Unit 分配、Dev 实现、Test 独立验证和 Review 结算的需求级 Acceptance。',
      required: '至少定义一项 Acceptance；每项都有稳定 key、可观察 statement、oracle 和来源。',
      prohibited: '不要直接写入投影 Artifact，也不要写技术实现或测试步骤。',
      contexts: ['acceptance-definitions'], workCommands,
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['每项 Acceptance 都能独立判断成立或不成立。'],
      validators: ['acceptance-required'], transitions: navigation.transitions,
    };
  }

  if (id === 'delivery-unit') {
    const workCommands = ['delivery-unit current'];
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [],
      title: 'DELIVERY UNIT',
      instructions: '读取并确认当前交付单元、可追溯来源和前置依赖，建立本次命令链不可变的工作范围。交付单元契约必须完整，且至少包含一个可追溯来源。不要创建、修改或复制交付单元。',
      objective: '读取并确认当前交付单元、可追溯来源和前置依赖，建立本次命令链不可变的工作范围。',
      required: '当前交付单元契约完整，至少包含一个可追溯来源，所有前置依赖都有稳定 unit key。',
      prohibited: '不要在当前命令链中创建、修改或复制交付单元。',
      contexts: [],
      workCommands,
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['已读取当前交付单元及其来源和依赖。'],
      validators: ['delivery-unit'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'delivery-plan-inputs') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [],
      title: 'FROZEN PLAN INPUTS',
      instructions: '读取并确认 Harness 从业务变化上下文或当前反馈工作组冻结的规划输入。规划输入是本轮拆分必须完整承接的只读边界，不要修改、删除或改写来源语义。',
      objective: '确认本轮不可变的交付规划输入。',
      required: '至少存在一项冻结规划输入，且每项输入都有稳定 key、类型、内容和来源。',
      prohibited: '不要修改、删除、重命名或绕过冻结规划输入。',
      contexts: ['delivery-plan-inputs'],
      workCommands: [],
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation),
      reviewBeforeSubmit: ['已读取全部冻结规划输入及其来源。'],
      validators: ['artifact-schema', 'delivery-plan-inputs'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'verification-inputs') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FROZEN VERIFICATION INPUTS',
      instructions: '读取并确认 Harness 从当前 Delivery Spec 与活动恢复事项冻结的验证输入。这些输入是独立测试的只读 Oracle，不要根据当前实现或 Dev 自述改写 Expected。',
      objective: '确认本轮不可变的独立验证输入。',
      required: '至少存在一项 Acceptance，并且每项输入都有稳定 key、Oracle 和来源。',
      prohibited: '不要修改、删除或绕过冻结验证输入。',
      contexts: ['verification-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['已读取全部冻结验证输入及其来源。'],
      validators: ['artifact-schema', 'verification-inputs'], transitions: navigation.transitions,
    };
  }
  if (id === 'verification-plan') {
    const scenarios = artifacts.find((artifact) => artifact.blockId === 'scenarios');
    if (!scenarios || artifacts.length !== 1 || scenarios.block.cardinality !== 'many' || !scenarios.block.required) {
      throw new Error(`内置 Phase phases.${phaseId} 必须声明 required cardinality: many 的 scenarios Artifact Block`);
    }
    const workCommands = [
      ...artifactCommands(artifacts),
      'runtime-input put --key <key> --title <title> --question <question> --why <why> --recommendation <recommendation>',
      'runtime-input remove --key <key>',
    ];
    return {
      type: 'builtin', builtin: id,
      artifactBlocks: artifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId })),
      title: 'PLAN',
      instructions: '在观察当前 Actual 前建立独立黑盒场景。每个场景必须包含准备、真实入口动作、可观察 Expected 和冻结来源引用；全部输入都要覆盖，至少一项 Acceptance 由 frontend 场景覆盖。缺少执行资源时登记 runtime input。',
      objective: '建立覆盖冻结 Oracle 的独立黑盒验证计划。',
      required: '全部冻结输入都有场景覆盖，Acceptance 至少有一个 frontend 业务闭环。',
      prohibited: '不要根据当前实现或 Dev 自述改变 Expected，也不要在计划中预判通过。',
      contexts: ['verification-inputs'], workCommands,
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['Expected 只来自冻结输入。', '场景可以从真实入口重复执行。'],
      validators: ['artifact-schema', `artifact-required:${scenarios.artifactId}.${scenarios.blockId}`, 'verification-plan', 'runtime-input-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'verification-execution') {
    const scenarios = artifacts.find((artifact) => artifact.blockId === 'scenarios');
    const results = artifacts.find((artifact) => artifact.blockId === 'results');
    if (!scenarios || !results || artifacts.length !== 2 || results.block.cardinality !== 'many' || !results.block.required) {
      throw new Error(`内置 Phase phases.${phaseId} 必须声明 scenarios 和 required cardinality: many 的 results Artifact Block`);
    }
    const workCommands = [
      ...artifactCommands(artifacts),
      'runtime-input put --key <key> --title <title> --question <question> --why <why> --recommendation <recommendation>',
      'runtime-input remove --key <key>',
    ];
    return {
      type: 'builtin', builtin: id,
      artifactBlocks: artifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId })),
      title: 'EXECUTE',
      instructions: '逐项执行冻结场景，用 Artifact 登记 Actual、独立证据和最小责任分类。可以用新 key 追加新风险场景，但不能覆盖已冻结场景。blocked 必须同时登记继续验证所需的 runtime input；收到回答后更新结果再完成本阶段。',
      objective: '以独立观察完成全部冻结场景并寻找反例。',
      required: '每个场景都有规则一致的 passed 或 failed 结果；blocked 已形成 runtime input 并暂停。',
      prohibited: '不要修改冻结场景适配 Actual，也不要用代码阅读、单测或 Dev 声明冒充业务黑盒证据。',
      contexts: ['verification-inputs'], workCommands,
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['每项结果都有可定位且可重复的独立证据。', 'failureKind 与观察事实一致。'],
      validators: ['artifact-schema', `artifact-required:${results.artifactId}.${results.blockId}`, 'verification-plan', 'verification-execution', 'runtime-input-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'delivery-spec') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    const workCommands = ['delivery-spec current'];
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [],
      title: 'DELIVERY SPEC',
      instructions: '读取并确认当前交付单元的冻结 Delivery Spec，包括用户可观察结果、影响、保护约束和验证关注点。Delivery Spec 是只读输入，不要在开发命令链中修改业务契约。',
      objective: '读取并确认当前交付单元的冻结 Delivery Spec。',
      required: '当前交付单元存在已收敛且结构有效的 Delivery Spec。',
      prohibited: '不要在开发命令链中修改业务契约。',
      contexts: [],
      workCommands,
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['已读取当前 Delivery Spec 并确认实现范围。'],
      validators: ['delivery-spec'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'implementation-evidence') {
    const recovery = artifacts.find((artifact) => artifact.blockId === 'recovery-resolutions');
    if (!recovery || artifacts.length !== 1 || recovery.block.cardinality !== 'many') {
      throw new Error(`内置 Phase phases.${phaseId} 必须声明 cardinality: many 的 recovery-resolutions Artifact Block`);
    }
    const artifactBlocks = artifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId }));
    const workCommands = [
      'acceptance assess --key <key> --result claimed --evidence-file <text>',
      ...artifactCommands(artifacts),
      'runtime-input put --key <key> --title <title> --question <question> --why <why> --recommendation <recommendation>',
      'runtime-input remove --key <key>',
    ];
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks,
      title: 'IMPLEMENT',
      instructions: '依据冻结 Delivery Spec 完成最小充分实现，并通过 acceptance assess 对每项内置 Acceptance 登记实现声明；活动恢复事项仍通过 Artifact 登记。需要外部运行信息时登记稳定 runtime input；不要用计划、意图或待执行检查冒充已实现证据。',
      objective: '完成真实实现并逐项登记验收证据与恢复事项。',
      required: '每项冻结验收语义都有实现证据，全部活动恢复事项已经声明处理，运行信息请求均已回答。',
      prohibited: '不要改变业务契约、扩大当前交付单元或提前声明测试通过。',
      contexts: ['development-evidence'],
      workCommands,
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['每项验收证据都指向真实实现位置或行为。'],
      validators: [
        'artifact-schema',
        'development-criteria',
        'development-recovery',
        'runtime-input-complete',
      ],
      transitions: navigation.transitions,
    };
  }
  if (id === 'command-verification') {
    const risks = artifacts.find((artifact) => artifact.blockId === 'risks');
    if (!risks || artifacts.length !== 1 || risks.block.cardinality !== 'many') {
      throw new Error(`内置 Phase phases.${phaseId} 必须声明 cardinality: many 的 risks Artifact Block`);
    }
    const artifactBlocks = [{ artifactId: risks.artifactId, blockId: risks.blockId }];
    const workCommands = [
      'check record --key <key> --receipt <receipt> --summary <summary>',
      'check remove --key <key>',
      ...artifactCommands(artifacts),
      'runtime-input put --key <key> --title <title> --question <question> --why <why> --recommendation <recommendation>',
      'runtime-input remove --key <key>',
    ];
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks,
      title: 'DEVELOPER VERIFY',
      instructions: '执行与风险相称的真实检查，并从 Harness 捕获的当前命令事实中选择明确成功的 receipt。不要手写 passed 或 exit code；如实登记仍存在但不否定当前交付的风险。',
      objective: '用真实命令事实验证当前实现并披露残余风险。',
      required: '至少记录一条仍为最新的成功检查；恢复修正周期中的检查来自当前 execution；运行信息请求均已回答。',
      prohibited: '不要伪造命令结果，也不要把开发者自检包装成独立 Test Agent 验收。',
      contexts: ['captured-commands'],
      workCommands,
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['关键检查真实覆盖本轮变化和高风险回归边界。'],
      validators: ['artifact-schema', 'development-ready', 'runtime-input-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'decision-proposal') {
    const requirementContext = commandChainId === 'requirement-context';
    const reproduction = commandChainId === 'reproduction';
    const feedback = commandChainId === 'feedback-triage';
    const businessAnalysis = commandChainId === 'idea-context' || commandChainId === 'business-design';
    const workCommands = [
      'decision put --tree decisions --key <key> --content-file <yaml>',
      'decision remove --tree decisions --key <key>',
    ];
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [],
      title: 'DECISION TREE · PROPOSE',
      instructions: requirementContext
        ? '一次建立规格与现状冲突、遗漏影响或业务边界中会形成不同结果的完整决策树、选项、依赖和推荐。每个活动决策必须有稳定 key、至少两个选项、推荐项、推荐理由和建议决定权；本阶段不要关闭决策或请求用户确认。'
        : reproduction
          ? '只有缺失的用户事实会改变复现环境、触发条件或观察结论时，才一次建立完整对齐问题、互斥选项、依赖和推荐。成功复现或可由当前项目事实继续调查时不要创建 Decision；本阶段不要关闭问题或请求用户确认。'
          : feedback
            ? '只有歧义会改变反馈工作组边界、工作类型或验收语义，且不能从冻结评论和项目事实判断时，才一次建立完整澄清问题、互斥选项和推荐。不要为实现细节或可直接分流的评论创建问题。'
            : businessAnalysis
              ? '一次建立当前 Business Analysis 职责范围内会形成不同业务结果的完整决策树、选项、依赖和推荐。只提出不回答，不把可调查事实伪装成用户问题。'
            : '一次建立会改变 Dev 或 Test 交付结果的完整决策树、选项、依赖和推荐。每个活动决策必须有稳定 key、至少两个选项、推荐项、推荐理由和建议决定权；本阶段不要关闭决策或请求用户确认。',
      objective: requirementContext
        ? '建立会改变最终业务上下文的完整决策树、选项、依赖和推荐。'
        : reproduction
          ? '建立继续复现所必需的完整用户事实对齐问题。'
        : '一次建立会改变 Dev 或 Test 交付结果的完整决策树、选项、依赖和推荐。',
      required: '每个活动决策有稳定 key、至少两个选项、推荐项、推荐理由和建议决定权。',
      prohibited: '不要在本阶段关闭决策或请求用户确认。',
      contexts: [],
      workCommands,
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['根节点与条件子节点已经一次建立。', '依赖无环，推荐项存在于选项中。'],
      validators: [
        'artifact-schema',
        ...(['requirement-context', 'reproduction', 'feedback-triage', 'idea-context', 'business-design'].includes(commandChainId) ? [] : ['impact-links']),
        'decision-schema',
        'decision-graph',
      ],
      transitions: navigation.transitions,
    };
  }
  if (id === 'decision-resolution') {
    const requirementContext = commandChainId === 'requirement-context';
    const reproduction = commandChainId === 'reproduction';
    const feedback = commandChainId === 'feedback-triage';
    const businessAnalysis = commandChainId === 'idea-context' || commandChainId === 'business-design';
    const workCommands = [
      'decision resolve --tree decisions --key <key> --option <id> --authority <authority> --decision-file <text> --rationale-file <text> --evidence-file <text>',
      'decision ask --tree decisions --key <key>',
      'decision reopen --tree decisions --key <key>',
      ...artifactCommands(artifacts),
    ];
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: artifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId })),
      title: 'DECISION TREE · RESOLVE',
      instructions: requirementContext
        ? '继承冻结业务输入、项目证据和已有用户答案，并按当前自动决策强度关闭完整决策树。活动决策必须解决，或组成完整 HUMAN 批次后提交等待用户输入；发现遗漏时返回 proposal。'
        : reproduction
          ? '使用已有用户答案关闭原 Decision；尚无答案且确实缺少必要复现事实时，组成完整 HUMAN 批次后提交等待用户输入。不要把可以继续调查的技术问题转给用户，也不要替用户捏造运行事实。'
          : businessAnalysis
            ? '按冻结上游语义、可靠事实、Agent 权限和用户决定权关闭完整决策树。活动决策必须解决，或组成完整 HUMAN 批次后提交等待用户输入；发现遗漏时回到 proposal。'
          : '按上游承诺、项目证据、Agent 权限和用户决定权关闭完整决策树。活动决策必须解决，或组成完整 HUMAN 批次后提交等待用户输入；发现选项遗漏时返回 proposal 或 impact scan。',
      objective: requirementContext
        ? '按冻结输入、项目证据、Agent 权限和用户决定权关闭需求级决策树。'
        : reproduction
          ? '关闭用户已经回答的复现事实问题，或一次提交仍不可缺少的完整确认批次。'
        : '按上游承诺、项目证据、Agent 权限和用户决定权关闭完整决策树。',
      required: '活动决策必须解决，或组成一个完整 HUMAN 批次后提交等待用户输入。',
      prohibited: requirementContext
        ? '不要临时新增选项；发现遗漏时回到 proposal。'
        : '不要临时新增选项；发现遗漏时回到 proposal 或 impact scan。',
      contexts: reproduction || feedback ? [] : ['analysis-decision-policy'],
      workCommands,
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['用户答案在原 decision key 上以 user 权限关闭。', '已解决决策不再留下 needs_decision 影响。'],
      validators: [
        'artifact-schema',
        ...(['requirement-context', 'reproduction', 'feedback-triage', 'idea-context', 'business-design'].includes(commandChainId) ? [] : ['impact-links']),
        'decision-schema',
        'decision-graph',
        'decision-resolution',
        ...(reproduction ? ['reproduction-alignment'] : []),
      ],
      transitions: navigation.transitions,
    };
  }
  if (id === 'decision-answer-review') {
    if (artifacts.length !== 1) throw new Error(`内置 Phase phases.${phaseId} 必须声明一个 Artifact Block`);
    const [artifact] = artifacts;
    const workCommands = artifactCommands(artifacts);
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [{ artifactId: artifact.artifactId, blockId: artifact.blockId }],
      title: 'ANSWER REVIEW',
      instructions: commandChainId === 'reproduction'
        ? '复查全部用户补充事实、条件分支和组合影响，并使用 Artifact 命令登记结论。若补充事实改变了复现环境、步骤或证据，完成复查后回退 investigation 重新取证；没有人工问题时明确登记无需对齐。'
        : '聚合复查 HUMAN、上游、项目证据与 Agent 决策答案、条件分支和组合后果，并使用 Artifact 命令登记完整复查结果。不要改写既有答案；发现新问题时返回 proposal。',
      objective: commandChainId === 'reproduction'
        ? '确认用户补充事实是否要求重新执行复现调查。'
        : '聚合复查 HUMAN、上游、项目证据与 Agent 决策答案、条件分支和组合后果，确认是否出现新增影响或问题。',
      required: `登记一份完整复查结果到 ${artifact.artifactId}.${artifact.blockId}。`,
      prohibited: '不要改写既有答案；发现新问题时回到 PROPOSE。',
      contexts: [],
      workCommands,
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation),
      reviewBeforeSubmit: ['已复查 HUMAN、上游、项目证据和 Agent 形成的全部答案。'],
      validators: [
        'artifact-schema',
        `artifact-required:${artifact.artifactId}.${artifact.blockId}`,
        ...(['requirement-context', 'reproduction', 'feedback-triage', 'idea-context', 'business-design'].includes(commandChainId) ? [] : ['impact-links']),
        'decision-schema',
        'decision-graph',
        'decision-complete',
      ],
      transitions: navigation.transitions,
    };
  }
  if (id === 'requirement-context-finalize') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [],
      title: 'FINALIZE',
      instructions: '最终校验业务意图、可靠 AS-IS、已关闭决策、唯一 TO-BE、变化影响、范围与需求级验收语义，并由 Harness 编译冻结业务变化上下文。发现缺口时使用 phase rewind 回到对应阶段。',
      objective: '校验并编译冻结业务变化上下文。',
      required: '业务上下文的必要实体完整，引用有效，不存在证据冲突、待决影响或未关闭决策。',
      prohibited: '不要用普通总结代替实体登记，也不要在最终阶段补写前序 Artifact。',
      contexts: [],
      workCommands: [],
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation),
      reviewBeforeSubmit: ['AS-IS、决策、TO-BE、影响、范围和验收语义之间一致。'],
      validators: ['artifact-schema', 'decision-schema', 'decision-graph', 'decision-complete', 'requirement-context-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'delivery-plan-finalize') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [],
      title: 'FINALIZE',
      instructions: '最终校验拆分依据、交付单元、冻结来源覆盖、依赖和顺序，并由 Harness 编译可落库的交付计划。发现缺口时使用 phase rewind 回到对应阶段。',
      objective: '校验并编译完整、可独立验收的交付计划。',
      required: '所有冻结输入均被有效单元承接；单元结构完整、依赖无环且顺序一致。',
      prohibited: '不要用普通总结代替 Artifact，不要在最终阶段绕过来源覆盖。',
      contexts: ['delivery-plan-inputs'],
      workCommands: [],
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation),
      reviewBeforeSubmit: ['全部单元组合后完整覆盖本轮目标，并且每个单元都能独立验收。'],
      validators: ['artifact-schema', 'delivery-plan-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'reproduction-finalize') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin',
      builtin: id,
      artifactBlocks: [],
      title: 'FINALIZE',
      instructions: '最终校验复现结论、环境、步骤、观察证据和调查方向。只有稳定且有证据的 reproduced 结论可以进入交付规划；无法确认时回退 alignment_proposal 建立必要的用户事实问题，或回退 investigation 继续取证。',
      objective: '校验并编译可供后续交付规划使用的问题复现证据。',
      required: '结论为 reproduced，复现条件完整，并且至少存在一条可重复步骤和可定位观察证据。',
      prohibited: '不要把 not_reproduced 当作成功结果，也不要用根因猜测替代观察证据。',
      contexts: [],
      workCommands: [],
      completeCommand: navigation.completeCommand,
      rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation),
      reviewBeforeSubmit: ['Observed Actual 只表达已记录条件下的事实，不上升为权威业务语义。'],
      validators: ['artifact-schema', 'decision-schema', 'decision-graph', 'decision-complete', 'reproduction-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'verification-finalize') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FINALIZE',
      instructions: '最终校验冻结验证输入、黑盒计划、逐项结果与证据复核，并由 Harness 确定性编译 passed 或 failed 结果。环境或证据仍受阻时回退 execute 登记 runtime input，不能提交不确定结论。',
      objective: '编译版本绑定且可确定路由的独立验证结果。',
      required: '全部场景有非阻塞结果，证据复核完整，失败状态与责任分类一致。',
      prohibited: '不要手工选择流程路由，也不要把环境阻塞伪装成产品失败。',
      contexts: ['verification-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['Expected、Actual、证据和责任分类彼此一致。'],
      validators: ['artifact-schema', 'verification-inputs', 'verification-plan', 'verification-execution', 'verification-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'review-inputs') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FROZEN REVIEW INPUTS',
      instructions: '读取 Harness 冻结的需求级承诺、全部交付单元、报告更正要求、证据来源和 Review 版本边界。普通结卡必须覆盖完整 Requirement Context；报告更正只处理当前反馈工作组与当前报告基线。',
      objective: '确认本轮最终事实对账的不可变对象、证据和版本边界。',
      required: '冻结对象、证据来源和 Review 元数据完整，全部 Delivery Spec 引用均存在于当前 Context Snapshot。',
      prohibited: '不要修改、删除或绕过冻结输入，也不要在 Review 中重新运行测试或修改仓库。',
      contexts: ['review-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['已读取全部冻结对象及证据来源。'],
      validators: ['artifact-schema', 'review-inputs'], transitions: navigation.transitions,
    };
  }
  if (id === 'review-reconciliation') {
    const reconciliations = artifacts.find((artifact) => artifact.blockId === 'reconciliations');
    const gaps = artifacts.find((artifact) => artifact.blockId === 'gaps');
    if (!reconciliations || !gaps || artifacts.length !== 2
      || reconciliations.block.cardinality !== 'many' || gaps.block.cardinality !== 'many') {
      throw new Error(`内置 Phase phases.${phaseId} 必须声明 cardinality: many 的 reconciliations 和 gaps Artifact Block`);
    }
    const workCommands = artifactCommands(artifacts);
    return {
      type: 'builtin', builtin: id,
      artifactBlocks: artifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId })),
      title: 'FACT RECONCILIATION',
      instructions: '逐项处理冻结对象：已被事实证明的对象登记 reconciliation，尚不能闭合的对象登记 gap，同一对象只能选择一种。普通结卡的每项 reconciliation 都必须引用当前冻结来源中的独立 Test 通过证据；报告更正不能登记 gap。',
      objective: '把每个需求级承诺和交付结果收敛为最终事实或明确结卡缺口。',
      required: '每个冻结对象恰好有一个 reconciliation 或 gap，引用有效且没有重复绑定。',
      prohibited: '不要用文档、规格或 Dev 自述代替独立 Test 通过证据，也不要创建问题或 runtime input。',
      contexts: ['review-inputs'], workCommands,
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation), reviewBeforeSubmit: ['全部冻结对象都已逐项处理。'],
      validators: ['artifact-schema', 'review-inputs', 'review-reconciliation'], transitions: navigation.transitions,
    };
  }
  if (id === 'review-output') {
    const report = artifacts.find((artifact) => artifact.blockId === 'report-sections');
    const units = artifacts.find((artifact) => artifact.blockId === 'forward-units');
    if (!report || !units || artifacts.length !== 2
      || report.block.cardinality !== 'many' || units.block.cardinality !== 'many') {
      throw new Error(`内置 Phase phases.${phaseId} 必须声明 cardinality: many 的 report-sections 和 forward-units Artifact Block`);
    }
    const workCommands = artifactCommands(artifacts);
    return {
      type: 'builtin', builtin: id,
      artifactBlocks: artifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId })),
      title: 'CLOSURE OUTPUT',
      instructions: '根据已冻结的对账分支登记输出。没有 gap 时用 report-sections 编写结卡报告核心章节；存在 gap 时用 forward-units 形成可直接追加的完整交付单元，每个 gap 恰好覆盖一次且依赖无环。不要同时构造两个分支。',
      objective: '形成唯一且可由 Harness 应用的结卡报告或前向交付单元集合。',
      required: '无 gap 时核心报告章节完整；有 gap 时全部缺口恰好被完整单元覆盖。',
      prohibited: '不要手工选择 verdict，不要让一个 gap 被多个单元重复覆盖。',
      contexts: ['review-inputs'], workCommands,
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands(workCommands, navigation), reviewBeforeSubmit: ['输出与 gap 状态选择同一个且唯一的分支。'],
      validators: ['artifact-schema', 'review-inputs', 'review-reconciliation', 'review-assessment', 'review-output'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'review-finalize') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FINALIZE',
      instructions: '重新校验当前任务状态、Review 版本、冻结证据、逐项事实、需求级评估和唯一输出分支，并由 Harness 确定性编译 report_ready 或 closure_gap。发现变化时结束当前 execution 等待重新派发。',
      objective: '编译版本绑定、事实闭合且可直接应用的 Review 结果。',
      required: '输入仍然是当前版本，全部事实和输出结构通过内置校验。',
      prohibited: '不要创建问题、runtime input 或回退路由，也不要在最终阶段补写前序 Artifact。',
      contexts: ['review-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['最终结果只包含 report_ready 或 closure_gap 之一。'],
      validators: ['artifact-schema', 'review-inputs', 'review-reconciliation', 'review-assessment', 'review-output'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'feedback-triage-inputs') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FROZEN FEEDBACK BATCH',
      instructions: '读取 Harness 冻结的当前反馈批次评论和既有交付单元数量。后续分组必须完整覆盖这些评论，不能引入批次外评论。',
      objective: '确认本轮反馈分流的不可变评论集合。', required: '至少存在一条冻结评论和稳定 batch id。',
      prohibited: '不要遗漏、重复或引入批次外评论。', contexts: ['feedback-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['已读取全部冻结评论。'],
      validators: ['artifact-schema', 'feedback-triage-inputs'], transitions: navigation.transitions,
    };
  }
  if (id === 'feedback-triage-finalize') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FINALIZE',
      instructions: '最终校验评论覆盖、工作组结构、影响单元引用和已关闭澄清，由 Harness 编译反馈分流结果。',
      objective: '编译完整且可直接调度的反馈工作组。', required: '每条冻结评论恰好属于一个有效工作组，全部决策已关闭。',
      prohibited: '不要手工选择后续 Agent 或绕过工作类型规则。', contexts: ['feedback-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['全部评论覆盖且工作组可以独立执行。'],
      validators: ['artifact-schema', 'decision-schema', 'decision-graph', 'decision-complete', 'feedback-triage-inputs', 'feedback-triage-complete'],
      transitions: navigation.transitions,
    };
  }
  if (id === 'feedback-verify-inputs') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FROZEN FEEDBACK TARGET',
      instructions: '读取 Harness 冻结的当前目标评论和工作组。本轮只能独立验证这一条评论，不能顺带修改或关闭其他反馈。',
      objective: '确认本轮唯一反馈验证目标。', required: '目标评论和工作组均存在。',
      prohibited: '不要验证、关闭或改写其他评论。', contexts: ['feedback-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['已确认唯一目标评论。'],
      validators: ['artifact-schema', 'feedback-verify-inputs'], transitions: navigation.transitions,
    };
  }
  if (id === 'feedback-verify-finalize') {
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FINALIZE',
      instructions: '最终校验目标评论、独立证据和 resolved/reopened 结论，由 Harness 编译单评论验证结果。',
      objective: '编译可直接应用的反馈验证结论。', required: '摘要、至少一条独立证据、结论和理由完整。',
      prohibited: '不要创建问题或 runtime input，也不要把缺少证据写成 resolved。', contexts: ['feedback-inputs'], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation), reviewBeforeSubmit: ['证据足以支持当前 verdict。'],
      validators: ['artifact-schema', 'feedback-verify-inputs', 'feedback-verify-complete'], transitions: navigation.transitions,
    };
  }
  if (id === 'business-analysis-finalize') {
    if (!['idea-context', 'business-design', 'requirement-spec', 'spec-review'].includes(commandChainId)) {
      throw new Error('business-analysis-finalize 仅用于 Business Analysis 命令链');
    }
    if (artifacts.length) throw new Error(`内置 Phase phases.${phaseId} 不接受 Artifact Block`);
    return {
      type: 'builtin', builtin: id, artifactBlocks: [], title: 'FINALIZE',
      instructions: '最终校验当前 Business Analysis 产物、决策和回流分支。Harness 将根据结构化 gap 确定性选择推进、批准或回流；发现内容缺口时使用 phase rewind 返回对应阶段修正。',
      objective: '编译结构完整、职责明确且可直接交给下一 Agent 的 Business Analysis 结果。',
      required: '正常分支的正式产物完整；回流分支至少有一个证据充分且目标一致的结构化 gap；全部决策已经关闭。',
      prohibited: '不要在最终阶段补写前序 Artifact，也不要同时提交正常产物和回流 gap。',
      contexts: [], workCommands: [],
      completeCommand: navigation.completeCommand, rewindCommand: navigation.rewindCommand,
      commands: phaseCommands([], navigation),
      reviewBeforeSubmit: ['最终结果只选择推进、批准或单一目标回流中的一个分支。'],
      validators: [
        'artifact-schema',
        ...(commandChainId === 'idea-context' || commandChainId === 'business-design'
          ? ['decision-schema', 'decision-graph', 'decision-complete']
          : []),
        'business-analysis-complete',
      ],
      transitions: navigation.transitions,
    };
  }
  throw new Error(`未知内置 Phase：${id}`);
}

function reachablePhase(
  phases: Record<string, CommandChainPhaseDefinition>,
  start: string,
  target: (phaseId: string) => boolean,
  blocked?: string,
) {
  if (start === blocked) return false;
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length) {
    const phaseId = pending.shift()!;
    if (visited.has(phaseId) || phaseId === blocked) continue;
    visited.add(phaseId);
    if (target(phaseId)) return true;
    pending.push(...phases[phaseId].transitions);
  }
  return false;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`命令链 YAML ${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`命令链 YAML ${path} 必须是非空字符串`);
  return value.trim();
}

function strings(value: unknown, path: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`命令链 YAML ${path} 必须是字符串数组`);
  }
  return value.map((item) => (item as string).trim());
}

function boolean(value: unknown, path: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`命令链 YAML ${path} 必须是布尔值`);
  return value;
}

function positiveInteger(value: unknown, path: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`命令链 YAML ${path} 必须是正整数`);
  }
  return value;
}

function parseFields(value: unknown, path: string) {
  if (value === undefined) return {};
  const raw = object(value, path);
  return Object.fromEntries(Object.entries(raw).map(([name, input]) => {
    const field = object(input, `${path}.${name}`);
    const type = string(field.type, `${path}.${name}.type`);
    if (!['string', 'enum', 'array'].includes(type)) throw new Error(`命令链 YAML ${path}.${name}.type 无效`);
    const values = field.values === undefined ? undefined : strings(field.values, `${path}.${name}.values`);
    if (type === 'enum' && !values?.length) throw new Error(`命令链 YAML ${path}.${name}.values 不能为空`);
    return [name, {
      type: type as CommandChainFieldDefinition['type'],
      required: boolean(field.required, `${path}.${name}.required`, false),
      ...(field.label === undefined ? {} : { label: string(field.label, `${path}.${name}.label`) }),
      ...(values ? { values } : {}),
      ...(field.minItems === undefined ? {} : { minItems: positiveInteger(field.minItems, `${path}.${name}.minItems`) }),
    }];
  })) as Record<string, CommandChainFieldDefinition>;
}

export function parseCommandChainDefinition(id: string, yaml: string): CommandChainDefinition {
  const root = object(parse(yaml), id);
  const definitionId = string(root.id, 'id');
  if (definitionId !== id) throw new Error(`命令链 YAML id 必须是 ${id}`);
  const catalog = commandChainCatalogItem(id);
  if (!catalog) throw new Error(`未知命令链：${id}`);
  const agent = string(root.agent, 'agent');
  if (agent !== catalog.agentId) {
    throw new Error(`命令链 YAML ${id} 必须绑定 Agent ${catalog.agentId}`);
  }
  if (root.decisionTrees !== undefined) {
    throw new Error('命令链 YAML 不再支持顶层 decisionTrees；Decision Tree 由内置 Decision Phase 提供');
  }
  const inputs = Object.fromEntries(Object.entries(
    root.inputs === undefined ? {} : object(root.inputs, 'inputs'),
  ).map(([inputId, inputValue]) => {
    const input = object(inputValue, `inputs.${inputId}`);
    const allowed = new Set(['metadata', 'required', 'default']);
    const extra = Object.keys(input).filter((key) => !allowed.has(key));
    if (extra.length) throw new Error(`命令链 YAML inputs.${inputId} 包含不支持的属性 ${extra.join(', ')}`);
    const metadataKey = string(input.metadata, `inputs.${inputId}.metadata`);
    if (!requirementMetadataDefinition(metadataKey)) {
      throw new Error(`命令链 YAML inputs.${inputId}.metadata 不支持 Metadata key ${metadataKey}`);
    }
    const defaultValue = input.default === undefined
      ? undefined
      : string(input.default, `inputs.${inputId}.default`);
    if (defaultValue !== undefined) {
      parseRequirementMetadata([{ key: metadataKey, value: defaultValue }]);
    }
    return [inputId, {
      metadataKey: metadataKey as RequirementMetadataKey,
      required: boolean(input.required, `inputs.${inputId}.required`, false),
      ...(defaultValue === undefined ? {} : { defaultValue }),
    }];
  })) as CommandChainDefinition['inputs'];
  const inputEntries = Object.entries(inputs);
  const duplicateInputMetadata = inputEntries.find(([, input], index) => (
    inputEntries.findIndex(([, candidate]) => candidate.metadataKey === input.metadataKey) !== index
  ));
  if (duplicateInputMetadata) {
    throw new Error(`命令链 YAML inputs 不能重复映射 Metadata key ${duplicateInputMetadata[1].metadataKey}`);
  }
  const artifacts = Object.fromEntries(Object.entries(object(root.artifacts, 'artifacts')).map(([artifactId, input]) => {
    const artifact = object(input, `artifacts.${artifactId}`);
    const artifactType = string(artifact.type, `artifacts.${artifactId}.type`);
    if (!['builtin', 'repository'].includes(artifactType)) {
      throw new Error(`命令链 YAML artifacts.${artifactId}.type 必须是 builtin 或 repository`);
    }
    const adapter = artifact.adapter === undefined || artifact.adapter === null
      ? null
      : string(artifact.adapter, `artifacts.${artifactId}.adapter`);
    if (artifactType === 'repository' && !adapter) {
      throw new Error(`命令链 YAML repository Artifact ${artifactId} 必须声明 adapter`);
    }
    if (artifactType === 'builtin' && adapter) {
      throw new Error(`命令链 YAML builtin Artifact ${artifactId} 不能声明 adapter`);
    }
    const blocks = Object.fromEntries(Object.entries(object(artifact.blocks, `artifacts.${artifactId}.blocks`)).map(([blockId, blockInput]) => {
      const block = object(blockInput, `artifacts.${artifactId}.blocks.${blockId}`);
      const cardinality = string(block.cardinality, `artifacts.${artifactId}.blocks.${blockId}.cardinality`);
      const format = string(block.format, `artifacts.${artifactId}.blocks.${blockId}.format`);
      if (!['one', 'many'].includes(cardinality)) throw new Error(`命令链 YAML block ${blockId} cardinality 无效`);
      if (!['markdown', 'yaml', 'text'].includes(format)) throw new Error(`命令链 YAML block ${blockId} format 无效`);
      return [blockId, {
        title: string(block.title, `artifacts.${artifactId}.blocks.${blockId}.title`),
        cardinality: cardinality as CommandChainBlockDefinition['cardinality'],
        format: format as CommandChainBlockDefinition['format'],
        writable: boolean(block.writable, `artifacts.${artifactId}.blocks.${blockId}.writable`, true),
        required: boolean(block.required, `artifacts.${artifactId}.blocks.${blockId}.required`, false),
        render: boolean(block.render, `artifacts.${artifactId}.blocks.${blockId}.render`, true),
        fields: parseFields(block.fields, `artifacts.${artifactId}.blocks.${blockId}.fields`),
      }];
    }));
    return [artifactId, {
      type: artifactType as CommandChainArtifactStorage,
      adapter,
      title: string(artifact.title, `artifacts.${artifactId}.title`),
      blocks,
    }];
  })) as CommandChainDefinition['artifacts'];
  const resolveArtifactReferences = (value: unknown, path: string, allowReadOnly = false) => {
    const references = strings(value, path);
    if (!references.length) throw new Error(`命令链 YAML ${path} 不能为空`);
    if (new Set(references).size !== references.length) throw new Error(`命令链 YAML ${path} 不能重复`);
    return references.map((reference) => {
      const parts = reference.split('.');
      if (parts.length !== 2) throw new Error(`Artifact 引用 ${reference} 必须使用 <artifact>.<block> 格式`);
      const [artifactId, blockId] = parts;
      const block = artifacts[artifactId]?.blocks[blockId];
      if (!block) throw new Error(`命令链 YAML ${path} 引用了未声明的 Block ${reference}`);
      if (!allowReadOnly && !block.writable) throw new Error(`命令链 YAML ${path} 不能写入只读 Block ${reference}`);
      return { artifactId, blockId, block };
    });
  };
  const resolveInputReferences = (value: unknown, path: string) => {
    if (value === undefined) return [];
    const references = strings(value, path);
    if (new Set(references).size !== references.length) throw new Error(`命令链 YAML ${path} 不能重复`);
    for (const reference of references) {
      if (!inputs[reference]) throw new Error(`命令链 YAML ${path} 引用了未声明的 Input ${reference}`);
    }
    return references;
  };
  const rawPhases = object(root.phases, 'phases');
  const phaseIds = Object.keys(rawPhases);
  if (!phaseIds.length) throw new Error('命令链 YAML phases 不能为空');
  const phaseByBuiltin = new Map<string, string>();
  for (const [phaseId, input] of Object.entries(rawPhases)) {
    const phase = object(input, `phases.${phaseId}`);
    if (phase.builtin !== undefined && phase.type !== 'builtin') {
      throw new Error(`内置 Phase phases.${phaseId} 必须声明 type: builtin`);
    }
    if (phase.type !== 'builtin') continue;
    const builtin = string(phase.builtin, `phases.${phaseId}.builtin`);
    const allowed = new Set(['type', 'builtin', 'artifacts', 'inputs']);
    const extra = Object.keys(phase).filter((key) => !allowed.has(key));
    if (extra.length) throw new Error(`内置 Phase phases.${phaseId} 包含不支持的属性 ${extra.join(', ')}`);
    if (phaseByBuiltin.has(builtin)) throw new Error(`命令链 YAML ${definitionId} 必须且只能声明一次内置 Phase ${builtin}`);
    phaseByBuiltin.set(builtin, phaseId);
  }
  const requiredBuiltins = REQUIRED_BUILT_IN_PHASES[definitionId] || [];
  for (const requiredBuiltin of requiredBuiltins) {
    if (!phaseByBuiltin.has(requiredBuiltin)) {
      throw new Error(`命令链 YAML ${definitionId} 必须且只能声明一次内置 Phase ${requiredBuiltin}`);
    }
  }
  const requiredBuiltinIndexes = requiredBuiltins.map((builtin) => phaseIds.indexOf(phaseByBuiltin.get(builtin)!));
  if (requiredBuiltinIndexes.some((index, position) => position > 0 && index <= requiredBuiltinIndexes[position - 1])) {
    throw new Error(`命令链 YAML ${definitionId} 的必要内置 Phase 顺序无效`);
  }
  const phases = Object.fromEntries(Object.entries(rawPhases).map(([phaseId, input]) => {
    const phase = object(input, `phases.${phaseId}`);
    if (phase.type === 'builtin') {
      const builtin = string(phase.builtin, `phases.${phaseId}.builtin`);
      const phaseArtifacts = phase.artifacts === undefined
        ? []
        : resolveArtifactReferences(phase.artifacts, `phases.${phaseId}.artifacts`, true);
      const artifactBuiltins = [
        'decision-resolution', 'decision-answer-review', 'implementation-evidence', 'command-verification',
        'verification-plan', 'verification-execution', 'review-reconciliation', 'review-output',
        'acceptance-definition',
      ];
      if (!artifactBuiltins.includes(builtin) && phaseArtifacts.length) {
        throw new Error(`内置 Phase ${builtin} 不接受 Artifact Block`);
      }
      if (builtin !== 'acceptance-definition' && phaseArtifacts.some(({ block }) => !block.writable)) {
        throw new Error(`内置 Phase ${builtin} 不能写入只读 Artifact Block`);
      }
      if (builtin === 'decision-answer-review') {
        if (phaseArtifacts.length !== 1) throw new Error(`内置 Phase phases.${phaseId} 必须声明一个 Artifact Block`);
        const block = phaseArtifacts[0].block;
        if (block.cardinality !== 'one') {
          throw new Error(`内置 Phase phases.${phaseId}.artifacts 必须引用 cardinality: one 的 Block`);
        }
        if (!block.required) throw new Error(`内置 Phase phases.${phaseId}.artifacts 必须引用 required: true 的 Block`);
      }
      if (builtin === 'decision-resolution' && phaseArtifacts.some(({ block }) => block.cardinality !== 'many')) {
        throw new Error(`内置 Phase phases.${phaseId}.artifacts 只能引用 cardinality: many 的 Block`);
      }
      return [phaseId, {
        ...builtInPhase(
          definitionId,
          builtin,
          phaseId,
          phaseIds,
          phaseArtifacts,
        ),
        inputs: resolveInputReferences(phase.inputs, `phases.${phaseId}.inputs`),
      }];
    }
    if (phase.type === 'artifact') {
      const allowed = new Set(['type', 'artifacts', 'instructions', 'inputs']);
      const extra = Object.keys(phase).filter((key) => !allowed.has(key));
      if (extra.length) throw new Error(`Artifact Phase phases.${phaseId} 包含不能手工声明的属性 ${extra.join(', ')}`);
      const phaseArtifacts = resolveArtifactReferences(phase.artifacts, `phases.${phaseId}.artifacts`);
      const references = phaseArtifacts.map(({ artifactId, blockId }) => `${artifactId}.${blockId}`);
      const artifactBlocks = phaseArtifacts.map(({ artifactId, blockId }) => ({ artifactId, blockId }));
      const navigation = phaseNavigation(phaseId, phaseIds);
      const workCommands = artifactCommands(phaseArtifacts);
      const instructions = string(phase.instructions, `phases.${phaseId}.instructions`);
      return [phaseId, {
        type: 'artifact',
        builtin: null,
        artifactBlocks,
        inputs: resolveInputReferences(phase.inputs, `phases.${phaseId}.inputs`),
        title: phaseTitle(phaseId),
        instructions,
        objective: instructions,
        required: `完成本阶段声明的 Artifact Block：${references.join('、')}。`,
        prohibited: '不要写入本阶段未声明的 Artifact Block。',
        contexts: [],
        workCommands,
        completeCommand: navigation.completeCommand,
        rewindCommand: navigation.rewindCommand,
        commands: phaseCommands(workCommands, navigation),
        reviewBeforeSubmit: [],
        validators: [
          'artifact-schema',
          ...artifactBlocks
            .filter(({ artifactId, blockId }) => artifacts[artifactId].blocks[blockId].required)
            .map(({ artifactId, blockId }) => `artifact-required:${artifactId}.${blockId}`),
        ],
        transitions: navigation.transitions,
      }];
    }
    if (phase.type === 'confirmation') {
      const allowed = new Set(['type', 'instructions', 'inputs']);
      const extra = Object.keys(phase).filter((key) => !allowed.has(key));
      if (extra.length) throw new Error(`Confirmation Phase phases.${phaseId} 包含不能手工声明的属性 ${extra.join(', ')}`);
      const navigation = phaseNavigation(phaseId, phaseIds);
      const instructions = string(phase.instructions, `phases.${phaseId}.instructions`);
      return [phaseId, {
        type: 'confirmation',
        builtin: null,
        artifactBlocks: [],
        inputs: resolveInputReferences(phase.inputs, `phases.${phaseId}.inputs`),
        title: phaseTitle(phaseId),
        instructions,
        objective: instructions,
        required: '完成本阶段检查并明确确认。',
        prohibited: '发现问题时不要确认完成；使用 phase rewind 回到对应阶段修正。',
        contexts: [],
        workCommands: [],
        completeCommand: navigation.completeCommand,
        rewindCommand: navigation.rewindCommand,
        commands: phaseCommands([], navigation),
        reviewBeforeSubmit: [],
        validators: [],
        transitions: navigation.transitions,
      }];
    }
    if (phase.type === 'metadata') {
      const allowed = new Set(['type', 'inputs', 'instructions']);
      const extra = Object.keys(phase).filter((key) => !allowed.has(key));
      if (extra.length) throw new Error(`Metadata Phase phases.${phaseId} 包含不能手工声明的属性 ${extra.join(', ')}`);
      const phaseInputs = resolveInputReferences(phase.inputs, `phases.${phaseId}.inputs`);
      if (!phaseInputs.length) throw new Error(`Metadata Phase phases.${phaseId}.inputs 不能为空`);
      const navigation = phaseNavigation(phaseId, phaseIds);
      const instructions = string(phase.instructions, `phases.${phaseId}.instructions`);
      const workCommands = phaseInputs.flatMap((inputId) => {
        const key = inputs[inputId].metadataKey;
        return [
          `metadata set --key ${key} --value <value>`,
          `metadata remove --key ${key}`,
        ];
      });
      const requiredInputs = phaseInputs.filter((inputId) => inputs[inputId].required);
      return [phaseId, {
        type: 'metadata',
        builtin: null,
        artifactBlocks: [],
        inputs: phaseInputs,
        title: phaseTitle(phaseId),
        instructions,
        objective: instructions,
        required: requiredInputs.length
          ? `设置本阶段必需的 Metadata Input：${requiredInputs.join('、')}。`
          : '按当前需求事实设置本阶段声明的 Metadata Input。',
        prohibited: '不要写入当前阶段未声明的 Metadata，也不要把未知值或猜测登记为需求事实。',
        contexts: [],
        workCommands,
        completeCommand: navigation.completeCommand,
        rewindCommand: navigation.rewindCommand,
        commands: phaseCommands(workCommands, navigation),
        reviewBeforeSubmit: [],
        validators: requiredInputs.map((inputId) => `metadata-required:${inputId}`),
        transitions: navigation.transitions,
      }];
    }
    throw new Error(`命令链 YAML phases.${phaseId} 必须声明 type: builtin、type: artifact、type: confirmation 或 type: metadata`);
  })) as CommandChainDefinition['phases'];
  for (const [phaseId, phase] of Object.entries(phases)) {
    const invalid = phase.transitions.filter((target) => !phaseIds.includes(target));
    if (invalid.length) throw new Error(`命令链 YAML phases.${phaseId}.transitions 包含未知阶段 ${invalid.join(', ')}`);
  }
  const completionPhaseId = phaseIds.at(-1)!;
  const terminal = (phaseId: string) => phaseId === completionPhaseId;
  for (const requiredBuiltin of requiredBuiltins) {
    const matches = Object.entries(phases).filter(([, phase]) => phase.builtin === requiredBuiltin);
    if (matches.length !== 1) {
      throw new Error(`命令链 YAML ${definitionId} 必须且只能声明一次内置 Phase ${requiredBuiltin}`);
    }
    const requiredPhaseId = matches[0][0];
    if (requiredBuiltin.endsWith('-finalize') && requiredPhaseId !== completionPhaseId) {
      throw new Error(`内置 Phase ${requiredBuiltin} 必须是命令链最后一个阶段`);
    }
    const start = phaseIds[0];
    if (!reachablePhase(phases, start, (phaseId) => phaseId === requiredPhaseId)) {
      throw new Error(`内置 Phase ${requiredBuiltin} 无法从初始阶段到达`);
    }
    if (reachablePhase(phases, start, terminal, requiredPhaseId)) {
      throw new Error(`命令链 YAML 存在绕过内置 Phase ${requiredBuiltin} 的提交路径`);
    }
  }
  const decisionTrees: CommandChainDefinition['decisionTrees'] = requiredBuiltins.includes('decision-proposal')
    ? { decisions: builtInDecisionTree('decisions') }
    : {};
  return {
    version: positiveInteger(root.version, 'version'),
    id: definitionId,
    agent,
    artifacts,
    inputs,
    decisionTrees,
    phases,
  };
}

export function loadCommandChainDefinition(id: string): CommandChainDefinition {
  const yaml = activeCommandChainYaml(id);
  if (!yaml) throw new Error(`命令链配置不存在：${id}`);
  return parseCommandChainDefinition(id, yaml);
}
