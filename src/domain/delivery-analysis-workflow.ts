export const DELIVERY_ANALYSIS_PHASE_ORDER = [
  'impact_scan',
  'decision_tree',
  'delivery_contract',
  'finalize',
] as const;

export type DeliveryAnalysisPhase = typeof DELIVERY_ANALYSIS_PHASE_ORDER[number];

export type DeliveryAnalysisWorkPacketDefinition = {
  title: string;
  objective: string;
  required: string;
  prohibited: string;
  commands: string[];
  reviewBeforeSubmit: string[];
  submit: string;
};

export const DELIVERY_ANALYSIS_WORKFLOW: Record<DeliveryAnalysisPhase, DeliveryAnalysisWorkPacketDefinition> = {
  impact_scan: {
    title: 'AS-IS & IMPACT SCAN',
    objective: '读取冻结业务契约与前置交付契约，用实时项目证据确认当前交付单元真正会改变、保持、排除或需要决策的影响。',
    required: '至少一项有 area、finding、disposition 和可定位 evidence 的实际影响；needs_decision 影响必须关联已建立稳定身份的 decision key。',
    prohibited: '不要写最终 summary、交付契约、guardrail 或 verification focus；不要把当前代码自动当作正确业务规则。',
    commands: [
      'delivery-analysis impact upsert',
      'delivery-analysis impact remove',
      'delivery-analysis decision upsert',
      'help impact',
      'help decision',
    ],
    reviewBeforeSubmit: [
      '已读取完整业务变化上下文、交付计划和所有前置单元的最新 resolved Delivery Spec。',
      '已从参与者和可观察结果、实时项目结构两个方向完成 Do It Twice 调查。',
      '每项影响都有可定位证据，并且没有把上游已确认语义重新包装为待决策问题。',
      '需要独立业务结果的新范围已明确 exclude，没有暗中扩大当前单元。',
    ],
    submit: 'delivery-analysis impact-scan complete',
  },
  decision_tree: {
    title: 'DECISION TREE',
    objective: '按决定权关闭所有会让 Dev 或 Test 得出不同交付结果的关键选择，并将关联影响收敛为最终 disposition。',
    required: '全部活动决策具有稳定 key 和决定权依据；HUMAN 节点具有互斥选项、后果、推荐及理由；已回答节点必须在原 key 上以 user 权限关闭。',
    prohibited: '不要新增影响或改写上游业务契约；发现遗漏影响时显式回流 IMPACT SCAN。',
    commands: [
      'delivery-analysis decision upsert',
      'delivery-analysis decision option-upsert',
      'delivery-analysis decision option-remove',
      'delivery-analysis decision depends-on',
      'delivery-analysis decision dependency-remove',
      'delivery-analysis decision resolve',
      'delivery-analysis decision ask',
      'delivery-analysis decision reopen',
      'delivery-analysis decision remove',
      'delivery-analysis impact resolve',
      'delivery-analysis decision-tree reopen-impacts',
      'help decision',
    ],
    reviewBeforeSubmit: [
      '全部根节点和已知条件子节点已一次建立，没有把相互依赖的问题拆成多轮随机追问。',
      '可由上游承诺、项目证据或 Agent 专业权限唯一关闭的选择没有转交用户。',
      '所有活动 HUMAN 节点的选项互斥、后果明确，并有真实推荐与理由。',
      '已关闭决策的关联影响不再保留 needs_decision；未命中分支不进入活动交付契约。',
    ],
    submit: 'delivery-analysis decision-tree complete',
  },
  delivery_contract: {
    title: 'DELIVERY CONTRACT',
    objective: '将已收敛的影响和决策压缩成 Dev 与 Test 共同依赖、又不剥夺两者专业自主性的冻结交付契约。',
    required: '交付分析 summary 和 implementation guidance；必要时增加 guardrail 与 Acceptance 之外的 verification focus。',
    prohibited: '不要保存调查过程、逐文件计划、结果等价的局部实现选择或完整测试步骤；新影响或新决策必须显式回流。',
    commands: [
      'delivery-analysis summary set',
      'delivery-analysis contract set',
      'delivery-analysis guardrail upsert',
      'delivery-analysis guardrail remove',
      'delivery-analysis verification-focus upsert',
      'delivery-analysis verification-focus remove',
      'delivery-analysis contract reopen-decisions',
      'delivery-analysis contract reopen-impacts',
      'help contract',
    ],
    reviewBeforeSubmit: [
      '两个合理 Dev Agent 遵守契约时，不会交付实质不同的用户可观察结果。',
      '两个独立 Test Agent 都能从契约推导出唯一业务 Oracle，但仍保留验证方法自主性。',
      'Guardrail 只保护已确认边界，Verification Focus 只补充单元 Acceptance 之外容易遗漏的风险。',
      '契约没有创造新业务语义、隐含技术选型或暗中扩大范围。',
    ],
    submit: 'delivery-analysis contract complete',
  },
  finalize: {
    title: 'FINALIZE',
    objective: '对完整交付分析做最终一致性校验并提交。',
    required: '活动影响、已关闭决策、summary、implementation guidance、guardrails 与 verification focus 互相一致。',
    prohibited: '不要在 FINALIZE 直接改写产物；发现问题时显式重新打开 DELIVERY CONTRACT。',
    commands: [
      'delivery-analysis validate',
      'delivery-analysis finalize reopen-contract',
      'help finish',
    ],
    reviewBeforeSubmit: [
      '不存在活动未决节点、needs_decision 影响或未处理的用户回答。',
      '影响 disposition、决策结论、交付方向和验证 Oracle 之间没有冲突。',
      '最终人类可读文档不使用内部稳定 key 干扰判断，机器结构仍保留稳定身份与追溯关系。',
    ],
    submit: 'delivery-analysis complete',
  },
};

export const DELIVERY_ANALYSIS_PHASE_SEQUENCE =
  'AS-IS & IMPACT SCAN → DECISION TREE → DELIVERY CONTRACT → FINALIZE';

export function deliveryAnalysisNormalCommandPath() {
  return DELIVERY_ANALYSIS_PHASE_ORDER.flatMap((phase) => {
    const definition = DELIVERY_ANALYSIS_WORKFLOW[phase];
    return phase === 'finalize'
      ? ['delivery-analysis validate', definition.submit]
      : [definition.submit];
  });
}
