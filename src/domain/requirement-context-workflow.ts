export const REQUIREMENT_CONTEXT_PHASE_ORDER = [
  'as_is',
  'decision_tree',
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
  decision_tree: {
    objective: '依据 Reported Intent 与已接受的 AS-IS，覆盖所有会改变需求语义或交付规划的实质分叉。',
    required: '稳定 decision key、互斥选项及后果、推荐与理由；事实可关闭的节点不得询问用户。',
    batch: '一次建立当前已知的全部根节点与条件子节点，以最少交互轮次充分覆盖，不按单问题拆轮次。',
    prohibited: '不要写最终 TO-BE 或 SCOPE；只问无法从证据确定且会形成不同业务结果的选择。',
    commands: [
      'requirement-context question add',
      'requirement-context question option-add',
      'requirement-context question recommend',
      'requirement-context question depends-on',
      'requirement-context question dependency-remove',
      'requirement-context question decide',
      'requirement-context question supersede',
      'requirement-context question remove',
      'requirement-context assertion upsert --decision <decision key>',
      'requirement-context impact upsert --decision <decision key>',
      'help question',
    ],
    reviewBeforeSubmit: [
      '所有会形成不同业务结果的根节点与条件子节点都已覆盖。',
      '可从环境或证据确认的事实没有转交用户决定。',
      '每个 HUMAN 节点都有互斥选项、后果、推荐与推荐理由。',
      '每个 AGENT 节点都有职责内依据并已使用 question decide 关闭。',
    ],
    submit: 'requirement-context decision-tree complete',
    pendingHumanSubmit: 'requirement-context request-clarification',
  },
  to_be: {
    objective: '把 Reported Intent、Active Decision Path 和必须保持的 Existing Expected 投影成 TO-BE。',
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
  'AS-IS → Decision Tree → TO-BE → Impact Scan → SCOPE → Acceptance → Finalize';

export function requirementContextNormalCommandPath() {
  return REQUIREMENT_CONTEXT_PHASE_ORDER.flatMap((phase) => {
    const definition = REQUIREMENT_CONTEXT_WORKFLOW[phase];
    return phase === 'finalize'
      ? ['requirement-context validate', definition.submit]
      : [definition.submit];
  });
}
