export const DELIVERY_PLAN_PHASE_ORDER = [
  'planning_basis',
  'delivery_units',
  'coverage_order',
  'finalize',
] as const;

export type DeliveryPlanPhase = typeof DELIVERY_PLAN_PHASE_ORDER[number];

export type DeliveryPlanWorkPacketDefinition = {
  title: string;
  objective: string;
  required: string;
  prohibited: string;
  commands: string[];
  reviewBeforeSubmit: string[];
  submit: string;
};

export const DELIVERY_PLAN_WORKFLOW: Record<DeliveryPlanPhase, DeliveryPlanWorkPacketDefinition> = {
  planning_basis: {
    title: 'PLANNING BASIS',
    objective: '消费当前委派冻结的业务契约和项目事实，建立不会改写上游语义的交付拆分依据。',
    required: '完整阅读 Required Context Refs；普通拆分消费业务变化上下文，反馈拆分消费本轮冻结反馈变化及关联历史；说明业务闭环、项目适配与保守合并原则。',
    prohibited: '不要建立交付单元、映射来源、设计实现方案或重新决定产品语义。',
    commands: [
      'delivery-plan rationale set',
      'help context',
      'help finish',
    ],
    reviewBeforeSubmit: [
      '已读取当前委派的完整业务契约，而不是只依据需求标题或规划输入摘要。',
      '拆分依据尊重当前冻结输入中已确认的目标、范围、决定与保持约束。',
      '项目调查只用于判断业务边界和可信跨度，没有提前形成技术方案。',
      '无法证明可独立的结果将采用保守的较大闭环。',
    ],
    submit: 'delivery-plan basis complete',
  },
  delivery_units: {
    title: 'DELIVERY UNITS',
    objective: '一次建立当前已知的完整交付单元集合，每个单元形成可独立验收的纵向业务闭环。',
    required: '至少一个 active 单元；稳定 unit key、参与者、触发条件、用户可观察结果与单元验收语义。',
    prohibited: '不要按数据库、API、页面、调度或测试等技术层拆分，也不要建立来源映射和依赖。',
    commands: [
      'delivery-plan unit upsert',
      'delivery-plan unit dismiss',
      'delivery-plan unit supersede',
      'help unit',
      'help revision',
    ],
    reviewBeforeSubmit: [
      '每个单元都能独立产生用户、运营者或外部系统可观察的结果。',
      '拆开后没有必须等待另一单元才能成立的半成品。',
      '一个单元没有混入多个可独立交付和验证的业务结果。',
      '没有创建建表、接口、页面、调度或补测试等技术步骤型单元。',
      '当前已知的所有业务结果都已进入候选集合。',
    ],
    submit: 'delivery-plan units complete',
  },
  coverage_order: {
    title: 'COVERAGE & ORDER',
    objective: '证明活动单元共同覆盖全部冻结规划输入，并建立真实、无环且与推荐顺序一致的业务依赖。',
    required: '整体覆盖说明；全部 source 的真实承接关系；多单元排序说明；适用时的前置依赖。',
    prohibited: '不要为了通过覆盖校验虚假关联来源，不要把 preserve 或 technical 单独包装成交付单元，不要制造串行依赖。',
    commands: [
      'delivery-plan coverage set',
      'delivery-plan ordering set',
      'delivery-plan unit source add',
      'delivery-plan unit source remove',
      'delivery-plan unit dependency add',
      'delivery-plan unit dependency remove',
      'delivery-plan unit move',
      'delivery-plan coverage reopen-units',
      'help source',
      'help dependency',
    ],
    reviewBeforeSubmit: [
      '每项冻结输入都由真正负责它的活动单元承接。',
      '每个单元至少承接一项业务变化或验收语义。',
      'Preserve 与 Analysis Obligation 已关联到相关业务单元，没有独立成项。',
      '多单元计划已说明推荐顺序；依赖只表达真实业务前置关系。',
      '全部单元组合后覆盖本轮业务目标和范围，且没有隐藏新语义。',
    ],
    submit: 'delivery-plan coverage complete',
  },
  finalize: {
    title: 'FINALIZE',
    objective: '对完整交付计划做最终一致性校验并提交。',
    required: '拆分依据、活动单元、来源覆盖、排序依赖和上游业务契约全部一致。',
    prohibited: '不要用普通最终文本、Markdown 或手写 JSON 代替 validate 与 complete。',
    commands: ['delivery-plan validate'],
    reviewBeforeSubmit: [
      '全部活动单元都是独立业务闭环，组合后完整覆盖本轮目标。',
      '没有技术步骤型单元、虚假来源关联、重复业务结果或隐含产品决定。',
      '来源覆盖、推荐顺序和依赖关系相互一致。',
      '历史修订与稳定 key 正确，但不会作为用户可读内容干扰下游判断。',
    ],
    submit: 'delivery-plan complete',
  },
};

export const DELIVERY_PLAN_PHASE_SEQUENCE =
  'PLANNING BASIS → DELIVERY UNITS → COVERAGE & ORDER → FINALIZE';

export function deliveryPlanNormalCommandPath() {
  return DELIVERY_PLAN_PHASE_ORDER.flatMap((phase) => {
    const definition = DELIVERY_PLAN_WORKFLOW[phase];
    return phase === 'finalize'
      ? ['delivery-plan validate', definition.submit]
      : [definition.submit];
  });
}
