export const VERIFICATION_PHASE_ORDER = [
  'plan',
  'execute',
  'evidence_review',
  'finalize',
] as const;

export type VerificationPhase = typeof VERIFICATION_PHASE_ORDER[number];

export type VerificationWorkPacketDefinition = {
  title: string;
  objective: string;
  required: string;
  prohibited: string;
  commands: string[];
  reviewBeforeSubmit: string[];
  submit: string;
};

export const VERIFICATION_WORKFLOW: Record<VerificationPhase, VerificationWorkPacketDefinition> = {
  plan: {
    title: 'PLAN',
    objective: '从冻结交付契约建立独立 Oracle，并在观察实际行为前形成覆盖验收、关注点、保护项和恢复事项的黑盒场景。',
    required: '全部必测引用都有场景覆盖；交付单元 Acceptance 至少由一个真实 frontend 场景覆盖。',
    prohibited: '不要根据当前实现或 Dev 自述改变 Expected；不要在计划中记录 Actual 或预判通过。',
    commands: ['verification plan upsert', 'verification plan dismiss', 'verification plan complete', 'verification request-input', 'help plan', 'help input'],
    reviewBeforeSubmit: [
      'Expected 只来自冻结交付契约和活动恢复事项，不来自当前实现。',
      '场景包含可复现的准备、真实入口动作和可观察结果。',
      'Acceptance 有真实前端闭环，API 只做业务语义补充。',
      '必要边界、保护项与原始反例没有被遗漏。',
    ],
    submit: 'verification plan complete',
  },
  execute: {
    title: 'EXECUTE',
    objective: '逐项执行冻结场景，以独立观察记录 Actual、证据和最小责任分类，并主动寻找能够推翻交付结论的反例。',
    required: '每个活动场景都有 passed、failed 或 blocked 结果；没有未回答的运行信息请求。',
    prohibited: '不要修改冻结场景来适配 Actual；不要用代码阅读、单测或 Dev 声明冒充业务黑盒证据。',
    commands: ['verification result record', 'verification plan upsert', 'verification execute complete', 'verification request-input', 'help execute', 'help input'],
    reviewBeforeSubmit: [
      '每项结果都包含与场景匹配、可定位且可重复的独立证据。',
      '失败区分实现偏离与规格矛盾，阻塞区分环境缺失与证据不足。',
      '新发现的相关风险已用新场景追加，没有改写冻结 Expected。',
      '安全且有诊断价值的其余场景已经继续执行。',
    ],
    submit: 'verification execute complete',
  },
  evidence_review: {
    title: 'EVIDENCE REVIEW',
    objective: '复核每项证据是否真正支持所记录的状态和责任边界，并披露不影响本次结论的残余风险。',
    required: '记录完整证据复核摘要；存在不充分或错误结果时显式回流 EXECUTE。',
    prohibited: '不要在本阶段修改场景或执行结果；不要把会影响契约是否成立的不确定性降格为残余风险。',
    commands: ['verification evidence-review record', 'verification evidence-review reopen-execution', 'verification evidence-review complete', 'help evidence'],
    reviewBeforeSubmit: [
      '证据来自独立观察，能够支持 Expected 与 Actual 的比较。',
      '状态、实际行为和失败分类彼此一致，没有从代码根因做无证据推断。',
      '人工观察明确标注来源，仍由 Test Agent 对照 Oracle 判定。',
      '残余风险不会使当前通过、失败或阻塞结论仍然不确定。',
    ],
    submit: 'verification evidence-review complete',
  },
  finalize: {
    title: 'FINALIZE',
    objective: '对冻结计划、执行结果、证据复核和确定性结论做版本绑定校验并提交独立验证结果。',
    required: '当前草稿版本已通过 validate，且校验后没有编辑或阶段回流。',
    prohibited: '不要在 FINALIZE 修改计划、结果或复核；发现问题时显式重新打开 EVIDENCE REVIEW。',
    commands: ['verification validate', 'verification finalize reopen-evidence-review', 'help finish'],
    reviewBeforeSubmit: [
      '所有活动场景有结果且证据复核已经完成。',
      'Application 可从结果确定性推导通过、回流或验证协助。',
      '用户可见报告表达业务场景、Expected、Actual 与证据，不泄露内部稳定 key。',
    ],
    submit: 'verification complete',
  },
};

export const VERIFICATION_PHASE_SEQUENCE = 'PLAN → EXECUTE → EVIDENCE REVIEW → FINALIZE';

export function verificationNormalCommandPath() {
  return [
    VERIFICATION_WORKFLOW.plan.submit,
    VERIFICATION_WORKFLOW.execute.submit,
    VERIFICATION_WORKFLOW.evidence_review.submit,
    'verification validate',
    VERIFICATION_WORKFLOW.finalize.submit,
  ];
}
