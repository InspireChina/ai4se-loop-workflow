export const DEVELOPMENT_PHASE_ORDER = [
  'implement',
  'review',
  'developer_verify',
  'commit',
  'finalize',
] as const;

export type DevelopmentPhase = typeof DEVELOPMENT_PHASE_ORDER[number];

export type DevelopmentWorkPacketDefinition = {
  title: string;
  objective: string;
  required: string;
  prohibited: string;
  commands: string[];
  reviewBeforeSubmit: string[];
  submit: string;
};

export const DEVELOPMENT_WORKFLOW: Record<DevelopmentPhase, DevelopmentWorkPacketDefinition> = {
  implement: {
    title: 'IMPLEMENT',
    objective: '依据冻结交付契约检查当前仓库并完成最小充分实现，使每项验收语义都能定位到真实实现证据。',
    required: '每项冻结验收语义都有实现证据；全部活动恢复事项已经声明本轮如何处理；没有尚未回答的运行信息请求。',
    prohibited: '不要提前声明测试通过，不要用 Git 历史或是否产生 diff 代替实现完整性，不要改变业务契约或扩大当前交付单元。',
    commands: [
      'implementation criterion satisfy',
      'implementation criterion reopen',
      'implementation recovery resolve',
      'implementation recovery reopen',
      'implementation runtime-input request',
      'implementation runtime-input withdraw',
      'implementation implement complete',
      'help evidence',
      'help input',
    ],
    reviewBeforeSubmit: [
      '已读取当前 Delivery Spec、活动恢复事项与相关项目规范，并核对实时仓库事实。',
      '现有实现满足承诺时有充分走查证据；存在缺口时已经完成结构完整的实现。',
      '每项验收证据都指向真实实现位置或行为，不把计划、意图或待执行检查写成已实现事实。',
      '必须保持与明确排除的边界没有被当前实现破坏。',
    ],
    submit: 'implementation implement complete',
  },
  review: {
    title: 'REVIEW',
    objective: '对当前实现做独立于功能自检的代码审查，确认它遵守仓库规范、职责边界和 Clean Code 原则。',
    required: '记录 pass 审查结论、覆盖代码规范与可维护性的摘要，以及可定位的审查依据；needs_changes 必须回流 IMPLEMENT。',
    prohibited: '不要把测试通过当作代码质量审查，不要忽略阻塞问题后继续推进，不要在 REVIEW 中暗中修改代码。',
    commands: [
      'implementation review record',
      'implementation review reopen-implementation',
      'implementation review complete',
      'help review',
    ],
    reviewBeforeSubmit: [
      '实现符合仓库已有格式、命名、模块边界和错误处理惯例。',
      '没有明显重复、过度抽象、隐藏副作用、无必要兼容分支或难以理解的控制流。',
      '测试与生产代码职责清晰，没有通过硬编码、降低检查强度或污染 Fixture 制造通过。',
      '所有阻塞审查意见已经通过回流 IMPLEMENT 修正，并基于修正后的代码重新完成审查。',
    ],
    submit: 'implementation review complete',
  },
  developer_verify: {
    title: 'DEVELOPER VERIFY',
    objective: '以与风险相称的真实命令检查当前实现，绑定 Application 捕获的最新成功结果，并披露仍存在的风险。',
    required: '至少一条有效成功检查；恢复修正周期中的检查必须来自当前 execution；没有尚未回答的运行信息请求。',
    prohibited: '不要手写 passed、exit code 或伪造 receipt；不要把开发者自检写成独立 Test Agent 已验收。发现实现缺口时回流 IMPLEMENT。',
    commands: [
      'implementation check record',
      'implementation check discard',
      'implementation risk record',
      'implementation risk clear',
      'implementation runtime-input request',
      'implementation runtime-input withdraw',
      'implementation verify reopen-implementation',
      'implementation verify complete',
      'help evidence',
      'help input',
    ],
    reviewBeforeSubmit: [
      '关键检查真实覆盖了本轮变化和高风险回归边界，而不只是执行最方便的命令。',
      '每条选中检查都绑定当前命令的最新成功 receipt，后续没有同命令的新失败结果。',
      '已知但不否定当前交付的残余风险已经如实披露。',
      '没有把 Dev 自检结论包装成业务最终验收结果。',
    ],
    submit: 'implementation verify complete',
  },
  commit: {
    title: 'COMMIT',
    objective: '把当前交付单元的代码变化形成边界清晰的 Git 提交，并向 Application 确认提交步骤已经处理。',
    required: '存在本单元代码变化时已经按仓库规范完成提交；没有代码变化时已经确认无需制造空提交。Application 只接收 Agent 的完成确认。',
    prohibited: '不要混入已有的无关工作区改动，不要为了通过阶段制造空提交；Application 不校验 commit hash、HEAD、提交内容或工作区状态。',
    commands: [
      'implementation commit complete',
      'implementation commit reopen-verification',
      'help commit',
      'help finish',
    ],
    reviewBeforeSubmit: [
      '有代码变化时，已经只提交当前交付单元相关文件，并使用符合仓库规范的提交说明。',
      '没有代码变化时，已经确认当前交付依赖现有实现，不制造空提交。',
      '已知无关工作区改动没有被加入本次提交。',
      'Application 将信任本次确认，不会检查 commit hash、HEAD、提交内容或工作区状态。',
    ],
    submit: 'implementation commit complete',
  },
  finalize: {
    title: 'FINALIZE',
    objective: '对实现证据、真实检查、风险、恢复处理和已确认的提交步骤做最终一致性校验并提交开发结果。',
    required: '当前草稿版本通过 validate，且校验后没有任何编辑或阶段回流。',
    prohibited: '不要在 FINALIZE 修改证据、检查或风险；发现问题时显式重新打开 COMMIT 之前的 DEVELOPER VERIFY。',
    commands: [
      'implementation validate',
      'implementation finalize reopen-verification',
      'help finish',
    ],
    reviewBeforeSubmit: [
      '每项验收语义都有实现证据，关键检查与当前仓库状态一致。',
      '不存在未回答运行信息、未处理恢复事项或被更新结果取代的检查。',
      '用户可见开发文档只表达业务语义、证据与检查结果，不泄露内部稳定 key。',
    ],
    submit: 'implementation complete',
  },
};

export const DEVELOPMENT_PHASE_SEQUENCE = 'IMPLEMENT → REVIEW → DEVELOPER VERIFY → COMMIT → FINALIZE';

export function developmentNormalCommandPath() {
  return [
    DEVELOPMENT_WORKFLOW.implement.submit,
    DEVELOPMENT_WORKFLOW.review.submit,
    DEVELOPMENT_WORKFLOW.developer_verify.submit,
    DEVELOPMENT_WORKFLOW.commit.submit,
    'implementation validate',
    DEVELOPMENT_WORKFLOW.finalize.submit,
  ];
}
