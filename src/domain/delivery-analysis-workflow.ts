export const DELIVERY_ANALYSIS_PHASE_ORDER = [
  'impact_scan',
  'decision_proposal',
  'decision_resolution',
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
      'delivery-analysis decision propose',
      'help impact',
      'help decision-proposal',
    ],
    reviewBeforeSubmit: [
      '已读取完整业务变化上下文、交付计划和所有前置单元的最新 resolved Delivery Spec。',
      '已从参与者和可观察结果、实时项目结构两个方向完成 Do It Twice 调查。',
      '每项影响都有可定位证据，并且没有把上游已确认语义重新包装为待决策问题。',
      '需要独立业务结果的新范围已明确 exclude，没有暗中扩大当前单元。',
    ],
    submit: 'delivery-analysis impact-scan complete',
  },
  decision_proposal: {
    title: 'DECISION TREE · PROPOSE',
    objective: '先完整提出所有会让 Dev 或 Test 得出不同交付结果的关键选择、候选结果、依赖关系、推荐和建议决定权。',
    required: '已发现的活动决策具有稳定 key、候选选项、后果、推荐及建议决定权；允许在充分扫描后以零决策完成。',
    prohibited: '不要关闭决策、标记 HUMAN 或请求用户确认；即使答案明显，也只登记方案和推荐。发现遗漏影响时显式回流 IMPACT SCAN。',
    commands: [
      'delivery-analysis decision propose',
      'delivery-analysis decision option-upsert',
      'delivery-analysis decision option-remove',
      'delivery-analysis decision depends-on',
      'delivery-analysis decision dependency-remove',
      'delivery-analysis decision recommend',
      'delivery-analysis decision remove',
      'delivery-analysis decision-proposal reopen-impacts',
      'help decision-proposal',
    ],
    reviewBeforeSubmit: [
      '全部根节点和已知条件子节点已一次建立，没有把相互依赖的问题拆成多轮随机追问。',
      '每个已登记节点的选项互斥、后果明确，并有真实推荐、理由和建议决定权。',
      '尚未根据推荐、当前实现或 Agent 偏好关闭任何新发现的节点。',
      '准备约束 Delivery Contract 的方案都已先登记，没有把选择直接藏进实现方向。',
    ],
    submit: 'delivery-analysis decision-proposal complete',
  },
  decision_resolution: {
    title: 'DECISION TREE · RESOLVE',
    objective: '按上游承诺、项目证据、本次自动决策强度与用户决定权，关闭已经完整提出的决策树。',
    required: '全部活动决策已按有效决定权关闭或按当前策略组成一个完整 HUMAN 批次；用户回答必须在原 key 上以 user 权限关闭，完全自主模式下所有其余节点必须由 Agent 关闭。',
    prohibited: '不要在回答阶段临时新增方案；发现遗漏决策时回流 PROPOSE，发现遗漏影响时回流 IMPACT SCAN。只能按当前 RESOLVE 工作包给出的自动决策强度行使决定权。',
    commands: [
      'delivery-analysis decision resolve',
      'delivery-analysis decision ask',
      'delivery-analysis decision reopen',
      'delivery-analysis impact resolve',
      'delivery-analysis decision-resolution reopen-proposals',
      'delivery-analysis decision-resolution reopen-impacts',
      'help decision-resolution',
    ],
    reviewBeforeSubmit: [
      '先继承上游答案和具备决定权的项目证据，再应用本次自动决策强度。',
      'Agent 自主结论符合当前决策强度，且没有覆盖明确上游承诺、扩大当前交付目标或引入无关业务结果。',
      '当前策略允许保留的 HUMAN 节点已经一次标记并形成完整批次，而不是逐个随机追问；完全自主模式下不存在 HUMAN 节点。',
      '已关闭决策的关联影响不再保留 needs_decision；未命中分支不进入活动交付契约。',
    ],
    submit: 'delivery-analysis decision-resolution complete',
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
      'delivery-analysis contract reopen-resolutions',
      'delivery-analysis contract reopen-proposals',
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
  'AS-IS & IMPACT SCAN → DECISION TREE · PROPOSE → DECISION TREE · RESOLVE → DELIVERY CONTRACT → FINALIZE';

export function deliveryAnalysisNormalCommandPath() {
  return DELIVERY_ANALYSIS_PHASE_ORDER.flatMap((phase) => {
    const definition = DELIVERY_ANALYSIS_WORKFLOW[phase];
    return phase === 'finalize'
      ? ['delivery-analysis validate', definition.submit]
      : [definition.submit];
  });
}
