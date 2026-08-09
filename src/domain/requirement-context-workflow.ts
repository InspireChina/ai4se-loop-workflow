export const REQUIREMENT_CONTEXT_PHASE_ORDER = [
  'as_is',
  'decision_proposal',
  'decision_resolution',
  'answer_review',
  'to_be',
  'impact_scan',
  'scope',
  'acceptance',
  'finalize',
] as const;

export type RequirementContextPhase = typeof REQUIREMENT_CONTEXT_PHASE_ORDER[number];

export type RequirementContextWorkPacketDefinition = {
  objective: string;
  required: string;
  batch?: string;
  prohibited: string;
  commands: string[];
  reviewBeforeSubmit: string[];
  submit: string;
  pendingHumanSubmit?: string;
};

export const REQUIREMENT_CONTEXT_WORKFLOW: Record<RequirementContextPhase, RequirementContextWorkPacketDefinition> = {
  as_is: {
    objective: '建立足以讨论本次变化的 AS-IS 事实基线。',
    required: 'Reported Intent、可靠 Actual、适用时的 Existing Expected，以及证据冲突和证明边界。',
    prohibited: '不要写 TO-BE、SCOPE 或用户决策问题；用户提出的做法此时仍是 reported 候选。',
    commands: [
      'requirement-context intent set',
      'requirement-context assertion upsert',
      'requirement-context assertion dismiss',
      'requirement-context assertion supersede',
      'help assertion',
    ],
    reviewBeforeSubmit: [
      'Actual 来自充分的项目事实调查，而不是只复述用户输入。',
      '若权威 Existing Expected 与代码或运行中的 Actual 不一致，两者均已记录并标明来源。',
      '证据冲突与当前材料不能证明的边界已显式保留。',
      '尚未提前写入 TO-BE、SCOPE 或要求用户决定可由事实确认的问题。',
    ],
    submit: 'requirement-context as-is complete',
  },
  decision_proposal: {
    objective: '依据输入业务方案与已接受的 AS-IS，只提出规格和代码现状冲突、遗漏影响处置，或为了让 TO-BE 与 SCOPE 在当前项目中唯一成立而必须关闭的实质分叉。',
    required: '稳定 decision key、互斥选项及后果、推荐与理由，以及建议决定权；允许在充分扫描后以零决策完成。',
    batch: '一次建立当前已知的全部根节点与条件子节点，以最少交互轮次充分覆盖，不按单问题拆轮次。',
    prohibited: '不要关闭决策或请求用户确认；即使答案明显，也只登记完整选项、推荐和建议决定权。不要主动改良、替换或扩展输入业务方案，也不要写最终 TO-BE 或 SCOPE。',
    commands: [
      'requirement-context question add',
      'requirement-context question option-add',
      'requirement-context question recommend',
      'requirement-context question depends-on',
      'requirement-context question dependency-remove',
      'requirement-context question supersede',
      'requirement-context question remove',
      'requirement-context assertion upsert --decision <decision key>',
      'requirement-context impact upsert --decision <decision key>',
      'help decision-proposal',
    ],
    reviewBeforeSubmit: [
      '所有会形成不同业务结果的根节点与条件子节点都已覆盖。',
      '可从环境或证据确认的事实没有转交用户决定。',
      '每个节点都有互斥选项、后果、推荐、推荐理由和建议决定权。',
      '所有节点都来自规格与现状冲突、遗漏影响或当前项目中的必要业务边界；没有主动改良、替换或扩展输入业务方案。',
      '尚未根据推荐、当前实现或 Agent 偏好关闭任何新发现的节点。',
    ],
    submit: 'requirement-context decision-proposal complete',
  },
  decision_resolution: {
    objective: '按已有承诺、项目证据、本次自动决策强度与用户决定权，关闭已经完整提出的需求级决策树。',
    required: '全部活动节点已由 Agent 关闭、由已有用户回答关闭，或按当前策略组成一个完整 HUMAN 批次。',
    prohibited: '不要在回答阶段临时新增问题、选项或推荐；发现遗漏决策时回流 PROPOSE。自动决策强度不能覆盖用户明确决定或扩大需求范围。',
    commands: [
      'requirement-context question decide',
      'requirement-context question ask',
      'requirement-context assertion upsert --decision <decision key>',
      'requirement-context impact upsert --decision <decision key>',
      'requirement-context decision-resolution reopen-proposals',
      'help decision-resolution',
    ],
    reviewBeforeSubmit: [
      '先继承已有用户决定和具备决定权的项目证据，再应用本次自动决策强度。',
      'Agent 自主结论没有覆盖明确输入、暗中扩大范围或创造无关业务结果。',
      '当前策略允许保留的 HUMAN 节点已一次标记并形成完整批次，而不是逐个随机追问；完全自主模式下不存在 HUMAN 节点。',
      '已回答节点沿用原 decision key，未命中分支不进入活动 TO-BE。',
    ],
    submit: 'requirement-context decision-resolution complete',
    pendingHumanSubmit: 'requirement-context request-clarification',
  },
  answer_review: {
    objective: '重新阅读全部 HUMAN 与 Agent 决策答案、活动条件分支及其组合后果，确认它们是否引入了尚未提出的新问题。',
    required: '一份聚合答案审查，覆盖全部活动答案、组合后果、被激活的子分支和潜在新语义；必须明确选择继续或增量补问。',
    prohibited: '不要在审查中直接新增或回答决策，也不要跳过 Agent 自主答案；发现新问题时回到 PROPOSE，并保留所有已关闭节点的稳定 key 和答案。',
    commands: [
      'requirement-context answer-review complete --artifact-file <答案审查>',
      'requirement-context answer-review expand --artifact-file <答案审查与新增问题依据>',
      'help answer-review',
    ],
    reviewBeforeSubmit: [
      'HUMAN 与 Agent 的答案均已逐项复查，没有因决定权来源不同而跳过任何节点。',
      '已检查答案组合是否激活条件子树、改变规格与代码现状冲突的解释，或产生新的 TO-BE/SCOPE 分叉。',
      '若出现新语义，只回流新增问题，不重问、改名、删除或覆盖已关闭节点。',
      '只有确认当前问题树在答案后仍完整闭合，才能继续 TO-BE。',
    ],
    submit: 'requirement-context answer-review complete',
  },
  to_be: {
    objective: '把输入业务方案、Active Decision Path 和必须保持的 Existing Expected 投影成经过 AS-IS 与影响核对的 TO-BE。',
    required: '每条 Target 都能追溯到已关闭决定、权威输入或明确约束，并共同形成自洽业务结果。',
    prohibited: 'TO-BE 不得创造未经记录的新选择；发现新业务分叉时重新打开决策树。',
    commands: [
      'requirement-context assertion upsert --perspective target',
      'requirement-context assertion dismiss',
      'requirement-context assertion supersede',
      'help assertion',
    ],
    reviewBeforeSubmit: [
      '每条 Target 都可追溯到活动决策路径、权威输入或明确约束。',
      'Target 共同覆盖选中分支形成的完整业务结果。',
      '没有把尚未记录的新选择隐藏在 TO-BE 陈述中。',
    ],
    submit: 'requirement-context to-be complete',
  },
  impact_scan: {
    objective: '对比 AS-IS 与 TO-BE，识别必须改变、必须保持和交付分析必须收敛的影响。',
    required: 'Change Summary；每项影响明确为 change、preserve 或 technical。',
    prohibited: '识别影响不等于扩大范围；新业务结果或新业务分叉必须回到决策树。',
    commands: [
      'requirement-context change set',
      'requirement-context impact upsert',
      'requirement-context impact dismiss',
      'requirement-context impact supersede',
      'requirement-context impact-scan reopen-decisions',
      'help impact',
    ],
    reviewBeforeSubmit: [
      '已对比所有相关 AS-IS、Existing Expected 与 TO-BE 业务表面。',
      '每项影响的 change、preserve 或 technical 处置均有依据。',
      '没有尚未关闭的业务结果或业务分叉。',
    ],
    submit: 'requirement-context impact-scan complete',
  },
  scope: {
    objective: '根据冻结 TO-BE、选中分支和影响处置派生本轮业务边界。',
    required: '至少一个 In Scope；明确相关但未选择、独立扩展或推迟的 Out of Scope。',
    prohibited: 'SCOPE 不得创造新的业务规则，也不得把 preserve 简化成无关事项。',
    commands: [
      'requirement-context scope include',
      'requirement-context scope exclude',
      'requirement-context scope remove',
      'requirement-context constraint add',
      'requirement-context constraint remove',
      'help scope',
    ],
    reviewBeforeSubmit: [
      '所有 In Scope 都由 TO-BE 或影响处置派生。',
      '相关但未选择、独立扩展或推迟的事项已明确排除。',
      '必须保持的行为没有因范围收敛而丢失。',
    ],
    submit: 'requirement-context scope complete',
  },
  acceptance: {
    objective: '根据最终 TO-BE 与 SCOPE 形成需求级验收语义，并最后确定需求分类。',
    required: '可观察 Acceptance；feature、bug、tech 或 other 分类；Bug 必须有可靠 Existing Expected。',
    prohibited: '不要写测试步骤、技术验证方式或实现方案。',
    commands: [
      'requirement-context acceptance upsert',
      'requirement-context acceptance dismiss',
      'requirement-context acceptance supersede',
      'requirement-context classification set',
      'help assertion',
      'help scope',
    ],
    reviewBeforeSubmit: [
      '验收语义覆盖最终 Target 与 In Scope 业务结果。',
      '每条验收都使用可观察的业务语言，不含实现或测试步骤。',
      '最终分类已有依据；若为 Bug，可靠 Existing Expected 已存在。',
    ],
    submit: 'requirement-context acceptance complete',
  },
  finalize: {
    objective: '对完整业务变化上下文做最终一致性校验并提交。',
    required: 'AS-IS 不由业务选择改写；DECISIONS 已关闭；TO-BE 不含隐含选择；SCOPE 不创造新语义。',
    prohibited: '不要通过普通最终文本、Markdown 或手写 JSON 代替终止命令。',
    commands: ['requirement-context validate'],
    reviewBeforeSubmit: [
      'AS-IS、决策、TO-BE、影响、SCOPE 与 Acceptance 之间没有语义冲突。',
      '不存在 pending、conflicted 或 needs_decision 活动项。',
      '稳定 key、修订历史与活动投影均正确。',
    ],
    submit: 'requirement-context complete',
  },
};

export const REQUIREMENT_CONTEXT_PHASE_SEQUENCE =
  'AS-IS → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → ANSWER REVIEW → TO-BE → Impact Scan → SCOPE → Acceptance → Finalize';

export function requirementContextNormalCommandPath() {
  return REQUIREMENT_CONTEXT_PHASE_ORDER.flatMap((phase) => {
    const definition = REQUIREMENT_CONTEXT_WORKFLOW[phase];
    return phase === 'finalize'
      ? ['requirement-context validate', definition.submit]
      : [definition.submit];
  });
}
