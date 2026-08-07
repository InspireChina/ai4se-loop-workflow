export const REVIEW_PHASE_ORDER = [
  'fact_reconciliation',
  'closure_assessment',
  'report',
  'forward_units',
  'finalize',
] as const;

export type ReviewPhase = typeof REVIEW_PHASE_ORDER[number];

export type ReviewWorkPacket = {
  title: string;
  objective: string;
  required: string;
  prohibited: string;
  commands: string[];
  reviewBeforeSubmit: string[];
  submit: string;
};

export const REVIEW_WORKFLOW: Record<ReviewPhase, ReviewWorkPacket> = {
  fact_reconciliation: {
    title: 'FACT RECONCILIATION',
    objective: '逐项把需求意图、TO-BE、影响、验收、交付单元和已验证反馈投影为当前最终事实。',
    required: '每个冻结 subject 恰好具有一个证据支持的对账结果或一个活动结卡缺口。',
    prohibited: '不要提前写报告，不要重新测试或使用 Dev 自述替代独立证据，不要在此阶段设计补齐单元。',
    commands: ['review reconciliation upsert', 'review reconciliation dismiss', 'review gap upsert', 'review gap resolve', 'review reconciliation complete', 'help reconciliation', 'help gap'],
    reviewBeforeSubmit: [
      '每个最终结果都表达用户可观察事实，而不是流程状态或 Agent 声明。',
      '证据与 subject 的语义确实匹配，不只是引用了一条 passed Test execution。',
      '缺口与残余风险严格区分，历史事实与当前有效事实没有混写。',
    ],
    submit: 'review reconciliation complete',
  },
  closure_assessment: {
    title: 'CLOSURE ASSESSMENT',
    objective: '检查所有对账结果组合后是否共同支持原始目标，并冻结跨单元、历史修订、开放义务和证据边界判断。',
    required: '记录需求级评估摘要与证据边界；会影响交付是否成立的问题必须表现为活动缺口。',
    prohibited: '不要修改逐项对账，不要把组合证据缺失降格为残余风险，不要自行选择后续 Agent。',
    commands: ['review assessment record', 'review assessment reopen-reconciliation', 'review assessment complete', 'help assessment'],
    reviewBeforeSubmit: [
      '多个交付单元组合后的最终行为仍支持原始业务目标。',
      '向前修订、已验证 Feedback 和旧事实的替代关系一致。',
      '不存在开放义务、事实冲突或缺失证据被隐藏在报告措辞中。',
    ],
    submit: 'review assessment complete',
  },
  report: {
    title: 'REPORT',
    objective: '只使用已经闭合的最终事实生成面向用户、无需阅读 Agent 日志的结卡报告。',
    required: '核心章节完整；表达与冻结对账及结卡评估一致。',
    prohibited: '不要展示内部 key、subject ref、execution ref 或 spec ref；不要创造新的事实或扩大承诺。',
    commands: ['review report section-upsert', 'review report section-remove', 'review report reopen-assessment', 'review report complete', 'help report'],
    reviewBeforeSubmit: [
      '报告先表达原始目标与最终结果，再说明范围、实现、验证和风险。',
      '可选章节没有为完整感制造不存在的决策、偏差或反馈。',
      '用户可见内容不泄露内部稳定标识和控制面引用。',
    ],
    submit: 'review report complete',
  },
  forward_units: {
    title: 'FORWARD DELIVERY UNITS',
    objective: '把活动结卡缺口组合为最小、完整、可直接进入 Analysis 的新增交付单元。',
    required: '每个活动缺口恰好被一个完整单元覆盖；依赖存在且无环。',
    prohibited: '不要重新拆分整个需求，不要新增产品范围，不要用泛化参与者或流程动作代替业务触发与可观察结果。',
    commands: ['review forward-unit upsert', 'review forward-unit remove', 'review forward-unit depends-on', 'review forward-unit dependency-remove', 'review forward-units reopen-assessment', 'review forward-units complete', 'help forward'],
    reviewBeforeSubmit: [
      '相关缺口被合并为同一个可独立验收的业务结果，不相关缺口没有被强行捆绑。',
      '每个单元都有明确参与者、业务触发、可观察结果与客观验收语义。',
      '新增单元只闭合已有承诺，后续可以绕过 Story Splitter 直接进入 Analysis。',
    ],
    submit: 'review forward-units complete',
  },
  finalize: {
    title: 'FINALIZE',
    objective: '对结卡报告或前向补齐单元做版本绑定校验并提交确定性结果。',
    required: '当前草稿版本通过 validate，且之后没有编辑或回流。',
    prohibited: '不要在 FINALIZE 修改事实、报告或单元；发现问题时显式回流对应分支。',
    commands: ['review validate', 'review finalize reopen-report', 'review finalize reopen-forward-units', 'help finish'],
    reviewBeforeSubmit: [
      '无缺口分支只提交 report_ready；缺口分支只提交 closure_gap 与完整前向单元。',
      'Application 可以直接落库新增单元并派发 Analysis，不需要 Story Splitter。',
    ],
    submit: 'review complete',
  },
};

export const REVIEW_HAPPY_PATH = 'FACT RECONCILIATION → CLOSURE ASSESSMENT → REPORT → FINALIZE';
export const REVIEW_GAP_PATH = 'FACT RECONCILIATION → CLOSURE ASSESSMENT → FORWARD DELIVERY UNITS → FINALIZE';
